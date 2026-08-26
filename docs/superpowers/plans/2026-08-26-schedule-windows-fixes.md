# roll schedule Windows 兼容修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `roll schedule` 的常驻面在 Windows 上能装、能活、能停，并把 Windows 上退化成「无效动作」的进程信号路径改成诚实的 fail-closed 行为。

**Architecture:** 三条主线互不依赖：① Windows 服务改为 `schtasks /Create /XML` 注册（去掉 `/TR` 261 字符上限，补 `ExecutionTimeLimit PT0S` / `RestartOnFailure` / 电池设置）；② 进程身份读取只信任绝对路径 PowerShell 并放宽 Windows 超时，exec 侧读身份失败先重试再终态；③ daemon 的树终止标志采用「最近一次结果」语义，Windows 不再发无效的 SIGTERM 阶段，exec 子进程在 Windows 也 detached，daemon 额外监听 SIGHUP/SIGBREAK。其余是文档校正与 CI 覆盖。所有改动只能在 macOS 上用注入 `platform` / `runner` / `spawnSync` 的单测验证，Windows 真机行为由 PR 触发的 `windows-latest` job 兜底。

**Tech Stack:** Node ≥ 22.6（type stripping，`.ts` 后缀 import，`import type`），node:test + node:assert/strict，node:sqlite，citty，schtasks / PowerShell（通过 `ProcessRunner` 抽象）。

**Spec:** `docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md`（架构与六轮评审修订）+ Windows 评估报告 https://claude.ai/code/artifact/9447eabf-e41f-482b-82be-1ac6d1cda5fe （编号 W1–W13 沿用该报告）。

## Global Constraints

- TypeScript：零 `any`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`；`import type` 分离；导入路径必须带 `.ts`；禁止 `enum` / `namespace`；类型从 `as const` 派生；if/else 必须加花括号
- 核心代码零注释；CLI 参数一律 kebab-case
- 源码不得含原始控制字符（`\u0000` 之类用 `String.fromCharCode` 生成），提交前跑 `pnpm check:source-control-chars`
- 共享工作树：**禁止** `git restore` / `git checkout -- <file>` / `git reset` / `git stash`；不要触碰 `.gitignore`、`docs/rfc-*.md`、`CLAUDE.md` / `AGENTS.md` 的现有未提交改动；`git add` 只加本任务明确列出的文件
- 进程身份 / 进程状态类探测一律用绝对路径可执行文件（仓库先例：`/bin/ps`、`%SystemRoot%\System32\taskkill.exe`）
- 不引入 root-only 回退；「释放单例前必须证明旧执行者已死」的不变量在 Windows 同样成立，弱探测表现为 unknown / 等待
- 分支：`fix/schedule-windows`，从 `dev`（09d7f2e）切出；完成后本地 merge 回 `dev`，**不 push**
- 单个测试文件运行方式：`node --experimental-strip-types --experimental-sqlite --test <file>`；core 全量：`pnpm --filter @roll-agent/core test`；runtime 全量：`pnpm --filter @roll-agent/runtime test`；e2e：`pnpm test:e2e`

---

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `packages/core/src/companion-host/service.ts` | 共享服务控制器：新增 XML 渲染 / 编码、`install` 先解析当前用户 SID 再写 XML 并 `/Create /XML`、`uninstall` 清理 XML、错误文案取 `displayName` | T1 |
| `packages/core/src/companion-host/identity.ts` | 抽出纯函数 `parseWindowsUserSid(stdout)`，供身份检查与服务控制器共用 | T1 |
| `packages/core/src/companion-host/paths.ts` / `packages/core/src/scheduler-host/paths.ts` | 各自新增 `windowsTaskXmlPath` | T1 |
| `packages/core/src/scheduler-host/service.ts` | identity 补 `displayName` / `windowsTaskXmlPath` | T1 |
| `packages/core/src/registry/process-identity.ts` | Windows 身份：可信绝对路径 PowerShell 列表、平台化超时 | T2 |
| `packages/core/src/scheduler-host/executor-liveness.ts` | `readExecutorIdentityWithRetry` | T2 |
| `packages/core/src/cli/commands/schedule-exec.ts` | 使用重试读身份 | T2 |
| `packages/core/src/scheduler-host/daemon.ts` | `platform` 选项；`treeKillUnconfirmed` 最近结果语义；win32 跳过 SIGTERM 阶段 | T3 |
| `packages/core/src/scheduler-host/stop-signals.ts`（新） | 从 `schedule-daemon.ts` 抽出 `installStopSignals`，加 SIGHUP / SIGBREAK | T3 |
| `packages/core/src/scheduler-host/spawn-invocation.ts` | win32 也 `detached: true` | T3 |
| `packages/core/src/cli/commands/schedule-daemon.ts` / `schedule-run-now.ts` | 接入 stop-signals；inline Ctrl+C 在 win32 转发 SIGKILL | T3 |
| `packages/core/src/cli/commands/schedule-cancel.ts` | Windows 后代不可验证时打印告警 | T4 |
| `docs/how-to-schedule-tasks.md`、`docs/windows-compatibility.md`、`docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md`、`.changeset/roll-schedule.md` | 文档 / 变更记录 | T4 |
| `.github/workflows/ci.yml` | windows-latest 增加 scheduler 单测与诊断性 e2e | T5 |

---

### Task 0: 建分支

**Files:** 无

- [ ] **Step 1: 确认起点并切分支**

Run:
```bash
git -C /Users/rensiwen/Documents/react-projects/Next-PJ/nano-agent status --short
git -C /Users/rensiwen/Documents/react-projects/Next-PJ/nano-agent rev-parse --short dev
git -C /Users/rensiwen/Documents/react-projects/Next-PJ/nano-agent switch -c fix/schedule-windows dev
```
Expected: `status` 只显示 ` M .gitignore`、` M AGENTS.md`、` M CLAUDE.md`、`?? docs/rfc-*.md`（别人的改动，保持不动）；`dev` 为 `09d7f2e`；新分支创建成功。

---

### Task 1: Windows 服务改为 XML 注册（W1 W2 W11 W13）

**Files:**
- Modify: `packages/core/src/companion-host/identity.ts`
- Modify: `packages/core/src/companion-host/paths.ts:5-33`
- Modify: `packages/core/src/scheduler-host/paths.ts:10-25`
- Modify: `packages/core/src/companion-host/service.ts`（`ServicePlanIdentity`、`companionServiceIdentity`、`MacOsLaunchAgentPlan`、Windows plan / controller、`atomicWritePrivate`）
- Modify: `packages/core/src/scheduler-host/service.ts:21-44`
- Test: `packages/core/src/companion-host/service.test.ts`、`packages/core/src/scheduler-host/service.test.ts`

**Interfaces:**
- Consumes: `ProcessRunner` / `ProcessInvocation`（`companion-host/process-runner.ts`），`resolveWindowsWhoAmIExecutable`（`windows-system.ts`），`escapeXml`（service.ts 已有）
- Produces:
  - `parseWindowsUserSid(stdout: string): string | undefined`（identity.ts）
  - `ServicePlanIdentity` 新增 `displayName: string`、`windowsTaskXmlPath: string`
  - `WindowsScheduledTaskPlan` 新增 `displayName`、`taskXmlPath`、`whoAmI: ProcessInvocation`、`renderTaskXml(principal: WindowsTaskPrincipal): string`；`create.args` 变为 `["/Create", "/F", "/XML", taskXmlPath, "/TN", taskName]`
  - `encodeWindowsTaskXml(xml: string): Buffer`（UTF-16LE + BOM）
  - `createWindowsScheduledTaskPlan(input: { paths: CompanionPaths; invocation: BundledRollInvocation; windowsDirectory?: string })`
  - `CompanionPaths.windowsTaskXmlPath`、`SchedulerPaths.windowsTaskXmlPath`

- [ ] **Step 1: 写 identity.ts 的失败测试**

在 `packages/core/src/companion-host/identity.test.ts`（若不存在则新建；存在则追加）加入：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseWindowsUserSid } from "./identity.ts";

test("parseWindowsUserSid 从 whoami csv 输出提取并大写 SID", () => {
  assert.equal(
    parseWindowsUserSid('"DESKTOP\\tester","s-1-5-21-1111-2222-3333-1001"\r\n'),
    "S-1-5-21-1111-2222-3333-1001",
  );
  assert.equal(parseWindowsUserSid("garbage"), undefined);
  assert.equal(parseWindowsUserSid(""), undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/core/src/companion-host/identity.test.ts`
Expected: FAIL，`parseWindowsUserSid` 不是导出。

- [ ] **Step 3: 实现 parseWindowsUserSid 并让身份检查复用**

`packages/core/src/companion-host/identity.ts` 改为：

```ts
import { SpawnProcessRunner, type ProcessRunner } from "./process-runner.ts";
import { resolveWindowsWhoAmIExecutable } from "./windows-system.ts";

const WINDOWS_SERVICE_ACCOUNT_SIDS = new Set(["S-1-5-18", "S-1-5-19", "S-1-5-20"]);
const WINDOWS_SID_PATTERN = /\bS-\d+(?:-\d+)+\b/iu;

export type CompanionUserIdentityCheck = () => Promise<void>;

export function parseWindowsUserSid(stdout: string): string | undefined {
  return WINDOWS_SID_PATTERN.exec(stdout)?.[0]?.toUpperCase();
}

export function createCompanionUserIdentityCheck(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly uid?: number;
    readonly runner?: ProcessRunner;
    readonly windowsDirectory?: string;
  } = {},
): CompanionUserIdentityCheck {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return async () => {
      const uid = options.uid ?? process.getuid?.();
      if (uid === undefined) {
        throw new Error("Unable to identify the current macOS Companion user");
      }
      if (uid === 0) {
        throw new Error("Roll Companion must not run as root");
      }
    };
  }
  if (platform === "win32") {
    const runner = options.runner ?? new SpawnProcessRunner();
    const whoAmIExecutable = resolveWindowsWhoAmIExecutable(options.windowsDirectory);
    return async () => {
      const result = await runner.run({
        command: whoAmIExecutable,
        args: ["/user", "/fo", "csv", "/nh"],
      });
      const sid = result.code === 0 ? parseWindowsUserSid(result.stdout) : undefined;
      if (sid === undefined) {
        throw new Error("Unable to identify the current Windows Companion user");
      }
      if (WINDOWS_SERVICE_ACCOUNT_SIDS.has(sid)) {
        throw new Error("Roll Companion must not run as a Windows service account");
      }
    };
  }
  throw new Error("roll companion supports macOS and Windows only");
}
```

- [ ] **Step 4: 跑 identity 测试确认通过**

Run: `node --experimental-strip-types --test packages/core/src/companion-host/identity.test.ts`
Expected: PASS（含文件里原有用例）。

- [ ] **Step 5: 写 service 层的失败测试（companion）**

`packages/core/src/companion-host/service.test.ts`：把「Windows plan is current-user ONLOGON and never SYSTEM」整段替换为下面三条，并把文件里其余 `createWindowsScheduledTaskPlan(invocation, "D:\\Windows")` 全部改成 `createWindowsScheduledTaskPlan({ paths: windowsPaths, invocation, windowsDirectory: "D:\\Windows" })`；在 `invocation` 常量下面加 `const windowsPaths = createCompanionPaths("C:\\Users\\tester", "win32");`，import 补 `mkdtempSync, readFileSync, rmSync, existsSync` from `node:fs`、`tmpdir` from `node:os`、`join` from `node:path`、`encodeWindowsTaskXml` from `./service.ts`：

```ts
test("Windows plan registers through an XML task definition, never through /TR", () => {
  const plan = createWindowsScheduledTaskPlan({
    paths: windowsPaths,
    invocation,
    windowsDirectory: "D:\\Windows",
  });
  assert.deepEqual(plan.create.args, [
    "/Create",
    "/F",
    "/XML",
    windowsPaths.windowsTaskXmlPath,
    "/TN",
    "Roll Agent Companion",
  ]);
  assert.equal(plan.create.command, "D:\\Windows\\System32\\schtasks.exe");
  assert.equal(plan.whoAmI.command, "D:\\Windows\\System32\\whoami.exe");
  assert.deepEqual(plan.whoAmI.args, ["/user", "/fo", "csv", "/nh"]);
  assert.equal(
    plan.query.command,
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  const xml = plan.renderTaskXml({ userId: "S-1-5-21-1-2-3-1001" });
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/u);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/u);
  assert.match(xml, /<Principal id="Author">\s*<UserId>S-1-5-21-1-2-3-1001<\/UserId>/u);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>S-1-5-21-1-2-3-1001<\/UserId>/u);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/u);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>/u);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/u);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/u);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.match(
    xml,
    /<Command>\/Applications\/Roll Companion\.app\/Contents\/Frameworks\/node<\/Command>/u,
  );
  assert.match(xml, /<Arguments>"\/Applications\/Roll Companion\.app[^<]*"--foreground"<\/Arguments>/u);
  assert.doesNotMatch(xml, /S-1-5-18|SYSTEM|HighestAvailable/u);
  assert.match(xml, /<Description>Roll Companion<\/Description>/u);
});

test("Windows task XML is encoded as UTF-16LE with BOM", () => {
  const encoded = encodeWindowsTaskXml("<a>é</a>");
  assert.deepEqual([...encoded.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(encoded.subarray(2).toString("utf16le"), "<a>é</a>");
});

test("Windows install resolves the user SID, writes the XML, registers and starts the task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-win-task-"));
  try {
    const paths = { ...windowsPaths, windowsTaskXmlPath: join(dir, "companion-task.xml") };
    const plan = createWindowsScheduledTaskPlan({
      paths,
      invocation,
      windowsDirectory: "D:\\Windows",
    });
    const runner = new QueueRunner([
      { code: 0, stdout: '"DESKTOP\\tester","S-1-5-21-1-2-3-1001"\r\n', stderr: "" },
      { code: 0, stdout: "SUCCESS", stderr: "" },
      { code: 0, stdout: "state:3", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ]);
    await new WindowsScheduledTaskController(plan, runner).install();
    assert.deepEqual(runner.invocations, [plan.whoAmI, plan.create, plan.query, plan.start]);
    const written = readFileSync(paths.windowsTaskXmlPath);
    assert.deepEqual([...written.subarray(0, 2)], [0xff, 0xfe]);
    assert.match(written.subarray(2).toString("utf16le"), /<UserId>S-1-5-21-1-2-3-1001<\/UserId>/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows install fails closed when the user SID cannot be read", async () => {
  const plan = createWindowsScheduledTaskPlan({
    paths: windowsPaths,
    invocation,
    windowsDirectory: "D:\\Windows",
  });
  const runner = new QueueRunner([{ code: 1, stdout: "", stderr: "denied" }]);
  await assert.rejects(
    new WindowsScheduledTaskController(plan, runner).install(),
    /Unable to identify the current Windows user for the Roll Companion task/u,
  );
  assert.equal(runner.invocations.length, 1);
});

test("Windows uninstall removes the task and its XML definition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-win-task-"));
  try {
    const paths = { ...windowsPaths, windowsTaskXmlPath: join(dir, "companion-task.xml") };
    const plan = createWindowsScheduledTaskPlan({
      paths,
      invocation,
      windowsDirectory: "D:\\Windows",
    });
    writeFileSync(paths.windowsTaskXmlPath, "stale");
    const runner = new QueueRunner([
      { code: 0, stdout: "state:3", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "state:3", stderr: "" },
      { code: 0, stdout: "state:3", stderr: "" },
      { code: 0, stdout: "SUCCESS", stderr: "" },
    ]);
    await new WindowsScheduledTaskController(plan, runner).uninstall();
    assert.deepEqual(runner.invocations, [plan.query, plan.stop, plan.query, plan.query, plan.remove]);
    assert.equal(existsSync(paths.windowsTaskXmlPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows controller error copy names the service being managed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-win-task-"));
  try {
    const plan = createWindowsScheduledTaskPlan({
      paths: { ...windowsPaths, windowsTaskXmlPath: join(dir, "t.xml") },
      invocation,
      windowsDirectory: "D:\\Windows",
    });
    const runner = new QueueRunner([
      { code: 0, stdout: '"DESKTOP\\tester","S-1-5-21-1-2-3-1001"\r\n', stderr: "" },
      { code: 1, stdout: "", stderr: "ERROR: Access is denied." },
    ]);
    assert.equal(plan.displayName, "Roll Companion");
    await assert.rejects(
      new WindowsScheduledTaskController(plan, runner).install(),
      /Unable to install the current-user Roll Companion task/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

（`writeFileSync` 也要 import。）同时把「Windows service stop rejects when the task remains running」的断言 `/Unable to stop/u` 保持不变——新文案为 `Unable to stop the current-user Roll Companion task`，仍匹配。

- [ ] **Step 6: 写 service 层的失败测试（scheduler）**

`packages/core/src/scheduler-host/service.test.ts`：把顶部 `import { createMacOsLaunchAgentPlanForIdentity } from "../companion-host/service.ts";` 改为 `import { createMacOsLaunchAgentPlanForIdentity, createWindowsScheduledTaskPlanForIdentity } from "../companion-host/service.ts";`（import 必须留在文件顶部，`import-x/first`），然后末尾追加：

```ts
test("scheduler identity 携带 Windows XML 路径与显示名", () => {
  const invocation = createBundledRollInvocation({
    command: "/bundle/node",
    cliEntrypoint: "/bundle/roll.js",
    execArgv: [],
  });
  const identity = schedulerServiceIdentity(
    createSchedulerPaths("/Users/tester/.roll-agent/scheduler", "/Users/tester"),
    invocation,
    { maxConcurrentRuns: 2 },
  );
  assert.equal(identity.displayName, "roll schedule daemon");
  assert.equal(identity.windowsTaskXmlPath, "/Users/tester/.roll-agent/scheduler/scheduler-task.xml");
});

test("Windows plan 不再把命令行塞进 /TR，长路径也能注册", () => {
  const longEntrypoint = `C:\\Users\\tester\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@roll-agent+core@0.12.0\\node_modules\\@roll-agent\\core\\bin\\roll.js`;
  const invocation = createBundledRollInvocation({
    command: "C:\\Program Files\\nodejs\\node.exe",
    cliEntrypoint: longEntrypoint,
    execArgv: ["--disable-warning=ExperimentalWarning", "--experimental-sqlite"],
  });
  const identity = schedulerServiceIdentity(
    createSchedulerPaths("C:\\Users\\tester\\.roll-agent\\scheduler", "C:\\Users\\tester"),
    invocation,
    { maxConcurrentRuns: 2 },
  );
  const plan = createWindowsScheduledTaskPlanForIdentity(identity, "C:\\Windows");
  assert.ok(plan.taskCommand.length > 261);
  assert.equal(plan.create.args.includes("/TR"), false);
  assert.equal(plan.create.args.includes(plan.taskCommand), false);
  const xml = plan.renderTaskXml({ userId: "S-1-5-21-1-2-3-1001" });
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/u);
  assert.match(xml, /"--max-concurrent-runs" "2"<\/Arguments>/u);
  assert.match(xml, /<Description>roll schedule daemon<\/Description>/u);
});
```

- [ ] **Step 7: 跑两个测试文件确认失败**

Run:
```bash
node --experimental-strip-types --test packages/core/src/companion-host/service.test.ts packages/core/src/scheduler-host/service.test.ts
```
Expected: FAIL（类型/导出缺失：`windowsTaskXmlPath`、`renderTaskXml`、`encodeWindowsTaskXml`、`whoAmI`、`createWindowsScheduledTaskPlan` 签名）。

- [ ] **Step 8: 实现 paths 与 identity 扩展**

`packages/core/src/companion-host/paths.ts`：接口加 `readonly windowsTaskXmlPath: string;`，返回对象加 `windowsTaskXmlPath: join(dataDir, "companion-task.xml"),`。

`packages/core/src/scheduler-host/paths.ts`：接口加 `readonly windowsTaskXmlPath: string;`，返回对象加 `windowsTaskXmlPath: join(resolvedDataDir, "scheduler-task.xml"),`。

`packages/core/src/scheduler-host/service.ts` 的 `schedulerServiceIdentity` 返回对象加：
```ts
    displayName: "roll schedule daemon",
    windowsTaskXmlPath: paths.windowsTaskXmlPath,
```

- [ ] **Step 9: 实现 service.ts 的 XML 注册**

在 `packages/core/src/companion-host/service.ts`：

1. import 增加 `resolveWindowsWhoAmIExecutable`（来自 `./windows-system.ts`）、`parseWindowsUserSid`（来自 `./identity.ts`）、`Buffer`（`node:buffer`）；`ServicePlanIdentity` 增加 `readonly displayName: string;` 与 `readonly windowsTaskXmlPath: string;`；`companionServiceIdentity` 返回对象加 `displayName: "Roll Companion"`、`windowsTaskXmlPath: paths.windowsTaskXmlPath`。
2. `MacOsLaunchAgentPlan` 增加 `readonly displayName: string;`，`createMacOsLaunchAgentPlanForIdentity` 返回时带上 `displayName: identity.displayName`；`MacOsLaunchAgentController.runRequired` 的文案改为 `` `Unable to update the per-user macOS ${this.plan.displayName} service` ``。
3. 替换 Windows plan 部分：

```ts
const WINDOWS_TASK_XML_NAMESPACE = "http://schemas.microsoft.com/windows/2004/02/mit/task";
const WINDOWS_TASK_RESTART_INTERVAL = "PT1M";
const WINDOWS_TASK_RESTART_COUNT = 3;
const WINDOWS_TASK_LOGON_TYPE = "InteractiveToken";

export interface WindowsTaskPrincipal {
  readonly userId: string;
}

export interface WindowsScheduledTaskPlan {
  readonly taskName: string;
  readonly displayName: string;
  readonly taskCommand: string;
  readonly taskXmlPath: string;
  readonly whoAmI: ProcessInvocation;
  readonly create: ProcessInvocation;
  readonly remove: ProcessInvocation;
  readonly start: ProcessInvocation;
  readonly stop: ProcessInvocation;
  readonly query: ProcessInvocation;
  renderTaskXml(principal: WindowsTaskPrincipal): string;
}

export function encodeWindowsTaskXml(xml: string): Buffer {
  return Buffer.from(`${String.fromCharCode(0xfeff)}${xml}`, "utf16le");
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderWindowsTaskXml(input: {
  readonly displayName: string;
  readonly userId: string;
  readonly command: string;
  readonly commandArguments: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="${WINDOWS_TASK_XML_NAMESPACE}">
  <RegistrationInfo>
    <Description>${escapeXmlText(input.displayName)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXmlText(input.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXmlText(input.userId)}</UserId>
      <LogonType>${WINDOWS_TASK_LOGON_TYPE}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>${WINDOWS_TASK_RESTART_INTERVAL}</Interval>
      <Count>${String(WINDOWS_TASK_RESTART_COUNT)}</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXmlText(input.command)}</Command>
      <Arguments>${escapeXmlText(input.commandArguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function createWindowsScheduledTaskPlanForIdentity(
  identity: Pick<
    ServicePlanIdentity,
    "windowsTaskName" | "windowsTaskXmlPath" | "displayName" | "programArguments"
  >,
  windowsDirectory?: string,
): WindowsScheduledTaskPlan {
  const [command, ...commandArguments] = identity.programArguments;
  if (command === undefined) {
    throw new Error("Windows task definition requires a program to run");
  }
  const taskCommand = identity.programArguments.map(quoteWindowsCommandArgument).join(" ");
  const quotedArguments = commandArguments.map(quoteWindowsCommandArgument).join(" ");
  const taskSchedulerExecutable = resolveWindowsScheduledTasksExecutable(windowsDirectory);
  const powershellExecutable = resolveWindowsPowerShellExecutable(windowsDirectory);
  const queryScript = `$taskName = ${createPowerShellUtf8StringExpression(identity.windowsTaskName)}\n${WINDOWS_TASK_STATE_QUERY_SCRIPT}`;
  return {
    taskName: identity.windowsTaskName,
    displayName: identity.displayName,
    taskCommand,
    taskXmlPath: identity.windowsTaskXmlPath,
    whoAmI: {
      command: resolveWindowsWhoAmIExecutable(windowsDirectory),
      args: ["/user", "/fo", "csv", "/nh"],
    },
    create: {
      command: taskSchedulerExecutable,
      args: ["/Create", "/F", "/XML", identity.windowsTaskXmlPath, "/TN", identity.windowsTaskName],
    },
    remove: {
      command: taskSchedulerExecutable,
      args: ["/Delete", "/F", "/TN", identity.windowsTaskName],
    },
    start: {
      command: taskSchedulerExecutable,
      args: ["/Run", "/TN", identity.windowsTaskName],
    },
    stop: {
      command: taskSchedulerExecutable,
      args: ["/End", "/TN", identity.windowsTaskName],
    },
    query: {
      command: powershellExecutable,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", queryScript],
    },
    renderTaskXml: (principal) =>
      renderWindowsTaskXml({
        displayName: identity.displayName,
        userId: principal.userId,
        command,
        commandArguments: quotedArguments,
      }),
  };
}

export function createWindowsScheduledTaskPlan(input: {
  readonly paths: CompanionPaths;
  readonly invocation: BundledRollInvocation;
  readonly windowsDirectory?: string;
}): WindowsScheduledTaskPlan {
  return createWindowsScheduledTaskPlanForIdentity(
    companionServiceIdentity(input.paths, input.invocation),
    input.windowsDirectory,
  );
}
```

4. `WindowsScheduledTaskController` 改为：

```ts
export class WindowsScheduledTaskController implements CompanionServiceController {
  private readonly plan: WindowsScheduledTaskPlan;
  private readonly runner: ProcessRunner;

  constructor(plan: WindowsScheduledTaskPlan, runner: ProcessRunner = new SpawnProcessRunner()) {
    this.plan = plan;
    this.runner = runner;
  }

  async install(): Promise<void> {
    const userId = await this.resolveUserId();
    await atomicWritePrivate(
      this.plan.taskXmlPath,
      encodeWindowsTaskXml(this.plan.renderTaskXml({ userId })),
    );
    await this.runRequired(this.plan.create, `Unable to install the current-user ${this.plan.displayName} task`);
    await this.start();
  }

  async uninstall(): Promise<void> {
    await this.stop();
    const status = await this.status();
    if (status.installed) {
      await this.runRequired(this.plan.remove, `Unable to uninstall the current-user ${this.plan.displayName} task`);
    }
    await unlink(this.plan.taskXmlPath).catch((error: unknown) => {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    });
  }

  async start(): Promise<void> {
    const status = await this.status();
    if (!status.installed) {
      throw new Error(`${this.plan.displayName} service is not installed`);
    }
    await this.runRequired(this.plan.start, `Unable to start the current-user ${this.plan.displayName} task`);
  }

  async stop(): Promise<void> {
    const status = await this.inspectTaskState();
    if (status.state === undefined) {
      return;
    }
    await this.runner.run(this.plan.stop);
    const finalStatus = await this.inspectTaskState();
    if (
      finalStatus.state !== undefined &&
      finalStatus.state !== WINDOWS_TASK_STATES.disabled &&
      finalStatus.state !== WINDOWS_TASK_STATES.ready
    ) {
      throw new Error(`Unable to stop the current-user ${this.plan.displayName} task`);
    }
  }

  async status(): Promise<CompanionServiceStatus> {
    const status = await this.inspectTaskState();
    if (status.state === undefined) {
      return { installed: false, running: false };
    }
    if (
      status.state === WINDOWS_TASK_STATES.unknown ||
      status.state === WINDOWS_TASK_STATES.queued
    ) {
      throw new Error(`The current-user ${this.plan.displayName} task state is indeterminate`);
    }
    return {
      installed: true,
      running: status.state === WINDOWS_TASK_STATES.running,
    };
  }

  private async resolveUserId(): Promise<string> {
    const result = await this.runner.run(this.plan.whoAmI);
    const sid = result.code === 0 ? parseWindowsUserSid(result.stdout) : undefined;
    if (sid === undefined) {
      throw new Error(`Unable to identify the current Windows user for the ${this.plan.displayName} task`);
    }
    return sid;
  }

  private async inspectTaskState(): Promise<{ readonly state: WindowsTaskState | undefined }> {
    const result = await this.runner.run(this.plan.query);
    if (result.code !== 0) {
      throw new Error(`Unable to inspect the current-user ${this.plan.displayName} task`);
    }
    const output = result.stdout.trim();
    if (output === "missing") {
      return { state: undefined };
    }
    const stateMatch = /^state:([0-4])$/u.exec(output);
    const state = Number(stateMatch?.[1]);
    if (!isWindowsTaskState(state)) {
      throw new Error(`The current-user ${this.plan.displayName} task returned an invalid state`);
    }
    return { state };
  }

  private async runRequired(invocation: ProcessInvocation, message: string): Promise<void> {
    const result = await this.runner.run(invocation);
    if (result.code !== 0) {
      throw new Error(message);
    }
  }
}
```

5. `atomicWritePrivate` 签名改为 `contents: string | Uint8Array`，`writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" })`（去掉 `encoding`，字符串默认 utf8）。
6. 删除 `MacOsLaunchAgentController.start()` 里写死的 "Roll Companion service is not installed"，改为 `` `${this.plan.displayName} service is not installed` ``。
7. 检查 `service.test.ts` 里断言 `/is not installed/` 或 `/Roll Companion service/` 的用例，改成新文案（macOS 侧 displayName 仍是 "Roll Companion"，一般无需改）。

- [ ] **Step 10: 跑 companion-host 与 scheduler-host 全部测试**

Run:
```bash
node --experimental-strip-types --experimental-sqlite --test packages/core/src/companion-host/*.test.ts packages/core/src/scheduler-host/*.test.ts
pnpm --filter @roll-agent/core typecheck
```
Expected: 全部 PASS；typecheck 无错误（`application.test.ts` 用 `createCompanionPaths(..., "darwin")` 只读字段，不受影响）。

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/companion-host/identity.ts packages/core/src/companion-host/identity.test.ts packages/core/src/companion-host/paths.ts packages/core/src/companion-host/service.ts packages/core/src/companion-host/service.test.ts packages/core/src/scheduler-host/paths.ts packages/core/src/scheduler-host/service.ts packages/core/src/scheduler-host/service.test.ts
git commit -m "fix(service): register Windows tasks from XML with restart-on-failure and no run-time limit"
```

---

### Task 2: Windows 进程身份只走可信 PowerShell，exec 读身份失败先重试（W3）

**Files:**
- Modify: `packages/core/src/registry/process-identity.ts:68,218-227,354-379`
- Modify: `packages/core/src/scheduler-host/executor-liveness.ts:137-140`
- Modify: `packages/core/src/cli/commands/schedule-exec.ts:29`
- Test: `packages/core/src/registry/process-identity.test.ts`、`packages/core/src/scheduler-host/executor-liveness.test.ts`

**Interfaces:**
- Produces:
  - `resolveTrustedWindowsPowerShellExecutables(env?: NodeJS.ProcessEnv, exists?: (path: string) => boolean): string[]`（process-identity.ts）
  - `readExecutorIdentityWithRetry(read?: () => ExecutorIdentity | undefined, attempts?: number): ExecutorIdentity | undefined`（executor-liveness.ts）

影响面提示：`readProcessStartToken` 是 CRITICAL 级 hub（61 个符号、agent lifecycle / install / doctor / update / schedule 共 10 条执行流依赖）。本任务只改 win32 分支与超时常量，macOS / Linux 行为不变；改完必须跑 `packages/core/src/registry/*.test.ts` 全量。

- [ ] **Step 1: 写失败测试（可信路径列表）**

`packages/core/src/registry/process-identity.test.ts` 追加：

```ts
import { resolveTrustedWindowsPowerShellExecutables } from "./process-identity.ts";

test("Windows identity only uses absolute PowerShell paths under SystemRoot / ProgramFiles", () => {
  const seen: string[] = [];
  const exists = (path: string) => {
    seen.push(path);
    return true;
  };
  assert.deepEqual(
    resolveTrustedWindowsPowerShellExecutables(
      { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
      exists,
    ),
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ],
  );
  assert.deepEqual(seen, [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  ]);
  assert.deepEqual(
    resolveTrustedWindowsPowerShellExecutables({ SystemRoot: "Windows" }, () => true),
    [],
  );
  assert.deepEqual(
    resolveTrustedWindowsPowerShellExecutables({ SystemRoot: "C:\\Windows" }, () => false),
    [],
  );
  assert.deepEqual(resolveTrustedWindowsPowerShellExecutables({ PATH: "C:\\evil" }, () => true), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/core/src/registry/process-identity.test.ts`
Expected: FAIL，`resolveTrustedWindowsPowerShellExecutables` 未导出。

- [ ] **Step 3: 实现**

`packages/core/src/registry/process-identity.ts`：

1. import 增加 `existsSync`（已有 `readFileSync`，合并为 `import { existsSync, readFileSync } from "node:fs";`）与 `import { win32 } from "node:path";`
2. 常量改为：
```ts
const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 2_000;
const WINDOWS_PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 8_000;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
```
3. 新增导出：
```ts
export function resolveTrustedWindowsPowerShellExecutables(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const candidates: string[] = [];
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (systemRoot !== undefined && WINDOWS_DRIVE_PATH_PATTERN.test(systemRoot)) {
    candidates.push(
      win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
  }
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
  if (programFiles !== undefined && WINDOWS_DRIVE_PATH_PATTERN.test(programFiles)) {
    candidates.push(win32.join(programFiles, "PowerShell", "7", "pwsh.exe"));
  }
  return candidates.filter((candidate) => exists(candidate));
}
```
4. `readWindowsProcessStartIdentity` 改为：
```ts
function readWindowsProcessStartIdentity(pid: number, version: "v1" | "v2"): string | undefined {
  const script =
    `$p = Get-Process -Id ${String(pid)} -ErrorAction Stop; ` +
    "$p.StartTime.ToUniversalTime().Ticks";
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  const executable = resolveTrustedWindowsPowerShellExecutables()[0];
  if (executable === undefined) return undefined;
  const startedAt = runIdentityCommand(executable, args, true);
  if (startedAt === undefined || !/^\d+$/u.test(startedAt)) return undefined;
  return version === "v1" ? `win32:${startedAt}` : `win32-v2:${startedAt}`;
}
```
（只用第一个存在的候选：探活会在 `claimDue` 的 `BEGIN IMMEDIATE` 事务内执行，`busy_timeout` 是 15 s，两个候选各 8 s 的串行超时会突破这个窗口；`exists` 已经保证了文件存在，不需要第二次回退。）

5. `runIdentityCommand` 的 `timeout` 改为 `process.platform === "win32" ? WINDOWS_PROCESS_IDENTITY_COMMAND_TIMEOUT_MS : PROCESS_IDENTITY_COMMAND_TIMEOUT_MS`。

- [ ] **Step 4: 跑 registry 全量测试**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/registry/*.test.ts`
Expected: 全部 PASS（macOS 路径未动）。

- [ ] **Step 5: 写失败测试（exec 读身份重试）**

`packages/core/src/scheduler-host/executor-liveness.test.ts` 追加：

```ts
import { readExecutorIdentityWithRetry } from "./executor-liveness.ts";

test("readExecutorIdentityWithRetry：首次失败后重读一次，连续失败才返回 undefined", () => {
  let calls = 0;
  const flaky = () => {
    calls += 1;
    return calls === 1 ? undefined : { pid: 7, startToken: "pst-v2:x" };
  };
  assert.deepEqual(readExecutorIdentityWithRetry(flaky), { pid: 7, startToken: "pst-v2:x" });
  assert.equal(calls, 2);
  let failures = 0;
  assert.equal(
    readExecutorIdentityWithRetry(() => {
      failures += 1;
      return undefined;
    }),
    undefined,
  );
  assert.equal(failures, 2);
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/executor-liveness.test.ts`
Expected: FAIL，`readExecutorIdentityWithRetry` 未导出。

- [ ] **Step 7: 实现重试并接入 exec**

`packages/core/src/scheduler-host/executor-liveness.ts` 在 `currentExecutorIdentity` 后加：

```ts
const EXECUTOR_IDENTITY_ATTEMPTS = 2;

export function readExecutorIdentityWithRetry(
  read: () => ExecutorIdentity | undefined = currentExecutorIdentity,
  attempts: number = EXECUTOR_IDENTITY_ATTEMPTS,
): ExecutorIdentity | undefined {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const identity = read();
    if (identity !== undefined) {
      return identity;
    }
  }
  return undefined;
}
```

`packages/core/src/cli/commands/schedule-exec.ts`：import 改为 `readExecutorIdentityWithRetry`，第 29 行改为 `const executor = readExecutorIdentityWithRetry();`。

- [ ] **Step 8: 跑测试确认通过**

Run:
```bash
node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/executor-liveness.test.ts
pnpm --filter @roll-agent/core typecheck
```
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/registry/process-identity.ts packages/core/src/registry/process-identity.test.ts packages/core/src/scheduler-host/executor-liveness.ts packages/core/src/scheduler-host/executor-liveness.test.ts packages/core/src/cli/commands/schedule-exec.ts
git commit -m "fix(scheduler): read Windows process identity only through trusted PowerShell paths, retry exec identity once"
```

---

### Task 3: daemon 信号语义（W4 W5 W6）

**Files:**
- Modify: `packages/core/src/scheduler-host/daemon.ts:16-29,56-88,239-251,321-349`
- Create: `packages/core/src/scheduler-host/stop-signals.ts`
- Modify: `packages/core/src/cli/commands/schedule-daemon.ts:39-61,140-143`
- Modify: `packages/core/src/scheduler-host/spawn-invocation.ts:59`
- Modify: `packages/core/src/cli/commands/schedule-run-now.ts:71-73`
- Test: `packages/core/src/scheduler-host/daemon.test.ts`、`packages/core/src/scheduler-host/stop-signals.test.ts`（新）

**Interfaces:**
- Consumes: `KILL_PROCESS_TREE_OUTCOMES`（executor-liveness.ts），`ScheduleStore`（`@roll-agent/runtime`，`beginInvocation(id, token, nowMs, executor?)`，`executorLiveness` 注入）
- Produces:
  - `SchedulerDaemonOptions.platform?: NodeJS.Platform`
  - `installStopSignals(onStop: () => void, onRepeat: () => void, target?: Pick<NodeJS.Process, "on" | "off">): { readonly controller: AbortController; readonly release: () => void }`、`STOP_SIGNALS`

- [ ] **Step 1: 写 daemon 失败测试**

`packages/core/src/scheduler-host/daemon.test.ts` 末尾追加（文件已 import `ScheduleStore`、`INVOCATION_STATUSES`、`SchedulerDaemon`、`SpawnedInvocation`，以及 `tempDir` / `silentLogger` / `addDueSchedule` / `NOW` helper）：

```ts
test("SIGTERM 阶段树终止失败但随后的 SIGKILL 整体终止成功时，退出后照常记失败并重试", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "dead" });
    const schedule = addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const exit = Promise.withResolvers<number | null>();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      childTerminateGraceMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
          pid: 4242,
          startToken: "pst-v2:root",
        });
        return {
          exited: exit.promise,
          kill: (signal) => {
            signals.push(signal ?? "SIGTERM");
            if (signal === "SIGKILL") {
              exit.resolve(null);
              return "tree-terminated";
            }
            return "failed";
          },
        };
      },
    });
    const controller = new AbortController();
    const running = daemon.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await running;
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.retry);
    assert.ok(lines.some((line) => /未能整体终止（failed）/u.test(line)));
    assert.ok(lines.some((line) => /已在后续 SIGKILL 中整体终止/u.test(line)));
    assert.equal(lines.some((line) => /终止未被确认/u.test(line)), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 停止时不发无效的 SIGTERM，grace 后直接整体终止", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { executorLiveness: () => "dead" });
    addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const exit = Promise.withResolvers<number | null>();
    const signals: string[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      platform: "win32",
      childTerminateGraceMs: 20,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW, {
          pid: 4242,
          startToken: "pst-v2:root",
        });
        return {
          exited: exit.promise,
          kill: (signal) => {
            signals.push(signal ?? "SIGTERM");
            exit.resolve(null);
            return "tree-terminated";
          },
        };
      },
    });
    const controller = new AbortController();
    const running = daemon.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const startedAt = Date.now();
    controller.abort();
    await running;
    assert.deepEqual(signals, ["SIGKILL"]);
    assert.ok(Date.now() - startedAt >= 15);
    assert.ok(lines.some((line) => /Windows 没有优雅终止信号/u.test(line)));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/daemon.test.ts`
Expected: 两条新用例 FAIL（第一条 status 为 running 而非 retry；第二条 `platform` 类型错误 / signals 含 SIGTERM）。

- [ ] **Step 3: 实现 daemon 改动**

`packages/core/src/scheduler-host/daemon.ts`：

1. import 增加 `import { KILL_PROCESS_TREE_OUTCOMES } from "./executor-liveness.ts";`
2. `SchedulerDaemonOptions` 增加 `readonly platform?: NodeJS.Platform;`；类字段 `private readonly platform: NodeJS.Platform;`，构造函数 `this.platform = options.platform ?? process.platform;`
3. `signalChild` 改为：
```ts
  private signalChild(id: string, signal: "SIGTERM" | "SIGKILL"): void {
    const entry = this.running.get(id);
    if (entry === undefined) {
      return;
    }
    const outcome = entry.handle.kill(signal);
    if (typeof outcome !== "string") {
      return;
    }
    if (outcome !== KILL_PROCESS_TREE_OUTCOMES.tree) {
      entry.treeKillUnconfirmed = true;
      this.logger.error(
        `invocation ${id} 的 exec 进程树未能整体终止（${outcome}）；退出后将保留 running 而不重试`,
      );
      return;
    }
    if (entry.treeKillUnconfirmed) {
      entry.treeKillUnconfirmed = false;
      this.logger.info(`invocation ${id} 的 exec 进程树已在后续 ${signal} 中整体终止`);
    }
  }
```
4. `terminateChildren` 开头的 SIGTERM 循环改为：
```ts
    if (this.platform === "win32") {
      if (this.running.size > 0) {
        this.logger.info(
          `Windows 没有优雅终止信号，等待 ${String(this.childTerminateGraceMs)} ms grace 后强制终止 exec 进程树`,
        );
      }
    } else {
      for (const id of this.running.keys()) {
        this.signalChild(id, "SIGTERM");
      }
    }
```

- [ ] **Step 4: 跑 daemon 测试确认通过**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/daemon.test.ts`
Expected: 全部 PASS（含原有「daemon 发出的进程树终止未被确认时…」用例——它的 kill 始终返回 root-only，语义不变）。

- [ ] **Step 5: 写 stop-signals 失败测试**

新建 `packages/core/src/scheduler-host/stop-signals.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { STOP_SIGNALS, installStopSignals } from "./stop-signals.ts";

test("installStopSignals 监听 SIGINT/SIGTERM/SIGHUP/SIGBREAK，首个信号 abort，重复信号只回调 onRepeat", () => {
  const listeners = new Map<string, () => void>();
  const target = {
    on: (signal: NodeJS.Signals, listener: () => void) => {
      listeners.set(signal, listener);
      return target;
    },
    off: (signal: NodeJS.Signals) => {
      listeners.delete(signal);
      return target;
    },
  } as unknown as Pick<NodeJS.Process, "on" | "off">;
  let stops = 0;
  let repeats = 0;
  const handle = installStopSignals(
    () => {
      stops += 1;
    },
    () => {
      repeats += 1;
    },
    target,
  );
  assert.deepEqual([...listeners.keys()].sort(), [...STOP_SIGNALS].sort());
  listeners.get("SIGHUP")?.();
  assert.equal(handle.controller.signal.aborted, true);
  assert.equal(stops, 1);
  listeners.get("SIGBREAK")?.();
  assert.equal(stops, 1);
  assert.equal(repeats, 1);
  handle.release();
  assert.equal(listeners.size, 0);
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/core/src/scheduler-host/stop-signals.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 7: 实现 stop-signals 并接入 daemon 命令**

新建 `packages/core/src/scheduler-host/stop-signals.ts`：

```ts
export const STOP_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGBREAK",
] as const satisfies readonly NodeJS.Signals[];

export interface StopSignalHandle {
  readonly controller: AbortController;
  readonly release: () => void;
}

export function installStopSignals(
  onStop: () => void,
  onRepeat: () => void,
  target: Pick<NodeJS.Process, "on" | "off"> = process,
): StopSignalHandle {
  const controller = new AbortController();
  const handler = () => {
    if (controller.signal.aborted) {
      onRepeat();
      return;
    }
    onStop();
    controller.abort(new Error("scheduler daemon was asked to stop"));
  };
  for (const signal of STOP_SIGNALS) {
    target.on(signal, handler);
  }
  return {
    controller,
    release: () => {
      for (const signal of STOP_SIGNALS) {
        target.off(signal, handler);
      }
    },
  };
}
```

`packages/core/src/cli/commands/schedule-daemon.ts`：删除本地 `installStopSignals` 函数（第 39–61 行），改为 `import { installStopSignals } from "../../scheduler-host/stop-signals.ts";`，其余调用不变。

- [ ] **Step 8: spawn detached 与 inline 信号**

`packages/core/src/scheduler-host/spawn-invocation.ts:59`：`detached: process.platform !== "win32",` → `detached: true,`。

`packages/core/src/cli/commands/schedule-run-now.ts:71-73` 改为：
```ts
        const forwardStop = () => {
          handle.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
        };
```

- [ ] **Step 9: 跑相关测试 + e2e（POSIX 无回归）**

Run:
```bash
node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/*.test.ts
pnpm --filter @roll-agent/core typecheck
pnpm test:e2e
```
Expected: 全部 PASS；e2e 的 daemon→exec→SIGTERM 用例与 cancel 用例仍绿（detached 在 POSIX 原本就是 true）。

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/scheduler-host/daemon.ts packages/core/src/scheduler-host/daemon.test.ts packages/core/src/scheduler-host/stop-signals.ts packages/core/src/scheduler-host/stop-signals.test.ts packages/core/src/cli/commands/schedule-daemon.ts packages/core/src/scheduler-host/spawn-invocation.ts packages/core/src/cli/commands/schedule-run-now.ts
git commit -m "fix(scheduler): track the latest tree-kill outcome, skip Windows no-op SIGTERM stage, detach exec on Windows"
```

---

### Task 4: cancel 告警与文档校正（W6 W9 W10 W13 文档面）

**Files:**
- Modify: `packages/core/src/cli/commands/schedule-cancel.ts:86-99,133-139`
- Modify: `docs/how-to-schedule-tasks.md:29,50,54,56,75`
- Modify: `docs/windows-compatibility.md`（第 149 行表格之后追加）
- Modify: `docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md`（「待拍板」之前追加第七轮）
- Modify: `.changeset/roll-schedule.md`（追加一条）

- [ ] **Step 1: cancel 在 Windows 打印后代不可验证告警**

`packages/core/src/cli/commands/schedule-cancel.ts`：把 `let killed = false;` 改为
```ts
        let killed = false;
        let killResult: KillResult | undefined;
```
在 `const result = await killAndConfirmExit(before.executor);` 后加 `killResult = result;`；在最后 `if (args.abandon) { log.warn(...) }` 之前加：
```ts
        if (killResult === KILL_RESULTS.unverifiable) {
          log.warn(
            "Windows 无法验证 exec 后代进程是否退出；已按根进程退出取消，若有残留子进程请手动检查",
          );
        }
```

- [ ] **Step 2: 跑 cancel 相关 e2e**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/cli/smoke-schedule.e2e.ts`
Expected: PASS（POSIX 不会走 unverifiable 分支，行为不变）。

- [ ] **Step 3: 更新 how-to**

`docs/how-to-schedule-tasks.md`：

- 第 29 行改为：`3. 安装为用户级常驻服务（macOS LaunchAgent / Windows 当前用户 Scheduled Task，随登录启动；Windows 任务通过 XML 注册，不受 \`schtasks /TR\` 261 字符限制，无运行时长上限，失败后每分钟重启最多 3 次，电池供电不影响启动）：`
- 第 50 行「Windows 没有进程组语义，只能确认根进程。」改为「Windows 没有进程组语义，只能确认根进程（exec 派生的 MCP 子进程若在根退出后仍存活，不会阻止下一轮）。」
- 第 54 行「（Windows 只能确认根进程，`taskkill` 未成功时需改用 `--abandon`）」改为「（Windows 只能确认根进程：根进程已退出即视为可取消并打印「后代不可验证」告警，只有探活为 unknown 时才需要 `--abandon`）」
- 第 56 行改为：`- **停止 daemon**：POSIX 收到 SIGTERM / SIGINT / SIGHUP 后先给子进程树 SIGTERM，10 秒内未退出则 SIGKILL；Windows 没有可投递给控制台进程的优雅信号，daemon 收到 Ctrl+C / Ctrl+Break 后直接等待 10 秒 grace 再 \`taskkill /T /F\`；\`roll schedule service uninstall\`（\`schtasks /End\`）在 Windows 是强制终止，daemon 没有机会处理子进程，在跑的 exec 由下一次 daemon 的探活规则收尾。进程树信号发送失败时不会单独终止根进程，日志标明「未整体终止」。任何时候 exec 根进程退出而最近一次进程树终止未被确认、或进程组里仍有存活成员，daemon 都不会把这次运行记为失败或重试，记录保持 \`running\`，交给探活规则与 1 小时上限处理。`
- 第 75 行之后追加：`- Windows：exec 子进程与 daemon 的启动身份通过 \`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe\`（或 \`%ProgramFiles%\PowerShell\7\pwsh.exe\`）读取，单次超时 8 秒；Node 22.6–22.12 下手动运行 \`roll schedule daemon --foreground\` 会经启动器再起一个进程（服务安装路径不受影响，flag 已固化进任务定义），建议 Windows 使用 Node ≥ 22.13。`

- [ ] **Step 4: 更新 windows-compatibility.md**

在第 149 行（`| 🟡 | pnpm 深层 node_modules …` 行）之后追加：

```markdown
| 🔴 | `roll schedule service install` 用 `schtasks /TR` 注册，pnpm 全局 / Node 22.6–22.12 路径 272–298 字符超过 261 上限 | `companion-host/service.ts` | ✅ 已修复：改为 `/Create /XML` 注册（companion 同步受益） |
| 🔴 | Windows 任务无失败重启、默认 72 小时运行上限、电池供电不启动 | `companion-host/service.ts` | ✅ 已修复：XML 声明 `RestartOnFailure PT1M×3`、`ExecutionTimeLimit PT0S`、`DisallowStartIfOnBatteries=false` |
| 🟠 | 进程启动身份经 PATH 上的 `powershell.exe` 读取，超时 2 s，exec 侧失败直接把任务 `paused` | `registry/process-identity.ts` | ✅ 已修复：只信任 SystemRoot / ProgramFiles 绝对路径，Windows 超时 8 s，exec 先重试一次 |
| 🟠 | `taskkill /T`（无 `/F`）对控制台进程恒失败，daemon 每次停止都把在跑记录留成 `running` | `scheduler-host/daemon.ts` | ✅ 已修复：树终止标志采用最近一次结果；win32 跳过 SIGTERM 阶段 |
| 🟠 | exec 子进程与 daemon 共享控制台，Ctrl+C 直接杀 exec | `scheduler-host/spawn-invocation.ts` | ✅ 已修复：win32 也 `detached`（🔬 真机确认 DETACHED_PROCESS 隔离 Ctrl+C） |
| 🟠 | `schtasks /End` = TerminateProcess，无优雅停止 | Task Scheduler 语义 | ⚠️ 平台限制：文档分平台说明；daemon 额外监听 SIGHUP / SIGBREAK |
| 🟡 | 登录后出现常驻控制台窗口，关窗 10 s 后 daemon 被杀 | `InteractiveToken` 登录类型 | 🔬 待真机评估 `S4U` 登录类型（无窗口，但需确认用户环境变量可用） |
| 🟡 | CI 对 scheduler 零 Windows 覆盖 | `.github/workflows/ci.yml` | ✅ 已修复：windows-latest 增加 scheduler 单测与诊断性 e2e |
```

并在「Windows 实测清单」末尾追加：

```markdown
6. 定时任务：`roll schedule service install`（npm 与 pnpm 全局各一次）后 `schtasks /Query /TN "Roll Agent Scheduler" /XML` 核对 XML；`Measure-Command` 冷启动 PowerShell 身份读取时延；前台 daemon Ctrl+C 时在跑 exec 是否存活到 grace 结束；注销再登录是否弹出控制台窗口
```

- [ ] **Step 5: 更新 spec 与 changeset**

`docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md`：在「- 待拍板（产品取舍，未改）」那一行之前插入：

```markdown
- 第七轮（Windows 兼容评估，静态；报告 https://claude.ai/code/artifact/9447eabf-e41f-482b-82be-1ac6d1cda5fe ）：`schtasks /TR` 261 字符上限在 pnpm 全局 / Node 22.6–22.12 路径下必然超限（272 / 298），且 CLI 注册的任务默认 72 小时运行上限、无失败重启、电池供电不启动。改为 `schtasks /Create /XML` 注册：`install` 先用 `whoami` 取当前用户 SID 写入 Principal / LogonTrigger，`ExecutionTimeLimit PT0S`、`RestartOnFailure PT1M×3`、电池设置关闭，XML 以 UTF-16LE+BOM 写到 data-dir。进程身份：Windows 只信任 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` / `%ProgramFiles%\PowerShell\7\pwsh.exe`，超时 8 s，exec 读身份失败先重试一次再 terminal。daemon：`treeKillUnconfirmed` 采用最近一次 kill 结果（后续 `/T /F` 成功即清除）；win32 不再发无意义的 `taskkill /T`（无 `/F`）阶段，grace 后直接强制终止；exec 在 win32 也 `detached`；daemon 监听 SIGHUP / SIGBREAK。`cancel --kill` 在 Windows 根已退出时取消并告警「后代不可验证」。未改：`schtasks /End` 强杀语义（文档说明）；登录黑窗（待真机评估 S4U）；全部 Windows 行为仅有注入式单测与 PR 触发的 windows-latest job 覆盖，无真机验证
```

`.changeset/roll-schedule.md` 末尾追加一条：

```markdown
- Windows：服务改为 XML 注册（不受 `schtasks /TR` 261 字符限制，无 72 小时运行上限，失败后自动重启，电池供电不影响），进程身份只走 SystemRoot / ProgramFiles 下的 PowerShell 绝对路径且超时放宽到 8 秒，daemon 停止时不再发送对控制台进程无效的 `taskkill /T`，exec 子进程在 Windows 也脱离 daemon 控制台
```

- [ ] **Step 6: 校验并提交**

Run:
```bash
pnpm format:check
pnpm changeset status
```
Expected: 通过。

```bash
git add packages/core/src/cli/commands/schedule-cancel.ts docs/how-to-schedule-tasks.md docs/windows-compatibility.md docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md .changeset/roll-schedule.md
git commit -m "docs(scheduler): describe Windows stop/cancel semantics and the XML service registration"
```

---

### Task 5: CI windows-latest 覆盖 scheduler（W12）

**Files:**
- Modify: `.github/workflows/ci.yml:66-70`

- [ ] **Step 1: 增加两个 step**

把 `Targeted shell tests` step 之后追加：

```yaml
      - name: Scheduler unit tests
        run: >
          node --experimental-strip-types --experimental-sqlite --test
          packages/runtime/src/scheduler/schedule-store.test.ts
          packages/core/src/registry/process-identity.test.ts
          packages/core/src/scheduler-host/daemon.test.ts
          packages/core/src/scheduler-host/executor-liveness.test.ts
          packages/core/src/scheduler-host/service.test.ts
          packages/core/src/scheduler-host/stop-signals.test.ts
          packages/core/src/companion-host/service.test.ts
          packages/core/src/companion-host/identity.test.ts

      - name: Scheduler E2E smoke (diagnostic, non-blocking)
        continue-on-error: true
        run: >
          node --experimental-strip-types --experimental-sqlite --test
          packages/core/src/cli/smoke-schedule.e2e.ts
```

- [ ] **Step 2: 本地校验 YAML 与同一命令在 macOS 可跑**

Run:
```bash
node -e "require('node:fs').readFileSync('.github/workflows/ci.yml','utf8')" && node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/scheduler/schedule-store.test.ts packages/core/src/registry/process-identity.test.ts packages/core/src/scheduler-host/daemon.test.ts packages/core/src/scheduler-host/executor-liveness.test.ts packages/core/src/scheduler-host/service.test.ts packages/core/src/scheduler-host/stop-signals.test.ts packages/core/src/companion-host/service.test.ts packages/core/src/companion-host/identity.test.ts
```
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run scheduler unit tests on windows-latest"
```

---

### Task 6: 收尾验证与合并

- [ ] **Step 1: 全量校验**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm check:source-control-chars
pnpm --filter @roll-agent/runtime test
pnpm --filter @roll-agent/core test
pnpm test:e2e
```
Expected: 全绿（已知：`runtime-server.test.ts` 的 1.1 Turn timeout 用例在全仓连跑下偶发，隔离重跑即过）。

- [ ] **Step 2: GitNexus 变更范围**

`detect_changes({ scope: "compare", base_ref: "dev", repo: "roll-agent" })`，确认只触及 Companion-host / Scheduler-host / Registry(win32 分支) / Commands(schedule-*) 与文档。

- [ ] **Step 3: 重建 dist（IDE 读 .d.ts）**

Run: `pnpm --filter @roll-agent/runtime build && pnpm --filter @roll-agent/core build`

- [ ] **Step 4: 合并回 dev（不 push）**

```bash
git switch dev
git merge --ff-only fix/schedule-windows
git branch -d fix/schedule-windows
```

- [ ] **Step 5: 更新评估 artifact**

把报告的 W10 缩窄为「仅手动 foreground 路径」、新增 W13（72 h / 电池默认值）、每条加「状态」列（已修 / 文档 / 待真机），重新发布到同一 URL。

---

## Self-Review

- **Spec coverage**：W1 W2 W11 W13 → T1；W3 → T2；W4 W5 W6（daemon 侧）→ T3；W6（文档）W9 W10 → T4；W12 → T5；W7（登录黑窗）W8（后代探测）明确不在本轮，记入 windows-compatibility.md 待真机 / 可选项。
- **Placeholder scan**：所有代码步骤均给出完整代码；无 TBD。
- **Type consistency**：`WindowsTaskPrincipal { userId }` 在 T1 定义并在测试中使用；`SchedulerDaemonOptions.platform` 在 T3 定义与测试一致；`installStopSignals` 的 `target` 参数类型 `Pick<NodeJS.Process, "on" | "off">` 与测试的 fake 一致；`KILL_RESULTS.unverifiable` 已存在于 schedule-cancel.ts。

---

## 执行偏差记录（2026-08-26，实施后）

- Task 1：`escapeXmlText` 只转义 `& < >`（计划初稿用了会把引号转成 `&quot;` 的 `escapeXml`）；scheduler 侧 Windows plan 测试中 `<Command>` 断言改为平台无关写法（macOS 上 `createBundledRollInvocation` 会用 POSIX `resolve` 处理 Windows 路径）
- Task 2：`resolveTrustedWindowsPowerShellExecutables` 额外接受 `WINDIR`，只用第一个存在的候选；新增 `identityCommandTimeoutMs(platform)` seam；exec 侧 `readExecutorIdentityWithRetry`。`packages/core/src/config/document-store.test.ts` 原本靠 PATH 上的假 `powershell.exe` 模拟 Windows，正是本轮移除的行为，已改为直接测 `atomicTextFileWriter.write` 的 win32 分支（commit() 路径在模拟 win32 下不再覆盖）；接线回归测试用「cwd 下反斜杠命名的可信文件 + PATH 影子」证明不再走 PATH
- Task 3：超出计划的部分——`inline-exit.ts`（`decideInlineExit` / `createInlineStopForwarder` / `settleInlineInvocation`）、`SpawnedInvocation.kill(signal)` 改为必填、`installStopSignals(onStop(signal) → abort reason, onRepeat(signal))`、daemon `URGENT_STOP_REASON`（Windows SIGHUP 跳过 grace）、`treeKillUnconfirmed` 最近结果语义之外 inline 侧 `tree-terminated` 粘性 + 退出后封口
- 计划文件表之外：`packages/runtime/src/scheduler/schedule-store.ts` / `limits.ts` 新增 `maxLivenessProbesPerClaim`（默认 1）与 `livenessProbeDeferralMs`（15 s），`claimDue` 每事务最多探活 1 个过期 running 行；`companion-host/identity.ts` SID 改为取 `whoami` CSV 最后一列
- Task 5：windows-latest 单测清单扩到 12 个文件（含 `windows-system` / `windows-powershell` / `inline-exit` / `schedule-store-probe-budget`），诊断性 e2e 加 `timeout-minutes: 5`；`process-identity.test.ts` 的 PATH 影子用例在 win32 用 `skip` 而非静默 return
- Task 6：`pnpm format:check` 在 `dev` 上本来就有 64 个文件不合格（`.gitnexus/` 缓存、`agents/browser-use/src`、`.claude/skills/.../*.mjs` 等，均早于本分支），本分支全部改动文件单独 `prettier --check` 通过；`detect_changes({scope:"compare", base_ref:"dev"})` 两次结果均只触及 Companion-host / Scheduler-host / Registry(win32) / Commands(schedule-*) / runtime scheduler，风险 high 来自 `ScheduleStore.claimDue` 与 `SchedulerDaemon.run`
- 终审两轮追加：probe 名额按 `executor_probed_at`（新增持久化列）「最久未探活」轮转，`livenessProbeDeferralMs` 15 s 续租跳过行；`cancel --kill` 的 Windows 告警与 SIGHUP → 紧急停止映射分别抽成 `descendantsUnverified`（`scheduler-host/cancel-descendants.ts`）与 `stopReasonFor`（`daemon.ts`）并覆盖平台矩阵；`--json` 输出增加 `unverifiedDescendants`；daemon 增加 `urgentStopSettleMs` 选项并测试「子进程在 settle 窗口内不退出」分支；`schedule-store.test.ts` 的 POSIX 权限用例改用 `{ skip }`；windows-latest 清单再加 `cancel-descendants.test.ts`
- 未做（记入 spec 待拍板）：W7 登录黑窗（待真机评估 S4U）、W8 后代探测、bash 工具命令自成 session 不在 exec 进程组内、Windows `service stop` 对 detached exec 的补偿终止

