import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_CONTAINMENT_DRIFT_MESSAGE,
  captureFilePathAdmission,
  escapesWorkdir,
  formatPathForApproval,
  loadImageFile,
  loadTextFile,
  resolveFilePath,
  revalidateFilePathAdmission,
  saveTextFile,
  sniffImageMediaType,
  splitUtf8Bom,
} from "./file-io.ts";

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
  writeFileSync(path, "\uFEFF内容", "utf8");
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

test("loadTextFile 二进制判定消息指明 U+0000", () => {
  const dir = tempDir();
  const bin = join(dir, "nul.dat");
  writeFileSync(bin, Buffer.from([0x61, 0x00, 0x62]));
  const loaded = loadTextFile(bin, LIMITS);
  assert.ok(!loaded.ok && loaded.code === "binary");
  assert.match(loaded.message, /U\+0000/u);
  assert.match(loaded.message, /shell/u);
});

test("loadTextFile 扫描整个文件：NUL 位于 8192 字节之后仍判定二进制", () => {
  const dir = tempDir();
  const path = join(dir, "late-nul.txt");
  const prefix = Buffer.alloc(8192 + 1, 0x61);
  writeFileSync(path, Buffer.concat([prefix, Buffer.from([0x00, 0x62])]));
  const loaded = loadTextFile(path, LIMITS);
  assert.ok(!loaded.ok && loaded.code === "binary");
  const lastByte = join(dir, "last-byte-nul.txt");
  writeFileSync(lastByte, Buffer.concat([Buffer.alloc(20000, 0x61), Buffer.from([0x00])]));
  const lastLoaded = loadTextFile(lastByte, LIMITS);
  assert.ok(!lastLoaded.ok && lastLoaded.code === "binary");
});

test("loadTextFile 放行 ESC/FF/VT/DEL 等非 NUL 控制字符（ANSI 日志可读）", () => {
  const dir = tempDir();
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["esc", 0x1b],
    ["ff", 0x0c],
    ["vt", 0x0b],
    ["del", 0x7f],
    ["bs", 0x08],
    ["us", 0x1f],
  ];
  for (const [name, code] of cases) {
    const path = join(dir, `${name}.txt`);
    writeFileSync(path, Buffer.from([0x61, code, 0x62]));
    const loaded = loadTextFile(path, LIMITS);
    assert.ok(loaded.ok, `U+${code.toString(16)} 应可读`);
    assert.equal(loaded.content, `a${String.fromCharCode(code)}b`);
  }
  const ansi = join(dir, "ansi.log");
  const ansiText = "\u001b[32mok\u001b[0m\npage 2\n";
  writeFileSync(ansi, ansiText, "utf8");
  const ansiLoaded = loadTextFile(ansi, LIMITS);
  assert.ok(ansiLoaded.ok);
  assert.equal(ansiLoaded.content, ansiText);
});

test("loadTextFile 放行 TAB 与 CRLF 文本", () => {
  const dir = tempDir();
  const path = join(dir, "tabs.txt");
  writeFileSync(path, "a\tb\r\nc\r\n", "utf8");
  const loaded = loadTextFile(path, LIMITS);
  assert.ok(loaded.ok);
});

test("splitUtf8Bom 剥离首个 BOM 并标记，非首位 BOM 保留", () => {
  assert.deepEqual(splitUtf8Bom("\uFEFF内容"), { content: "内容", hadBom: true });
  assert.deepEqual(splitUtf8Bom("内容"), { content: "内容", hadBom: false });
  assert.deepEqual(splitUtf8Bom("a\uFEFFb"), { content: "a\uFEFFb", hadBom: false });
  assert.deepEqual(splitUtf8Bom(""), { content: "", hadBom: false });
});

test("saveTextFile 自动建父目录并按需还原 BOM", () => {
  const dir = tempDir();
  const nested = join(dir, "sub", "deep", "out.txt");
  saveTextFile(nested, "内容", true);
  assert.equal(readFileSync(nested, "utf8"), "\uFEFF内容");
});

test("symlink 目录下新建文件判定为 external", () => {
  const workdir = realpathSync(tempDir());
  const outside = realpathSync(tempDir());
  symlinkSync(outside, join(workdir, "out"));
  assert.equal(escapesWorkdir(workdir, "out/secret.txt"), true);
  assert.equal(escapesWorkdir(workdir, "inside.txt"), false);
  assert.equal(
    formatPathForApproval(workdir, "out/secret.txt"),
    `${join(outside, "secret.txt")}（工作目录外）`,
  );
});

test("断链目标判定为 external", () => {
  const workdir = realpathSync(tempDir());
  symlinkSync(join(workdir, "missing-target"), join(workdir, "broken"));
  assert.equal(escapesWorkdir(workdir, "broken"), true);
  assert.equal(escapesWorkdir(workdir, "broken/secret.txt"), true);
});

test("lexical workdir 下新建文件判定为 workdir 内", () => {
  const root = realpathSync(tempDir());
  const real = join(root, "real");
  mkdirSync(real);
  const lexical = join(root, "link");
  symlinkSync(real, lexical);
  assert.notEqual(lexical, realpathSync(lexical));
  assert.equal(escapesWorkdir(lexical, "new.txt"), false);
  assert.equal(escapesWorkdir(lexical, join("nested", "new.txt")), false);
});

test("名为 ..cache 的目录判定为 workdir 内", () => {
  const workdir = realpathSync(tempDir());
  mkdirSync(join(workdir, "..cache"));
  writeFileSync(join(workdir, "..cache", "a.txt"), "x", "utf8");
  assert.equal(escapesWorkdir(workdir, "..cache"), false);
  assert.equal(escapesWorkdir(workdir, join("..cache", "a.txt")), false);
  assert.equal(escapesWorkdir(workdir, join("..cache", "new.txt")), false);
});

test("准入后父目录换成越界 symlink 时 revalidate 阻止", () => {
  const workdir = realpathSync(tempDir());
  const outside = realpathSync(tempDir());
  mkdirSync(join(workdir, "out"));
  const captured = captureFilePathAdmission(workdir, join("out", "secret.txt"));
  assert.equal(captured.admittedExternal, false);
  rmSync(join(workdir, "out"), { recursive: true, force: true });
  symlinkSync(outside, join(workdir, "out"));
  const blocked = revalidateFilePathAdmission(workdir, join("out", "secret.txt"), captured);
  assert.ok(blocked !== undefined);
  assert.equal(blocked.outcome.kind, "tool_failed");
  assert.equal(String(blocked.display), FILE_CONTAINMENT_DRIFT_MESSAGE);
});

test("准入后 external symlink 改指向另一外部目录时 revalidate 阻止", () => {
  const workdir = realpathSync(tempDir());
  const outsideA = realpathSync(tempDir());
  const outsideB = realpathSync(tempDir());
  symlinkSync(outsideA, join(workdir, "out"));
  const captured = captureFilePathAdmission(workdir, join("out", "secret.txt"));
  assert.equal(captured.admittedExternal, true);
  assert.equal(captured.admittedTarget, join(outsideA, "secret.txt"));
  assert.equal(
    revalidateFilePathAdmission(workdir, join("out", "secret.txt"), captured),
    undefined,
  );
  rmSync(join(workdir, "out"));
  symlinkSync(outsideB, join(workdir, "out"));
  const blocked = revalidateFilePathAdmission(workdir, join("out", "secret.txt"), captured);
  assert.ok(blocked !== undefined);
  assert.equal(blocked.outcome.kind, "tool_failed");
});

test("准入后目标未变时 revalidate 放行（含文件在此期间被创建）", () => {
  const workdir = realpathSync(tempDir());
  const captured = captureFilePathAdmission(workdir, join("nested", "new.txt"));
  assert.equal(captured.admittedExternal, false);
  assert.equal(captured.admittedTarget, join(workdir, "nested", "new.txt"));
  mkdirSync(join(workdir, "nested"));
  writeFileSync(join(workdir, "nested", "new.txt"), "created meanwhile", "utf8");
  assert.equal(
    revalidateFilePathAdmission(workdir, join("nested", "new.txt"), captured),
    undefined,
  );
});

test("loadTextFile 拒绝非普通文件", (t) => {
  const workdir = realpathSync(tempDir());
  const fifo = join(workdir, "pipe.fifo");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    t.skip("mkfifo 不可用");
    return;
  }
  const loaded = loadTextFile(fifo, LIMITS);
  assert.ok(!loaded.ok && loaded.code === "not-regular-file");
});

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

test("sniffImageMediaType 通过 magic bytes 识别四种图像格式", () => {
  assert.equal(sniffImageMediaType(PNG_HEADER), "image/png");
  assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageMediaType(Buffer.from("GIF89a")), "image/gif");
  assert.equal(sniffImageMediaType(Buffer.from("GIF87a")), "image/gif");
  assert.equal(sniffImageMediaType(Buffer.from("RIFF\x10\x00\x00\x00WEBP")), "image/webp");
});

test("sniffImageMediaType 对非图像内容返回 undefined", () => {
  assert.equal(sniffImageMediaType(Buffer.from("hello world")), undefined);
  assert.equal(sniffImageMediaType(Buffer.from("GIF9")), undefined);
  assert.equal(sniffImageMediaType(Buffer.from("RIFF\x10\x00\x00\x00WAVE")), undefined);
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), undefined);
  assert.equal(sniffImageMediaType(PNG_HEADER.subarray(0, 4)), undefined);
});

test("loadImageFile 读取真实 PNG 返回 base64 与 mediaType", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-io-image-"));
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const path = join(dir, "one.png");
  writeFileSync(path, Buffer.from(pngBase64, "base64"));
  const loaded = loadImageFile(path, { maxImageBytes: 1024 });
  assert.ok(loaded !== undefined && loaded.ok);
  assert.equal(loaded.mediaType, "image/png");
  assert.equal(loaded.base64, pngBase64);
});

test("loadImageFile 对不含 NUL 的图像签名文本返回 undefined（不劫持文本文件）", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-io-image-"));
  const path = join(dir, "gif-notes.txt");
  writeFileSync(path, "GIF89a 是 GIF 格式的版本标识\n第二行说明", "utf8");
  assert.equal(loadImageFile(path, { maxImageBytes: 1024 }), undefined);
});

test("loadImageFile 拒绝缺少格式结尾标记的截断图像", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-io-image-"));
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const fullPng = Buffer.from(pngBase64, "base64");
  const truncatedPng = join(dir, "truncated.png");
  writeFileSync(truncatedPng, fullPng.subarray(0, fullPng.length - 8));
  const pngResult = loadImageFile(truncatedPng, { maxImageBytes: 1024 });
  assert.ok(pngResult !== undefined && !pngResult.ok);
  assert.equal(pngResult.code, "corrupt-image");

  const truncatedJpeg = join(dir, "truncated.jpg");
  writeFileSync(truncatedJpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xaa, 0xbb]));
  const jpegResult = loadImageFile(truncatedJpeg, { maxImageBytes: 1024 });
  assert.ok(jpegResult !== undefined && !jpegResult.ok);
  assert.equal(jpegResult.code, "corrupt-image");

  const truncatedGif = join(dir, "truncated.gif");
  writeFileSync(
    truncatedGif,
    Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00])]),
  );
  const gifResult = loadImageFile(truncatedGif, { maxImageBytes: 1024 });
  assert.ok(gifResult !== undefined && !gifResult.ok);
  assert.equal(gifResult.code, "corrupt-image");

  const truncatedWebp = join(dir, "truncated.webp");
  const webpHeader = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  webpHeader.writeUInt32LE(200, 4);
  writeFileSync(truncatedWebp, Buffer.concat([webpHeader, Buffer.from([0x00, 0x01])]));
  const webpResult = loadImageFile(truncatedWebp, { maxImageBytes: 1024 });
  assert.ok(webpResult !== undefined && !webpResult.ok);
  assert.equal(webpResult.code, "corrupt-image");
});

test("loadImageFile 接受结构完整的 JPEG/GIF/WebP 最小样例", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-io-image-"));
  const jpegPath = join(dir, "ok.jpg");
  writeFileSync(
    jpegPath,
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xaa, 0xbb, 0xff, 0xd9]),
  );
  const jpeg = loadImageFile(jpegPath, { maxImageBytes: 1024 });
  assert.ok(jpeg !== undefined && jpeg.ok);
  assert.equal(jpeg.mediaType, "image/jpeg");

  const gifPath = join(dir, "ok.gif");
  writeFileSync(
    gifPath,
    Buffer.concat([
      Buffer.from("GIF89a"),
      Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]),
    ]),
  );
  const gif = loadImageFile(gifPath, { maxImageBytes: 1024 });
  assert.ok(gif !== undefined && gif.ok);
  assert.equal(gif.mediaType, "image/gif");

  const webpPath = join(dir, "ok.webp");
  const webpBody = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const webpHeader = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  webpHeader.writeUInt32LE(4 + webpBody.length, 4);
  writeFileSync(webpPath, Buffer.concat([webpHeader, webpBody]));
  const webp = loadImageFile(webpPath, { maxImageBytes: 1024 });
  assert.ok(webp !== undefined && webp.ok);
  assert.equal(webp.mediaType, "image/webp");
});

test("loadImageFile 对非图像文件返回 undefined，对超限图像返回 too-large", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-io-image-"));
  const textPath = join(dir, "plain.txt");
  writeFileSync(textPath, "not an image", "utf8");
  assert.equal(loadImageFile(textPath, { maxImageBytes: 1024 }), undefined);
  assert.equal(loadImageFile(join(dir, "missing.png"), { maxImageBytes: 1024 }), undefined);
  const pngPath = join(dir, "big.png");
  writeFileSync(
    pngPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const tooLarge = loadImageFile(pngPath, { maxImageBytes: 16 });
  assert.ok(tooLarge !== undefined && !tooLarge.ok);
  assert.equal(tooLarge.code, "too-large");
});
