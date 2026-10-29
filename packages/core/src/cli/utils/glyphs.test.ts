import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const TERMINAL_ENV_KEYS = [
  "WT_SESSION",
  "TERMINUS_SUBLIME",
  "ConEmuTask",
  "TERM_PROGRAM",
  "TERM",
  "TERMINAL_EMULATOR",
] as const;

test("Fast glyph uses Unicode in modern Windows terminals and ASCII in legacy consoles", () => {
  const inheritedEnv = { ...process.env };
  for (const key of TERMINAL_ENV_KEYS) delete inheritedEnv[key];
  for (const terminal of [
    { env: { WT_SESSION: "test-session" }, fast: "⚡" },
    { env: { TERM_PROGRAM: "vscode" }, fast: "⚡" },
    { env: { CI: "true" }, fast: ">>" },
  ]) {
    // Isolate platform and module initialization; never change the test runner's globals.
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `Object.defineProperty(process, "platform", { value: "win32" });
         const { GLYPHS } = await import(${JSON.stringify(new URL("./glyphs.ts", import.meta.url).href)});
         process.stdout.write(JSON.stringify(GLYPHS));`,
      ],
      { encoding: "utf8", env: { ...inheritedEnv, ...terminal.env } },
    );
    const glyphs: unknown = JSON.parse(output);
    assert.ok(glyphs !== null && typeof glyphs === "object" && "fast" in glyphs);
    assert.equal(glyphs.fast, terminal.fast);
    if (terminal.fast === ">>") assert.match(output, /^[\x20-\x7e]+$/);
  }
});
