import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonFile } from "./json-file.ts";

test("readJsonFile parses plain UTF-8 JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-json-"));
  try {
    const filePath = join(dir, "package.json");
    writeFileSync(filePath, JSON.stringify({ name: "示例", version: "1.0.0" }), "utf-8");
    assert.deepEqual(readJsonFile(filePath), { name: "示例", version: "1.0.0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonFile tolerates a UTF-8 BOM prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-json-"));
  try {
    const filePath = join(dir, "package.json");
    writeFileSync(filePath, `\uFEFF${JSON.stringify({ rollAgent: { runtime: {} } })}`, "utf-8");
    assert.deepEqual(readJsonFile(filePath), { rollAgent: { runtime: {} } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
