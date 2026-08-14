import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRg } from "./rg-exec.ts";

test("有命中返回 stdout，无命中返回空且 ok", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-exec-test-"));
  writeFileSync(join(dir, "a.txt"), "hello roll\n", "utf8");
  const hit = await runRg(["--line-number", "roll", "."], dir);
  assert.equal(hit.ok, true);
  assert.match(hit.stdout, /a\.txt/u);
  const miss = await runRg(["--line-number", "nomatch_zzz", "."], dir);
  assert.equal(miss.ok, true);
  assert.equal(miss.stdout, "");
});

test("非法正则返回 ok:false 与错误信息", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-exec-test-"));
  const result = await runRg(["--line-number", "([unclosed", "."], dir);
  assert.equal(result.ok, false);
  assert.ok(result.errorMessage !== undefined && result.errorMessage.length > 0);
});

test("输出超限被截断并标记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-exec-test-"));
  writeFileSync(join(dir, "big.txt"), "line\n".repeat(5000), "utf8");
  const result = await runRg(["--line-number", "line", "."], dir, { maxOutputBytes: 1024 });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 2048);
});
