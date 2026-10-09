import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("standalone update uses the independent deadline and cleans up after timeout or connection loss", async () => {
  for (const { downloadTimeoutMs, networkFailure } of [
    { downloadTimeoutMs: undefined, networkFailure: false },
    { downloadTimeoutMs: 1_800_000, networkFailure: false },
    { downloadTimeoutMs: undefined, networkFailure: true },
  ]) {
    const home = await mkdtemp(join(tmpdir(), "roll-update-download-"));
    try {
      const config =
        "install:\n  network-timeout-ms: 10000\n" +
        (downloadTimeoutMs === undefined
          ? ""
          : "  distribution-download-timeout-ms: " + downloadTimeoutMs + "\n");
      const body = [
        "import assert from 'node:assert/strict';",
        "import { createHash } from 'node:crypto';",
        "import { writeFile, readFile, readdir } from 'node:fs/promises';",
        "import update from " + JSON.stringify(new URL("./update.ts", import.meta.url).href) + ";",
        "import { resolveExecutionEnvironment, withExecutionEnvironment } from " +
          JSON.stringify(new URL("../../execution-environment/index.ts", import.meta.url).href) +
          ";",
        'await writeFile(\'installation.json\', \'{"schemaVersion":1,"channel":"standalone"}\');',
        "await writeFile('current.txt', '1.0.0\\n');",
        "const expectedDeadline = " + (downloadTimeoutMs ?? 900_000) + ";",
        "const networkFailure = " + networkFailure + ";",
        "await writeFile('roll.config.yaml', " + JSON.stringify(config) + ");",
        "const environment = resolveExecutionEnvironment();",
        "const platform = process.platform + '-' + process.arch;",
        "const current = { ...environment, mode: 'bundled', installation: { ...environment.installation, channel: 'standalone', version: '1.0.0', installRoot: process.cwd(), platform } };",
        "const bytes = Buffer.from('archive');",
        "const manifest = { schemaVersion: 1, version: '1.0.1', nodeVersion: '24.18.0', assets: [{ platform, filename: 'roll-1.0.1-' + platform + (process.platform === 'win32' ? '.zip' : '.tar.gz'), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };",
        "const deadlines = [];",
        "const originalTimeout = AbortSignal.timeout;",
        "AbortSignal.timeout = ms => { deadlines.push(ms); return originalTimeout(ms === expectedDeadline ? 200 : ms); };",
        "globalThis.fetch = async (url, options) => {",
        "  assert.equal(new URL(String(url)).origin, 'https://roll.duliday.com');",
        "  if (String(url).endsWith('/manifest.json')) return new Response(JSON.stringify(manifest));",
        "  return new Response(new ReadableStream({ start(controller) {",
        "    controller.enqueue(bytes.subarray(0, 3));",
        "    options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });",
        "  }, pull(controller) { if (networkFailure) controller.error(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })); } }));",
        "};",
        "const keepAlive = setInterval(() => {}, 5000);",
        "try { await withExecutionEnvironment(current, () => update.run({ args: { check: false, 'skip-browser-setup': true } })); } finally { clearInterval(keepAlive); }",
        "assert.equal(deadlines.at(-1), expectedDeadline);",
        "assert.equal(deadlines.includes(10000), false);",
        "assert.equal(process.exitCode, 1);",
        "assert.equal(await readFile('current.txt', 'utf8'), '1.0.0\\n');",
        "assert.equal((await readdir('.')).some(name => name === '.install-lock' || name.startsWith('.update-')), false);",
        "process.exitCode = 0;",
      ].join("\n");
      const result = await run(
        process.execPath,
        [
          "--experimental-strip-types",
          "--experimental-sqlite",
          "--input-type=module",
          "--eval",
          body,
        ],
        {
          cwd: home,
          env: { ...process.env, HOME: home, USERPROFILE: home },
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /获取 Roll v1\.0\.1 发行信息/);
      assert.match(result.stderr, /下载 Roll v1\.0\.1.*0%/);
      if (networkFailure) {
        assert.match(
          result.stderr,
          /下载网络错误：已下载.*耗时.*other side closed.*UND_ERR_SOCKET/,
        );
        assert.doesNotMatch(result.stderr, /下载超时/);
      } else {
        assert.match(
          result.stderr,
          /下载超时：已下载.*下载时限.*install\.distribution-download-timeout-ms/,
        );
      }
      assert.doesNotMatch(result.stderr, /解压发行包|验证启动|进入更新维护阶段/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
