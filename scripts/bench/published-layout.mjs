#!/usr/bin/env node
// Build a measurement layout with real published exports and no workspace source
// fallback. This is not the independent tarball-consumer acceptance test.
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, relative, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    output: { type: "string" },
    entry: { type: "string", default: "dist" },
  },
});
if (!values.root || !values.output) throw new Error("--root and --output are required");
if (!["src", "dist"].includes(values.entry)) throw new Error("--entry must be src or dist");
const root = realpathSync(values.root);
let output = resolve(values.output);
if (existsSync(output)) {
  throw new Error("--output must not exist; measurement layouts are immutable");
}
if (
  !existsSync(
    join(root, `packages/core/${values.entry}/cli/index.${values.entry === "src" ? "ts" : "js"}`),
  )
) {
  throw new Error("selected Core entry does not exist; build before selecting dist");
}
mkdirSync(output, { recursive: true });
output = realpathSync(output);
const copy = (from, to) =>
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "node_modules"]) {
  copy(join(root, name), join(output, name));
}
const packages = [];
for (const group of ["packages", "agents"]) {
  for (const name of readdirSync(join(root, group))) {
    const from = join(root, group, name);
    if (!existsSync(join(from, "package.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));
    if (!existsSync(join(from, values.entry))) {
      if (!manifest.private) throw new Error(`missing build for ${manifest.name}`);
      continue;
    }
    const destination = join(output, group, name);
    mkdirSync(destination, { recursive: true });
    copy(join(from, values.entry), join(destination, values.entry));
    if (existsSync(join(from, "node_modules"))) {
      copy(join(from, "node_modules"), join(destination, "node_modules"));
    }
    const published =
      values.entry === "dist" ? { ...manifest, ...manifest.publishConfig } : manifest;
    if (values.entry === "dist") delete published.publishConfig;
    writeFileSync(join(destination, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
    packages.push({ name: manifest.name, path: relative(output, destination) });
  }
}
const resolutions = [];
for (const item of packages) {
  const manifestPath = join(output, item.path, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const require = createRequire(manifestPath);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (!dependency.startsWith("@roll-agent/")) continue;
    const target = realpathSync(require.resolve(dependency));
    if (!target.startsWith(`${output}${sep}`) || !target.includes(`${sep}${values.entry}${sep}`)) {
      throw new Error(`${item.name} -> ${dependency} escaped published layout: ${target}`);
    }
    resolutions.push({ from: item.name, to: dependency, path: relative(output, target) });
  }
}
writeFileSync(
  join(output, "published-layout.json"),
  `${JSON.stringify({ sourceRoot: root, entry: values.entry, packages, resolutions }, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ output, packages: packages.length, resolutions: resolutions.length })}\n`,
);
