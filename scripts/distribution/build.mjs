import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { assetFilename, NODE_VERSION, sha256 } from "./metadata.mjs";

const REPO = resolve(import.meta.dirname, "../..");

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

/** Resolve all pnpm links before archiving; preserve Node resolution and dependency cycles. */
export async function materializePackage(source, target, ancestors = new Map(), depth = 0) {
  if (depth > 64) throw new Error("Dependency graph cannot be materialized within 64 levels");
  const sourceRoot = await realpath(source);
  const manifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const visible = new Map(ancestors);
  visible.set(manifest.name, sourceRoot);
  await cp(sourceRoot, target, {
    recursive: true,
    dereference: true,
    filter: (path) =>
      path === sourceRoot ||
      (!path
        .slice(sourceRoot.length + 1)
        .split(/[\\/]/)
        .includes("node_modules") &&
        !["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs"].includes(
          basename(path),
        )),
  });
  if (manifest.publishConfig) {
    for (const key of ["main", "module", "types", "exports", "imports", "bin"]) {
      if (manifest.publishConfig[key] !== undefined) manifest[key] = manifest.publishConfig[key];
    }
  }
  if (manifest.name === "@roll-agent/core") {
    manifest.rollDistribution = { schemaVersion: 1, channel: "standalone" };
  }
  delete manifest.devDependencies;
  const required = manifest.dependencies ?? {};
  const optional = manifest.optionalDependencies ?? {};
  for (const name of Object.keys({ ...required, ...optional, ...manifest.peerDependencies })) {
    let cursor = sourceRoot;
    let dependency;
    while (true) {
      try {
        dependency = await realpath(join(cursor, "node_modules", name));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (dirname(cursor) === cursor) break;
      cursor = dirname(cursor);
    }
    if (!dependency) {
      if (name in required && !(name in optional)) {
        throw new Error(`Missing production dependency ${manifest.name} -> ${name}`);
      }
      continue;
    }
    const dependencyManifest = JSON.parse(await readFile(join(dependency, "package.json"), "utf8"));
    for (const field of ["dependencies", "optionalDependencies"]) {
      if (manifest[field]?.[name] !== undefined) manifest[field][name] = dependencyManifest.version;
    }
    if (visible.get(name) === dependency) continue;
    await materializePackage(dependency, join(target, "node_modules", name), visible, depth + 1);
  }
  await writeFile(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function assertNoLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Archive must not contain links: ${path}`);
    if (info.isDirectory()) await assertNoLinks(path);
  }
}

/** Runtime imports Core subpaths even though its workspace edge is a devDependency.
 * Keep one Core module identity: portable ESM forwarding files replace the npm self symlink.
 * Copying Core would duplicate its AsyncLocalStorage and bypass the selected update runtime.
 */
export async function createCoreSelfReference(app) {
  const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  if (manifest.name !== "@roll-agent/core") throw new Error("Expected the Core application root");
  const facade = join(app, "node_modules/@roll-agent/core");
  await mkdir(facade, { recursive: true });
  await writeFile(
    join(facade, "package.json"),
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        type: "module",
        exports: manifest.exports,
      },
      null,
      2,
    ),
  );
  async function forward(directory, parts = []) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const source = join(directory, entry.name);
      const names = [...parts, entry.name];
      if (entry.isDirectory()) {
        await forward(source, names);
        continue;
      }
      if (!entry.isFile() || !/\.(m?js|d\.ts)$/.test(entry.name)) continue;
      const destination = join(facade, ...names);
      await mkdir(dirname(destination), { recursive: true });
      const specifier = relative(dirname(destination), source)
        .split("\\")
        .join("/")
        .replace(/\.d\.ts$/, ".js");
      const content = await readFile(source, "utf8");
      const syntax = ts.createSourceFile(source, content, ts.ScriptTarget.Latest, false);
      const hasDefault = syntax.statements.some(
        (statement) =>
          (ts.isExportAssignment(statement) && !statement.isExportEquals) ||
          (ts.isExportDeclaration(statement) &&
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.some((element) => element.name.text === "default")) ||
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
      );
      await writeFile(
        destination,
        `export * from ${JSON.stringify(specifier)};\n${hasDefault ? `export { default } from ${JSON.stringify(specifier)};\n` : ""}`,
      );
    }
  }
  await forward(app);
}

export async function build(outputDirectory) {
  const platform = `${process.platform}-${process.arch}`;
  const core = JSON.parse(await readFile(join(REPO, "packages/core/package.json"), "utf8"));
  const filename = assetFilename(core.version, platform);
  if (process.versions.node !== NODE_VERSION) {
    throw new Error(`Build requires Node ${NODE_VERSION}`);
  }
  const rootManifest = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const toolVersion = spawnSync(pnpm, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (`pnpm@${toolVersion.stdout?.trim()}` !== rootManifest.packageManager) {
    throw new Error("pnpm version must match packageManager");
  }
  const temp = await mkdtemp(join(tmpdir(), "roll-distribution-"));
  try {
    // pnpm deploy may prepare workspace injection metadata. Never do that in the developer's
    // checkout: snapshot only build inputs, preserving the already built dist/UI directories.
    const workspace = join(temp, "workspace");
    await mkdir(workspace);
    for (const name of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "patches",
      "packages",
      "agents",
    ]) {
      await cp(join(REPO, name), join(workspace, name), {
        recursive: true,
        filter: (path) =>
          !path
            .slice(REPO.length + 1)
            .split(/[\\/]/)
            .some((part) => ["node_modules", ".git", ".env", ".roll-agent"].includes(part)),
      });
    }
    run(pnpm, ["install", "--frozen-lockfile"], {
      cwd: workspace,
      shell: process.platform === "win32",
      env: { ...process.env, NODE_ENV: "development" },
    });
    const deployed = join(temp, "deployed");
    run(
      pnpm,
      [
        "--filter",
        "@roll-agent/core",
        "--config.inject-workspace-packages=true",
        "deploy",
        "--prod",
        "--frozen-lockfile",
        deployed,
      ],
      {
        cwd: workspace,
        shell: process.platform === "win32",
      },
    );
    const bundle = join(temp, "bundle");
    await mkdir(bundle);
    await materializePackage(deployed, join(bundle, "app"));
    await createCoreSelfReference(join(bundle, "app"));
    const checksums = JSON.parse(
      await readFile(join(import.meta.dirname, "node-checksums.json"), "utf8"),
    );
    const nodeName = `node-v${NODE_VERSION}-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
    const nodeFilename = `${nodeName}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
    const nodeArchive = join(temp, nodeFilename);
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${nodeFilename}`, {
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
    await writeFile(nodeArchive, Buffer.from(await response.arrayBuffer()));
    if ((await sha256(nodeArchive)) !== checksums.files[nodeFilename]) {
      throw new Error("Node checksum mismatch");
    }
    if (process.platform === "win32") {
      run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Expand-Archive -LiteralPath $env:ROLL_NODE_ARCHIVE -DestinationPath $env:ROLL_NODE_TARGET",
        ],
        {
          env: { ...process.env, ROLL_NODE_ARCHIVE: nodeArchive, ROLL_NODE_TARGET: temp },
        },
      );
    } else run("tar", ["-xzf", nodeArchive, "-C", temp]);
    await cp(join(temp, nodeName), join(bundle, "runtime"), { recursive: true, dereference: true });
    if (process.platform !== "win32") {
      // Dereferenced npm symlinks cannot retain their relative JS imports at bin/npm.
      for (const tool of ["npm", "npx"]) {
        await writeFile(
          join(bundle, "runtime/bin", tool),
          `#!/bin/sh\nSELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$SELF_DIR/node" "$SELF_DIR/../lib/node_modules/npm/bin/${tool}-cli.js" "$@"\n`,
          { mode: 0o755 },
        );
      }
    }
    await writeFile(
      join(bundle, "distribution.json"),
      `${JSON.stringify({ schemaVersion: 1, channel: "standalone", version: core.version, platform, nodeVersion: NODE_VERSION }, null, 2)}\n`,
    );
    await assertNoLinks(bundle);
    await cp(
      join(import.meta.dirname, "node-checksums.json"),
      join(bundle, "runtime/node-checksums.json"),
    );
    // The smoke test runs detached from the checkout and does not read real user config.
    run(process.execPath, [join(import.meta.dirname, "smoke.mjs"), bundle], { cwd: temp });
    await mkdir(outputDirectory, { recursive: true });
    const output = resolve(outputDirectory, filename);
    // Immutable output: caller must use a fresh staging directory.
    try {
      await lstat(output);
      throw new Error(`Refusing to replace ${output}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    run(process.platform === "win32" ? "python" : "python3", [
      join(import.meta.dirname, "archive.py"),
      bundle,
      output,
    ]);
    console.log(
      JSON.stringify({ platform, filename: basename(output), sha256: await sha256(output) }),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node build.mjs <output-directory>");
  await build(resolve(process.argv[2]));
}
