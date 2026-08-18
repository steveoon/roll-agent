#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const DEFAULT_ROOTS = ["agents", "benchmarks", "examples", "packages", "scripts"];
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
  "outputs",
  "tmp",
]);
const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
]);

// Raw C0 control characters (everything below TAB, plus VT, FF, the upper C0
// block and DEL) never belong in source files. This guard itself compares code
// points numerically so its own source stays free of raw control bytes, and
// escapes written as plain text (backslash + "u0000") are ordinary ASCII that
// passes.
function isRawControlCode(code) {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f
  );
}

export function findControlCharViolations(text) {
  const violations = [];
  let lineNumber = 1;
  let lineStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      lineNumber += 1;
      lineStart = index + 1;
      continue;
    }
    if (isRawControlCode(code)) {
      violations.push({ line: lineNumber, column: index - lineStart + 1, codePoint: code });
    }
  }

  return violations;
}

export async function scanDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const findings = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        findings.push(...(await scanDirectory(path)));
      }
      continue;
    }

    if (entry.isFile() && SCANNED_EXTENSIONS.has(extname(entry.name))) {
      const text = await readFile(path, "utf8");
      for (const violation of findControlCharViolations(text)) {
        findings.push({ file: relative(repoRoot, path), ...violation });
      }
    }
  }

  return findings;
}

function formatCodePoint(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

async function main() {
  const roots =
    process.argv.length > 2
      ? process.argv.slice(2).map((root) => resolve(root))
      : DEFAULT_ROOTS.map((root) => resolve(repoRoot, root));
  const findings = [];

  for (const root of roots) {
    findings.push(...(await scanDirectory(root)));
  }

  if (findings.length > 0) {
    console.error("Raw control characters found in source files:");
    for (const finding of findings) {
      console.error(
        `- ${finding.file}:${finding.line}:${finding.column} ${formatCodePoint(finding.codePoint)}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log("Source control-char guard OK");
}

const entryPointUrl =
  process.argv[1] !== undefined ? pathToFileURL(process.argv[1]).href : undefined;

if (import.meta.url === entryPointUrl) {
  main().catch((error) => {
    console.error("check-source-control-chars.mjs failed:", error);
    process.exit(1);
  });
}
