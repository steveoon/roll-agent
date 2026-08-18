import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocateOutputDumpFile,
  createOutputDumpWriter,
  isWithinOutputDumpDir,
  OUTPUT_DUMP_MAX_AGE_MS,
  OUTPUT_DUMP_MAX_FILES,
  pruneOutputDumpDir,
  rollOutputDumpDir,
  writeOutputDump,
} from "./output-dump.ts";

function tempDumpDir(): string {
  return join(mkdtempSync(join(tmpdir(), "roll-dump-")), "bash-output-dumps");
}

test("rollOutputDumpDir 位于 roll 自己的数据目录下", () => {
  const dir = rollOutputDumpDir("/home/u");
  assert.equal(dir, join("/home/u", ".roll-agent", "bash-output-dumps"));
});

test("allocate 创建 0700 目录且路径在目录内", () => {
  const dir = tempDumpDir();
  const path = allocateOutputDumpFile(dir, "bash");
  mkdirSync(dir, { recursive: true });
  const mode = statSync(dir).mode & 0o777;
  assert.equal(mode, 0o700);
  assert.ok(isWithinOutputDumpDir(path, dir));
});

test("writeOutputDump 以 0600 写盘", () => {
  const dir = tempDumpDir();
  const path = allocateOutputDumpFile(dir, "bash");
  writeOutputDump(path, "hello");
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("prune 删除超龄文件并按数量收敛", () => {
  const dir = tempDumpDir();
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const old = join(dir, "old.log");
  writeFileSync(old, "x");
  const past = (now - OUTPUT_DUMP_MAX_AGE_MS - 1_000) / 1_000;
  utimesSync(old, past, past);
  pruneOutputDumpDir(dir, now);
  assert.ok(!readdirSync(dir).includes("old.log"));

  for (let index = 0; index < OUTPUT_DUMP_MAX_FILES + 3; index += 1) {
    writeFileSync(join(dir, `f-${String(index)}.log`), "y");
  }
  pruneOutputDumpDir(dir, now);
  assert.ok(readdirSync(dir).length <= OUTPUT_DUMP_MAX_FILES);
});

test("isWithinOutputDumpDir 拒绝目录外与越界前缀", () => {
  const dir = tempDumpDir();
  assert.equal(isWithinOutputDumpDir(join(dir, "a.log"), dir), true);
  assert.equal(isWithinOutputDumpDir(join(dir, "..", "evil.log"), dir), false);
  assert.equal(isWithinOutputDumpDir(`${dir}x/evil.log`, dir), false);
});

test("createOutputDumpWriter 超过上限后停止写入", () => {
  const dir = tempDumpDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "cap.log");
  const writer = createOutputDumpWriter(path, 8);
  writer.write("1234567890");
  writer.close();
  const content = readFileSync(path, "utf8");
  assert.equal(content.length, 8);
});
