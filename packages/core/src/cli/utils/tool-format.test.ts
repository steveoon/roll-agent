import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToolInput, formatApprovalDetails } from "./tool-format.ts";

test("formatToolInput 截断超长输入到 80 字符", () => {
  const long = "x".repeat(200);
  const out = formatToolInput({ command: long });
  assert.ok(out.length <= 80);
  assert.ok(out.endsWith("…"));
});

test("formatApprovalDetails 完整展示 bash 的 command/workdir/timeout（不截断）", () => {
  const command = `for f in $(ls); do echo "processing ${"very-long-name".repeat(10)} $f"; done`;
  const details = formatApprovalDetails({ command, workdir: "/srv/app", timeout_ms: 30_000 });
  assert.ok(details.includes(command), "完整命令必须可见，不能被截断");
  assert.ok(details.includes("workdir: /srv/app"));
  assert.ok(details.includes("timeout_ms: 30000"));
});

test("formatApprovalDetails 逐字段换行", () => {
  const details = formatApprovalDetails({ command: "ls", workdir: "/tmp", timeout_ms: 10_000 });
  assert.deepEqual(details.split("\n"), ["command: ls", "workdir: /tmp", "timeout_ms: 10000"]);
});

test("formatApprovalDetails 空对象返回空串", () => {
  assert.equal(formatApprovalDetails({}), "");
});

test("formatApprovalDetails 对敏感 key 仍做脱敏", () => {
  const details = formatApprovalDetails({ command: "deploy", apiKey: "secret-value-123" });
  assert.ok(details.includes("command: deploy"));
  assert.ok(!details.includes("secret-value-123"));
});

test("formatApprovalDetails 剥除 ANSI/控制字符防审批框欺骗", () => {
  const esc = String.fromCharCode(27);
  const spoof = `rm -rf /${esc}[2K${esc}[1Aecho safe\r`;
  const details = formatApprovalDetails({ command: spoof });
  assert.ok(!details.includes(esc), "ESC 必须被剥除");
  assert.ok(!details.includes("\r"), "CR 必须被剥除");
  assert.ok(details.includes("rm -rf /"), "真实命令仍完整可见");
  assert.ok(details.includes("echo safe"));
});

test("formatApprovalDetails 保留合法换行与制表符（多行脚本）", () => {
  const script = "for f in a b; do\n\techo $f\ndone";
  const details = formatApprovalDetails({ command: script });
  assert.ok(details.includes("\n\techo $f"));
});
