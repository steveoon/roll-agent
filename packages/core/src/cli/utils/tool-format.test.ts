import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatApprovalDetails,
  formatApprovalExplanation,
  formatToolInput,
} from "./tool-format.ts";

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

test("formatApprovalExplanation 清洗控制字符并把空白折叠成单行", () => {
  const explanation = formatApprovalExplanation("  运行测试\n\t确认改动\u0000\u001b  ");
  assert.equal(explanation, "运行测试 确认改动");
});

test("formatApprovalExplanation 按 Unicode 字符限制为 100 字", () => {
  const explanation = formatApprovalExplanation("🙂".repeat(101));
  assert.equal(Array.from(explanation ?? "").length, 100);
  assert.equal(explanation, "🙂".repeat(100));
});

test("formatApprovalExplanation 对清洗后的空说明返回 undefined", () => {
  assert.equal(formatApprovalExplanation("\u0000\u001b \n\t"), undefined);
});

test("schedule_create 的规范化确认对象逐行完整渲染，不被截断", () => {
  const details = {
    name: "检查BOSS未读消息",
    prompt: `使用 browser-use-agent 检查 BOSS直聘的未读消息：${"细节".repeat(60)}`,
    every: "每 30 分钟",
    cwd: "/very/long/workspace/path/that/should/stay/visible/project-b",
    maxRun: "1 小时",
    firstRunAt: "8/31/2026, 5:46:04 PM",
    lifecycle: "会持续运行，直到暂停或删除；创建时记录当前权限边界",
    serviceStatus: "尚未安装调度服务且 daemon 未运行：任务已登记但不会自动执行",
  };
  const rendered = formatApprovalDetails(details);
  assert.match(
    rendered,
    /cwd: \/very\/long\/workspace\/path\/that\/should\/stay\/visible\/project-b/u,
  );
  assert.match(rendered, /maxRun: 1 小时/u);
  assert.match(rendered, /firstRunAt: 8\/31\/2026/u);
  assert.match(rendered, /lifecycle: 会持续运行/u);
  assert.match(rendered, /serviceStatus: 尚未安装调度服务/u);
  assert.ok(rendered.includes(details.prompt));

  const explanation = formatApprovalExplanation("将登记定时任务「检查BOSS未读消息」（每 30 分钟）");
  assert.ok(explanation !== undefined);
  assert.ok(explanation.length <= 100);
});
