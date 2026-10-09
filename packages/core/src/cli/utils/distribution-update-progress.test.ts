import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DistributionDownloadNetworkError,
  DistributionDownloadTimeoutError,
} from "../../execution-environment/distribution.ts";
import {
  createDistributionUpdateReporter,
  formatDistributionDownloadProgress,
  formatDistributionDownloadTimeout,
  formatDistributionDownloadNetworkError,
} from "./distribution-update-progress.ts";

const MIB = 1024 * 1024;

test("download progress formats bytes, percentage, average speed and remaining time", () => {
  assert.equal(
    formatDistributionDownloadProgress("1.0.1", {
      downloadedBytes: 40 * MIB,
      totalBytes: 80 * MIB,
      elapsedMs: 40_000,
    }),
    "下载 Roll v1.0.1：40.0 / 80.0 MiB（50%），1.0 MiB/s，预计剩余 40 秒",
  );
  assert.match(
    formatDistributionDownloadProgress("1.0.1", {
      downloadedBytes: 40 * MIB,
      totalBytes: 880 * MIB,
      elapsedMs: 40_000,
    }),
    /预计剩余 约 14 分钟/,
  );
  assert.match(
    formatDistributionDownloadProgress("1.0.1", {
      downloadedBytes: 0,
      totalBytes: 80 * MIB,
      elapsedMs: 0,
    }),
    /0%.*0 KiB\/s.*估算中/,
  );
  assert.match(
    formatDistributionDownloadProgress("1.0.1", {
      downloadedBytes: 80 * MIB,
      totalBytes: 80 * MIB,
      elapsedMs: 160_000,
    }),
    /100%.*512 KiB\/s.*剩余 0 秒/,
  );
});

test("non-TTY progress is periodic, announces phases and stops after disposal", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const lines: string[] = [];
  const reporter = createDistributionUpdateReporter("1.0.1", {
    isTTY: false,
    now: () => Date.now(),
    write: (text) => lines.push(text),
  });
  t.after(reporter.stop);
  reporter.onEvent({
    phase: "download",
    progress: { downloadedBytes: 0, totalBytes: 80 * MIB, elapsedMs: 0 },
  });
  reporter.onEvent({
    phase: "download",
    progress: { downloadedBytes: 40 * MIB, totalBytes: 80 * MIB, elapsedMs: 40_000 },
  });
  t.mock.timers.tick(4999);
  assert.equal(lines.length, 2, "chunk notifications must not flood non-TTY logs");
  t.mock.timers.tick(1);
  assert.match(lines.at(-1)!, /50%.*910 KiB\/s.*剩余 45 秒/);
  reporter.onEvent({
    phase: "download",
    progress: { downloadedBytes: 80 * MIB, totalBytes: 80 * MIB, elapsedMs: 80_000 },
  });
  assert.match(lines.at(-1)!, /100%/);
  for (const phase of ["verify", "extract", "check"] as const) reporter.onEvent({ phase });
  assert.deepEqual(lines.slice(-3), [
    "校验发行包 Roll v1.0.1...",
    "解压发行包 Roll v1.0.1...",
    "验证启动 Roll v1.0.1...",
  ]);
  const count = lines.length;
  t.mock.timers.tick(10_000);
  assert.equal(lines.length, count, "phase change must stop the download timer");
  reporter.stop();
  reporter.onEvent({
    phase: "download",
    progress: { downloadedBytes: 0, totalBytes: MIB, elapsedMs: 0 },
  });
  t.mock.timers.tick(10_000);
  assert.equal(lines.length, count);
});

test("TTY progress refreshes once a second and failure stops subsequent updates", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const spinner = {
    text: "",
    start() {
      return this;
    },
    succeed() {
      return this;
    },
    fail() {
      return this;
    },
    stop() {
      return this;
    },
  };
  const reporter = createDistributionUpdateReporter("1.0.1", {
    isTTY: true,
    now: () => Date.now(),
    spinner,
  });
  t.after(reporter.stop);
  reporter.onEvent({
    phase: "download",
    progress: { downloadedBytes: MIB, totalBytes: 2 * MIB, elapsedMs: 1000 },
  });
  assert.match(spinner.text, /1.0 MiB\/s/);
  t.mock.timers.tick(999);
  assert.match(spinner.text, /1.0 MiB\/s/);
  t.mock.timers.tick(1);
  assert.match(spinner.text, /512 KiB\/s.*剩余 2 秒/);
  reporter.fail("failed");
  const text = spinner.text;
  t.mock.timers.tick(10_000);
  reporter.onEvent({ phase: "check" });
  assert.equal(spinner.text, text);
});

test("timeout diagnostics include transferred bytes, elapsed time and the configuration key", () => {
  const error = new DistributionDownloadTimeoutError(
    { downloadedBytes: 65 * MIB, totalBytes: 70 * MIB, elapsedMs: 120_004 },
    120_000,
    new Error("timeout"),
  );
  assert.equal(
    formatDistributionDownloadTimeout(error),
    "下载超时：已下载 65.0 / 70.0 MiB，耗时 120 秒（下载时限 120 秒）。可调大 install.distribution-download-timeout-ms 后重试。",
  );
});

test("zero-byte timeout suggests checking connectivity instead of extending the deadline", () => {
  const text = formatDistributionDownloadTimeout(
    new DistributionDownloadTimeoutError(
      { downloadedBytes: 0, totalBytes: 70 * MIB, elapsedMs: 900_000 },
      900_000,
      new Error("timeout"),
    ),
  );
  assert.match(text, /尚未收到发行包数据.*网络、代理/);
  assert.doesNotMatch(text, /调大/);
});

test("network diagnostics surface transport causes and error codes with download progress", () => {
  for (const code of ["UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]) {
    const reason = Object.assign(new Error("transport failure"), { code });
    const text = formatDistributionDownloadNetworkError(
      new DistributionDownloadNetworkError(
        { downloadedBytes: 3 * MIB, totalBytes: 70 * MIB, elapsedMs: 302_000 },
        new TypeError("terminated", { cause: reason }),
      ),
    );
    assert.match(text, /已下载 3\.0 \/ 70\.0 MiB，耗时 302 秒/);
    assert.ok(text.includes(`transport failure（${code}）`));
    assert.match(text, /检查网络、代理/);
    assert.doesNotMatch(text, /调大/);
  }
});

test("TTY environments with disabled animation still print periodic progress", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const lines: string[] = [];
  const spinner = {
    text: "",
    isEnabled: false,
    start() {
      assert.fail("disabled spinner should use text output");
    },
    succeed() {},
    fail() {},
    stop() {},
  };
  const reporter = createDistributionUpdateReporter("1.0.1", {
    isTTY: true,
    spinner,
    now: () => Date.now(),
    write: (text) => lines.push(text),
  });
  t.after(reporter.stop);
  reporter.onEvent({
    phase: "download",
    progress: { downloadedBytes: MIB, totalBytes: 2 * MIB, elapsedMs: 1000 },
  });
  t.mock.timers.tick(5000);
  assert.equal(lines.length, 3);
  assert.match(lines.at(-1)!, /50%/);
  reporter.stop();
});
