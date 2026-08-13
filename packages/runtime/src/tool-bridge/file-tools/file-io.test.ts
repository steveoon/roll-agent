import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTextFile, resolveFilePath, saveTextFile } from "./file-io.ts";

const LIMITS = { maxFileBytes: 1024 * 1024 };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "file-io-test-"));
}

test("resolveFilePath 相对路径基于 workdir 解析", () => {
  assert.equal(resolveFilePath("/base", "a/b.txt"), "/base/a/b.txt");
  assert.equal(resolveFilePath("/base", "/abs/c.txt"), "/abs/c.txt");
});

test("loadTextFile 读取 UTF-8 内容", () => {
  const dir = tempDir();
  const path = join(dir, "a.txt");
  writeFileSync(path, "你好\n世界", "utf8");
  const loaded = loadTextFile(path, LIMITS);
  assert.ok(loaded.ok);
  assert.equal(loaded.content, "你好\n世界");
  assert.equal(loaded.hadBom, false);
});

test("loadTextFile 剥离 BOM 并标记", () => {
  const dir = tempDir();
  const path = join(dir, "bom.txt");
  writeFileSync(path, "﻿内容", "utf8");
  const loaded = loadTextFile(path, LIMITS);
  assert.ok(loaded.ok);
  assert.equal(loaded.content, "内容");
  assert.equal(loaded.hadBom, true);
});

test("loadTextFile 拒绝不存在的路径与目录", () => {
  const dir = tempDir();
  const missing = loadTextFile(join(dir, "nope.txt"), LIMITS);
  assert.ok(!missing.ok && missing.code === "not-found");
  const directory = loadTextFile(dir, LIMITS);
  assert.ok(!directory.ok && directory.code === "is-directory");
});

test("loadTextFile 拒绝超大文件与二进制文件", () => {
  const dir = tempDir();
  const big = join(dir, "big.txt");
  writeFileSync(big, "x".repeat(64), "utf8");
  const tooLarge = loadTextFile(big, { maxFileBytes: 16 });
  assert.ok(!tooLarge.ok && tooLarge.code === "too-large");
  const bin = join(dir, "bin.dat");
  writeFileSync(bin, Buffer.from([0x61, 0x00, 0x62]));
  const binary = loadTextFile(bin, LIMITS);
  assert.ok(!binary.ok && binary.code === "binary");
});

test("saveTextFile 自动建父目录并按需还原 BOM", () => {
  const dir = tempDir();
  const nested = join(dir, "sub", "deep", "out.txt");
  saveTextFile(nested, "内容", true);
  assert.equal(readFileSync(nested, "utf8"), "﻿内容");
});
