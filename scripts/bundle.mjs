#!/usr/bin/env node
import { builtinModules } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { build } from "esbuild";

const packageDir = process.cwd();
const packageJsonPath = resolve(packageDir, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

async function main() {
  const entries = resolveBundleEntries(packageJson);
  const external = resolveExternalModules(packageJson);

  for (const entry of entries) {
    const banner = readShebang(entry.entryPoint);
    await build({
      absWorkingDir: packageDir,
      entryPoints: [entry.entryPoint],
      outfile: entry.outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "es2024",
      splitting: false,
      minify: false,
      sourcemap: false,
      external,
      banner: banner ? { js: banner } : undefined,
      logLevel: "info",
    });

    console.log(
      `  Bundled ${relative(packageDir, entry.entryPoint)} -> ${relative(packageDir, entry.outfile)}`,
    );
  }
}

function resolveBundleEntries(manifest) {
  const exportsField = manifest.exports;
  if (!exportsField) {
    throw new Error("package.json exports is required for bundle.mjs");
  }

  const normalizedExports = typeof exportsField === "string" ? { ".": exportsField } : exportsField;
  if (typeof normalizedExports !== "object" || normalizedExports === null) {
    throw new Error("package.json exports must be a string or object");
  }

  return Object.entries(normalizedExports).map(([subpath, exportTarget]) => {
    const runtimeTarget = resolveRuntimeTarget(exportTarget);
    const { sourceEntry, outputFile } = resolveEntryFromRuntimeTarget(runtimeTarget);
    const entryPoint = resolve(packageDir, sourceEntry);
    const outfile = resolve(packageDir, outputFile);

    if (!existsSync(entryPoint)) {
      throw new Error(`Missing source entry for export "${subpath}": ${sourceEntry}`);
    }

    return { subpath, entryPoint, outfile };
  });
}

function resolveRuntimeTarget(exportTarget) {
  if (typeof exportTarget === "string") {
    return exportTarget;
  }

  if (typeof exportTarget !== "object" || exportTarget === null) {
    throw new Error(`Unsupported export target: ${String(exportTarget)}`);
  }

  const conditionalTarget =
    exportTarget.default ??
    exportTarget.import ??
    exportTarget.node;

  if (typeof conditionalTarget !== "string") {
    throw new Error("bundle.mjs requires exports entries with a string default/import/node target");
  }

  return conditionalTarget;
}

function resolveEntryFromRuntimeTarget(runtimeTarget) {
  if (runtimeTarget.startsWith("./src/") && runtimeTarget.endsWith(".ts")) {
    const relativeEntry = runtimeTarget.slice("./src/".length, -".ts".length);
    return {
      sourceEntry: runtimeTarget,
      outputFile: `./dist/${relativeEntry}.js`,
    };
  }

  if (runtimeTarget.startsWith("./dist/") && runtimeTarget.endsWith(".js")) {
    const relativeEntry = runtimeTarget.slice("./dist/".length, -".js".length);
    return {
      sourceEntry: `./src/${relativeEntry}.ts`,
      outputFile: runtimeTarget,
    };
  }

  throw new Error(
    `Unsupported runtime target "${runtimeTarget}". Expected ./src/*.ts or ./dist/*.js exports.`,
  );
}

function resolveExternalModules(manifest) {
  const runtimeDeps = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);

  const builtins = new Set();
  for (const builtin of builtinModules) {
    builtins.add(builtin);
    if (!builtin.startsWith("node:")) {
      builtins.add(`node:${builtin}`);
    }
  }

  const external = new Set(["node:*"]);
  for (const builtin of builtins) {
    external.add(builtin);
  }

  for (const dep of runtimeDeps) {
    external.add(dep);
    external.add(`${dep}/*`);
  }

  return [...external];
}

function readShebang(filePath) {
  const source = readFileSync(filePath, "utf-8");
  const firstLine = source.split("\n", 1)[0] ?? "";
  return firstLine.startsWith("#!") ? firstLine : undefined;
}

main().catch((error) => {
  console.error("bundle.mjs failed:", error);
  process.exit(1);
});
