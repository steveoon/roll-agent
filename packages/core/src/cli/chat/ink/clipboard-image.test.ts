import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClipboardScriptOutput } from "./clipboard-image.ts";

test("parseClipboardScriptOutput 解析文件引用输出", () => {
  assert.deepEqual(parseClipboardScriptOutput("FILE:/tmp/截图 1.png\n"), {
    kind: "file",
    path: "/tmp/截图 1.png",
  });
  assert.deepEqual(parseClipboardScriptOutput("FILE:"), { kind: "none" });
});

test("parseClipboardScriptOutput 解析 PNGf hex 数据为 base64", () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const output = `«data PNGf${pngBytes.toString("hex").toUpperCase()}»\n`;
  assert.deepEqual(parseClipboardScriptOutput(output), {
    kind: "image",
    data: pngBytes.toString("base64"),
    mediaType: "image/png",
  });
});

test("parseClipboardScriptOutput 拒绝畸形 hex 并识别无图输出", () => {
  assert.deepEqual(parseClipboardScriptOutput("«data PNGfZZZZ»"), {
    kind: "error",
    message: "剪贴板图像数据无法解析",
  });
  assert.deepEqual(parseClipboardScriptOutput("«data PNGf123»"), {
    kind: "error",
    message: "剪贴板图像数据无法解析",
  });
  assert.deepEqual(parseClipboardScriptOutput("NONE\n"), { kind: "none" });
  assert.deepEqual(parseClipboardScriptOutput(""), { kind: "none" });
});

test("parseClipboardScriptOutput 拒绝非绝对路径的文件输出", () => {
  assert.deepEqual(parseClipboardScriptOutput("FILE:÷ª乱码相对路径"), { kind: "none" });
});
