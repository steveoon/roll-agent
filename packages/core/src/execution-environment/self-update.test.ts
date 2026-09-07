import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveExecutionEnvironment } from "./index.ts";
import { isCurrentNpmInstallation, resolveSelfUpdateTarget } from "./self-update.ts";

test("source and unknown installations never dispatch a global npm update", async () => {
  const host = resolveExecutionEnvironment();
  assert.equal((await resolveSelfUpdateTarget(host)).channel, "unmanaged");
  assert.equal(
    (
      await resolveSelfUpdateTarget({
        ...host,
        installation: { ...host.installation, channel: "unknown" },
        resolveCommand() {
          throw new Error("must not execute npm");
        },
      })
    ).channel,
    "unmanaged",
  );
});

test("npm self-update requires exact current installation root and captures its prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "roll npm prefix 中文 "));
  try {
    const npmRoot = join(root, "lib/node_modules");
    const packageRoot = join(npmRoot, "@roll-agent/core");
    await mkdir(packageRoot, { recursive: true });
    const cli = join(root, "npm-cli.mjs");
    await writeFile(
      cli,
      `console.log(process.argv[2] === 'prefix' ? ${JSON.stringify(root)} : ${JSON.stringify(npmRoot)});`,
    );
    const host = resolveExecutionEnvironment();
    const environment = {
      ...host,
      npmCliPath: cli,
      installation: { ...host.installation, channel: "host" as const, packageRoot },
      resolveCommand(_command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
        return { command: process.execPath, args: [cli, ...args], env: host.createEnv(env) };
      },
    };
    const target = await resolveSelfUpdateTarget(environment);
    assert.equal(target.channel, "npm");
    if (target.channel === "npm") {
      assert.ok(
        await isCurrentNpmInstallation(packageRoot, join(target.prefix, "lib/node_modules")),
      );
    }
    assert.equal(await isCurrentNpmInstallation(host.installation.packageRoot, npmRoot), false);
    assert.equal(
      (
        await resolveSelfUpdateTarget({
          ...environment,
          installation: { ...environment.installation, packageRoot: root },
        })
      ).channel,
      "unmanaged",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
