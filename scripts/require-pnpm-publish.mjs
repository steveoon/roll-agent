#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const userAgent = process.env["npm_config_user_agent"] ?? "";
const execPath = process.env["npm_execpath"] ?? "";
const packageJsonPath = resolve(process.cwd(), "package.json");

let packageName = "this package";
try {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
    packageName = packageJson.name;
  }
} catch {
  // Ignore and fall back to generic package label.
}

const isPnpm =
  userAgent.includes("pnpm/") ||
  execPath.includes(`${resolve("node_modules", ".bin", "pnpm")}`) ||
  execPath.includes("pnpm.cjs") ||
  execPath.includes("pnpm.js");

if (isPnpm) {
  process.exit(0);
}

console.error(`Refusing to publish ${packageName} with npm.`);
console.error("Use `pnpm publish` or the Changesets + CI release flow instead.");
console.error("This package relies on pnpm publish-time rewrites for its final npm manifest.");
process.exit(1);
