import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NODE_VERSION } from "./metadata.mjs";

const bundle = resolve(process.argv[2]);
const info = JSON.parse(await readFile(join(bundle, "distribution.json"), "utf8"));
if (info.platform !== `${process.platform}-${process.arch}`) {
  throw new Error("Smoke test must run natively on target platform");
}
const node = join(bundle, "runtime", process.platform === "win32" ? "node.exe" : "bin/node");
const home = await mkdtemp(join(tmpdir(), "roll-smoke-home-"));
await writeFile(join(home, "roll.config.yaml"), "{}\n");
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
  APPDATA: home,
  LOCALAPPDATA: home,
  NODE_PATH: "",
  NODE_OPTIONS: "",
  PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin",
};
function check(args) {
  const result = spawnSync(node, args, { cwd: home, env, encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Detached smoke failed: ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}
try {
  if (check(["--version"]).trim() !== `v${NODE_VERSION}`) {
    throw new Error("Wrong bundled Node version");
  }
  await access(join(bundle, "app/dist/ui-assets/index.html"));
  await access(join(bundle, "runtime/LICENSE"));
  check([join(bundle, "app/bin/roll.js"), "--version"]);
  check([join(bundle, "app/bin/roll.js"), "agent", "health"]);
  const npm = join(
    bundle,
    "runtime",
    process.platform === "win32"
      ? "node_modules/npm/bin/npm-cli.js"
      : "lib/node_modules/npm/bin/npm-cli.js",
  );
  check([npm, "--version"]);
  const probe = join(bundle, "app", ".distribution-smoke.mjs");
  await writeFile(
    probe,
    `
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const db = new DatabaseSync(':memory:');
if (db.prepare('select 42 as value').get().value !== 42) throw Error('SQLite failure');
db.close();
const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve('@roll-agent/runtime'));
await import(pathToFileURL(require.resolve('@roll-agent/runtime')).href);
const { rgPath } = await import(pathToFileURL(runtimeRequire.resolve('@vscode/ripgrep')).href);
const rg = spawnSync(rgPath, ['--version']);
if (rg.status !== 0) throw Error('ripgrep failure');
`,
  );
  try {
    check([probe]);
  } finally {
    await rm(probe, { force: true });
  }
} finally {
  await rm(home, { recursive: true, force: true });
}
