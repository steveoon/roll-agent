import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatAttachmentSize,
  loadPendingAttachment,
  MAX_ATTACHMENT_BYTES,
  parsePastedImagePaths,
} from "./paste-attachments.ts";

test("parsePastedImagePaths 识别裸路径与多文件拖拽", () => {
  assert.deepEqual(parsePastedImagePaths("/tmp/a.png"), ["/tmp/a.png"]);
  assert.deepEqual(parsePastedImagePaths("/tmp/a.png /tmp/b.jpeg\n/tmp/c.webp"), [
    "/tmp/a.png",
    "/tmp/b.jpeg",
    "/tmp/c.webp",
  ]);
});

test("parsePastedImagePaths 识别 shell 转义空格与引号包裹", () => {
  assert.deepEqual(parsePastedImagePaths("/tmp/My\\ Shot.png"), ["/tmp/My Shot.png"]);
  assert.deepEqual(parsePastedImagePaths("'/tmp/My Shot.png' \"/tmp/b 2.gif\""), [
    "/tmp/My Shot.png",
    "/tmp/b 2.gif",
  ]);
});

test("parsePastedImagePaths 识别 file:// URL 并解码", () => {
  const url = pathToFileURL("/tmp/截图 1.png").href;
  assert.deepEqual(parsePastedImagePaths(url), ["/tmp/截图 1.png"]);
});

test("parsePastedImagePaths 展开 ~ 前缀", () => {
  const [expanded] = parsePastedImagePaths("~/shot.png") ?? [];
  assert.ok(expanded !== undefined && expanded.endsWith("/shot.png") && !expanded.startsWith("~"));
});

test("parsePastedImagePaths 对普通文本与非图像路径返回 undefined", () => {
  assert.equal(parsePastedImagePaths("你好，帮我看下这个"), undefined);
  assert.equal(parsePastedImagePaths("/tmp/notes.txt"), undefined);
  assert.equal(parsePastedImagePaths("/tmp/a.png /tmp/notes.txt"), undefined);
  assert.equal(parsePastedImagePaths("   "), undefined);
  assert.equal(parsePastedImagePaths("png"), undefined);
});

test("loadPendingAttachment 读取真实文件并产出 base64", () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-paste-"));
  try {
    const path = join(dir, "shot.png");
    writeFileSync(path, Buffer.from("hello"));
    const result = loadPendingAttachment(path);
    assert.ok(result.ok);
    assert.equal(result.attachment.name, "shot.png");
    assert.equal(result.attachment.mediaType, "image/png");
    assert.equal(result.attachment.data, Buffer.from("hello").toString("base64"));
    assert.equal(result.attachment.sizeLabel, "5B");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPendingAttachment 拒绝缺失文件与超限文件", () => {
  const missing = loadPendingAttachment("/nonexistent/shot.png");
  assert.equal(missing.ok, false);
  assert.match((missing as { message: string }).message, /不存在或不可读/u);

  const dir = mkdtempSync(join(tmpdir(), "roll-paste-"));
  try {
    const path = join(dir, "big.jpg");
    writeFileSync(path, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    const tooLarge = loadPendingAttachment(path);
    assert.equal(tooLarge.ok, false);
    assert.match((tooLarge as { message: string }).message, /超过.*上限/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatAttachmentSize 输出人类可读大小", () => {
  assert.equal(formatAttachmentSize(512), "512B");
  assert.equal(formatAttachmentSize(118 * 1024), "118KB");
  assert.equal(formatAttachmentSize(2.15 * 1024 * 1024), "2.1MB");
});

test("parsePastedImagePaths 不把相对路径 resolve 到 cwd", () => {
  assert.equal(parsePastedImagePaths("logo.png"), undefined);
  assert.equal(parsePastedImagePaths("images/logo.png"), undefined);
  assert.equal(parsePastedImagePaths("./logo.png"), undefined);
});
