import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { findControlCharViolations, scanDirectory } from "./check-source-control-chars.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./check-source-control-chars.mjs", import.meta.url));

// Built from code points so this test source never contains raw control bytes.
const NUL = String.fromCharCode(0x00);
const VT = String.fromCharCode(0x0b);
const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const TAB = String.fromCharCode(0x09);
const BACKSLASH = String.fromCharCode(0x5c);

describe("source control-char guard", () => {
  it("flags raw NUL and other C0 controls with line and column", () => {
    const text = `const ok = 1;${LF}const bad = "${NUL}";${LF}const vt = "${VT}";${LF}`;

    const violations = findControlCharViolations(text);

    assert.deepEqual(
      violations.map((violation) => [violation.line, violation.codePoint]),
      [
        [2, 0x00],
        [3, 0x0b],
      ],
    );
    assert.equal(violations[0].column, text.split(LF)[1].indexOf(NUL) + 1);
  });

  it("accepts escapes written as text and ordinary whitespace", () => {
    const lines = [
      `const a = "${BACKSLASH}u0000";`,
      `${TAB}const b = 1;${CR}`,
      `const c = "${BACKSLASH}x0b";`,
    ];
    const text = lines.join(LF) + LF;

    assert.deepEqual(findControlCharViolations(text), []);
  });

  it("scans directories recursively and skips node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-chars-scan-"));
    try {
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, "node_modules", "pkg", "bad.ts"), `export const x = "${NUL}";`);
      await writeFile(join(root, "clean.ts"), "export const a = 1;");
      await writeFile(join(root, "nested", "bad.mjs"), `line1${LF}line2${NUL}${LF}`);
      await writeFile(join(root, "nested", "bad.tsx"), `export const x = "${NUL}";`);

      const findings = await scanDirectory(root);

      assert.equal(findings.length, 2);
      assert.ok(findings.some((finding) => finding.file.endsWith("bad.tsx")));
      const mjsFinding = findings.find((finding) => finding.file.endsWith("bad.mjs"));
      assert.ok(mjsFinding);
      assert.equal(mjsFinding.line, 2);
      assert.equal(mjsFinding.codePoint, 0x00);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("CLI exits zero on a clean root and non-zero on a dirty root", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-chars-cli-"));
    try {
      await writeFile(join(root, "clean.ts"), "export const a = 1;");
      const clean = await execFileAsync(process.execPath, [scriptPath, root]);
      assert.match(clean.stdout, /OK/);

      await writeFile(join(root, "bad.ts"), `export const x = "${NUL}";`);
      await assert.rejects(
        execFileAsync(process.execPath, [scriptPath, root]),
        (error) =>
          error.code === 1 && error.stderr.includes("bad.ts:1:") && error.stderr.includes("U+0000"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
