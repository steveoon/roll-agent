# roll chat coding 工具扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在第一轮文件工具（PR #221，同分支）之上新增检索层（`roll__grep` / `roll__glob`）、验证层（`roll__verify_file` 多语言注册表）、会话级批准记忆、write 导流与缩水防护，把「检索→编辑→验证」推成协议闭环。

**Architecture:** 全部沿用第一轮已验证的内建工具模式（`packages/runtime/src/tool-bridge/file-tools/` 下按工具一文件，Zod schema + `tool()` + `ToolExecutionPlan` + `gateToolCall` + `executeCoordinatedTool`）。新增横切面：批准记忆走 `ToolBridgeContext.approvalMemory` + `gateToolCall` 的 `memoryKey`（不传则完全不受影响）；协议面仅给 `approval.respond` 加可选 `scope` 字段（strip 语义双向兼容）。设计依据见 `docs/chat-coding-tools-design.md`。

**Tech Stack:** TypeScript（Type Stripping）、zod、ai、@vscode/ripgrep（新增）、yaml（新增，与 core 版本对齐）、node:test。

## Global Constraints

- Node.js ≥22.6.0；开发运行 `node --experimental-strip-types`
- `erasableSyntaxOnly`；导入相对路径**必须**带 `.ts` 扩展名；`import type` 分离
- 零 `any`；`exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess` 开启
- **核心代码零注释**；if/else **必须**花括号；Prettier 双引号/分号/尾逗号/100 行宽
- 测试同目录 `*.test.ts`；单文件跑法 `node --experimental-strip-types --test <path>`
- 每个 commit message 结尾：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- GitNexus：修改**既有**符号前跑 `impact({target, direction: "upstream", repo: "roll-agent"})`（HIGH/CRITICAL 先停下上报）；索引已知落后本分支，新增符号查不到属预期，误报用 `git diff` 证伪（先例见第一轮 Task 8/9 报告模式）
- **不可见字符纪律（第一轮四次事故的教训）**：任何 BOM/NBSP/零宽字符一律 Unicode escape 书写；直接在 Edit 参数里打 escape 序列可能被静默错转——用 node 脚本 `String.fromCharCode` 生成替换文本并对落盘结果做字节级核验
- 工具面向模型的文案一律中文
- 新增/修改文件最终须同时通过 `npx eslint` 与 `npx prettier --check`
- 本轮触及三个包：runtime（主体）、protocol（可选字段）、core（TUI）——changeset 三包

## File Structure

```
packages/runtime/src/approval/approval-memory.ts            (Task 1)
packages/runtime/src/tool-bridge/file-tools/rg-exec.ts       (Task 5)
packages/runtime/src/tool-bridge/file-tools/grep-tool.ts     (Task 6)
packages/runtime/src/tool-bridge/file-tools/glob-tool.ts     (Task 7)
packages/runtime/src/tool-bridge/file-tools/verifier-registry.ts (Task 8)
packages/runtime/src/tool-bridge/file-tools/verify-file-tool.ts  (Task 9)
修改：
packages/runtime/src/approval/approval-gate.ts               (Task 1: scope 字段)
packages/runtime/src/tool-bridge/build-tools.ts              (Task 1: gateToolCall memoryKey)
packages/runtime/src/tool-bridge/file-tools/{read,list-dir,edit,write}-file 工具 (Task 2)
packages/runtime/src/engine/agent-session.ts                 (Task 2: memory 实例；Task 9: 接线)
packages/protocol/src/index.ts                               (Task 3: respond scope)
packages/runtime/src/server/*（approval respond 处理点）      (Task 3: 透传)
packages/core/src/cli/chat/ink/*（确认组件）                  (Task 4: 三选项)
packages/runtime/src/tool-bridge/file-tools/index.ts         (Task 9: 组装)
packages/runtime/src/engine/capability-manifest.ts           (Task 9: file-verify role)
packages/runtime/src/engine/system-prompt.ts                 (Task 10: 纪律)
packages/runtime/package.json                                (Task 5: 依赖)
```

---

### Task 1: 批准记忆内核（approval-memory + ApprovalDecision.scope + gateToolCall）

**Files:**
- Create: `packages/runtime/src/approval/approval-memory.ts`
- Modify: `packages/runtime/src/approval/approval-gate.ts:1-4`（ApprovalDecision）
- Modify: `packages/runtime/src/tool-bridge/build-tools.ts`（ApprovalDisplayOptions + gateToolCall）
- Test: `packages/runtime/src/approval/approval-memory.test.ts`；`packages/runtime/src/tool-bridge/build-tools.test.ts`（若无则新建，只测 gateToolCall 记忆路径）

**Interfaces:**
- Consumes: 既有 `ApprovalDecision` / `ToolPolicy` / `failedToolResult`
- Produces（Task 2/4 依赖，签名逐字）:
  - `class SessionApprovalMemory { isGranted(key: string): boolean; grant(key: string): void }`
  - `ApprovalDecision` 增 `readonly scope?: "once" | "session"`
  - `ToolBridgeContext` 增 `readonly approvalMemory?: SessionApprovalMemory`
  - `ApprovalDisplayOptions` 增 `readonly memoryKey?: string`
  - gateToolCall 语义：`decision.action === "confirm"` 时，若 `display?.memoryKey` 且 `ctx.approvalMemory?.isGranted(memoryKey)` → 直接放行（返回 undefined，不发 requestApproval）；否则 requestApproval，`approval.approved && approval.scope === "session" && memoryKey` → `ctx.approvalMemory?.grant(memoryKey)`

- [ ] **Step 1: 写失败测试**

`approval-memory.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionApprovalMemory } from "./approval-memory.ts";

test("未授权的 key 返回 false，grant 后返回 true", () => {
  const memory = new SessionApprovalMemory();
  assert.equal(memory.isGranted("edit_file:workdir"), false);
  memory.grant("edit_file:workdir");
  assert.equal(memory.isGranted("edit_file:workdir"), true);
  assert.equal(memory.isGranted("write_file:workdir"), false);
});
```

`build-tools.test.ts` 追加（该文件不存在则新建，import 参照 file-tools/index.test.ts 的构造方式）：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionApprovalMemory } from "../approval/approval-memory.ts";
import { gateToolCall, type ApprovalRequest, type ToolBridgeContext } from "./build-tools.ts";

function confirmPolicyCtx(memory: SessionApprovalMemory | undefined, decisions: Array<{ approved: boolean; scope?: "once" | "session" }>) {
  const approvals: ApprovalRequest[] = [];
  const ctx: ToolBridgeContext = {
    policy: { check: () => ({ action: "confirm", reason: "测试" }) },
    requestApproval: (request) => {
      approvals.push(request);
      const next = decisions.shift();
      return Promise.resolve(next ?? { approved: false });
    },
    ...(memory ? { approvalMemory: memory } : {}),
  };
  return { ctx, approvals };
}

test("记忆命中时跳过 requestApproval", async () => {
  const memory = new SessionApprovalMemory();
  memory.grant("edit_file:workdir");
  const { ctx, approvals } = confirmPolicyCtx(memory, []);
  const result = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    memoryKey: "edit_file:workdir",
  });
  assert.equal(result, undefined);
  assert.equal(approvals.length, 0);
});

test("scope=session 的批准写入记忆，后续调用免确认", async () => {
  const memory = new SessionApprovalMemory();
  const { ctx, approvals } = confirmPolicyCtx(memory, [{ approved: true, scope: "session" }]);
  const first = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    memoryKey: "edit_file:workdir",
  });
  assert.equal(first, undefined);
  assert.equal(approvals.length, 1);
  const second = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {
    memoryKey: "edit_file:workdir",
  });
  assert.equal(second, undefined);
  assert.equal(approvals.length, 1);
});

test("scope 缺省的批准不写记忆，下次仍确认", async () => {
  const memory = new SessionApprovalMemory();
  const { ctx, approvals } = confirmPolicyCtx(memory, [{ approved: true }, { approved: true }]);
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, { memoryKey: "k" });
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, { memoryKey: "k" });
  assert.equal(approvals.length, 2);
});

test("无 memoryKey 或无 memory 时行为与既有一致", async () => {
  const { ctx, approvals } = confirmPolicyCtx(undefined, [{ approved: true, scope: "session" }]);
  await gateToolCall(ctx, "roll", "edit_file", {}, undefined, {});
  assert.equal(approvals.length, 1);
});

test("拒绝不写记忆", async () => {
  const memory = new SessionApprovalMemory();
  const { ctx } = confirmPolicyCtx(memory, [{ approved: false, scope: "session" }]);
  const result = await gateToolCall(ctx, "roll", "edit_file", {}, undefined, { memoryKey: "k" });
  assert.ok(result !== undefined);
  assert.equal(memory.isGranted("k"), false);
});
```

- [ ] **Step 2: 跑测试确认失败**（模块/字段不存在）
- [ ] **Step 3: 实现**

`approval-memory.ts`：

```ts
export class SessionApprovalMemory {
  private readonly granted = new Set<string>();

  isGranted(key: string): boolean {
    return this.granted.has(key);
  }

  grant(key: string): void {
    this.granted.add(key);
  }
}
```

`approval-gate.ts` 的 ApprovalDecision 增字段：

```ts
export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
  readonly scope?: "once" | "session";
}
```

`build-tools.ts`：`ToolBridgeContext` 增 `readonly approvalMemory?: SessionApprovalMemory;`（import type from `../approval/approval-memory.ts`，值 import 不需要）；`ApprovalDisplayOptions` 增 `readonly memoryKey?: string;`；`gateToolCall` 的 confirm 分支改为：

```ts
  if (decision.action === "confirm") {
    const memoryKey = display?.memoryKey;
    if (memoryKey !== undefined && ctx.approvalMemory?.isGranted(memoryKey)) {
      return undefined;
    }
    const approval = await ctx.requestApproval({
      agentName,
      toolName,
      input,
      reason: display?.includePolicyReason === false ? undefined : decision.reason,
      ...(display?.explanation !== undefined ? { explanation: display.explanation } : {}),
    });
    if (!approval.approved) {
      return failedToolResult(
        TOOL_OUTCOME_KINDS.userRejected,
        `已取消执行${approval.reason ? `: ${approval.reason}` : ""}`,
        approval.reason ? { reason: approval.reason } : {},
      );
    }
    if (memoryKey !== undefined && approval.scope === "session") {
      ctx.approvalMemory?.grant(memoryKey);
    }
  }
```

改前对 `gateToolCall` 跑 impact（upstream）。

- [ ] **Step 4: 跑测试 + typecheck 确认通过**
- [ ] **Step 5: Commit** `feat(runtime): add session approval memory with opt-in scope on approval decisions`

---

### Task 2: 文件工具接记忆 + 缩水防护 + 导流

**Files:**
- Modify: `packages/runtime/src/tool-bridge/file-tools/edit-file-tool.ts`（memoryKey + 导流文案）
- Modify: `packages/runtime/src/tool-bridge/file-tools/write-file-tool.ts`（memoryKey + 缩水防护）
- Modify: `packages/runtime/src/tool-bridge/file-tools/read-file-tool.ts` 与 `list-dir-tool.ts`（external 确认接 memory）
- Modify: `packages/runtime/src/engine/agent-session.ts`（构造 SessionApprovalMemory 放进 file toolset ctx）
- Test: 各工具 test 文件追加用例

**Interfaces:**
- Consumes: Task 1 全部产出；既有 `escapesWorkdir`（file-io.ts）
- Produces: memoryKey 约定 `${toolName}:workdir` / `${toolName}:external`（Task 4 的 UI 文案不依赖 key 形态）

**行为规格（每条都要有测试）：**
1. edit/write 的 prepare：计算 `const memoryKey = \`${TOOL_NAME}:${escapesWorkdir(settings.workdir, parsed.data.file_path) ? "external" : "workdir"}\`;` 传入 gateToolCall display
2. read/list 的 external 分支（第一轮 final fix 加的 requestApproval 直调）改为经 memory：先 `ctx.approvalMemory?.isGranted(key)` 命中跳过；未命中 requestApproval；`approved && scope==="session"` → grant。key 用 `${TOOL_NAME}:external`
3. **缩水防护**：write 的 prepare 中目标存在时读取原文件行数（`loadTextFile` 成功才比较；读取失败不拦截，交给 execute 阶段报错），`原行数 >= 20 && 新行数 < 原行数 * 0.5` 时：explanation 追加 `⚠ 新内容 ${新}行，比原文件 ${原} 行减少 ${百分比}%，请确认是有意删减`，且**该次调用不传 memoryKey**（强制确认不吃记忆）
4. **导流**：edit 的 no-match 失败返回尾部追加一行 `若修改面较大或文件已大幅变化，可改用 roll__write_file 整文件重写（需先 read_file）`
5. AgentSession constructor：`const fileApprovalMemory = new SessionApprovalMemory();` 放进 buildFileToolset 的 ctx（仅 file toolset ctx，bashCtx 不加）

测试要点（各文件追加）：
- edit：workdir 内 scope=session 批准后第二次编辑不再触发 requestApproval（用 index.test.ts 的 buildFixture 模式端到端）
- write：缩水场景（30 行文件覆盖为 5 行）触发的 approval request 的 explanation 含「有意删减」；且即使 memory 已 grant `write_file:workdir` 仍会弹（approvals 计数 +1）；非缩水覆盖吃记忆
- read：external 路径 scope=session 批准后第二次免弹
- edit no-match 返回文案含「roll__write_file 整文件重写」

- [ ] Step 1 写失败测试 → Step 2 跑红 → Step 3 实现 → Step 4 跑绿（全 file-tools 测试 + agent-session.test.ts 回归 + typecheck） → Step 5 Commit `feat(runtime): wire approval memory into file tools with shrink guard and write-file steering`

改 agent-session.ts 前对 `AgentSession` 跑 impact（第一轮已裁决过 hub 结构性 HIGH 的处理先例：增量可选改动 + 调用点核实后继续并报告）。

---

### Task 3: protocol respond scope 字段 + server 侧透传

**Files:**
- Modify: `packages/protocol/src/index.ts:1360-1368`（approvalRespondParamsSchema）
- Modify: runtime server 侧 approval respond 处理点（先探查：`rg -n "approvalRespond\|approval.respond" packages/runtime/src/server/ -l`，找到把 respond params 转成 `ApprovalGate.resolve(approvalId, decision)` 的位置）
- Test: protocol 的 schema 测试文件（探查 `packages/protocol/src/index.test.ts` 中 approvalRespond 既有用例位置）+ server 侧透传用例（参照该处理点既有测试）

**Interfaces:**
- Consumes: Task 1 的 `ApprovalDecision.scope`
- Produces: `approvalRespondParamsSchema` 增 `scope: z.enum(["once", "session"]).optional()`；server 把 params.scope 透传进 resolve 的 decision

**行为规格：**
1. schema 增可选字段（z.object 默认 strip——旧客户端不传即 undefined，旧服务端收到新字段静默忽略，双向兼容，无需 bump 协议版本；在测试中显式断言这两个方向）
2. server 处理点：respond params → `{ approved: params.decision === "approve", ...(params.reason ? { reason } : {}), ...(params.scope ? { scope: params.scope } : {}) }`（以探查到的实际转换代码为准做等价增量）
3. 测试：schema 解析带 scope / 不带 scope 均成功；带非法值失败；server 透传用例断言 resolve 收到的 decision.scope

- [ ] Step 1 探查两处实际代码位置（报告记录 file:line） → Step 2 写失败测试 → Step 3 跑红 → Step 4 实现 → Step 5 跑绿（protocol 与 runtime 两包 typecheck + 相关测试文件） → Step 6 Commit `feat(protocol): optional approval scope field for session-level approval memory`

改 schema 前对 `approvalRespondParamsSchema` 跑 impact。

---

### Task 4: TUI 确认三选项（探查型任务）

**Files:**
- Modify: `packages/core/src/cli/chat/ink/use-session.ts`（`resolveConfirm: (ln: boolean) => void` 布尔确认改三态）
- Modify: ink 目录下渲染确认选项的组件（探查：`ls packages/core/src/cli/chat/ink/` + `rg -n "resolveConfirm\|确认\|approve" packages/core/src/cli/chat/ink/`）
- Test: 该组件/hook 的既有测试文件追加（探查既有测试模式；Ink 组件若无测试基建则以 hook 层测试为准，UI 层留 smoke 说明）

**Interfaces:**
- Consumes: Task 1 的 `ApprovalDecision`（core 从 runtime import 的路径探查确认）
- Produces: 确认交互三选项——「允许一次 / 允许并且本会话内不再询问 / 拒绝」，分别产生 `{approved:true}` / `{approved:true, scope:"session"}` / `{approved:false}`

**行为规格：**
1. 现状是 `Promise<boolean>` 决策流——改为决策对象（保持既有两个选项行为逐字不变，新增第三选项）
2. 键位：探查现有确认的按键约定（y/n 或方向键选择），第三选项遵循同风格；文案「允许并且本会话内不再询问」
3. basic REPL（非 Ink 路径，若存在确认交互）**不改**——不传 scope 即 once，渐进覆盖
4. 探查中若发现确认链路与 AgentSession.requestApproval 的对接层有类型收窄（boolean 假设扩散多处），只做最小传播，逐处记录

- [ ] Step 1 探查（组件位置/决策流/测试基建，写进报告） → Step 2 失败测试 → Step 3 实现 → Step 4 core 包 typecheck + 相关测试 + `pnpm --filter @roll-agent/core test` 回归 → Step 5 Commit `feat(core): three-way approval prompt with session-scope remember option`

改 use-session.ts 前对其导出符号跑 impact。若探查发现改动面显著超出「确认组件 + hook」（例如 boolean 假设扩散到 5+ 文件），停下 BLOCKED 上报而不是扩大重构。

---

### Task 5: rg 基建（依赖 + rg-exec helper）

**Files:**
- Modify: `packages/runtime/package.json`（dependencies 增 `@vscode/ripgrep` 与 `yaml`——版本：ripgrep 用 npm 最新 1.x（`npm view @vscode/ripgrep version` 核实）；yaml 与 core 的 package.json 中 yaml 版本对齐（先 `rg '"yaml"' packages/core/package.json` 核实实际版本））
- Create: `packages/runtime/src/tool-bridge/file-tools/rg-exec.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/rg-exec.test.ts`

**Interfaces:**
- Produces（Task 6/7 依赖）:
  - `interface RgRunResult { readonly ok: boolean; readonly stdout: string; readonly truncated: boolean; readonly errorMessage?: string }`
  - `function runRg(args: readonly string[], cwd: string, options?: { readonly timeoutMs?: number; readonly maxOutputBytes?: number }): Promise<RgRunResult>`
  - 语义：`execFile(rgPath, args, { cwd, timeout, maxBuffer })`；rg 退出码 0（有命中）与 1（无命中）都算 ok（stdout 为空即无命中）；退出码 2 或 spawn 失败 → ok:false + errorMessage；输出超 maxOutputBytes（默认 1 MiB）截断并标记 truncated；默认 timeoutMs 10_000

- [ ] **Step 1: 加依赖并核实**

```bash
npm view @vscode/ripgrep version
rg '"yaml"' packages/core/package.json
```
把两个版本写进 package.json 后 `pnpm install`，然后：
```bash
node -e "const { rgPath } = require('@vscode/ripgrep'); console.log(require('fs').existsSync(rgPath));"
```
Expected: true

- [ ] **Step 2: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRg } from "./rg-exec.ts";

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

test("输出超限被截断并标记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-exec-test-"));
  writeFileSync(join(dir, "big.txt"), "line\n".repeat(5000), "utf8");
  const result = await runRg(["--line-number", "line", "."], dir, { maxOutputBytes: 1024 });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 2048);
});
```

- [ ] **Step 3: 跑红 → 实现**

```ts
import { execFile } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RgRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly truncated: boolean;
  readonly errorMessage?: string;
}

export function runRg(
  args: readonly string[],
  cwd: string,
  options: { readonly timeoutMs?: number; readonly maxOutputBytes?: number } = {},
): Promise<RgRunResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    execFile(
      rgPath,
      [...args],
      {
        cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: maxOutputBytes * 2,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "number" && error.code > 1) {
          resolve({ ok: false, stdout: "", truncated: false, errorMessage: stderr.trim() || error.message });
          return;
        }
        if (error && typeof error.code !== "number") {
          resolve({ ok: false, stdout: "", truncated: false, errorMessage: error.message });
          return;
        }
        const raw = stdout;
        if (Buffer.byteLength(raw, "utf8") > maxOutputBytes) {
          const clipped = Buffer.from(raw, "utf8").subarray(0, maxOutputBytes).toString("utf8");
          const lastNewline = clipped.lastIndexOf("\n");
          resolve({ ok: true, stdout: lastNewline > 0 ? clipped.slice(0, lastNewline) : clipped, truncated: true });
          return;
        }
        resolve({ ok: true, stdout: raw, truncated: false });
      },
    );
  });
}
```

注意：execFile 的 timeout 触发时 error.killed=true 且 code 可能为 null——归入 ok:false 分支（errorMessage 含 timeout 语义，实现时核实 error 对象形态并在测试外用手动脚本验证一次超时路径，不写超时自动化测试——不稳定）。

- [ ] **Step 4: 跑绿 + typecheck** → **Step 5: Commit** `feat(runtime): add ripgrep execution helper and yaml dependency for coding tools`

---

### Task 6: roll__grep

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/grep-tool.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/grep-tool.test.ts`

**Interfaces:**
- Consumes: Task 5 `runRg`；既有 `escapesWorkdir`/`resolveFilePath`/`canonicalFileKey`、`normalizeForMatch`（0 命中诊断）、settings、gateToolCall/coordinator 模式（参照 read-file-tool.ts + 第一轮 final fix 后的 external 确认结构，external 确认接 Task 2 的 memory 模式）
- Produces（Task 9 依赖）: `GREP_TOOL_NAME = "grep"`；`executeGrep(settings, input): Promise<NormalizedToolResult>`；`buildGrepTool(settings, registry, ctx): ToolSet`

**Schema：**

```ts
const grepInputSchema = z.object({
  pattern: z.string().min(1).describe("搜索正则（ripgrep 语法）"),
  path: z.string().min(1).optional().describe("搜索目录或文件，相对当前工作目录或绝对路径，默认工作目录"),
  glob: z.string().min(1).optional().describe('按 glob 过滤文件，如 "**/*.ts"'),
  context: z.number().int().min(0).max(10).optional().describe("每处命中前后附带的行数，默认 0"),
  ignore_case: z.boolean().optional().describe("忽略大小写，默认 false"),
  max_results: z.number().int().min(1).max(500).optional().describe("最多返回的命中行数，默认 100"),
});
```

**行为规格（测试逐条覆盖）：**
1. rg argv：`["--line-number", "--no-heading", "--color", "never", ...(ignore_case ? ["-i"] : []), ...(context ? ["-C", String(context)] : []), ...(glob ? ["-g", glob] : []), "--max-count", "50", "-e", pattern, resolvedPath]`；`-e` 防 pattern 以 `-` 开头被当 flag
2. 输出解析：rg 的 `path:line:content`（context 行是 `path-line-content`）重组为按文件分组：文件头一行绝对路径，命中行 `${String(行号).padStart(5)}→内容`（与 read_file 同构）；总命中行数超 max_results 截停 + 提示
3. 0 命中：`未找到匹配。` + 若 `normalizeForMatch(pattern).text !== pattern` 追加 `pattern 含全角/智能标点，文件中可能是半角形式，试试：<归一化后>`
4. rg 报错（ok:false）→ invalidInput + errorMessage（正则语法错误可读）
5. workdir 外 path → external 确认（memory key `grep:external`，接 Task 2 模式）；readOnly annotations；resources `file:<canonical>` read
6. truncated → 尾注「结果过多已截断，请缩小范围（加 glob 或更精确的 pattern）」

测试用例：基本命中格式（分组 + 行号箭头）、context 行渲染、glob 过滤生效、ignore_case、0 命中 + 归一化提示（pattern 用全角逗号）、非法正则报错、max_results 截断、workdir 外确认（fake approval）。

- [ ] TDD 五步 + Commit `feat(runtime): add roll__grep builtin tool with read-contract output and normalization hint`

---

### Task 7: roll__glob

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/glob-tool.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/glob-tool.test.ts`

**Interfaces:**
- Consumes: Task 5 `runRg`；同 Task 6 的既有资产
- Produces（Task 9 依赖）: `GLOB_TOOL_NAME = "glob"`；`executeGlob(settings, input)`；`buildGlobTool(settings, registry, ctx)`

**Schema 与行为：**

```ts
const globInputSchema = z.object({
  pattern: z.string().min(1).describe('文件名 glob，如 "**/*.md" 或 "src/**/config.*"'),
  path: z.string().min(1).optional().describe("起始目录，相对当前工作目录或绝对路径，默认工作目录"),
});
```

1. rg argv：`["--files", "--glob", pattern, resolvedPath]`
2. 结果按 mtime 降序（statSync 逐个取，失败的排最后）、上限 200 条 + 「共 N 个文件，仅显示前 200 个（按修改时间倒序）」
3. 0 命中：「未找到匹配 <pattern> 的文件。」
4. workdir 外 path → external 确认（key `glob:external`）；readOnly；resources read

测试：命中按 mtime 排序（写两个文件控制 mtime——utimesSync 显式设置避免时钟粒度 flaky）、上限截断、0 命中、pattern 过滤正确性、workdir 外确认。

- [ ] TDD 五步 + Commit `feat(runtime): add roll__glob builtin tool backed by ripgrep file listing`

---

### Task 8: 验证器注册表基建 verifier-registry.ts

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/verifier-registry.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/verifier-registry.test.ts`

**Interfaces:**
- Produces（Task 9 依赖，签名逐字）:

```ts
export const VERIFIER_LEVELS = { fast: "fast", project: "project" } as const;
export type VerifierLevel = (typeof VERIFIER_LEVELS)[keyof typeof VERIFIER_LEVELS];

export interface VerifierCommand {
  readonly bin: string;
  readonly args: readonly string[];
}

export interface Verifier {
  readonly id: string;
  readonly level: VerifierLevel;
  readonly detect: (workdir: string, filePath: string) => boolean;
  readonly command: (workdir: string, filePath: string) => VerifierCommand | "builtin-json" | "builtin-yaml";
  readonly timeoutMs: number;
}

export function verifiersForFile(filePath: string): readonly Verifier[];
export function runVerifier(verifier: Verifier, workdir: string, filePath: string): Promise<VerifierOutcome>;

export type VerifierOutcome =
  | { readonly id: string; readonly status: "pass" }
  | { readonly id: string; readonly status: "fail"; readonly output: string }
  | { readonly id: string; readonly status: "skipped"; readonly reason: string };
```

**注册表内容（detect 全部零配置探测，探测不过由 Task 9 转为 skipped）：**

| id | 扩展名 | level | detect | command |
|---|---|---|---|---|
| eslint | .ts .tsx .mts .cts .js .jsx .mjs .cjs | fast | `existsSync(join(workdir, "node_modules/.bin/eslint"))` 且 workdir 向上找得到 eslint 配置（`eslint.config.{js,mjs,cjs,ts}` 或 `.eslintrc*`——只查 workdir 一层即可，不向上递归，简化） | `{bin: join(workdir, "node_modules/.bin/eslint"), args: ["--no-fix", filePath]}` |
| tsc | .ts .tsx .mts .cts | project | 本地 `node_modules/.bin/tsc` + workdir 下有 `tsconfig.json` | `{bin: <local tsc>, args: ["--noEmit"]}` |
| ruff | .py | fast | PATH 探测（`spawnSync("ruff", ["--version"])` status===0；探测结果模块级缓存） | `{bin: "ruff", args: ["check", "--no-fix", filePath]}` |
| py-compile | .py | fast | PATH 探测 python3；仅当 ruff 探测失败时作为兜底进入候选 | `{bin: "python3", args: ["-m", "py_compile", filePath]}` |
| json | .json | fast | 恒 true | `"builtin-json"`（readFileSync + JSON.parse，SyntaxError → fail） |
| yaml | .yaml .yml | fast | 动态 `import("yaml")` 可用（缓存探测结果） | `"builtin-yaml"`（parse，异常 → fail） |
| bash-syntax | .sh .bash | fast | PATH 探测 bash | `{bin: "bash", args: ["-n", filePath]}` |
| gofmt | .go | fast | PATH 探测 gofmt | `{bin: "gofmt", args: ["-l", filePath]}`（stdout 非空 = fail：文件未格式化） |
| go-vet | .go | project | PATH gofmt 同探测 + workdir 有 go.mod | `{bin: "go", args: ["vet", "./..."]}` |
| cargo-check | .rs | project | workdir 有 Cargo.toml + PATH cargo | `{bin: "cargo", args: ["check", "--quiet"]}` |

**runVerifier 语义：** builtin 直接进程内执行；外部命令 `execFile(bin, args, {cwd: workdir, timeout: verifier.timeoutMs, maxBuffer: 512*1024})`——退出码 0 → pass（gofmt 特例：exit 0 且 stdout 非空 → fail）；非 0 → fail，output = (stdout+stderr) 截断 4000 字符；spawn/timeout 错误 → fail，output 含错误描述。fast timeoutMs 10_000，project 120_000。

测试（真实文件系统，外部二进制类只测「探测失败→skipped 语义由 Task 9 处理」与 argv 构造正确性，不假设 CI 机器装了 ruff/go/cargo）：
- verifiersForFile 的扩展名路由（.ts 含 eslint+tsc、.py 的 ruff/兜底逻辑、.json/.yaml/.sh）
- builtin-json：合法/非法 JSON 的 pass/fail
- builtin-yaml：探测可用性（本仓 runtime 已加 yaml 依赖，应可用）+ 合法/非法
- bash-syntax：`bash -n` 对合法/语法错误脚本（bash 在 macOS/Linux CI 均可用）
- eslint detect：临时目录无 node_modules → false
- gofmt 的 stdout 非空判 fail 逻辑（用注入 execFile 的可测结构或直接单测该判定函数——实现时把「outcome 判定」抽成纯函数 `outcomeFromExecution(verifier, exitCode, stdout, stderr)` 以便零依赖单测）

- [ ] TDD 五步 + Commit `feat(runtime): add multi-language verifier registry with zero-config detection`

---

### Task 9: roll__verify_file 工具 + 接线（grep/glob/verify 进 toolset）

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/verify-file-tool.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/verify-file-tool.test.ts`
- Modify: `packages/runtime/src/tool-bridge/file-tools/index.ts`（buildFileToolset 组装三个新工具）
- Modify: `packages/runtime/src/engine/capability-manifest.ts`（CAPABILITY_TOOL_ROLES 增 `fileVerify: "file-verify"`；CAPABILITY_APPROVAL_BY_ROLE 不加条目——runtimePolicy 默认）
- Modify: `packages/runtime/src/engine/agent-session.ts`（markToolRole：grep/glob 归 fileRead，verify 归 fileVerify）
- Test: `index.test.ts` 与 `agent-session.test.ts` 追加断言

**Interfaces:**
- Consumes: Task 8 全部；Task 2 的 memory 模式
- Produces: `VERIFY_FILE_TOOL_NAME = "verify_file"`；`buildVerifyFileTool(settings, registry, ctx)`；`BuiltFileToolset` 增 `readonly verifyTools: ToolSet`（readTools 增 grep/glob）

**verify_file 行为规格：**

```ts
const verifyFileInputSchema = z.object({
  path: z.string().min(1).describe("要验证的文件路径"),
  level: z.enum(["fast", "project"]).optional().describe("fast=单文件快速检查（默认）；project=项目级完整检查（较慢，需确认）"),
});
```

1. prepare：fast → annotations `{readOnlyHint: true}` 走 gateToolCall（allow）；project → annotations `{}` + explanation `项目级验证 <path>（将执行 <命令列表>）` 走 confirm（不传 memoryKey——项目级每次确认）
2. execute：`verifiersForFile(path)` 按 level 过滤 → 逐个 detect：不过 → `skipped(未安装或未配置 <id>)`；过 → runVerifier。文件不存在 → invalidInput
3. 返回格式：

```
验证 <绝对路径>：
✓ eslint 通过
✗ ruff 失败：
  <output 截断>
– tsc 跳过（level=fast 未包含，用 level: "project" 运行）
– gofmt 跳过（未安装）
```

结尾规则（fail-honest）：至少一个 fail → 总结「验证发现问题，请修复后重试」；全部 skipped → 「该文件类型当前无可用验证器（未安装或未配置），本次未做任何验证」；有 pass 无 fail → 「验证通过（<通过的 id 列表>）」。project 级候选存在但 level=fast 时列出提示行
4. resources：`file:<canonical>` read + `verify:<workdir>` write（验证器可能写缓存，保守串行）

接线：readTools 增 grep/glob；新 `verifyTools` 组；agent-session markToolRole 三组；conversation-engine 无需改（fileTools 开关整体控制）。

测试：verify 对 .json 合法/非法端到端（builtin 路径全真实）；level=project 走确认（fake approval 记录）而 fast 不确认；全 skipped 场景文案（.rs 文件且无 cargo 探测——detect 注入或用不存在的扩展名 .xyz → 「无可用验证器」）；index.test 断言 7 个工具注册与分组；agent-session.test 断言 file-verify role 出现。

- [ ] TDD 五步（agent-session/capability-manifest 改前跑 impact） + Commit `feat(runtime): add roll__verify_file with fail-honest multi-language verification and wire coding tools`

---

### Task 10: prompt 纪律 + 全量回归 + changeset

**Files:**
- Modify: `packages/runtime/src/engine/system-prompt.ts`（文件工具节追加三条 + fileToolIds 增 grep/glob/verify id）
- Test: `system-prompt.test.ts` 追加
- Create: `.changeset/chat-coding-tools.md`

**Steps：**
1. `FileToolPromptIds` 增 `grep` / `glob` / `verify` 字段（manifest 提取按 role file-read + endsWith("grep"/"glob")、file-verify + endsWith("verify_file")，缺任一则整体不注入的既有 AND 门禁语义保持——三个新工具与原四个一体注入）；纪律追加：
   - `在文件中搜索内容用 ${grep}（结果行号可直接用作 ${read} 的 offset），按文件名找文件用 ${glob}；不要用 shell 的 grep/find 代替。`
   - `修改代码文件后用 ${verify} 验证（默认 fast 级）；验证失败先修复再汇报完成，验证被跳过时如实说明未验证。`
2. 全量：`pnpm typecheck && pnpm lint && pnpm test`；失败先判断与本分支相关性（无关 flaky 重跑一次并记录）
3. detect_changes：`{scope: "compare", base_ref: "7d8e690", worktree: "<本 worktree 绝对路径>", repo: "roll-agent"}`——索引过期误报用 git diff 证伪（先例：第一轮 Task 8/9/10 报告）
4. 包名核对（`node -e "console.log(require('./packages/{runtime,protocol,core}/package.json').name)"`) 后写 changeset：

```markdown
---
"@roll-agent/runtime": minor
"@roll-agent/protocol": patch
"@roll-agent/core": patch
---

roll chat coding 工具扩展：roll__grep / roll__glob（ripgrep 后端，输出与 read/edit 契约耦合，全角标点归一化提示）、roll__verify_file（多语言验证器注册表，fast/project 分级，fail-honest）、会话级批准记忆（确认弹窗三选项「允许并本会话不再询问」，协议 approval.respond 增可选 scope 字段向后兼容）、write_file 缩水防护与 edit→write 导流。
```

5. `pnpm changeset status` 验证 → Commit（prompt+回归一个 commit：`feat(runtime): add coding tools discipline to chat system prompt`；changeset 单独：`chore: add changeset for chat coding tools`）

---

## Self-Review 记录

- **Spec 覆盖**：设计 §3.1 grep → Task 5/6；§3.2 glob → Task 7；§3.3 verify → Task 8/9；§3.4 导流缩水 → Task 2；§4 批准记忆 → Task 1（内核）/2（工具）/3（协议）/4（TUI）；§5 纪律 → Task 10；§7 决策全部落在对应任务的规格里。§6 真实场景验证是落地后的人工活动，无任务（有意）。
- **类型一致性**：`SessionApprovalMemory`/`memoryKey`/`scope` 在 Task 1 定义、2/3/4 消费；`runRg`/`RgRunResult` Task 5 定义、6/7 消费；`Verifier*` 家族 Task 8 定义、9 消费；`BuiltFileToolset.verifyTools` Task 9 定义并接线。
- **探查型步骤**（非 placeholder，均给了行为规格 + 探查命令 + BLOCKED 条件）：Task 3 的 server respond 处理点、Task 4 的 ink 确认组件、Task 5 的依赖版本核实。
- **第一轮教训内化**：不可见字符纪律进 Global Constraints；detect_changes 的 worktree/repo 参数写死在 Task 10；impact 的 hub-HIGH 处理先例在 Task 2 注明。
