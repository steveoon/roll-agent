import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rgPath } from "@vscode/ripgrep";
import { runRg } from "./rg-exec.ts";

test(
  "Windows 深安装路径中的实际 ripgrep 可通过生产 runRg 执行",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "roll-rg-long-install-"));
    try {
      const deep = join(
        dir,
        ...Array.from({ length: 6 }, () => "中文 installed path with spaces ".repeat(2).trimEnd()),
      );
      mkdirSync(toNamespacedPath(deep), { recursive: true });
      const executable = join(deep, "rg.exe");
      assert(executable.length > 300);
      copyFileSync(rgPath, toNamespacedPath(executable));
      const packageRoot = join(dir, "node_modules/@vscode/ripgrep");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ type: "module", exports: "./index.js" }),
      );
      writeFileSync(
        join(packageRoot, "index.js"),
        `export const rgPath = ${JSON.stringify(executable)};`,
      );
      const copied = join(dir, "rg-exec.ts");
      copyFileSync(fileURLToPath(new URL("./rg-exec.ts", import.meta.url)), copied);
      const isolated: { runRg: typeof runRg } = await import(pathToFileURL(copied).href);
      writeFileSync(join(dir, "fixture.txt"), "deep-installed-rg-marker\n");
      const result = await isolated.runRg(
        ["--line-number", "deep-installed-rg-marker", "fixture.txt"],
        dir,
      );
      assert.equal(result.ok, true, result.errorMessage);
      assert.match(result.stdout, /1:deep-installed-rg-marker/u);
    } finally {
      rmSync(toNamespacedPath(dir), { recursive: true, force: true });
    }
  },
);

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

test("abort 后返回 cancelled 且不把结果当成功", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-exec-abort-"));
  writeFileSync(join(dir, "a.txt"), "hello\n", "utf8");
  const controller = new AbortController();
  controller.abort();
  const result = await runRg(["--line-number", "hello", "."], dir, {
    abortSignal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
});

test("输出超限被截断并标记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-exec-test-"));
  writeFileSync(join(dir, "big.txt"), "line\n".repeat(5000), "utf8");
  const result = await runRg(["--line-number", "line", "."], dir, { maxOutputBytes: 1024 });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 2048);
});
