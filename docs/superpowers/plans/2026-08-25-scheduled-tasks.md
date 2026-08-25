# roll 定时任务 v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户用 `roll schedule add --name … --every 30m --prompt "…"` 登记重复任务，由 `roll schedule daemon` 常驻进程按时 spawn `roll schedule exec` 子进程跑一轮无人值守的 chat turn（新 thread、`background` host mode、审批一律拒绝、来源标记只进推理副本），每次触发有持久 invocation 账本，失败有重试预算并自动 PAUSE。

**Architecture:** runtime 新增 `scheduler/`（trigger、ScheduleStore、claim/lease/retry 状态机，node:sqlite）与四处小的引擎改动（`background` host mode、`UnattendedToolPolicy`、turn origin 走 `resolveDynamicCapabilityContext`、后台不建 agent-install 工具）；core 把 chat.ts 的 Engine factory 与 `runJsonTurn` 搬到 `runtime-host/`（chat.ts re-export，零调用方改动），新增 `scheduler-host/`（daemon、exec、spawn、daemon 记录）与 `roll schedule …` 命令组；OS service 复用 companion `service.ts` 控制器（参数化 label/plist/task name）。

**Tech Stack:** TypeScript（Node type stripping：`.ts` import、`import type`、零 `any`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`erasableSyntaxOnly`、if/else 必须花括号、核心代码零注释、Prettier 100 列）、node:test + node:assert/strict、node:sqlite（`--experimental-sqlite`）、zod 3.25、citty。

**Spec:** `docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md`

## Global Constraints

- 时间列一律 epoch **毫秒** INTEGER；记录字段名 `*AtMs` / `*ForMs`；对外 JSON 打印时再转 ISO。
- 数值上限只在 `packages/runtime/src/scheduler/limits.ts` 的 `SCHEDULER_LIMITS` 出现一次：`minIntervalMs 60_000、claimLeaseMs 120_000、leaseRenewIntervalMs 30_000、retryBudget 3、retryBackoffMs 10_000、pollIntervalMs 15_000、maxNameChars 120、maxPromptChars 4_000、maxOutputExcerptChars 4_000`。CLI 文案与 tool/description 引用常量，不写字面量。
- 配置键：`scheduler.data-dir`（默认 `~/.roll-agent/scheduler`）、`scheduler.max-schedules`（50，1..500）、`scheduler.max-concurrent-runs`（2，1..8）。
- 间隔低于 60 s **报错**，不 clamp。
- 派发写入：claim 之后每一条 UPDATE 都带 `AND ownership_token = ?`，用 `changes === 1` 判断是否仍持有 claim。
- 新增 host mode 字面量 `"background"`；新增 turn origin 字段 `origin`；`CAPABILITY_TURN_CONTEXT_VERSION` 1 → 2（grep 所有断言 `=== 1` / `version, 1` 的测试一并改）。
- `packages/runtime` 对 core 只是 devDependency：runtime 的 scheduler 模块**不得** import `@roll-agent/core/*`。
- 修改既有导出符号前先跑 GitNexus `impact({ target: "<symbol>", direction: "upstream", repo: "roll-agent" })`（索引落后 23 commits，再用 `rg` 复核调用方）；HIGH/CRITICAL 先在汇报里说明。
- 测试命令：runtime `node --experimental-strip-types --experimental-sqlite --test <file>`；core 同样两个 flag；core e2e `node --experimental-strip-types --experimental-sqlite --test packages/core/src/cli/<file>.e2e.ts`。改完 `.ts` 跑 `npx prettier --write <files>` 与 `npx eslint <files>`；提交前 `pnpm check:source-control-chars`。`*.md` 不跑 prettier。
- 源码里不能出现原始控制字符；保留锁名的 NUL 前缀写成 `String.fromCharCode(0)`。
- 提交信息：`feat(runtime): …` / `feat(core): …` / `test(core): …` / `docs: …`，末尾附 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- **不要执行** `git restore` / `git checkout -- <file>` / `git reset` / `git stash`（工作树有其他会话的未提交改动：`.gitignore`、`docs/rfc-*.md`）。
- 行号以 commit `d71bcd2` 为准；编辑后行号会漂移，**按内容定位**。引用的标识符写入前先 `rg` 确认存在。
- 每个 Task 结束时对应包 `pnpm --filter <pkg> typecheck` 必须零错误。

## 文件结构

| 路径 | 责任 |
|---|---|
| `packages/core/src/config/schema.ts` / `loader.ts` | `scheduler` 配置段 + tilde 展开 |
| `packages/runtime/src/scheduler/limits.ts` | 数值上限单一来源 |
| `packages/runtime/src/scheduler/trigger.ts` | TriggerSpec（v1 interval）解析/格式化/下次触发 |
| `packages/runtime/src/scheduler/types.ts` | 状态常量、记录类型、错误类型 |
| `packages/runtime/src/scheduler/schedule-store.ts` | SQLite 存储：schedules CRUD、invocations claim/lease/complete/fail |
| `packages/runtime/src/policy/unattended-policy.ts` | confirm → deny 并记录 |
| `packages/runtime/src/engine/capability-manifest.ts` | `background` host mode、`CapabilityTurnOrigin`、sanitizer |
| `packages/runtime/src/engine/system-prompt.ts` | 无人值守段、reminder origin 行 |
| `packages/runtime/src/engine/agent-session.ts` / `conversation-engine.ts` | origin 透传、process-bound 文案、后台不建 agent-install |
| `packages/core/src/runtime-host/engine-factory.ts` / `json-turn.ts` | 从 chat.ts 搬出的 Engine 组装与 JSON turn |
| `packages/core/src/scheduler-host/paths.ts` | 路径与 service 标识 |
| `packages/core/src/scheduler-host/execute-invocation.ts` | begin → runTurn → complete/fail |
| `packages/core/src/scheduler-host/run-scheduled-turn.ts` | 真实 runner（引擎 + 无人值守 policy + origin） |
| `packages/core/src/scheduler-host/spawn-invocation.ts` | spawn exec 子进程 |
| `packages/core/src/scheduler-host/daemon.ts` | `SchedulerDaemon` tick 循环 |
| `packages/core/src/scheduler-host/daemon-record.ts` | daemon.json 写/读/校验 |
| `packages/core/src/cli/commands/schedule*.ts` | `roll schedule …` 命令组 |
| `packages/core/src/companion-host/service.ts` / `invocation.ts` | 参数化 service plan；`execArgv` / `schedulerArgs` |

## 并行建议

- Task 1（core config）、Task 2（runtime trigger）、Task 5（policy）互不依赖，可并行。
- Task 3 → Task 4 串行；Task 6 → Task 7 串行；Task 8 依赖 Task 6；Task 9 依赖 4/5/7/8；Task 10 依赖 3；Task 11 依赖 4；Task 12 依赖 9/10/11；Task 13 依赖 12；Task 14 最后。

---

### Task 1: `scheduler` 配置段

**Files:**
- Modify: `packages/core/src/config/schema.ts:97-109`（`runtimeConfigSchema` 之后）、`:224-243`
- Modify: `packages/core/src/config/loader.ts:124-159`（`expandPaths`）
- Test: `packages/core/src/config/schema.test.ts`、`packages/core/src/config/loader.test.ts`

**Interfaces:**
- Produces: `schedulerConfigSchema`、`SchedulerConfig`、`RollConfig["scheduler"] = { dataDir: string; maxSchedules: number; maxConcurrentRuns: number }`

- [ ] **Step 1: 写失败的 schema 测试**

在 `packages/core/src/config/schema.test.ts` 的 `describe("rollConfigSchema", …)` 内追加：

```ts
  it("should default scheduler section", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      agents: { dataDir: "/tmp" },
    });
    assert.equal(result.success, true);
    if (!result.success) {
      return;
    }
    assert.equal(result.data.scheduler.dataDir, "~/.roll-agent/scheduler");
    assert.equal(result.data.scheduler.maxSchedules, 50);
    assert.equal(result.data.scheduler.maxConcurrentRuns, 2);
  });

  it("should reject scheduler max-concurrent-runs above 8", () => {
    const result = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      agents: { dataDir: "/tmp" },
      scheduler: { maxConcurrentRuns: 9 },
    });
    assert.equal(result.success, false);
  });
```

在 `packages/core/src/config/loader.test.ts` 末尾追加（先 `rg -n "validateConfigText" packages/core/src/config/loader.test.ts` 确认已 import，没有就加 `import { validateConfigText } from "./loader.ts";`）：

```ts
test("scheduler.data-dir 展开 ~", () => {
  const config = validateConfigText(
    `llm:
  default-provider: anthropic
  default-model: claude-test
  providers: {}
ask: {}
agents:
  data-dir: /tmp/agents
scheduler:
  data-dir: ~/custom-scheduler
`,
    "/virtual/roll.config.yaml",
  );
  assert.equal(config.scheduler.dataDir, resolve(homedir(), "custom-scheduler"));
});
```

补 `import { homedir } from "node:os"; import { resolve } from "node:path";`（若已存在则跳过）。loader.test.ts 若用 `describe/it`，把 `test(` 改成同文件的风格。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/config/schema.test.ts packages/core/src/config/loader.test.ts`
Expected: FAIL，`result.data.scheduler` 为 undefined / `config.scheduler` 不存在。

- [ ] **Step 3: 实现 schema 与展开**

`schema.ts` 在 `runtimeConfigSchema` 定义之后加：

```ts
export const schedulerConfigSchema = z.object({
  dataDir: z.string().default("~/.roll-agent/scheduler"),
  maxSchedules: z.number().int().min(1).max(500).default(50),
  maxConcurrentRuns: z.number().int().min(1).max(8).default(2),
});
```

`rollConfigSchema` 加一行 `scheduler: schedulerConfigSchema.default({}),`（放在 `runtime:` 之后）。类型区加 `export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;`。

`loader.ts` 的 `expandPaths` 返回对象里加：

```ts
    scheduler: {
      ...config.scheduler,
      dataDir: expandTilde(config.scheduler.dataDir),
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS。再跑 `pnpm --filter @roll-agent/core typecheck`。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/config/loader.ts packages/core/src/config/schema.test.ts packages/core/src/config/loader.test.ts
git commit -m "feat(core): add scheduler config section" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: runtime `scheduler/limits.ts` + `trigger.ts`

**Files:**
- Create: `packages/runtime/src/scheduler/limits.ts`
- Create: `packages/runtime/src/scheduler/trigger.ts`
- Test: `packages/runtime/src/scheduler/trigger.test.ts`

**Interfaces:**
- Produces: `SCHEDULER_LIMITS`；`TRIGGER_KINDS`、`triggerSpecSchema`、`TriggerSpec`、`ScheduleTriggerError`、`parseIntervalText(text): number`、`createIntervalTrigger(text): TriggerSpec`、`formatInterval(ms): string`、`describeTrigger(trigger): string`、`computeNextRunAtMs(trigger, nowMs): number`、`parseTriggerJson(json): TriggerSpec`

- [ ] **Step 1: 写失败的测试**

`packages/runtime/src/scheduler/trigger.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEDULER_LIMITS } from "./limits.ts";
import {
  ScheduleTriggerError,
  computeNextRunAtMs,
  createIntervalTrigger,
  describeTrigger,
  formatInterval,
  parseIntervalText,
  parseTriggerJson,
} from "./trigger.ts";

test("parseIntervalText 解析 s/m/h/d", () => {
  assert.equal(parseIntervalText("30m"), 1_800_000);
  assert.equal(parseIntervalText(" 2h "), 7_200_000);
  assert.equal(parseIntervalText("1d"), 86_400_000);
  assert.equal(parseIntervalText("90s"), 90_000);
});

test("parseIntervalText 低于下限报错而不是 clamp", () => {
  assert.throws(() => parseIntervalText("45s"), (error: unknown) => {
    return error instanceof ScheduleTriggerError && /60/u.test(error.message);
  });
  assert.equal(SCHEDULER_LIMITS.minIntervalMs, 60_000);
});

test("parseIntervalText 拒绝无法识别的格式", () => {
  for (const text of ["", "abc", "0m", "2H", "1.5h", "10"]) {
    assert.throws(() => parseIntervalText(text), ScheduleTriggerError);
  }
});

test("formatInterval 输出人类可读的中文周期", () => {
  assert.equal(formatInterval(1_800_000), "每 30 分钟");
  assert.equal(formatInterval(7_200_000), "每 2 小时");
  assert.equal(formatInterval(86_400_000), "每 1 天");
  assert.equal(formatInterval(90_000), "每 90 秒");
});

test("computeNextRunAtMs 从 now 重锚，不补课", () => {
  const trigger = createIntervalTrigger("5m");
  assert.deepEqual(trigger, { kind: "interval", everyMs: 300_000 });
  assert.equal(computeNextRunAtMs(trigger, 1_000_000), 1_300_000);
  assert.equal(describeTrigger(trigger), "每 5 分钟");
});

test("parseTriggerJson 拒绝未知 kind 与低于下限的 everyMs", () => {
  assert.deepEqual(parseTriggerJson('{"kind":"interval","everyMs":60000}'), {
    kind: "interval",
    everyMs: 60_000,
  });
  assert.throws(() => parseTriggerJson('{"kind":"daily","hour":9}'), ScheduleTriggerError);
  assert.throws(() => parseTriggerJson('{"kind":"interval","everyMs":1000}'), ScheduleTriggerError);
  assert.throws(() => parseTriggerJson("not json"), ScheduleTriggerError);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/scheduler/trigger.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`packages/runtime/src/scheduler/limits.ts`：

```ts
export const SCHEDULER_LIMITS = {
  minIntervalMs: 60_000,
  claimLeaseMs: 120_000,
  leaseRenewIntervalMs: 30_000,
  retryBudget: 3,
  retryBackoffMs: 10_000,
  pollIntervalMs: 15_000,
  maxNameChars: 120,
  maxPromptChars: 4_000,
  maxOutputExcerptChars: 4_000,
} as const;
```

`packages/runtime/src/scheduler/trigger.ts`：

```ts
import { z } from "zod";
import { SCHEDULER_LIMITS } from "./limits.ts";

export const TRIGGER_KINDS = { interval: "interval" } as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[keyof typeof TRIGGER_KINDS];

export const intervalTriggerSchema = z
  .object({
    kind: z.literal(TRIGGER_KINDS.interval),
    everyMs: z.number().int().min(SCHEDULER_LIMITS.minIntervalMs),
  })
  .strict();

export const triggerSpecSchema = z.discriminatedUnion("kind", [intervalTriggerSchema]);
export type TriggerSpec = z.infer<typeof triggerSpecSchema>;

export class ScheduleTriggerError extends Error {
  readonly code = "schedule_trigger_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ScheduleTriggerError";
  }
}

const INTERVAL_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type IntervalUnit = keyof typeof INTERVAL_UNIT_MS;
const INTERVAL_PATTERN = /^(\d{1,9})([smhd])$/u;

function isIntervalUnit(value: string): value is IntervalUnit {
  return Object.hasOwn(INTERVAL_UNIT_MS, value);
}

export function formatInterval(ms: number): string {
  if (ms % INTERVAL_UNIT_MS.d === 0) {
    return `每 ${String(ms / INTERVAL_UNIT_MS.d)} 天`;
  }
  if (ms % INTERVAL_UNIT_MS.h === 0) {
    return `每 ${String(ms / INTERVAL_UNIT_MS.h)} 小时`;
  }
  if (ms % INTERVAL_UNIT_MS.m === 0) {
    return `每 ${String(ms / INTERVAL_UNIT_MS.m)} 分钟`;
  }
  return `每 ${String(Math.round(ms / INTERVAL_UNIT_MS.s))} 秒`;
}

export function parseIntervalText(text: string): number {
  const trimmed = text.trim();
  const match = INTERVAL_PATTERN.exec(trimmed);
  const digits = match?.[1];
  const unit = match?.[2];
  if (digits === undefined || unit === undefined || !isIntervalUnit(unit)) {
    throw new ScheduleTriggerError(
      `无法识别的间隔 "${trimmed}"：格式为 <数字><s|m|h|d>，例如 30m、2h、1d`,
    );
  }
  const value = Number.parseInt(digits, 10);
  if (value <= 0) {
    throw new ScheduleTriggerError("间隔必须大于 0");
  }
  const ms = value * INTERVAL_UNIT_MS[unit];
  if (ms < SCHEDULER_LIMITS.minIntervalMs) {
    throw new ScheduleTriggerError(
      `间隔不能小于 ${formatInterval(SCHEDULER_LIMITS.minIntervalMs)}（收到 ${trimmed}）`,
    );
  }
  return ms;
}

export function createIntervalTrigger(text: string): TriggerSpec {
  return { kind: TRIGGER_KINDS.interval, everyMs: parseIntervalText(text) };
}

export function describeTrigger(trigger: TriggerSpec): string {
  return formatInterval(trigger.everyMs);
}

export function computeNextRunAtMs(trigger: TriggerSpec, nowMs: number): number {
  return nowMs + trigger.everyMs;
}

export function parseTriggerJson(json: string): TriggerSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    throw new ScheduleTriggerError("trigger 不是合法 JSON");
  }
  const parsed = triggerSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScheduleTriggerError(`trigger 不合法：${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return parsed.data;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS。`pnpm --filter @roll-agent/runtime typecheck`。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/scheduler/limits.ts packages/runtime/src/scheduler/trigger.ts packages/runtime/src/scheduler/trigger.test.ts
git commit -m "feat(runtime): add scheduler trigger parsing and limits" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `ScheduleStore` — schedules 表与 CRUD

**Files:**
- Create: `packages/runtime/src/scheduler/types.ts`
- Create: `packages/runtime/src/scheduler/schedule-store.ts`
- Test: `packages/runtime/src/scheduler/schedule-store.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `TriggerSpec`、`computeNextRunAtMs`、`parseTriggerJson`、`triggerSpecSchema`、`SCHEDULER_LIMITS`
- Produces: `SCHEDULE_STATUSES`、`INVOCATION_MODES`、`INVOCATION_STATUSES`、`INVOCATION_FAILURE_OUTCOMES`、`ScheduleRecord`、`InvocationRecord`、`ClaimedInvocation`、`CreateScheduleInput`、`CompleteInvocationInput`、`ScheduleStoreError`；`class ScheduleStore { constructor(dir: string, options?: ScheduleStoreOptions); createSchedule(input, nowMs?): ScheduleRecord; getSchedule(id): ScheduleRecord | undefined; listSchedules(): ScheduleRecord[]; setScheduleStatus(id, status, nowMs?): boolean; removeSchedule(id): boolean; close(): void }`

- [ ] **Step 1: 写 types.ts（无测试，纯类型/常量）**

```ts
import type { TriggerSpec } from "./trigger.ts";

export const SCHEDULE_STATUSES = { active: "active", paused: "paused" } as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[keyof typeof SCHEDULE_STATUSES];

export const INVOCATION_MODES = { scheduled: "scheduled", manual: "manual" } as const;
export type InvocationMode = (typeof INVOCATION_MODES)[keyof typeof INVOCATION_MODES];

export const INVOCATION_STATUSES = {
  pending: "pending",
  claimed: "claimed",
  running: "running",
  retry: "retry",
  completed: "completed",
  needsConfirmation: "needs_confirmation",
  failed: "failed",
} as const;
export type InvocationStatus = (typeof INVOCATION_STATUSES)[keyof typeof INVOCATION_STATUSES];

export const INVOCATION_LIVE_STATUSES = [
  INVOCATION_STATUSES.pending,
  INVOCATION_STATUSES.claimed,
  INVOCATION_STATUSES.running,
  INVOCATION_STATUSES.retry,
] as const;

export type CompleteInvocationStatus =
  | typeof INVOCATION_STATUSES.completed
  | typeof INVOCATION_STATUSES.needsConfirmation;

export const INVOCATION_FAILURE_OUTCOMES = {
  retryScheduled: "retry-scheduled",
  terminal: "terminal",
  terminalPaused: "terminal-paused",
  lostClaim: "lost-claim",
} as const;
export type InvocationFailureOutcome =
  (typeof INVOCATION_FAILURE_OUTCOMES)[keyof typeof INVOCATION_FAILURE_OUTCOMES];

export interface ScheduleRecord {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly trigger: TriggerSpec;
  readonly status: ScheduleStatus;
  readonly nextRunAtMs: number | undefined;
  readonly lastRunAtMs: number | undefined;
  readonly lastError: string | undefined;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface InvocationRecord {
  readonly id: string;
  readonly scheduleId: string;
  readonly mode: InvocationMode;
  readonly status: InvocationStatus;
  readonly scheduledForMs: number;
  readonly attempt: number;
  readonly claimedBy: string | undefined;
  readonly leaseUntilMs: number | undefined;
  readonly retryAtMs: number | undefined;
  readonly threadId: string | undefined;
  readonly outputExcerpt: string | undefined;
  readonly error: string | undefined;
  readonly pendingActions: readonly string[];
  readonly createdAtMs: number;
  readonly startedAtMs: number | undefined;
  readonly finishedAtMs: number | undefined;
}

export interface ClaimedInvocation {
  readonly invocation: InvocationRecord;
  readonly schedule: ScheduleRecord;
  readonly ownershipToken: string;
}

export interface CreateScheduleInput {
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly trigger: TriggerSpec;
  readonly fireImmediately?: boolean;
}

export interface CompleteInvocationInput {
  readonly id: string;
  readonly ownershipToken: string;
  readonly status: CompleteInvocationStatus;
  readonly nowMs: number;
  readonly threadId?: string;
  readonly outputExcerpt?: string;
  readonly pendingActions?: readonly string[];
}

export const SCHEDULE_STORE_ERROR_CODES = {
  limitReached: "schedule_limit_reached",
  notFound: "schedule_not_found",
  invalid: "schedule_invalid",
} as const;
export type ScheduleStoreErrorCode =
  (typeof SCHEDULE_STORE_ERROR_CODES)[keyof typeof SCHEDULE_STORE_ERROR_CODES];

export class ScheduleStoreError extends Error {
  readonly code: ScheduleStoreErrorCode;

  constructor(code: ScheduleStoreErrorCode, message: string) {
    super(message);
    this.name = "ScheduleStoreError";
    this.code = code;
  }
}
```

- [ ] **Step 2: 写失败的 store 测试**

`packages/runtime/src/scheduler/schedule-store.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore } from "./schedule-store.ts";
import { SCHEDULE_STATUSES, SCHEDULE_STORE_ERROR_CODES, ScheduleStoreError } from "./types.ts";
import { createIntervalTrigger } from "./trigger.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-schedules-"));
}

const NOW = Date.parse("2026-08-25T09:00:00.000Z");

function sampleInput(overrides: Partial<Parameters<ScheduleStore["createSchedule"]>[0]> = {}) {
  return {
    name: "每日巡检",
    prompt: "检查未读消息并汇总",
    cwd: "/workspace/demo",
    trigger: createIntervalTrigger("30m"),
    ...overrides,
  };
}

test("ScheduleStore 创建、查询、列出与删除 schedule", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput(), NOW);
    assert.equal(created.status, SCHEDULE_STATUSES.active);
    assert.equal(created.nextRunAtMs, NOW + 1_800_000);
    assert.equal(created.lastRunAtMs, undefined);
    assert.deepEqual(store.getSchedule(created.id), created);
    assert.deepEqual(store.listSchedules().map((s) => s.id), [created.id]);
    assert.equal(store.removeSchedule(created.id), true);
    assert.equal(store.removeSchedule(created.id), false);
    assert.equal(store.getSchedule(created.id), undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fireImmediately 让 nextRunAt 等于 now", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    assert.equal(created.nextRunAtMs, NOW);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pause/resume 只改状态不改相位", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput(), NOW);
    assert.equal(store.setScheduleStatus(created.id, SCHEDULE_STATUSES.paused, NOW + 1), true);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.paused);
    assert.equal(store.getSchedule(created.id)?.nextRunAtMs, NOW + 1_800_000);
    assert.equal(store.setScheduleStatus(created.id, SCHEDULE_STATUSES.active, NOW + 2), true);
    assert.equal(store.getSchedule(created.id)?.nextRunAtMs, NOW + 1_800_000);
    assert.equal(store.setScheduleStatus("missing", SCHEDULE_STATUSES.paused, NOW), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("超过 maxSchedules、非法 name/prompt/cwd 都被拒绝", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { maxSchedules: 1 });
    store.createSchedule(sampleInput(), NOW);
    assert.throws(
      () => store.createSchedule(sampleInput({ name: "second" }), NOW),
      (error: unknown) =>
        error instanceof ScheduleStoreError &&
        error.code === SCHEDULE_STORE_ERROR_CODES.limitReached,
    );
    assert.throws(() => store.createSchedule(sampleInput({ name: "   " }), NOW), ScheduleStoreError);
    assert.throws(
      () => store.createSchedule(sampleInput({ prompt: "x".repeat(4_001) }), NOW),
      ScheduleStoreError,
    );
    assert.throws(
      () => store.createSchedule(sampleInput({ cwd: "relative/path" }), NOW),
      ScheduleStoreError,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ScheduleStore 在 POSIX 上收紧目录与数据库权限", () => {
  if (process.platform === "win32") {
    return;
  }
  const parent = tempDir();
  const dir = join(parent, "nested", "scheduler");
  try {
    chmodSync(parent, 0o755);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const store = new ScheduleStore(dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "schedules.db")).mode & 0o777, 0o600);
    store.close();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/scheduler/schedule-store.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现 schedule-store.ts（本 Task 只到 schedules；invocation 方法在 Task 4 加）**

```ts
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expandTilde } from "../store/thread-store.ts";
import { SCHEDULER_LIMITS } from "./limits.ts";
import {
  computeNextRunAtMs,
  parseTriggerJson,
  triggerSpecSchema,
  type TriggerSpec,
} from "./trigger.ts";
import {
  SCHEDULE_STATUSES,
  SCHEDULE_STORE_ERROR_CODES,
  ScheduleStoreError,
  type CreateScheduleInput,
  type ScheduleRecord,
  type ScheduleStatus,
} from "./types.ts";

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 15_000;

export interface ScheduleStoreOptions {
  readonly maxSchedules?: number;
  readonly claimLeaseMs?: number;
  readonly retryBudget?: number;
  readonly retryBackoffMs?: number;
}

interface ScheduleRow {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly trigger_json: string;
  readonly status: string;
  readonly next_run_at: number | null;
  readonly last_run_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function isScheduleStatus(value: string): value is ScheduleStatus {
  return value === SCHEDULE_STATUSES.active || value === SCHEDULE_STATUSES.paused;
}

function toScheduleRecord(row: ScheduleRow): ScheduleRecord {
  if (!isScheduleStatus(row.status)) {
    throw new ScheduleStoreError(
      SCHEDULE_STORE_ERROR_CODES.invalid,
      `schedule ${row.id} 的 status 非法: ${row.status}`,
    );
  }
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    cwd: row.cwd,
    trigger: parseTriggerJson(row.trigger_json),
    status: row.status,
    nextRunAtMs: row.next_run_at ?? undefined,
    lastRunAtMs: row.last_run_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
  };
}

function validateCreateInput(input: CreateScheduleInput): {
  readonly name: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly trigger: TriggerSpec;
} {
  const name = input.name.trim();
  if (name.length === 0 || name.length > SCHEDULER_LIMITS.maxNameChars) {
    throw new ScheduleStoreError(
      SCHEDULE_STORE_ERROR_CODES.invalid,
      `name 必须为 1..${String(SCHEDULER_LIMITS.maxNameChars)} 个字符`,
    );
  }
  const prompt = input.prompt.trim();
  if (prompt.length === 0 || prompt.length > SCHEDULER_LIMITS.maxPromptChars) {
    throw new ScheduleStoreError(
      SCHEDULE_STORE_ERROR_CODES.invalid,
      `prompt 必须为 1..${String(SCHEDULER_LIMITS.maxPromptChars)} 个字符`,
    );
  }
  if (!isAbsolute(input.cwd)) {
    throw new ScheduleStoreError(SCHEDULE_STORE_ERROR_CODES.invalid, "cwd 必须是绝对路径");
  }
  const trigger = triggerSpecSchema.safeParse(input.trigger);
  if (!trigger.success) {
    throw new ScheduleStoreError(SCHEDULE_STORE_ERROR_CODES.invalid, "trigger 不合法");
  }
  return { name, prompt, cwd: input.cwd, trigger: trigger.data };
}

export class ScheduleStore {
  private readonly db: DatabaseSync;
  private readonly maxSchedules: number;
  private readonly claimLeaseMs: number;
  private readonly retryBudget: number;
  private readonly retryBackoffMs: number;

  constructor(dir: string, options: ScheduleStoreOptions = {}) {
    this.maxSchedules = options.maxSchedules ?? 50;
    this.claimLeaseMs = options.claimLeaseMs ?? SCHEDULER_LIMITS.claimLeaseMs;
    this.retryBudget = options.retryBudget ?? SCHEDULER_LIMITS.retryBudget;
    this.retryBackoffMs = options.retryBackoffMs ?? SCHEDULER_LIMITS.retryBackoffMs;
    const resolved = expandTilde(dir);
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32") {
      chmodSync(resolved, 0o700);
    }
    const databasePath = resolve(resolved, "schedules.db");
    this.db = new DatabaseSync(databasePath);
    if (process.platform !== "win32") {
      try {
        chmodSync(databasePath, 0o600);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    this.init();
  }

  private init(): void {
    this.db.exec(
      `PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)};
       PRAGMA foreign_keys = ON;
       PRAGMA secure_delete = ON;`,
    );
    const versionRow = this.db.prepare("PRAGMA user_version").get() as {
      readonly user_version: number;
    };
    if (versionRow.user_version > SCHEMA_VERSION) {
      throw new Error(
        `ScheduleStore schema v${String(versionRow.user_version)} 高于当前支持的 v${String(SCHEMA_VERSION)}`,
      );
    }
    this.transaction(() => {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS schedules (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           prompt TEXT NOT NULL,
           cwd TEXT NOT NULL,
           trigger_json TEXT NOT NULL,
           status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
           next_run_at INTEGER,
           last_run_at INTEGER,
           last_error TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS invocations (
           id TEXT PRIMARY KEY,
           schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
           mode TEXT NOT NULL CHECK (mode IN ('scheduled', 'manual')),
           status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'running', 'retry', 'completed', 'needs_confirmation', 'failed')),
           scheduled_for INTEGER NOT NULL,
           attempt INTEGER NOT NULL DEFAULT 0,
           claimed_by TEXT,
           ownership_token TEXT,
           lease_until INTEGER,
           retry_at INTEGER,
           thread_id TEXT,
           output_excerpt TEXT,
           error TEXT,
           pending_actions_json TEXT NOT NULL DEFAULT '[]',
           created_at INTEGER NOT NULL,
           started_at INTEGER,
           finished_at INTEGER,
           UNIQUE (schedule_id, mode, scheduled_for)
         );
         CREATE INDEX IF NOT EXISTS idx_schedules_due
           ON schedules (next_run_at) WHERE status = 'active' AND next_run_at IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_invocations_live
           ON invocations (schedule_id) WHERE status IN ('pending', 'claimed', 'running', 'retry');`,
      );
      this.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)};`);
    });
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createSchedule(input: CreateScheduleInput, nowMs: number = Date.now()): ScheduleRecord {
    const valid = validateCreateInput(input);
    return this.transaction(() => {
      const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM schedules").get() as {
        readonly count: number;
      };
      if (countRow.count >= this.maxSchedules) {
        throw new ScheduleStoreError(
          SCHEDULE_STORE_ERROR_CODES.limitReached,
          `已达到定时任务上限 ${String(this.maxSchedules)}，请先删除不再需要的任务`,
        );
      }
      const id = randomUUID();
      const nextRunAt =
        input.fireImmediately === true ? nowMs : computeNextRunAtMs(valid.trigger, nowMs);
      this.db
        .prepare(
          `INSERT INTO schedules
             (id, name, prompt, cwd, trigger_json, status, next_run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          valid.name,
          valid.prompt,
          valid.cwd,
          JSON.stringify(valid.trigger),
          SCHEDULE_STATUSES.active,
          nextRunAt,
          nowMs,
          nowMs,
        );
      return this.requireSchedule(id);
    });
  }

  getSchedule(id: string): ScheduleRecord | undefined {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as
      | ScheduleRow
      | undefined;
    return row ? toScheduleRecord(row) : undefined;
  }

  listSchedules(): ScheduleRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules ORDER BY created_at ASC, rowid ASC")
      .all() as unknown as ScheduleRow[];
    return rows.map(toScheduleRecord);
  }

  setScheduleStatus(id: string, status: ScheduleStatus, nowMs: number = Date.now()): boolean {
    const result = this.db
      .prepare("UPDATE schedules SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowMs, id);
    return result.changes === 1;
  }

  removeSchedule(id: string): boolean {
    const result = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return result.changes === 1;
  }

  close(): void {
    this.db.close();
  }

  private requireSchedule(id: string): ScheduleRecord {
    const record = this.getSchedule(id);
    if (record === undefined) {
      throw new ScheduleStoreError(SCHEDULE_STORE_ERROR_CODES.notFound, `schedule ${id} 不存在`);
    }
    return record;
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: 同 Step 3。Expected: PASS。`pnpm --filter @roll-agent/runtime typecheck`。

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/scheduler/types.ts packages/runtime/src/scheduler/schedule-store.ts packages/runtime/src/scheduler/schedule-store.test.ts
git commit -m "feat(runtime): add ScheduleStore with schedule CRUD" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `ScheduleStore` — invocations：claim / lease / complete / fail

**Files:**
- Modify: `packages/runtime/src/scheduler/schedule-store.ts`（Task 3 产物）
- Modify: `packages/runtime/src/index.ts:98-99`（追加 scheduler 导出）
- Test: `packages/runtime/src/scheduler/schedule-store.test.ts`

**Interfaces:**
- Produces（都在 `ScheduleStore` 上）：`enqueueManualInvocation(scheduleId, nowMs?): InvocationRecord`、`claimPendingInvocation(id, workerId, nowMs?): ClaimedInvocation | undefined`、`claimDue({ workerId, nowMs, limit }): ClaimedInvocation[]`、`beginInvocation(id, ownershipToken, nowMs?): ClaimedInvocation | undefined`、`renewLease(id, ownershipToken, nowMs?): boolean`、`completeInvocation(input: CompleteInvocationInput): boolean`、`failInvocation(id, ownershipToken, error, nowMs?): InvocationFailureOutcome`、`getInvocation(id): InvocationRecord | undefined`、`listInvocations(scheduleId, limit?): InvocationRecord[]`、`nextWakeAtMs(): number | undefined`
- runtime index 导出：`ScheduleStore`、`SCHEDULER_LIMITS`、trigger 全部导出、types 全部导出

- [ ] **Step 1: 写失败的测试（追加到 schedule-store.test.ts）**

在 import 里补：`INVOCATION_FAILURE_OUTCOMES, INVOCATION_MODES, INVOCATION_STATUSES`（从 `./types.ts`）。追加：

```ts
test("claimDue 为到期 schedule 生成 invocation 并把 nextRunAt 从 now 重锚", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 120_000 });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const late = NOW + 4 * 3_600_000;
    const claims = store.claimDue({ workerId: "w1", nowMs: late, limit: 5 });
    assert.equal(claims.length, 1);
    const claim = claims[0];
    assert.ok(claim);
    assert.equal(claim.invocation.status, INVOCATION_STATUSES.claimed);
    assert.equal(claim.invocation.mode, INVOCATION_MODES.scheduled);
    assert.equal(claim.invocation.scheduledForMs, NOW);
    assert.equal(claim.invocation.attempt, 1);
    assert.equal(claim.invocation.claimedBy, "w1");
    assert.equal(claim.invocation.leaseUntilMs, late + 120_000);
    assert.equal(claim.schedule.id, created.id);
    assert.equal(store.getSchedule(created.id)?.nextRunAtMs, late + 1_800_000);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: late + 1, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimDue 尊重 limit，paused schedule 不触发", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const a = store.createSchedule(sampleInput({ name: "a", fireImmediately: true }), NOW);
    store.createSchedule(sampleInput({ name: "b", fireImmediately: true }), NOW);
    const c = store.createSchedule(sampleInput({ name: "c", fireImmediately: true }), NOW);
    store.setScheduleStatus(c.id, SCHEDULE_STATUSES.paused, NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.schedule.id, a.id);
    const second = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 5 });
    assert.equal(second.length, 1);
    assert.equal(second[0]?.schedule.name, "b");
    assert.deepEqual(store.claimDue({ workerId: "w1", nowMs: NOW, limit: 5 }), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("begin/renew/complete 都受 ownership token 约束", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    assert.equal(store.beginInvocation(claim.invocation.id, "wrong-token", NOW + 1), undefined);
    const begun = store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW + 1);
    assert.equal(begun?.invocation.status, INVOCATION_STATUSES.running);
    assert.equal(begun?.invocation.startedAtMs, NOW + 1);
    assert.equal(store.renewLease(claim.invocation.id, "wrong-token", NOW + 2), false);
    assert.equal(store.renewLease(claim.invocation.id, claim.ownershipToken, NOW + 2), true);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: "wrong-token",
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 3,
      }),
      false,
    );
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.needsConfirmation,
        nowMs: NOW + 3,
        threadId: "thread-1",
        outputExcerpt: "done",
        pendingActions: ["browser.click"],
      }),
      true,
    );
    const stored = store.getInvocation(claim.invocation.id);
    assert.equal(stored?.status, INVOCATION_STATUSES.needsConfirmation);
    assert.equal(stored?.threadId, "thread-1");
    assert.deepEqual(stored?.pendingActions, ["browser.click"]);
    assert.equal(stored?.claimedBy, undefined);
    assert.equal(stored?.finishedAtMs, NOW + 3);
    assert.equal(store.getSchedule(created.id)?.lastRunAtMs, NOW + 3);
    assert.equal(store.getSchedule(created.id)?.lastError, undefined);
    assert.equal(
      store.completeInvocation({
        id: claim.invocation.id,
        ownershipToken: claim.ownershipToken,
        status: INVOCATION_STATUSES.completed,
        nowMs: NOW + 4,
      }),
      false,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failInvocation 走退避重试，预算耗尽后终态并 pause scheduled 任务", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 2, retryBackoffMs: 10_000 });
    const created = store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    assert.equal(
      store.failInvocation(first.invocation.id, "wrong", "boom", NOW + 1),
      INVOCATION_FAILURE_OUTCOMES.lostClaim,
    );
    assert.equal(
      store.failInvocation(first.invocation.id, first.ownershipToken, "boom", NOW + 1),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    const afterFirst = store.getInvocation(first.invocation.id);
    assert.equal(afterFirst?.status, INVOCATION_STATUSES.retry);
    assert.equal(afterFirst?.retryAtMs, NOW + 10_001);
    assert.equal(afterFirst?.error, "boom");
    assert.deepEqual(store.claimDue({ workerId: "w1", nowMs: NOW + 5_000, limit: 5 }), []);
    const second = store.claimDue({ workerId: "w1", nowMs: NOW + 11_000, limit: 5 })[0];
    assert.ok(second);
    assert.equal(second.invocation.id, first.invocation.id);
    assert.equal(second.invocation.attempt, 2);
    assert.equal(
      store.failInvocation(second.invocation.id, second.ownershipToken, "boom again", NOW + 12_000),
      INVOCATION_FAILURE_OUTCOMES.terminalPaused,
    );
    assert.equal(store.getInvocation(first.invocation.id)?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.paused);
    assert.match(store.getSchedule(created.id)?.lastError ?? "", /boom again/u);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lease 过期的 claimed/running invocation 会被重新 claim 为同一次触发", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { claimLeaseMs: 1_000, retryBudget: 3 });
    store.createSchedule(sampleInput({ fireImmediately: true }), NOW);
    const first = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(first);
    store.beginInvocation(first.invocation.id, first.ownershipToken, NOW);
    assert.deepEqual(store.claimDue({ workerId: "w2", nowMs: NOW + 500, limit: 5 }), []);
    const reclaimed = store.claimDue({ workerId: "w2", nowMs: NOW + 1_001, limit: 5 });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.invocation.id, first.invocation.id);
    assert.equal(reclaimed[0]?.invocation.attempt, 2);
    assert.equal(reclaimed[0]?.invocation.claimedBy, "w2");
    assert.notEqual(reclaimed[0]?.ownershipToken, first.ownershipToken);
    assert.equal(store.renewLease(first.invocation.id, first.ownershipToken, NOW + 1_002), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual invocation 入队、单独 claim，失败不 pause 计划", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const created = store.createSchedule(sampleInput(), NOW);
    const queued = store.enqueueManualInvocation(created.id, NOW);
    assert.equal(queued.mode, INVOCATION_MODES.manual);
    assert.equal(queued.status, INVOCATION_STATUSES.pending);
    assert.throws(() => store.enqueueManualInvocation("missing", NOW), ScheduleStoreError);
    assert.equal(store.claimPendingInvocation(queued.id, "inline", NOW + 1)?.invocation.attempt, 1);
    assert.equal(store.claimPendingInvocation(queued.id, "inline", NOW + 1), undefined);
    const claimed = store.getInvocation(queued.id);
    assert.equal(claimed?.status, INVOCATION_STATUSES.claimed);
    assert.equal(claimed?.claimedBy, "inline");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual 失败终态不 pause 计划；listInvocations 与 nextWakeAtMs", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const created = store.createSchedule(sampleInput(), NOW);
    const queued = store.enqueueManualInvocation(created.id, NOW);
    assert.equal(store.nextWakeAtMs(), NOW);
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW + 1, limit: 5 })[0];
    assert.ok(claim);
    assert.equal(claim.invocation.id, queued.id);
    assert.equal(
      store.failInvocation(claim.invocation.id, claim.ownershipToken, "manual boom", NOW + 2),
      INVOCATION_FAILURE_OUTCOMES.terminal,
    );
    assert.equal(store.getSchedule(created.id)?.status, SCHEDULE_STATUSES.active);
    assert.equal(store.listInvocations(created.id).length, 1);
    assert.equal(store.listInvocations(created.id, 0).length, 0);
    assert.equal(store.nextWakeAtMs(), NOW + 1_800_000);
    store.removeSchedule(created.id);
    assert.equal(store.nextWakeAtMs(), undefined);
    assert.equal(store.listInvocations(created.id).length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/scheduler/schedule-store.test.ts`
Expected: FAIL（方法不存在）。

- [ ] **Step 3: 实现 invocation 方法**

在 `schedule-store.ts` 顶部 import 补：

```ts
import {
  INVOCATION_FAILURE_OUTCOMES,
  INVOCATION_MODES,
  INVOCATION_STATUSES,
  type ClaimedInvocation,
  type CompleteInvocationInput,
  type InvocationFailureOutcome,
  type InvocationMode,
  type InvocationRecord,
  type InvocationStatus,
} from "./types.ts";
```

（与已有 `./types.ts` import 合并成一条。）在 `ScheduleRow` 后加：

```ts
interface InvocationRow {
  readonly id: string;
  readonly schedule_id: string;
  readonly mode: string;
  readonly status: string;
  readonly scheduled_for: number;
  readonly attempt: number;
  readonly claimed_by: string | null;
  readonly ownership_token: string | null;
  readonly lease_until: number | null;
  readonly retry_at: number | null;
  readonly thread_id: string | null;
  readonly output_excerpt: string | null;
  readonly error: string | null;
  readonly pending_actions_json: string;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly finished_at: number | null;
}

const INVOCATION_MODE_VALUES: readonly string[] = Object.values(INVOCATION_MODES);
const INVOCATION_STATUS_VALUES: readonly string[] = Object.values(INVOCATION_STATUSES);

function isInvocationMode(value: string): value is InvocationMode {
  return INVOCATION_MODE_VALUES.includes(value);
}

function isInvocationStatus(value: string): value is InvocationStatus {
  return INVOCATION_STATUS_VALUES.includes(value);
}

function parsePendingActions(json: string): readonly string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toInvocationRecord(row: InvocationRow): InvocationRecord {
  if (!isInvocationMode(row.mode) || !isInvocationStatus(row.status)) {
    throw new ScheduleStoreError(
      SCHEDULE_STORE_ERROR_CODES.invalid,
      `invocation ${row.id} 的 mode/status 非法: ${row.mode}/${row.status}`,
    );
  }
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    mode: row.mode,
    status: row.status,
    scheduledForMs: row.scheduled_for,
    attempt: row.attempt,
    claimedBy: row.claimed_by ?? undefined,
    leaseUntilMs: row.lease_until ?? undefined,
    retryAtMs: row.retry_at ?? undefined,
    threadId: row.thread_id ?? undefined,
    outputExcerpt: row.output_excerpt ?? undefined,
    error: row.error ?? undefined,
    pendingActions: parsePendingActions(row.pending_actions_json),
    createdAtMs: row.created_at,
    startedAtMs: row.started_at ?? undefined,
    finishedAtMs: row.finished_at ?? undefined,
  };
}

export interface ClaimDueInput {
  readonly workerId: string;
  readonly nowMs: number;
  readonly limit: number;
}
```

在 `ScheduleStore` 类的 `close()` 之前加入：

```ts
  enqueueManualInvocation(scheduleId: string, nowMs: number = Date.now()): InvocationRecord {
    return this.transaction(() => {
      this.requireSchedule(scheduleId);
      const id = randomUUID();
      for (let offset = 0; offset < 1_000; offset += 1) {
        const inserted = this.db
          .prepare(
            `INSERT OR IGNORE INTO invocations
               (id, schedule_id, mode, status, scheduled_for, attempt, created_at)
             VALUES (?, ?, ?, ?, ?, 0, ?)`,
          )
          .run(
            id,
            scheduleId,
            INVOCATION_MODES.manual,
            INVOCATION_STATUSES.pending,
            nowMs + offset,
            nowMs,
          );
        if (inserted.changes === 1) {
          return this.requireInvocation(id);
        }
      }
      throw new ScheduleStoreError(
        SCHEDULE_STORE_ERROR_CODES.invalid,
        `schedule ${scheduleId} 的手动触发入队失败`,
      );
    });
  }

  claimPendingInvocation(
    id: string,
    workerId: string,
    nowMs: number = Date.now(),
  ): ClaimedInvocation | undefined {
    return this.transaction(() => {
      const token = randomUUID();
      const result = this.db
        .prepare(
          `UPDATE invocations
             SET status = ?, claimed_by = ?, ownership_token = ?, lease_until = ?, attempt = 1,
                 retry_at = NULL
           WHERE id = ? AND status = ?`,
        )
        .run(
          INVOCATION_STATUSES.claimed,
          workerId,
          token,
          nowMs + this.claimLeaseMs,
          id,
          INVOCATION_STATUSES.pending,
        );
      return result.changes === 1 ? this.loadClaim(id, token) : undefined;
    });
  }

  claimDue(input: ClaimDueInput): ClaimedInvocation[] {
    if (input.limit <= 0) {
      return [];
    }
    return this.transaction(() => {
      const claimed: ClaimedInvocation[] = [];
      const liveRows = this.db
        .prepare(
          `SELECT * FROM invocations
            WHERE status = ?
               OR (status = ? AND retry_at IS NOT NULL AND retry_at <= ?)
               OR (status IN (?, ?) AND lease_until IS NOT NULL AND lease_until <= ?)
            ORDER BY scheduled_for ASC, created_at ASC`,
        )
        .all(
          INVOCATION_STATUSES.pending,
          INVOCATION_STATUSES.retry,
          input.nowMs,
          INVOCATION_STATUSES.claimed,
          INVOCATION_STATUSES.running,
          input.nowMs,
        ) as unknown as InvocationRow[];
      for (const row of liveRows) {
        if (claimed.length >= input.limit) {
          break;
        }
        const attempt = row.status === INVOCATION_STATUSES.pending ? 1 : row.attempt + 1;
        if (attempt > this.retryBudget) {
          this.markTerminalFailureInTransaction(
            row,
            `重试预算耗尽（${String(this.retryBudget)} 次）：${row.error ?? "exec 未成功完成"}`,
            input.nowMs,
          );
          continue;
        }
        const token = randomUUID();
        this.db
          .prepare(
            `UPDATE invocations
               SET status = ?, claimed_by = ?, ownership_token = ?, lease_until = ?,
                   attempt = ?, retry_at = NULL
             WHERE id = ?`,
          )
          .run(
            INVOCATION_STATUSES.claimed,
            input.workerId,
            token,
            input.nowMs + this.claimLeaseMs,
            attempt,
            row.id,
          );
        const claim = this.loadClaim(row.id, token);
        if (claim !== undefined) {
          claimed.push(claim);
        }
      }
      if (claimed.length >= input.limit) {
        return claimed;
      }
      const dueRows = this.db
        .prepare(
          `SELECT s.* FROM schedules s
            WHERE s.status = ? AND s.next_run_at IS NOT NULL AND s.next_run_at <= ?
              AND NOT EXISTS (
                SELECT 1 FROM invocations i
                 WHERE i.schedule_id = s.id AND i.status IN (?, ?, ?, ?))
            ORDER BY s.next_run_at ASC, s.created_at ASC
            LIMIT ?`,
        )
        .all(
          SCHEDULE_STATUSES.active,
          input.nowMs,
          INVOCATION_STATUSES.pending,
          INVOCATION_STATUSES.claimed,
          INVOCATION_STATUSES.running,
          INVOCATION_STATUSES.retry,
          input.limit - claimed.length,
        ) as unknown as ScheduleRow[];
      for (const row of dueRows) {
        const trigger = parseTriggerJson(row.trigger_json);
        const id = randomUUID();
        const token = randomUUID();
        const inserted = this.db
          .prepare(
            `INSERT OR IGNORE INTO invocations
               (id, schedule_id, mode, status, scheduled_for, attempt, claimed_by,
                ownership_token, lease_until, created_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          )
          .run(
            id,
            row.id,
            INVOCATION_MODES.scheduled,
            INVOCATION_STATUSES.claimed,
            row.next_run_at ?? input.nowMs,
            input.workerId,
            token,
            input.nowMs + this.claimLeaseMs,
            input.nowMs,
          );
        this.db
          .prepare("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?")
          .run(computeNextRunAtMs(trigger, input.nowMs), input.nowMs, row.id);
        if (inserted.changes === 1) {
          const claim = this.loadClaim(id, token);
          if (claim !== undefined) {
            claimed.push(claim);
          }
        }
      }
      return claimed;
    });
  }

  beginInvocation(
    id: string,
    ownershipToken: string,
    nowMs: number = Date.now(),
  ): ClaimedInvocation | undefined {
    const result = this.db
      .prepare(
        `UPDATE invocations
           SET status = ?, started_at = ?, lease_until = ?
         WHERE id = ? AND ownership_token = ? AND status = ?`,
      )
      .run(
        INVOCATION_STATUSES.running,
        nowMs,
        nowMs + this.claimLeaseMs,
        id,
        ownershipToken,
        INVOCATION_STATUSES.claimed,
      );
    return result.changes === 1 ? this.loadClaim(id, ownershipToken) : undefined;
  }

  renewLease(id: string, ownershipToken: string, nowMs: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE invocations SET lease_until = ?
         WHERE id = ? AND ownership_token = ? AND status IN (?, ?)`,
      )
      .run(
        nowMs + this.claimLeaseMs,
        id,
        ownershipToken,
        INVOCATION_STATUSES.claimed,
        INVOCATION_STATUSES.running,
      );
    return result.changes === 1;
  }

  completeInvocation(input: CompleteInvocationInput): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE invocations
             SET status = ?, thread_id = ?, output_excerpt = ?, pending_actions_json = ?,
                 error = NULL, finished_at = ?, claimed_by = NULL, ownership_token = NULL,
                 lease_until = NULL, retry_at = NULL
           WHERE id = ? AND ownership_token = ? AND status IN (?, ?)`,
        )
        .run(
          input.status,
          input.threadId ?? null,
          input.outputExcerpt ?? null,
          JSON.stringify(input.pendingActions ?? []),
          input.nowMs,
          input.id,
          input.ownershipToken,
          INVOCATION_STATUSES.claimed,
          INVOCATION_STATUSES.running,
        );
      if (result.changes !== 1) {
        return false;
      }
      this.db
        .prepare(
          `UPDATE schedules SET last_run_at = ?, last_error = NULL, updated_at = ?
           WHERE id = (SELECT schedule_id FROM invocations WHERE id = ?)`,
        )
        .run(input.nowMs, input.nowMs, input.id);
      return true;
    });
  }

  failInvocation(
    id: string,
    ownershipToken: string,
    error: string,
    nowMs: number = Date.now(),
  ): InvocationFailureOutcome {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(id) as
        | InvocationRow
        | undefined;
      if (
        row === undefined ||
        row.ownership_token !== ownershipToken ||
        (row.status !== INVOCATION_STATUSES.claimed && row.status !== INVOCATION_STATUSES.running)
      ) {
        return INVOCATION_FAILURE_OUTCOMES.lostClaim;
      }
      if (row.attempt >= this.retryBudget) {
        this.markTerminalFailureInTransaction(row, error, nowMs);
        return row.mode === INVOCATION_MODES.scheduled
          ? INVOCATION_FAILURE_OUTCOMES.terminalPaused
          : INVOCATION_FAILURE_OUTCOMES.terminal;
      }
      this.db
        .prepare(
          `UPDATE invocations
             SET status = ?, retry_at = ?, error = ?, claimed_by = NULL, ownership_token = NULL,
                 lease_until = NULL
           WHERE id = ?`,
        )
        .run(INVOCATION_STATUSES.retry, nowMs + this.retryBackoffMs, error, id);
      return INVOCATION_FAILURE_OUTCOMES.retryScheduled;
    });
  }

  getInvocation(id: string): InvocationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM invocations WHERE id = ?").get(id) as
      | InvocationRow
      | undefined;
    return row ? toInvocationRecord(row) : undefined;
  }

  listInvocations(scheduleId: string, limit = 20): InvocationRecord[] {
    if (limit <= 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM invocations WHERE schedule_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(scheduleId, limit) as unknown as InvocationRow[];
    return rows.map(toInvocationRecord);
  }

  nextWakeAtMs(): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MIN(t) AS wake FROM (
           SELECT MIN(next_run_at) AS t FROM schedules
            WHERE status = ? AND next_run_at IS NOT NULL
           UNION ALL SELECT MIN(retry_at) FROM invocations WHERE status = ?
           UNION ALL SELECT MIN(lease_until) FROM invocations WHERE status IN (?, ?)
           UNION ALL SELECT MIN(scheduled_for) FROM invocations WHERE status = ?)`,
      )
      .get(
        SCHEDULE_STATUSES.active,
        INVOCATION_STATUSES.retry,
        INVOCATION_STATUSES.claimed,
        INVOCATION_STATUSES.running,
        INVOCATION_STATUSES.pending,
      ) as { readonly wake: number | null };
    return row.wake ?? undefined;
  }

  private markTerminalFailureInTransaction(
    row: InvocationRow,
    error: string,
    nowMs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE invocations
           SET status = ?, error = ?, finished_at = ?, claimed_by = NULL, ownership_token = NULL,
               lease_until = NULL, retry_at = NULL
         WHERE id = ?`,
      )
      .run(INVOCATION_STATUSES.failed, error, nowMs, row.id);
    if (row.mode === INVOCATION_MODES.scheduled) {
      this.db
        .prepare("UPDATE schedules SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
        .run(SCHEDULE_STATUSES.paused, error, nowMs, row.schedule_id);
    } else {
      this.db
        .prepare("UPDATE schedules SET last_error = ?, updated_at = ? WHERE id = ?")
        .run(error, nowMs, row.schedule_id);
    }
  }

  private loadClaim(id: string, ownershipToken: string): ClaimedInvocation | undefined {
    const invocation = this.getInvocation(id);
    if (invocation === undefined) {
      return undefined;
    }
    const schedule = this.getSchedule(invocation.scheduleId);
    if (schedule === undefined) {
      return undefined;
    }
    return { invocation, schedule, ownershipToken };
  }

  private requireInvocation(id: string): InvocationRecord {
    const record = this.getInvocation(id);
    if (record === undefined) {
      throw new ScheduleStoreError(SCHEDULE_STORE_ERROR_CODES.notFound, `invocation ${id} 不存在`);
    }
    return record;
  }
```

`packages/runtime/src/index.ts` 在 ThreadStore 导出行之后追加：

```ts
export { ScheduleStore } from "./scheduler/schedule-store.ts";
export type { ScheduleStoreOptions, ClaimDueInput } from "./scheduler/schedule-store.ts";
export { SCHEDULER_LIMITS } from "./scheduler/limits.ts";
export {
  TRIGGER_KINDS,
  ScheduleTriggerError,
  computeNextRunAtMs,
  createIntervalTrigger,
  describeTrigger,
  formatInterval,
  parseIntervalText,
  parseTriggerJson,
  triggerSpecSchema,
} from "./scheduler/trigger.ts";
export type { TriggerKind, TriggerSpec } from "./scheduler/trigger.ts";
export {
  INVOCATION_FAILURE_OUTCOMES,
  INVOCATION_LIVE_STATUSES,
  INVOCATION_MODES,
  INVOCATION_STATUSES,
  SCHEDULE_STATUSES,
  SCHEDULE_STORE_ERROR_CODES,
  ScheduleStoreError,
} from "./scheduler/types.ts";
export type {
  ClaimedInvocation,
  CompleteInvocationInput,
  CompleteInvocationStatus,
  CreateScheduleInput,
  InvocationFailureOutcome,
  InvocationMode,
  InvocationRecord,
  InvocationStatus,
  ScheduleRecord,
  ScheduleStatus,
  ScheduleStoreErrorCode,
} from "./scheduler/types.ts";
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2；再 `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/scheduler/trigger.test.ts`；`pnpm --filter @roll-agent/runtime typecheck`。Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/scheduler packages/runtime/src/index.ts
git commit -m "feat(runtime): add invocation claim/lease/retry ledger to ScheduleStore" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `UnattendedToolPolicy`

**Files:**
- Create: `packages/runtime/src/policy/unattended-policy.ts`
- Modify: `packages/runtime/src/index.ts`（policy 导出行附近）
- Test: `packages/runtime/src/policy/unattended-policy.test.ts`

**Interfaces:**
- Produces: `UNATTENDED_CONFIRMATION_DENIED_REASON`、`UnattendedDeniedConfirmation { agentName; toolName; reason: string | undefined }`、`class UnattendedToolPolicy implements ToolPolicy { constructor(inner: ToolPolicy); check(context): PolicyDecision; readonly deniedConfirmations: readonly UnattendedDeniedConfirmation[] }`

- [ ] **Step 1: 写失败的测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigurableToolPolicy } from "./configurable-policy.ts";
import {
  UNATTENDED_CONFIRMATION_DENIED_REASON,
  UnattendedToolPolicy,
} from "./unattended-policy.ts";
import type { ToolPolicyContext } from "../types/policy.ts";

function context(toolName: string, extra: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return { agentName: "browser-use-agent", toolName, input: {}, ...extra };
}

test("UnattendedToolPolicy 把 confirm 转成 deny 并记录", () => {
  const policy = new UnattendedToolPolicy(new ConfigurableToolPolicy({ defaultMode: "auto" }));
  const decision = policy.check(
    context("browser_click", { annotations: { destructiveHint: true } }),
  );
  assert.equal(decision.action, "deny");
  assert.equal(decision.reason, UNATTENDED_CONFIRMATION_DENIED_REASON);
  assert.deepEqual(policy.deniedConfirmations, [
    { agentName: "browser-use-agent", toolName: "browser_click", reason: "破坏性操作" },
  ]);
});

test("UnattendedToolPolicy 透传 allow 与 deny", () => {
  const policy = new UnattendedToolPolicy(
    new ConfigurableToolPolicy({
      defaultMode: "auto",
      overrides: { "browser-use-agent.browser_status": "deny" },
    }),
  );
  assert.equal(policy.check(context("browser_read")).action, "allow");
  assert.equal(policy.check(context("browser_status")).action, "deny");
  assert.equal(policy.check(context("browser_status")).reason, "配置拒绝执行");
  assert.deepEqual(policy.deniedConfirmations, []);
});

test("deniedConfirmations 返回副本", () => {
  const policy = new UnattendedToolPolicy(new ConfigurableToolPolicy({ defaultMode: "guarded" }));
  policy.check(context("send_message"));
  const first = policy.deniedConfirmations;
  policy.check(context("delete_item"));
  assert.equal(first.length, 1);
  assert.equal(policy.deniedConfirmations.length, 2);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/policy/unattended-policy.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
import type { PolicyDecision, ToolPolicy, ToolPolicyContext } from "../types/policy.ts";

export const UNATTENDED_CONFIRMATION_DENIED_REASON = "无人值守运行不支持交互确认";

export interface UnattendedDeniedConfirmation {
  readonly agentName: string;
  readonly toolName: string;
  readonly reason: string | undefined;
}

export class UnattendedToolPolicy implements ToolPolicy {
  private readonly inner: ToolPolicy;
  private readonly denied: UnattendedDeniedConfirmation[] = [];

  constructor(inner: ToolPolicy) {
    this.inner = inner;
  }

  check(context: ToolPolicyContext): PolicyDecision {
    const decision = this.inner.check(context);
    if (decision.action !== "confirm") {
      return decision;
    }
    this.denied.push({
      agentName: context.agentName,
      toolName: context.toolName,
      reason: decision.reason,
    });
    return { action: "deny", reason: UNATTENDED_CONFIRMATION_DENIED_REASON };
  }

  get deniedConfirmations(): readonly UnattendedDeniedConfirmation[] {
    return [...this.denied];
  }
}
```

`packages/runtime/src/index.ts` 在 `export { ConfigurableToolPolicy } …` 之后加：

```ts
export {
  UNATTENDED_CONFIRMATION_DENIED_REASON,
  UnattendedToolPolicy,
} from "./policy/unattended-policy.ts";
export type { UnattendedDeniedConfirmation } from "./policy/unattended-policy.ts";
```

- [ ] **Step 4: 跑测试确认通过；typecheck**

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/policy/unattended-policy.ts packages/runtime/src/policy/unattended-policy.test.ts packages/runtime/src/index.ts
git commit -m "feat(runtime): add UnattendedToolPolicy that denies confirmations" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `background` host mode

**Files:**
- Modify: `packages/runtime/src/engine/capability-manifest.ts:57-64`
- Modify: `packages/runtime/src/engine/system-prompt.ts:42-55`、`:169-186`、`:219-257`、`:296-335`
- Modify: `packages/runtime/src/engine/agent-session.ts:3468`、`:3505`（`hostMode === CAPABILITY_HOST_MODES.oneShot` 两处）
- Modify: `packages/runtime/src/engine/conversation-engine.ts:561-580`（`buildSession` 中 `const agentInstall = this.resolveAgentInstallBinding();`）
- Test: `packages/runtime/src/engine/capability-manifest.test.ts`、`packages/runtime/src/engine/system-prompt.test.ts`

**Interfaces:**
- Produces: `CAPABILITY_HOST_MODES.background = "background"`；`isProcessBoundHostMode(mode: CapabilityHostMode): boolean`；`shouldOfferAgentInstall(mode: CapabilityHostMode): boolean`；`BuildChatSystemPromptOptions.hostMode?: CapabilityHostMode`；`UNATTENDED_SECTION_HEADING = "# 无人值守运行"`

- [ ] **Step 0: impact**

`impact({ target: "CAPABILITY_HOST_MODES", direction: "upstream", repo: "roll-agent" })`，再 `rg -n "CAPABILITY_HOST_MODES\." packages --glob '!*.test.ts'`。预期只有 capability-manifest / system-prompt / agent-session / conversation-engine / chat.ts。

- [ ] **Step 1: 写失败的测试**

`capability-manifest.test.ts` 末尾追加：

```ts
test("background host mode 与 one-shot 同属进程绑定，且不提供 agent-install", () => {
  assert.equal(CAPABILITY_HOST_MODES.background, "background");
  assert.equal(isProcessBoundHostMode(CAPABILITY_HOST_MODES.background), true);
  assert.equal(isProcessBoundHostMode(CAPABILITY_HOST_MODES.oneShot), true);
  assert.equal(isProcessBoundHostMode(CAPABILITY_HOST_MODES.interactive), false);
  assert.equal(shouldOfferAgentInstall(CAPABILITY_HOST_MODES.background), false);
  assert.equal(shouldOfferAgentInstall(CAPABILITY_HOST_MODES.interactive), true);
});
```

import 里加 `isProcessBoundHostMode, shouldOfferAgentInstall`。

`system-prompt.test.ts` 末尾追加：

```ts
test("background host mode 注入无人值守段，其余模式不注入", () => {
  const background = buildChatSystemPrompt({ hostMode: CAPABILITY_HOST_MODES.background });
  assert.match(background, /# 无人值守运行/u);
  assert.match(background, /不要向用户提问/u);
  const interactive = buildChatSystemPrompt({ hostMode: CAPABILITY_HOST_MODES.interactive });
  assert.doesNotMatch(interactive, /# 无人值守运行/u);
  assert.doesNotMatch(buildChatSystemPrompt(), /# 无人值守运行/u);
});
```

确认该文件已 import `CAPABILITY_HOST_MODES`（`rg -n "CAPABILITY_HOST_MODES" packages/runtime/src/engine/system-prompt.test.ts`），没有就从 `./capability-manifest.ts` 加。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/capability-manifest.test.ts packages/runtime/src/engine/system-prompt.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`capability-manifest.ts`：

```ts
export const CAPABILITY_HOST_MODES = {
  embedded: "embedded",
  interactive: "interactive",
  oneShot: "one-shot",
  server: "server",
  background: "background",
} as const;

export type CapabilityHostMode = (typeof CAPABILITY_HOST_MODES)[keyof typeof CAPABILITY_HOST_MODES];

export function isProcessBoundHostMode(mode: CapabilityHostMode): boolean {
  return mode === CAPABILITY_HOST_MODES.oneShot || mode === CAPABILITY_HOST_MODES.background;
}

export function shouldOfferAgentInstall(mode: CapabilityHostMode): boolean {
  return mode !== CAPABILITY_HOST_MODES.background;
}
```

`system-prompt.ts`：
1. `BuildChatSystemPromptOptions` 加 `readonly hostMode?: CapabilityHostMode;`。
2. 在文件常量区加：

```ts
export const UNATTENDED_SECTION_HEADING = "# 无人值守运行";

const UNATTENDED_SECTION = [
  UNATTENDED_SECTION_HEADING,
  "- 本轮由定时任务自动触发，没有人在终端旁：不要向用户提问、不要等待确认、不要请求补充信息。",
  "- 需要人工确认的操作会被策略直接拒绝；遇到拒绝就跳过该步骤，继续完成其余可以完成的部分。",
  "- 结尾用简短状态汇报：做了什么、哪些步骤因需要确认而未执行、有什么需要人工关注。",
].join("\n");
```

3. shell 段（第 178 行附近）`sessionHostMode === CAPABILITY_HOST_MODES.oneShot` 改为 `sessionHostMode !== undefined && isProcessBoundHostMode(sessionHostMode)`；import `isProcessBoundHostMode`。
4. `buildChatSystemPrompt` 里 `sections.push(OUTPUT_SECTION);` 之前加：

```ts
  if (options.hostMode === CAPABILITY_HOST_MODES.background) {
    sections.push(UNATTENDED_SECTION);
  }
```

5. `buildChatSystemPromptFromManifest` 传给 `buildChatSystemPrompt` 的对象里加 `hostMode: manifest.lifecycle.hostMode,`。

`agent-session.ts` 两处 `this.capabilityManifest.lifecycle.hostMode === CAPABILITY_HOST_MODES.oneShot` 改为 `isProcessBoundHostMode(this.capabilityManifest.lifecycle.hostMode)`（import 加 `isProcessBoundHostMode`）。

`conversation-engine.ts` `buildSession` 中：

```ts
    const agentInstall = shouldOfferAgentInstall(this.hostMode)
      ? this.resolveAgentInstallBinding()
      : undefined;
```

import 加 `shouldOfferAgentInstall`。

- [ ] **Step 4: 跑测试确认通过**

Run: Step 2 命令 + `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/agent-session.test.ts packages/runtime/src/engine/conversation-engine.test.ts`；`pnpm --filter @roll-agent/runtime typecheck`；`pnpm --filter @roll-agent/core typecheck`（chat.ts 的 `satisfies Record<ChatEngineSurface, …>` 不受影响）。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/engine/capability-manifest.ts packages/runtime/src/engine/system-prompt.ts packages/runtime/src/engine/agent-session.ts packages/runtime/src/engine/conversation-engine.ts packages/runtime/src/engine/capability-manifest.test.ts packages/runtime/src/engine/system-prompt.test.ts
git commit -m "feat(runtime): add background host mode with unattended prompt section" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: turn origin（来源标记只进推理副本）

**Files:**
- Modify: `packages/runtime/src/engine/capability-manifest.ts:14-15`、`:99-112`、`:146-167`、`:453-484`、`:521-557`
- Modify: `packages/runtime/src/engine/system-prompt.ts:341-366`
- Modify: `packages/runtime/src/engine/conversation-engine.ts:592-602`（钩子包装）
- Modify: `packages/runtime/src/engine/agent-session.ts:1439-1448`（`buildEffectiveCapabilityTurnContext` 调用）
- Modify: `packages/runtime/src/index.ts`（导出 origin 类型）
- Test: `packages/runtime/src/engine/capability-manifest.test.ts`、`packages/runtime/src/engine/system-prompt.test.ts`、`packages/runtime/src/engine/conversation-engine.test.ts`

**Interfaces:**
- Produces: `CAPABILITY_TURN_ORIGIN_KINDS = { scheduled: "scheduled" }`；`CapabilityTurnOrigin { kind; scheduleId; invocationId; scheduledFor; unattended: boolean }`；`CapabilityExternalDynamicContext.origin?`、`BuildCapabilityTurnContextInput.origin?`、`CapabilityDynamicTurnSnapshot.origin?`；`CAPABILITY_TURN_CONTEXT_VERSION = 2`；reminder 新增行 `turnOrigin=… scheduleId=… invocationId=… scheduledFor=… unattended=…`

- [ ] **Step 0: impact + 版本断言清点**

`impact({ target: "buildEffectiveCapabilityTurnContext", direction: "upstream", repo: "roll-agent" })`；`rg -n "CAPABILITY_TURN_CONTEXT_VERSION|turnContext\.version|version, 1\)" packages --glob '*.test.ts'`，记录所有需要改成 2 的断言。

- [ ] **Step 1: 写失败的测试**

`capability-manifest.test.ts` 末尾追加：

```ts
test("turn origin 进入 turn context 与 safe snapshot，并截断超长字符串", () => {
  const manifest = buildEffectiveCapabilityManifest({
    tools: {},
    toolRoles: {},
    resolveRoute: () => undefined,
    skills: [],
    agentCount: 0,
    profile: "posix",
    cwd: "/workspace",
    platform: "linux",
    hostMode: CAPABILITY_HOST_MODES.background,
  });
  const origin = {
    kind: CAPABILITY_TURN_ORIGIN_KINDS.scheduled,
    scheduleId: "sched-1",
    invocationId: "inv-1",
    scheduledFor: "2026-08-25T09:00:00.000Z",
    unattended: true,
  } as const;
  const context = buildEffectiveCapabilityTurnContext(manifest, { origin });
  assert.equal(context.version, 2);
  assert.deepEqual(context.dynamic.origin, origin);
  const snapshot = createSafeCapabilitySnapshot(manifest, context);
  assert.deepEqual(snapshot.turnContext?.dynamic.origin, origin);
  const long = buildEffectiveCapabilityTurnContext(manifest, {
    origin: { ...origin, scheduleId: "x".repeat(600) },
  });
  const longSnapshot = createSafeCapabilitySnapshot(manifest, long);
  assert.ok((longSnapshot.turnContext?.dynamic.origin?.scheduleId.length ?? 0) < 600);
  assert.equal(buildEffectiveCapabilityTurnContext(manifest).dynamic.origin, undefined);
});
```

import 加 `CAPABILITY_TURN_ORIGIN_KINDS`。

`system-prompt.test.ts` 末尾追加：

```ts
test("reminder 渲染 turn origin 行", () => {
  const manifest = buildEffectiveCapabilityManifest({
    tools: {},
    toolRoles: {},
    resolveRoute: () => undefined,
    skills: [],
    agentCount: 0,
    profile: "posix",
    cwd: "/workspace",
    platform: "linux",
  });
  const reminder = buildCapabilityTurnReminder(
    buildEffectiveCapabilityTurnContext(manifest, {
      now: new Date("2026-08-25T09:00:00Z"),
      origin: {
        kind: "scheduled",
        scheduleId: "sched-1",
        invocationId: "inv-1",
        scheduledFor: "2026-08-25T09:00:00.000Z",
        unattended: true,
      },
    }),
  );
  assert.match(reminder, /turnOrigin=scheduled/u);
  assert.match(reminder, /scheduleId=sched-1/u);
  assert.match(reminder, /invocationId=inv-1/u);
  assert.match(reminder, /scheduledFor=2026-08-25T09:00:00\.000Z/u);
  assert.match(reminder, /unattended=true/u);
  const plain = buildCapabilityTurnReminder(buildEffectiveCapabilityTurnContext(manifest));
  assert.doesNotMatch(plain, /turnOrigin=/u);
});
```

`rg -n "buildEffectiveCapabilityManifest" packages/runtime/src/engine/system-prompt.test.ts`，没有就加 import。

`conversation-engine.test.ts` 末尾追加（该文件已有构造 engine 的用法，按其 `sources: []`、`skillLibrary: null`、`workspaceInstructions: null` 与 MockLanguageModelV4 的方式建 engine；用 `rg -n "new ConversationEngine\(" packages/runtime/src/engine/conversation-engine.test.ts` 找最近的一处抄其 options）：

```ts
test("resolveDynamicCapabilityContext 的 origin 会透传到 turn context", async () => {
  const engine = new ConversationEngine({
    ...baseEngineOptions(),
    hostMode: CAPABILITY_HOST_MODES.background,
    resolveDynamicCapabilityContext: () => ({
      origin: {
        kind: "scheduled",
        scheduleId: "sched-1",
        invocationId: "inv-1",
        scheduledFor: "2026-08-25T09:00:00.000Z",
        unattended: true,
      },
    }),
  });
  try {
    const session = await engine.createSession();
    for await (const event of session.send("hi")) {
      void event;
    }
    const snapshot = session.getCapabilitySnapshot();
    assert.equal(snapshot.turnContext?.dynamic.origin?.invocationId, "inv-1");
  } finally {
    await engine.dispose();
  }
});
```

`baseEngineOptions()` 指该测试文件里已有的 engine options 工厂——`rg -n "function .*Options\(|const .*options = \{" packages/runtime/src/engine/conversation-engine.test.ts` 找到并复用（名字按实际替换）；`getCapabilitySnapshot` 若在 AgentSession 上叫别的名字（`rg -n "createSafeCapabilitySnapshot\(" packages/runtime/src/engine/agent-session.ts` 找调用它的 public 方法名），按实际替换。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

`capability-manifest.ts`：
- `CAPABILITY_TURN_CONTEXT_VERSION = 2 as const`。
- 在 `CapabilityExternalDynamicContext` 之前加：

```ts
export const CAPABILITY_TURN_ORIGIN_KINDS = { scheduled: "scheduled" } as const;
export type CapabilityTurnOriginKind =
  (typeof CAPABILITY_TURN_ORIGIN_KINDS)[keyof typeof CAPABILITY_TURN_ORIGIN_KINDS];

export interface CapabilityTurnOrigin {
  readonly kind: CapabilityTurnOriginKind;
  readonly scheduleId: string;
  readonly invocationId: string;
  readonly scheduledFor: string;
  readonly unattended: boolean;
}
```

- `CapabilityDynamicTurnSnapshot`、`CapabilityExternalDynamicContext`、`BuildCapabilityTurnContextInput` 各加 `readonly origin?: CapabilityTurnOrigin;`。
- `buildEffectiveCapabilityTurnContext` 的 `dynamic` 对象里加 `...(input.origin ? { origin: { ...input.origin } } : {}),`。
- `sanitizeCapabilityTurnContext` 的 `dynamic` 对象里加：

```ts
      ...(context.dynamic.origin
        ? {
            origin: {
              kind: context.dynamic.origin.kind,
              scheduleId: sanitizeSnapshotString(context.dynamic.origin.scheduleId),
              invocationId: sanitizeSnapshotString(context.dynamic.origin.invocationId),
              scheduledFor: sanitizeSnapshotString(context.dynamic.origin.scheduledFor),
              unattended: context.dynamic.origin.unattended,
            },
          }
        : {}),
```

`system-prompt.ts` `buildCapabilityTurnReminder` 在 `date=` 行之后插入：

```ts
    ...(context.dynamic.origin
      ? [
          `turnOrigin=${context.dynamic.origin.kind}`,
          `scheduleId=${context.dynamic.origin.scheduleId}`,
          `invocationId=${context.dynamic.origin.invocationId}`,
          `scheduledFor=${context.dynamic.origin.scheduledFor}`,
          `unattended=${String(context.dynamic.origin.unattended)}`,
        ]
      : []),
```

`conversation-engine.ts` 钩子包装返回对象加 `...(dynamic.origin ? { origin: dynamic.origin } : {}),`。

`agent-session.ts` `buildEffectiveCapabilityTurnContext(this.capabilityManifest, { … })` 参数里加 `...(externalDynamicContext.origin ? { origin: externalDynamicContext.origin } : {}),`。

`packages/runtime/src/index.ts` 加：

```ts
export { CAPABILITY_HOST_MODES, CAPABILITY_TURN_ORIGIN_KINDS } from "./engine/capability-manifest.ts";
export type {
  CapabilityHostMode,
  CapabilityTurnOrigin,
  CapabilityExternalDynamicContext,
} from "./engine/capability-manifest.ts";
```

把 Step 0 记录的版本断言全部改为 2。

- [ ] **Step 4: 跑全部 runtime 测试确认通过**

Run: `pnpm --filter @roll-agent/runtime test`（`runtime-server.test.ts` 的「1.1 Turn timeout」偶发，隔离重跑一次即可）；`pnpm --filter @roll-agent/runtime typecheck`。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/engine packages/runtime/src/index.ts
git commit -m "feat(runtime): carry scheduled turn origin through capability turn context" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: core `runtime-host/`：从 chat.ts 搬出 Engine factory 与 `runJsonTurn`

**Files:**
- Create: `packages/core/src/runtime-host/engine-factory.ts`
- Create: `packages/core/src/runtime-host/json-turn.ts`
- Modify: `packages/core/src/cli/commands/chat.ts:47-172`、`:197-252`、`:388-488`
- Test: 既有 `packages/core/src/cli/commands/chat.test.ts`（不改断言，只确认 re-export 后仍通过）

**Interfaces:**
- Produces（`engine-factory.ts`）：`RuntimeModule`、`ChatEngineOptions`、`ThreadStoreInstance`、`ConversationEngineInstance`、`CHAT_ENGINE_SURFACES`（新增 `background: "background"`）、`ChatEngineSurface`、`chatHostModeForSurface`、`createToolPolicy`、`CreateChatEngineInput`（新增可选 `policy`、`resolveDynamicCapabilityContext`）、`createChatEngine`、`resolveChatLlmReadiness`、`resolveChatLlmCalls`、`loadRuntime`
- Produces（`json-turn.ts`）：`runJsonTurn(session: AgentSession, message: string): Promise<ChatCommandResult>`
- chat.ts 继续 `export` 同名符号（re-export），`runtime-serve.ts` 与 `chat.test.ts` 零改动

- [ ] **Step 0: impact**

`impact({ target: "createChatEngine", direction: "upstream", repo: "roll-agent" })`、`impact({ target: "runJsonTurn", … })`；`rg -n "from \"./chat.ts\"|commands/chat.ts\"" packages/core/src`。已知调用方：`chat.test.ts:15-22`（导入 CHAT_ENGINE_SURFACES / chatHostModeForSurface / createChatEngine / resolveChatLlmCalls / resolveChatLlmReadiness / runJsonTurn / runRepl）、`runtime-serve.ts:4`（runServer）。

- [ ] **Step 1: 先跑基线测试**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/cli/commands/chat.test.ts`
Expected: PASS（记录用例数，搬完必须一致）。

- [ ] **Step 2: 创建 `engine-factory.ts`**

把 chat.ts 中以下内容**剪切**过去（保持原文，仅改 import 路径）：`type RuntimeModule`（47）、`createToolPolicy`（51-56）、三个 `type` 别名（57-59）、`CHAT_ENGINE_SURFACES`…`chatHostModeForSurface`（61-84）、`CreateChatEngineInput`（85-96）、`reportAgentBootstrapIssue / reportSkillLibraryIssue / reportWorkspaceInstructionsIssue`（120-137）、`createChatEngine`（152-172）、`loadRuntime`（197-199）、`resolveChatLlmReadiness`（207-212）、`resolveChatLlmCalls`（214-252）。文件头 import：

```ts
import { inspectLlmConfigReadiness, type LlmConfigReadiness } from "../config/helpers.ts";
import type { RollConfig } from "../config/schema.ts";
import { resolveLLMCall } from "../llm/providers.ts";
import { isDebugLogEnabled, log } from "../cli/utils/output.ts";
```

（`resolveLLMCall` 是否还需要 `thinkingProviderOptions` 以 typecheck 为准；chat.ts 里不再使用的 import 要删掉，否则 `noUnusedLocals` 报错。）

对搬过去的代码做三处修改：

```ts
export const CHAT_ENGINE_SURFACES = {
  ink: "ink",
  basicRepl: "basic-repl",
  oneShot: "one-shot",
  json: "json",
  server: "server",
  background: "background",
} as const;

const CHAT_HOST_MODE_BY_SURFACE = {
  [CHAT_ENGINE_SURFACES.ink]: "interactive",
  [CHAT_ENGINE_SURFACES.basicRepl]: "interactive",
  [CHAT_ENGINE_SURFACES.oneShot]: "one-shot",
  [CHAT_ENGINE_SURFACES.json]: "one-shot",
  [CHAT_ENGINE_SURFACES.server]: "server",
  [CHAT_ENGINE_SURFACES.background]: "background",
} as const satisfies Record<ChatEngineSurface, NonNullable<ChatEngineOptions["hostMode"]>>;

export interface CreateChatEngineInput {
  readonly runtime: RuntimeModule;
  readonly config: RollConfig;
  readonly model: NonNullable<ChatEngineOptions["model"]>;
  readonly store: ThreadStoreInstance;
  readonly surface: ChatEngineSurface;
  readonly policy?: NonNullable<ChatEngineOptions["policy"]>;
  readonly resolveDynamicCapabilityContext?: NonNullable<
    ChatEngineOptions["resolveDynamicCapabilityContext"]
  >;
  readonly providerOptions?: NonNullable<ChatEngineOptions["providerOptions"]>;
  readonly structuredOutputProviderOptions?: NonNullable<
    ChatEngineOptions["structuredOutputProviderOptions"]
  >;
  readonly structuredOutputReasoning?: NonNullable<ChatEngineOptions["structuredOutputReasoning"]>;
  readonly shellEnv?: NodeJS.ProcessEnv;
}
```

`createChatEngine` 里 `policy: createToolPolicy(input.runtime, input.config),` 改为 `policy: input.policy ?? createToolPolicy(input.runtime, input.config),`，并在 `debugEvents` 之前加 `...(input.resolveDynamicCapabilityContext ? { resolveDynamicCapabilityContext: input.resolveDynamicCapabilityContext } : {}),`。所有搬过去的函数/类型都加 `export`（`RuntimeModule`、`ChatEngineOptions`、`ThreadStoreInstance`、`ConversationEngineInstance`、`createToolPolicy`、`loadRuntime` 也导出）。

- [ ] **Step 3: 创建 `json-turn.ts`**

剪切 `runJsonTurn`（388-488）过去，import：

```ts
import type { AgentSession } from "@roll-agent/runtime";
import type {
  ChatCommandResult,
  ChatCompactionSummary,
  ChatPendingAction,
  ChatStepSummary,
  ChatStepUsage,
  ChatTokenUsage,
} from "../types/chat.ts";
```

（以 chat.ts 原 import 与 typecheck 为准补齐。）

- [ ] **Step 4: chat.ts 改为 import + re-export**

chat.ts 顶部加：

```ts
import {
  CHAT_ENGINE_SURFACES,
  chatHostModeForSurface,
  createChatEngine,
  loadRuntime,
  resolveChatLlmCalls,
  resolveChatLlmReadiness,
  type ChatEngineSurface,
  type ConversationEngineInstance,
  type RuntimeModule,
} from "../../runtime-host/engine-factory.ts";
import { runJsonTurn } from "../../runtime-host/json-turn.ts";

export {
  CHAT_ENGINE_SURFACES,
  chatHostModeForSurface,
  createChatEngine,
  resolveChatLlmCalls,
  resolveChatLlmReadiness,
  runJsonTurn,
};
export type { ChatEngineSurface };
```

`moduleExtension` 常量保留在 chat.ts（`runChatOnboardingFlow` 用）。删除已搬走的定义与不再使用的 import，直到 `pnpm --filter @roll-agent/core typecheck` 零错误。

- [ ] **Step 5: 跑测试确认与基线一致**

Run: Step 1 命令 + `node --experimental-strip-types --experimental-sqlite --test packages/core/src/cli/commands/runtime-serve.test.ts`（若存在）；`npx eslint packages/core/src/runtime-host packages/core/src/cli/commands/chat.ts`；`npx prettier --write` 三个文件。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime-host packages/core/src/cli/commands/chat.ts
git commit -m "refactor(core): extract engine factory and json turn into runtime-host" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: `scheduler-host/`：paths、`executeInvocation`、真实 runner、`roll schedule exec`

**Files:**
- Create: `packages/core/src/scheduler-host/paths.ts`
- Create: `packages/core/src/scheduler-host/execute-invocation.ts`
- Create: `packages/core/src/scheduler-host/run-scheduled-turn.ts`
- Create: `packages/core/src/cli/commands/schedule-command-utils.ts`
- Create: `packages/core/src/cli/commands/schedule-exec.ts`
- Test: `packages/core/src/scheduler-host/execute-invocation.test.ts`

**Interfaces:**
- Consumes: Task 4 `ScheduleStore` API、Task 5 `UnattendedToolPolicy`、Task 7 origin、Task 8 `createChatEngine / resolveChatLlmReadiness / resolveChatLlmCalls / runJsonTurn / loadRuntime / createToolPolicy / CHAT_ENGINE_SURFACES`
- Produces: `SCHEDULER_SERVICE_LABEL`、`WINDOWS_SCHEDULER_TASK_NAME`、`SCHEDULER_DAEMON_LOCK_NAME`、`SCHEDULE_TOKEN_ENV`、`SchedulerPaths`、`createSchedulerPaths(dataDir, homeDir?)`；`ScheduledTurnOutcome`、`ScheduledTurnRunner`、`ExecuteInvocationResult`、`executeInvocation(options)`；`createScheduledTurnRunner({ config, runtime, shellEnv? })`；`openScheduleStore(config, runtime)`、`runScheduleCommand(work)`

- [ ] **Step 1: 写失败的测试**

`packages/core/src/scheduler-host/execute-invocation.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INVOCATION_FAILURE_OUTCOMES,
  INVOCATION_STATUSES,
  ScheduleStore,
  createIntervalTrigger,
} from "@roll-agent/runtime";
import { executeInvocation, type ScheduledTurnRunner } from "./execute-invocation.ts";

const NOW = Date.parse("2026-08-25T09:00:00.000Z");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-exec-"));
}

function claimOne(store: ScheduleStore) {
  store.createSchedule(
    {
      name: "巡检",
      prompt: "检查未读",
      cwd: "/workspace",
      trigger: createIntervalTrigger("30m"),
      fireImmediately: true,
    },
    NOW,
  );
  const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
  assert.ok(claim);
  return claim;
}

test("executeInvocation 完成后写入 thread id 与输出摘录", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    const runTurn: ScheduledTurnRunner = (schedule, invocation) => {
      assert.equal(invocation.status, INVOCATION_STATUSES.running);
      assert.equal(schedule.prompt, "检查未读");
      return Promise.resolve({ status: "completed", threadId: "thread-1", output: "ok".repeat(5_000) });
    };
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn,
      now: () => NOW + 10,
    });
    assert.deepEqual(result, {
      kind: "completed",
      invocationId: claim.invocation.id,
      threadId: "thread-1",
    });
    const stored = store.getInvocation(claim.invocation.id);
    assert.equal(stored?.status, INVOCATION_STATUSES.completed);
    assert.equal(stored?.threadId, "thread-1");
    assert.equal(stored?.outputExcerpt?.length, 4_000);
    assert.equal(stored?.finishedAtMs, NOW + 10);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeInvocation 记录 needs_confirmation 与 pendingActions", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn: () =>
        Promise.resolve({
          status: "needs_confirmation",
          threadId: "thread-2",
          output: "partial",
          pendingActions: ["browser.click"],
        }),
    });
    assert.equal(result.kind, "needs_confirmation");
    assert.deepEqual(store.getInvocation(claim.invocation.id)?.pendingActions, ["browser.click"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner 抛错或返回 failed 走 failInvocation", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3 });
    const claim = claimOne(store);
    const thrown = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn: () => Promise.reject(new Error("model exploded")),
    });
    assert.deepEqual(thrown, {
      kind: "failed",
      invocationId: claim.invocation.id,
      error: "model exploded",
      outcome: INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    });
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.retry);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token 不匹配返回 lost-claim 且不调用 runner", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    let called = false;
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: "stale",
      runTurn: () => {
        called = true;
        return Promise.resolve({ status: "completed", threadId: "t", output: "" });
      },
    });
    assert.deepEqual(result, { kind: "lost-claim", invocationId: claim.invocation.id });
    assert.equal(called, false);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.claimed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/execute-invocation.test.ts`

- [ ] **Step 3: 实现 paths.ts**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export const SCHEDULER_SERVICE_LABEL = "dev.roll-agent.scheduler" as const;
export const WINDOWS_SCHEDULER_TASK_NAME = "Roll Agent Scheduler" as const;
export const SCHEDULER_DAEMON_LOCK_NAME = `${String.fromCharCode(0)}roll-scheduler-daemon`;
export const SCHEDULE_TOKEN_ENV = "ROLL_SCHEDULE_OWNERSHIP_TOKEN";

export interface SchedulerPaths {
  readonly dataDir: string;
  readonly logPath: string;
  readonly daemonRecordPath: string;
  readonly launchAgentPath: string;
}

export function createSchedulerPaths(dataDir: string, homeDir: string = homedir()): SchedulerPaths {
  return {
    dataDir,
    logPath: join(dataDir, "scheduler.log"),
    daemonRecordPath: join(dataDir, "daemon.json"),
    launchAgentPath: join(homeDir, "Library", "LaunchAgents", `${SCHEDULER_SERVICE_LABEL}.plist`),
  };
}
```

- [ ] **Step 4: 实现 execute-invocation.ts**

```ts
import { SCHEDULER_LIMITS } from "@roll-agent/runtime";
import type {
  InvocationFailureOutcome,
  InvocationRecord,
  ScheduleRecord,
  ScheduleStore,
} from "@roll-agent/runtime";

export const SCHEDULED_TURN_STATUSES = {
  completed: "completed",
  needsConfirmation: "needs_confirmation",
  failed: "failed",
} as const;

export type ScheduledTurnOutcome =
  | {
      readonly status: typeof SCHEDULED_TURN_STATUSES.completed;
      readonly threadId: string;
      readonly output: string;
    }
  | {
      readonly status: typeof SCHEDULED_TURN_STATUSES.needsConfirmation;
      readonly threadId: string;
      readonly output: string;
      readonly pendingActions: readonly string[];
    }
  | {
      readonly status: typeof SCHEDULED_TURN_STATUSES.failed;
      readonly threadId?: string;
      readonly error: string;
    };

export type ScheduledTurnRunner = (
  schedule: ScheduleRecord,
  invocation: InvocationRecord,
) => Promise<ScheduledTurnOutcome>;

export const EXECUTE_INVOCATION_KINDS = {
  completed: "completed",
  needsConfirmation: "needs_confirmation",
  failed: "failed",
  lostClaim: "lost-claim",
} as const;

export type ExecuteInvocationResult =
  | {
      readonly kind:
        | typeof EXECUTE_INVOCATION_KINDS.completed
        | typeof EXECUTE_INVOCATION_KINDS.needsConfirmation;
      readonly invocationId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: typeof EXECUTE_INVOCATION_KINDS.failed;
      readonly invocationId: string;
      readonly error: string;
      readonly outcome: InvocationFailureOutcome;
    }
  | { readonly kind: typeof EXECUTE_INVOCATION_KINDS.lostClaim; readonly invocationId: string };

export interface ExecuteInvocationOptions {
  readonly store: ScheduleStore;
  readonly invocationId: string;
  readonly ownershipToken: string;
  readonly runTurn: ScheduledTurnRunner;
  readonly now?: () => number;
  readonly maxOutputExcerptChars?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeInvocation(
  options: ExecuteInvocationOptions,
): Promise<ExecuteInvocationResult> {
  const now = options.now ?? Date.now;
  const maxChars = options.maxOutputExcerptChars ?? SCHEDULER_LIMITS.maxOutputExcerptChars;
  const begun = options.store.beginInvocation(options.invocationId, options.ownershipToken, now());
  if (begun === undefined) {
    return { kind: EXECUTE_INVOCATION_KINDS.lostClaim, invocationId: options.invocationId };
  }
  let outcome: ScheduledTurnOutcome;
  try {
    outcome = await options.runTurn(begun.schedule, begun.invocation);
  } catch (error) {
    const message = errorMessage(error);
    const failure = options.store.failInvocation(
      options.invocationId,
      options.ownershipToken,
      message,
      now(),
    );
    return {
      kind: EXECUTE_INVOCATION_KINDS.failed,
      invocationId: options.invocationId,
      error: message,
      outcome: failure,
    };
  }
  if (outcome.status === SCHEDULED_TURN_STATUSES.failed) {
    const failure = options.store.failInvocation(
      options.invocationId,
      options.ownershipToken,
      outcome.error,
      now(),
    );
    return {
      kind: EXECUTE_INVOCATION_KINDS.failed,
      invocationId: options.invocationId,
      error: outcome.error,
      outcome: failure,
    };
  }
  const written = options.store.completeInvocation({
    id: options.invocationId,
    ownershipToken: options.ownershipToken,
    status: outcome.status,
    nowMs: now(),
    threadId: outcome.threadId,
    outputExcerpt: outcome.output.slice(0, maxChars),
    ...(outcome.status === SCHEDULED_TURN_STATUSES.needsConfirmation
      ? { pendingActions: outcome.pendingActions }
      : {}),
  });
  if (!written) {
    return { kind: EXECUTE_INVOCATION_KINDS.lostClaim, invocationId: options.invocationId };
  }
  return { kind: outcome.status, invocationId: options.invocationId, threadId: outcome.threadId };
}
```

- [ ] **Step 5: 跑测试确认通过**

- [ ] **Step 6: 实现 run-scheduled-turn.ts（真实 runner，不写单测，靠 typecheck + Task 14 手动验证）**

```ts
import type { RollConfig } from "../config/schema.ts";
import type { ChatCommandResult } from "../types/chat.ts";
import {
  CHAT_ENGINE_SURFACES,
  createChatEngine,
  createToolPolicy,
  resolveChatLlmCalls,
  resolveChatLlmReadiness,
  type RuntimeModule,
} from "../runtime-host/engine-factory.ts";
import { runJsonTurn } from "../runtime-host/json-turn.ts";
import { SCHEDULED_TURN_STATUSES, type ScheduledTurnOutcome, type ScheduledTurnRunner } from "./execute-invocation.ts";

export interface CreateScheduledTurnRunnerInput {
  readonly config: RollConfig;
  readonly runtime: RuntimeModule;
  readonly shellEnv?: NodeJS.ProcessEnv;
}

function mapTurnResult(result: ChatCommandResult, denied: readonly string[]): ScheduledTurnOutcome {
  switch (result.status) {
    case "completed":
      return denied.length > 0
        ? {
            status: SCHEDULED_TURN_STATUSES.needsConfirmation,
            threadId: result.sessionId,
            output: result.output,
            pendingActions: denied,
          }
        : { status: SCHEDULED_TURN_STATUSES.completed, threadId: result.sessionId, output: result.output };
    case "needs_confirmation":
      return {
        status: SCHEDULED_TURN_STATUSES.needsConfirmation,
        threadId: result.sessionId,
        output: "",
        pendingActions: [...result.pendingActions.map((action) => action.summary), ...denied],
      };
    case "needs_input":
      return { status: SCHEDULED_TURN_STATUSES.failed, threadId: result.sessionId, error: "需要用户输入" };
    case "failed":
      return {
        status: SCHEDULED_TURN_STATUSES.failed,
        ...(result.sessionId !== undefined ? { threadId: result.sessionId } : {}),
        error: result.message,
      };
    case "unavailable":
      return { status: SCHEDULED_TURN_STATUSES.failed, error: result.message };
  }
}

export function createScheduledTurnRunner(input: CreateScheduledTurnRunnerInput): ScheduledTurnRunner {
  return async (schedule, invocation) => {
    const readiness = resolveChatLlmReadiness(input.config);
    if (!readiness.configured || !readiness.providerConfig) {
      return { status: SCHEDULED_TURN_STATUSES.failed, error: readiness.message };
    }
    const llm = resolveChatLlmCalls(
      readiness.provider,
      readiness.model,
      readiness.providerConfig.apiKey,
      readiness.providerConfig.baseUrl,
      input.config.runtime.thinkingLevel,
      input.config.runtime.compaction.thinkingLevel,
      input.config.runtime.compaction.strategy === "summarize",
    );
    const store = new input.runtime.ThreadStore(input.config.runtime.threadsDir);
    const policy = new input.runtime.UnattendedToolPolicy(createToolPolicy(input.runtime, input.config));
    const engine = createChatEngine({
      runtime: input.runtime,
      config: input.config,
      model: llm.model,
      store,
      surface: CHAT_ENGINE_SURFACES.background,
      policy,
      resolveDynamicCapabilityContext: () => ({
        origin: {
          kind: "scheduled",
          scheduleId: schedule.id,
          invocationId: invocation.id,
          scheduledFor: new Date(invocation.scheduledForMs).toISOString(),
          unattended: true,
        },
      }),
      ...(llm.providerOptions ? { providerOptions: llm.providerOptions } : {}),
      ...(llm.structuredOutputProviderOptions
        ? { structuredOutputProviderOptions: llm.structuredOutputProviderOptions }
        : {}),
      ...(llm.structuredOutputReasoning
        ? { structuredOutputReasoning: llm.structuredOutputReasoning }
        : {}),
      ...(input.shellEnv ? { shellEnv: input.shellEnv } : {}),
    });
    let session: Awaited<ReturnType<typeof engine.createSession>> | undefined;
    try {
      session = await engine.createSession({ title: `[定时] ${schedule.name}` });
      const result = await runJsonTurn(session, schedule.prompt);
      const denied = policy.deniedConfirmations.map((item) => `${item.agentName}.${item.toolName}`);
      return mapTurnResult(result, denied);
    } finally {
      await session?.close();
      await engine.dispose();
      store.close();
    }
  };
}
```

（`session.close()` 名称以 `rg -n "async close\(\)" packages/runtime/src/engine/agent-session.ts` 为准。）

- [ ] **Step 7: 实现 schedule-command-utils.ts 与 schedule-exec.ts**

`schedule-command-utils.ts`：

```ts
import type { RollConfig } from "../../config/schema.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, type RuntimeModule } from "../../runtime-host/engine-factory.ts";
import { SCHEDULE_TOKEN_ENV } from "../../scheduler-host/paths.ts";

export type ScheduleStoreInstance = InstanceType<RuntimeModule["ScheduleStore"]>;

export function openScheduleStore(config: RollConfig, runtime: RuntimeModule): ScheduleStoreInstance {
  return new runtime.ScheduleStore(config.scheduler.dataDir, {
    maxSchedules: config.scheduler.maxSchedules,
  });
}

export async function runScheduleCommand(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error: unknown) {
    log.error(error instanceof Error ? error.message : "roll schedule 命令执行失败");
    process.exitCode = 1;
  }
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export { loadRuntime, SCHEDULE_TOKEN_ENV };
```

`schedule-exec.ts`：

```ts
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { executeInvocation } from "../../scheduler-host/execute-invocation.ts";
import { createScheduledTurnRunner } from "../../scheduler-host/run-scheduled-turn.ts";
import { log } from "../utils/output.ts";
import {
  SCHEDULE_TOKEN_ENV,
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "（daemon 内部入口）执行一条已 claim 的定时任务 invocation" },
  args: {
    invocation: { type: "string", description: "invocation ID", required: true },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const ownershipToken = process.env[SCHEDULE_TOKEN_ENV];
      if (ownershipToken === undefined || ownershipToken.length === 0) {
        throw new Error(`缺少 ${SCHEDULE_TOKEN_ENV}；该命令只应由 roll schedule daemon 调用`);
      }
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const result = await executeInvocation({
          store,
          invocationId: args.invocation,
          ownershipToken,
          runTurn: createScheduledTurnRunner({ config, runtime }),
        });
        printJson(result);
        if (result.kind === "failed") {
          log.warn(`invocation ${args.invocation} 执行失败：${result.error}`);
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });
  },
});
```

- [ ] **Step 8: typecheck + lint + 提交**

Run: `pnpm --filter @roll-agent/core typecheck`；`npx eslint packages/core/src/scheduler-host packages/core/src/cli/commands/schedule-command-utils.ts packages/core/src/cli/commands/schedule-exec.ts`；`npx prettier --write` 同上文件。

```bash
git add packages/core/src/scheduler-host packages/core/src/cli/commands/schedule-command-utils.ts packages/core/src/cli/commands/schedule-exec.ts
git commit -m "feat(core): add scheduler-host invocation executor and roll schedule exec" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: `roll schedule` 命令组：add / list / show / remove / pause / resume / runs + e2e

**Files:**
- Create: `packages/core/src/cli/commands/schedule.ts`
- Create: `packages/core/src/cli/commands/schedule-add.ts`、`schedule-list.ts`、`schedule-show.ts`、`schedule-remove.ts`、`schedule-pause.ts`、`schedule-resume.ts`、`schedule-runs.ts`
- Modify: `packages/core/src/cli/commands/schedule-command-utils.ts`（加序列化 helper）
- Modify: `packages/core/src/cli/index.ts:28-42`（`subCommands` 加 `schedule`）
- Test: `packages/core/src/cli/smoke-schedule.e2e.ts`

**Interfaces:**
- Produces: `serializeSchedule(record): ScheduleJson`、`serializeInvocation(record): InvocationJson`（ISO 时间字符串）；命令：`roll schedule add <prompt> --name <n> --every <30m> [--cwd <dir>] [--now] [--json]`、`roll schedule list [--json]`、`roll schedule show <id> [--json]`、`roll schedule remove <id>`、`roll schedule pause <id>`、`roll schedule resume <id>`、`roll schedule runs <id> [--limit N] [--json]`

- [ ] **Step 1: 写失败的 e2e**

`packages/core/src/cli/smoke-schedule.e2e.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildConfigYaml, runRoll } from "./smoke.e2e-harness.ts";

function setupWorkspace(): { readonly workspace: string; readonly env: Record<string, string> } {
  const workspace = mkdtempSync(resolve(tmpdir(), `roll-schedule-${randomUUID()}-`));
  const dataDir = resolve(workspace, "agents");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    resolve(workspace, "roll.config.yaml"),
    `${buildConfigYaml(dataDir)}
scheduler:
  data-dir: ${resolve(workspace, "scheduler")}
`,
  );
  return { workspace, env: { HOME: workspace } };
}

test("e2e smoke: roll schedule add/list/pause/resume/remove --json", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const added = runRoll(
      ["schedule", "add", "检查未读并汇总", "--name", "巡检", "--every", "30m", "--cwd", workspace, "--json"],
      workspace,
      { env },
    );
    assert.equal(added.status, 0, added.stderr);
    const created = JSON.parse(added.stdout) as { id: string; status: string; nextRunAt: string };
    assert.equal(created.status, "active");
    assert.ok(Date.parse(created.nextRunAt) > Date.now() + 29 * 60_000);

    const listed = runRoll(["schedule", "list", "--json"], workspace, { env });
    assert.equal(listed.status, 0, listed.stderr);
    const rows = JSON.parse(listed.stdout) as Array<{ id: string; trigger: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, created.id);
    assert.equal(rows[0]?.trigger, "每 30 分钟");

    assert.equal(runRoll(["schedule", "pause", created.id], workspace, { env }).status, 0);
    const shown = runRoll(["schedule", "show", created.id, "--json"], workspace, { env });
    assert.equal((JSON.parse(shown.stdout) as { status: string }).status, "paused");
    assert.equal(runRoll(["schedule", "resume", created.id], workspace, { env }).status, 0);

    const runs = runRoll(["schedule", "runs", created.id, "--json"], workspace, { env });
    assert.equal(runs.status, 0, runs.stderr);
    assert.deepEqual(JSON.parse(runs.stdout), []);

    assert.equal(runRoll(["schedule", "remove", created.id], workspace, { env }).status, 0);
    const empty = runRoll(["schedule", "list", "--json"], workspace, { env });
    assert.deepEqual(JSON.parse(empty.stdout), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll schedule add 拒绝低于 60 秒的间隔与不存在的 cwd", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const tooFast = runRoll(
      ["schedule", "add", "x", "--name", "快", "--every", "30s", "--cwd", workspace],
      workspace,
      { env },
    );
    assert.equal(tooFast.status, 1);
    assert.match(tooFast.stderr, /60/u);
    const missingCwd = runRoll(
      ["schedule", "add", "x", "--name", "无目录", "--every", "5m", "--cwd", resolve(workspace, "nope")],
      workspace,
      { env },
    );
    assert.equal(missingCwd.status, 1);
    assert.match(missingCwd.stderr, /cwd/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("e2e smoke: roll --help 列出 schedule", () => {
  const { workspace, env } = setupWorkspace();
  try {
    const result = runRoll(["--help"], workspace, { env });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\bschedule\b/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑 e2e 确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/cli/smoke-schedule.e2e.ts`
Expected: FAIL（unknown command）。

- [ ] **Step 3: 实现序列化 helper（追加到 schedule-command-utils.ts）**

```ts
import type { InvocationRecord, ScheduleRecord } from "@roll-agent/runtime";
import { describeTrigger } from "@roll-agent/runtime";

function isoOrUndefined(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

export function serializeSchedule(record: ScheduleRecord) {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    trigger: describeTrigger(record.trigger),
    cwd: record.cwd,
    prompt: record.prompt,
    nextRunAt: isoOrUndefined(record.nextRunAtMs),
    lastRunAt: isoOrUndefined(record.lastRunAtMs),
    lastError: record.lastError,
    createdAt: new Date(record.createdAtMs).toISOString(),
  };
}

export function serializeInvocation(record: InvocationRecord) {
  return {
    id: record.id,
    scheduleId: record.scheduleId,
    mode: record.mode,
    status: record.status,
    scheduledFor: new Date(record.scheduledForMs).toISOString(),
    attempt: record.attempt,
    threadId: record.threadId,
    error: record.error,
    pendingActions: record.pendingActions,
    outputExcerpt: record.outputExcerpt,
    startedAt: isoOrUndefined(record.startedAtMs),
    finishedAt: isoOrUndefined(record.finishedAtMs),
  };
}

export function requireSchedule(store: ScheduleStoreInstance, id: string): ScheduleRecord {
  const record = store.getSchedule(id);
  if (record === undefined) {
    throw new Error(`定时任务 ${id} 不存在；用 roll schedule list 查看`);
  }
  return record;
}
```

- [ ] **Step 4: 实现命令组与各子命令**

`schedule.ts`：

```ts
import { defineCommand } from "citty";

const commandExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";

function loadScheduleCommand(fileName: string) {
  const specifier = new URL(`./${fileName}.${commandExtension}`, import.meta.url).href;
  return import(specifier).then((m) => m.default);
}

export default defineCommand({
  meta: { description: "管理定时任务：按周期无人值守地运行一轮 chat" },
  subCommands: {
    add: () => loadScheduleCommand("schedule-add"),
    list: () => loadScheduleCommand("schedule-list"),
    show: () => loadScheduleCommand("schedule-show"),
    remove: () => loadScheduleCommand("schedule-remove"),
    pause: () => loadScheduleCommand("schedule-pause"),
    resume: () => loadScheduleCommand("schedule-resume"),
    runs: () => loadScheduleCommand("schedule-runs"),
    exec: () => loadScheduleCommand("schedule-exec"),
  },
});
```

`schedule-add.ts`：

```ts
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
  serializeSchedule,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "登记一个按周期运行的定时任务" },
  args: {
    prompt: { type: "positional", description: "每次触发时交给 roll chat 的任务描述", required: true },
    name: { type: "string", description: "任务名称", required: true },
    every: { type: "string", description: "运行周期，如 30m、2h、1d（最短 60s）", required: true },
    cwd: { type: "string", description: "任务运行的工作目录（默认当前目录）" },
    now: { type: "boolean", description: "登记后立即触发一次", default: false },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const cwd = resolve(args.cwd ?? process.cwd());
      let isDirectory = false;
      try {
        isDirectory = statSync(cwd).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (!isDirectory) {
        throw new Error(`cwd 不存在或不是目录：${cwd}`);
      }
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const record = store.createSchedule({
          name: args.name,
          prompt: args.prompt,
          cwd,
          trigger: runtime.createIntervalTrigger(args.every),
          fireImmediately: args.now,
        });
        const serialized = serializeSchedule(record);
        if (args.json) {
          printJson(serialized);
          return;
        }
        log.success(
          `已登记定时任务 ${record.name}（${serialized.trigger}），ID ${record.id}，下次运行 ${serialized.nextRunAt ?? "-"}`,
        );
        log.info("需要 roll schedule daemon 在运行才会触发；用 roll schedule status 查看。");
      } finally {
        store.close();
      }
    });
  },
});
```

`schedule-list.ts`：

```ts
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
  serializeSchedule,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "列出所有定时任务" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const rows = store.listSchedules().map(serializeSchedule);
        if (args.json) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          console.log("暂无定时任务。用 `roll schedule add <prompt> --name <name> --every 30m` 登记一个。");
          return;
        }
        for (const row of rows) {
          console.log(
            `${row.id}  ${row.status.padEnd(6)}  ${row.trigger.padEnd(10)}  next=${row.nextRunAt ?? "-"}  ${row.name}${row.lastError ? `  ⚠ ${row.lastError}` : ""}`,
          );
        }
      } finally {
        store.close();
      }
    });
  },
});
```

`schedule-show.ts`（positional `id`，`--json`）：取 `requireSchedule` → `printJson(serializeSchedule(record))`，非 json 逐字段 `console.log("name: …")`。

`schedule-remove.ts`：positional `id`；`store.removeSchedule(id)` 为 false 时抛 `定时任务 ${id} 不存在`；成功 `log.success`。

`schedule-pause.ts` / `schedule-resume.ts`：positional `id`；`store.setScheduleStatus(id, runtime.SCHEDULE_STATUSES.paused | active)` 为 false 时抛不存在；成功 `log.success`。

`schedule-runs.ts`：positional `id`，`limit`（string，默认 `"20"`，`Number.parseInt` 后 `<= 0` 或 NaN 抛错），`--json`；先 `requireSchedule`，`store.listInvocations(id, limit).map(serializeInvocation)`，json 直接打印，否则每行 `${status} ${scheduledFor} attempt=${attempt} thread=${threadId ?? "-"} ${error ?? ""}`。

`packages/core/src/cli/index.ts` 的 `subCommands` 在 `runtime:` 之后加 `schedule: () => loadMainCommand("schedule"),`。

- [ ] **Step 5: 跑 e2e 确认通过**

Run: Step 2 命令；`pnpm --filter @roll-agent/core typecheck`；`npx eslint packages/core/src/cli/commands/schedule*.ts packages/core/src/cli/smoke-schedule.e2e.ts`；prettier。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/cli/commands/schedule*.ts packages/core/src/cli/index.ts packages/core/src/cli/smoke-schedule.e2e.ts
git commit -m "feat(core): add roll schedule management commands" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: `SchedulerDaemon` 循环 + exec 子进程 spawn

**Files:**
- Modify: `packages/core/src/companion-host/invocation.ts:1-44`（`BundledRollInvocation` 加 `execArgv`）
- Create: `packages/core/src/scheduler-host/spawn-invocation.ts`
- Create: `packages/core/src/scheduler-host/daemon.ts`
- Test: `packages/core/src/companion-host/invocation.test.ts`、`packages/core/src/scheduler-host/daemon.test.ts`

**Interfaces:**
- Produces: `BundledRollInvocation.execArgv: readonly string[]`（过滤后的安全 execArgv）；`SpawnedInvocation { exited: Promise<number | null>; kill(): void }`、`InvocationSpawner = (claim: ClaimedInvocation) => SpawnedInvocation`、`createInvocationSpawner({ invocation, logPath, env? })`；`SchedulerDaemonLogger { info; error }`、`SchedulerDaemonOptions`、`class SchedulerDaemon { constructor(options); tick(): number; run(signal?): Promise<void>; readonly runningCount: number }`

- [ ] **Step 0: impact**

`impact({ target: "createBundledRollInvocation", direction: "upstream", repo: "roll-agent" })`；`rg -n "BundledRollInvocation" packages --glob '!*.test.ts'`。加字段是增量，`deepEqual` 断言只在 invocation.test.ts。

- [ ] **Step 1: 写失败的测试**

`invocation.test.ts` 追加：

```ts
test("bundled invocation exposes the filtered execArgv for other daemons", () => {
  const invocation = createBundledRollInvocation({
    command: "/bundle/node",
    cliEntrypoint: "/bundle/roll.js",
    execArgv: ["--experimental-strip-types", "--inspect"],
  });
  assert.deepEqual(invocation.execArgv, ["--experimental-strip-types"]);
});
```

`packages/core/src/scheduler-host/daemon.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INVOCATION_STATUSES,
  SCHEDULE_STATUSES,
  ScheduleStore,
  createIntervalTrigger,
  type ClaimedInvocation,
} from "@roll-agent/runtime";
import { SchedulerDaemon, type SpawnedInvocation } from "./daemon.ts";

const NOW = Date.parse("2026-08-25T09:00:00.000Z");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-daemon-"));
}

function silentLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message: string) => {
        lines.push(`info ${message}`);
      },
      error: (message: string) => {
        lines.push(`error ${message}`);
      },
    },
  };
}

function addDueSchedule(store: ScheduleStore, name: string) {
  return store.createSchedule(
    { name, prompt: "p", cwd: "/workspace", trigger: createIntervalTrigger("30m"), fireImmediately: true },
    NOW,
  );
}

test("tick 为到期任务 spawn 子进程，子进程完成后 invocation 完成", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const schedule = addDueSchedule(store, "a");
    const { logger } = silentLogger();
    const spawned: ClaimedInvocation[] = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 2,
      logger,
      now: () => NOW,
      spawnInvocation: (claim) => {
        spawned.push(claim);
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW);
        store.completeInvocation({
          id: claim.invocation.id,
          ownershipToken: claim.ownershipToken,
          status: INVOCATION_STATUSES.completed,
          nowMs: NOW + 1,
          threadId: "t1",
        });
        return { exited: Promise.resolve(0), kill: () => undefined };
      },
    });
    assert.equal(daemon.tick(), 1);
    assert.equal(spawned[0]?.schedule.id, schedule.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(daemon.runningCount, 0);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.completed);
    assert.equal(daemon.tick(), 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick 受 maxConcurrentRuns 约束，子进程退出后才继续 claim", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    addDueSchedule(store, "a");
    addDueSchedule(store, "b");
    const { logger } = silentLogger();
    const pending: Array<(code: number) => void> = [];
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, NOW);
        return {
          exited: new Promise<number | null>((resolve) => {
            pending.push((code) => {
              store.completeInvocation({
                id: claim.invocation.id,
                ownershipToken: claim.ownershipToken,
                status: INVOCATION_STATUSES.completed,
                nowMs: NOW + 1,
              });
              resolve(code);
            });
          }),
          kill: () => undefined,
        };
      },
    });
    assert.equal(daemon.tick(), 1);
    assert.equal(daemon.tick(), 0);
    assert.equal(daemon.runningCount, 1);
    pending[0]?.(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(daemon.runningCount, 0);
    assert.equal(daemon.tick(), 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("子进程非零退出且未写结果时记为失败并进入重试", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const schedule = addDueSchedule(store, "a");
    const { logger, lines } = silentLogger();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      spawnInvocation: () => ({ exited: Promise.resolve(1), kill: () => undefined }),
    });
    assert.equal(daemon.tick(), 1);
    await new Promise((resolve) => setImmediate(resolve));
    const invocation = store.listInvocations(schedule.id)[0];
    assert.equal(invocation?.status, INVOCATION_STATUSES.retry);
    assert.match(invocation?.error ?? "", /code=1/u);
    assert.ok(lines.some((line) => line.startsWith("error")));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn 抛错时 invocation 立即记失败", () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 1 });
    const schedule = addDueSchedule(store, "a");
    const { logger } = silentLogger();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      now: () => NOW,
      spawnInvocation: () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(daemon.tick(), 1);
    assert.equal(daemon.runningCount, 0);
    assert.equal(store.listInvocations(schedule.id)[0]?.status, INVOCATION_STATUSES.failed);
    assert.equal(store.getSchedule(schedule.id)?.status, SCHEDULE_STATUSES.paused);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run 在 abort 后终止子进程并退出", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    addDueSchedule(store, "a");
    const { logger } = silentLogger();
    let killed = false;
    const controller = new AbortController();
    const daemon = new SchedulerDaemon({
      store,
      workerId: "w1",
      maxConcurrentRuns: 1,
      logger,
      pollIntervalMs: 50,
      spawnInvocation: (claim): SpawnedInvocation => {
        store.beginInvocation(claim.invocation.id, claim.ownershipToken, Date.now());
        return {
          exited: new Promise<number | null>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(null), { once: true });
          }),
          kill: () => {
            killed = true;
          },
        };
      },
    });
    const running = daemon.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(daemon.runningCount, 1);
    controller.abort();
    await running;
    assert.equal(killed, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/companion-host/invocation.test.ts packages/core/src/scheduler-host/daemon.test.ts`

- [ ] **Step 3: 实现 `execArgv`**

`invocation.ts`：接口加 `readonly execArgv: readonly string[];`，返回对象加 `execArgv: safeExecArgv,`。

- [ ] **Step 4: 实现 spawn-invocation.ts**

```ts
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { ClaimedInvocation } from "@roll-agent/runtime";
import type { BundledRollInvocation } from "../companion-host/invocation.ts";
import { SCHEDULE_TOKEN_ENV } from "./paths.ts";

export interface SpawnedInvocation {
  readonly exited: Promise<number | null>;
  kill(): void;
}

export type InvocationSpawner = (claim: ClaimedInvocation) => SpawnedInvocation;

export interface CreateInvocationSpawnerOptions {
  readonly invocation: BundledRollInvocation;
  readonly logPath: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function createInvocationSpawner(options: CreateInvocationSpawnerOptions): InvocationSpawner {
  return (claim) => {
    const logFd = openSync(options.logPath, "a", 0o600);
    let closed = false;
    const closeLog = () => {
      if (!closed) {
        closed = true;
        closeSync(logFd);
      }
    };
    const child = spawn(
      options.invocation.command,
      [
        ...options.invocation.execArgv,
        options.invocation.cliEntrypoint,
        "schedule",
        "exec",
        "--invocation",
        claim.invocation.id,
      ],
      {
        cwd: claim.schedule.cwd,
        env: { ...(options.env ?? process.env), [SCHEDULE_TOKEN_ENV]: claim.ownershipToken },
        stdio: ["ignore", "ignore", logFd],
        windowsHide: true,
      },
    );
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        closeLog();
        resolve(code);
      });
      child.once("error", () => {
        closeLog();
        resolve(null);
      });
    });
    return {
      exited,
      kill: () => {
        child.kill("SIGTERM");
      },
    };
  };
}
```

- [ ] **Step 5: 实现 daemon.ts**

```ts
import { SCHEDULER_LIMITS, type ClaimedInvocation, type ScheduleStore } from "@roll-agent/runtime";
import type { InvocationSpawner, SpawnedInvocation } from "./spawn-invocation.ts";

export type { SpawnedInvocation } from "./spawn-invocation.ts";

export interface SchedulerDaemonLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface SchedulerDaemonOptions {
  readonly store: ScheduleStore;
  readonly workerId: string;
  readonly maxConcurrentRuns: number;
  readonly spawnInvocation: InvocationSpawner;
  readonly logger: SchedulerDaemonLogger;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly leaseRenewIntervalMs?: number;
  readonly maxTimerDelayMs?: number;
}

interface RunningInvocation {
  readonly ownershipToken: string;
  readonly handle: SpawnedInvocation;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SchedulerDaemon {
  private readonly store: ScheduleStore;
  private readonly workerId: string;
  private readonly maxConcurrentRuns: number;
  private readonly spawnInvocation: InvocationSpawner;
  private readonly logger: SchedulerDaemonLogger;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly maxTimerDelayMs: number;
  private readonly running = new Map<string, RunningInvocation>();
  private wake = Promise.withResolvers<void>();
  private stopped = false;

  constructor(options: SchedulerDaemonOptions) {
    this.store = options.store;
    this.workerId = options.workerId;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
    this.spawnInvocation = options.spawnInvocation;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? SCHEDULER_LIMITS.pollIntervalMs;
    this.leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? SCHEDULER_LIMITS.leaseRenewIntervalMs;
    this.maxTimerDelayMs = options.maxTimerDelayMs ?? MAX_TIMER_DELAY_MS;
  }

  get runningCount(): number {
    return this.running.size;
  }

  tick(): number {
    const capacity = this.maxConcurrentRuns - this.running.size;
    if (capacity <= 0) {
      return 0;
    }
    let claims: ClaimedInvocation[];
    try {
      claims = this.store.claimDue({ workerId: this.workerId, nowMs: this.now(), limit: capacity });
    } catch (error) {
      this.logger.error(`claimDue 失败：${errorMessage(error)}`);
      return 0;
    }
    for (const claim of claims) {
      this.launch(claim);
    }
    return claims.length;
  }

  async run(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return;
    }
    const onAbort = () => {
      this.stopped = true;
      this.wake.resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const renewTimer = setInterval(() => this.renewLeases(), this.leaseRenewIntervalMs);
    this.logger.info(`scheduler daemon 启动，workerId=${this.workerId}`);
    try {
      while (!this.stopped) {
        this.tick();
        await this.sleepUntilWake();
      }
    } finally {
      clearInterval(renewTimer);
      signal?.removeEventListener("abort", onAbort);
      await this.terminateChildren();
      this.logger.info("scheduler daemon 已停止");
    }
  }

  private launch(claim: ClaimedInvocation): void {
    const id = claim.invocation.id;
    this.logger.info(
      `触发 ${claim.schedule.name}（schedule=${claim.schedule.id} invocation=${id} attempt=${String(claim.invocation.attempt)}）`,
    );
    let handle: SpawnedInvocation;
    try {
      handle = this.spawnInvocation(claim);
    } catch (error) {
      const message = `无法启动 exec 子进程：${errorMessage(error)}`;
      this.logger.error(`invocation ${id} ${message}`);
      this.store.failInvocation(id, claim.ownershipToken, message, this.now());
      return;
    }
    this.running.set(id, { ownershipToken: claim.ownershipToken, handle });
    handle.exited
      .then((code) => {
        this.onExit(claim, code);
      })
      .catch((error: unknown) => {
        this.onExit(claim, null);
        this.logger.error(`invocation ${id} 退出监听异常：${errorMessage(error)}`);
      });
  }

  private onExit(claim: ClaimedInvocation, code: number | null): void {
    const id = claim.invocation.id;
    this.running.delete(id);
    const outcome = this.store.failInvocation(
      id,
      claim.ownershipToken,
      `exec 进程退出 code=${code === null ? "null" : String(code)}，未写入执行结果`,
      this.now(),
    );
    if (outcome !== "lost-claim") {
      this.logger.error(`invocation ${id} 未正常完成（code=${String(code)}），处理结果：${outcome}`);
    } else if (code !== 0) {
      this.logger.error(`invocation ${id} 已写入结果但子进程 code=${String(code)}`);
    } else {
      this.logger.info(`invocation ${id} 完成`);
    }
    this.wake.resolve();
  }

  private renewLeases(): void {
    for (const [id, entry] of this.running) {
      if (!this.store.renewLease(id, entry.ownershipToken, this.now())) {
        this.logger.error(`invocation ${id} 的 lease 已丢失，子进程结果将被忽略`);
      }
    }
  }

  private async sleepUntilWake(): Promise<void> {
    const nowMs = this.now();
    const wakeAt = this.store.nextWakeAtMs();
    const target = Math.min(wakeAt ?? Number.POSITIVE_INFINITY, nowMs + this.pollIntervalMs);
    const delay = Math.min(Math.max(target - nowMs, 0), this.maxTimerDelayMs);
    this.wake = Promise.withResolvers<void>();
    const timer = setTimeout(() => this.wake.resolve(), delay);
    try {
      await this.wake.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  private async terminateChildren(): Promise<void> {
    for (const entry of this.running.values()) {
      entry.handle.kill();
    }
    await Promise.allSettled([...this.running.values()].map((entry) => entry.handle.exited));
  }
}
```

- [ ] **Step 6: 跑测试确认通过；typecheck；lint；prettier**

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/companion-host/invocation.ts packages/core/src/companion-host/invocation.test.ts packages/core/src/scheduler-host/spawn-invocation.ts packages/core/src/scheduler-host/daemon.ts packages/core/src/scheduler-host/daemon.test.ts
git commit -m "feat(core): add SchedulerDaemon tick loop and exec child spawner" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: `roll schedule daemon` / `status` / `run-now`（含 daemon 记录）

**Files:**
- Create: `packages/core/src/scheduler-host/daemon-record.ts`
- Create: `packages/core/src/cli/commands/schedule-daemon.ts`、`schedule-status.ts`、`schedule-run-now.ts`
- Modify: `packages/core/src/cli/commands/schedule.ts`（注册三个子命令）
- Test: `packages/core/src/scheduler-host/daemon-record.test.ts`

**Interfaces:**
- Consumes: `acquireAgentLifecycleLock`、`AgentLifecycleBusyError`（`../registry/process-manager.ts`）；`readProcessStartToken`、`verifyProcessStartToken`、`isProcessStartToken`、`ProcessStartToken`（`../registry/process-identity.ts`）；`FileCompanionLogger`（`../companion-host/logger.ts`）；`createProcessAbortController`（`./companion-command-utils.ts`）；`createBundledRollInvocation`
- Produces: `SchedulerDaemonRecord { pid; processStartToken; startedAt; workerId }`、`DAEMON_LIVENESS = { running, stopped, unverifiable }`、`createDaemonRecord(workerId)`、`writeDaemonRecord(path, record)`、`readDaemonRecord(path)`、`removeDaemonRecord(path, expected)`、`inspectDaemon(path): { liveness; record }`

- [ ] **Step 1: 写失败的测试**

`packages/core/src/scheduler-host/daemon-record.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_LIVENESS,
  createDaemonRecord,
  inspectDaemon,
  readDaemonRecord,
  removeDaemonRecord,
  writeDaemonRecord,
} from "./daemon-record.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-daemon-record-"));
}

test("daemon 记录写入、读回、按 pid+token 删除", () => {
  const dir = tempDir();
  const path = join(dir, "nested", "daemon.json");
  try {
    const record = createDaemonRecord("w-test");
    assert.equal(record.pid, process.pid);
    writeDaemonRecord(path, record);
    assert.deepEqual(readDaemonRecord(path), record);
    removeDaemonRecord(path, { ...record, pid: record.pid + 1 });
    assert.deepEqual(readDaemonRecord(path), record);
    removeDaemonRecord(path, record);
    assert.equal(readDaemonRecord(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectDaemon 对当前进程报 running，对不存在的记录/进程报 stopped", () => {
  const dir = tempDir();
  const path = join(dir, "daemon.json");
  try {
    assert.equal(inspectDaemon(path).liveness, DAEMON_LIVENESS.stopped);
    const record = createDaemonRecord("w-live");
    writeDaemonRecord(path, record);
    assert.equal(inspectDaemon(path).liveness, DAEMON_LIVENESS.running);
    writeFileSync(path, `${JSON.stringify({ ...record, pid: 4_194_303 })}\n`);
    assert.equal(inspectDaemon(path).liveness, DAEMON_LIVENESS.stopped);
    writeFileSync(path, "not json\n");
    assert.equal(inspectDaemon(path).liveness, DAEMON_LIVENESS.stopped);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/daemon-record.test.ts`

- [ ] **Step 3: 实现 daemon-record.ts**

```ts
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isProcessStartToken,
  readProcessStartToken,
  verifyProcessStartToken,
  type ProcessStartToken,
} from "../registry/process-identity.ts";

export interface SchedulerDaemonRecord {
  readonly pid: number;
  readonly processStartToken: ProcessStartToken;
  readonly startedAt: string;
  readonly workerId: string;
}

export const DAEMON_LIVENESS = {
  running: "running",
  stopped: "stopped",
  unverifiable: "unverifiable",
} as const;
export type DaemonLiveness = (typeof DAEMON_LIVENESS)[keyof typeof DAEMON_LIVENESS];

export interface DaemonInspection {
  readonly liveness: DaemonLiveness;
  readonly record: SchedulerDaemonRecord | undefined;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createDaemonRecord(workerId: string): SchedulerDaemonRecord {
  const processStartToken = readProcessStartToken(process.pid);
  if (processStartToken === undefined) {
    throw new Error(
      `无法验证当前 Roll 进程 (PID: ${String(process.pid)}) 的 OS 启动身份，拒绝启动 scheduler daemon。`,
    );
  }
  return { pid: process.pid, processStartToken, startedAt: new Date().toISOString(), workerId };
}

export function writeDaemonRecord(path: string, record: SchedulerDaemonRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function readDaemonRecord(path: string): SchedulerDaemonRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecordObject(value) ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    !isProcessStartToken(value.processStartToken) ||
    typeof value.startedAt !== "string" ||
    typeof value.workerId !== "string"
  ) {
    return undefined;
  }
  return {
    pid: value.pid,
    processStartToken: value.processStartToken,
    startedAt: value.startedAt,
    workerId: value.workerId,
  };
}

export function removeDaemonRecord(path: string, expected: SchedulerDaemonRecord): void {
  const current = readDaemonRecord(path);
  if (
    current === undefined ||
    current.pid !== expected.pid ||
    current.processStartToken !== expected.processStartToken
  ) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    return;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function inspectDaemon(path: string): DaemonInspection {
  const record = readDaemonRecord(path);
  if (record === undefined) {
    return { liveness: DAEMON_LIVENESS.stopped, record: undefined };
  }
  if (!isPidAlive(record.pid)) {
    return { liveness: DAEMON_LIVENESS.stopped, record };
  }
  const verification = verifyProcessStartToken(record.pid, record.processStartToken);
  if (verification.status === "match") {
    return { liveness: DAEMON_LIVENESS.running, record };
  }
  if (verification.status === "mismatch") {
    return { liveness: DAEMON_LIVENESS.stopped, record };
  }
  return { liveness: DAEMON_LIVENESS.unverifiable, record };
}
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 实现 schedule-daemon.ts**

```ts
import { mkdirSync } from "node:fs";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createBundledRollInvocation } from "../../companion-host/invocation.ts";
import { FileCompanionLogger } from "../../companion-host/logger.ts";
import {
  AgentLifecycleBusyError,
  acquireAgentLifecycleLock,
} from "../../registry/process-manager.ts";
import { SchedulerDaemon } from "../../scheduler-host/daemon.ts";
import {
  createDaemonRecord,
  removeDaemonRecord,
  writeDaemonRecord,
} from "../../scheduler-host/daemon-record.ts";
import { SCHEDULER_DAEMON_LOCK_NAME, createSchedulerPaths } from "../../scheduler-host/paths.ts";
import { createInvocationSpawner } from "../../scheduler-host/spawn-invocation.ts";
import { log } from "../utils/output.ts";
import { createProcessAbortController } from "./companion-command-utils.ts";
import { loadRuntime, openScheduleStore, runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "在前台运行定时任务 daemon（服务管理器使用的正式入口）" },
  args: {
    foreground: { type: "boolean", description: "明确以前台模式运行", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      if (args.foreground !== true) {
        throw new Error("Use `roll schedule daemon --foreground`");
      }
      const { config } = loadConfig();
      const paths = createSchedulerPaths(config.scheduler.dataDir);
      mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
      let lock;
      try {
        lock = acquireAgentLifecycleLock(paths.dataDir, SCHEDULER_DAEMON_LOCK_NAME);
      } catch (error) {
        if (error instanceof AgentLifecycleBusyError) {
          throw new Error("已有 roll schedule daemon 在运行；用 roll schedule status 查看");
        }
        throw error;
      }
      const record = createDaemonRecord(`daemon-${String(process.pid)}`);
      writeDaemonRecord(paths.daemonRecordPath, record);
      const fileLogger = new FileCompanionLogger(paths.logPath);
      const logger = {
        info: (message: string) => {
          fileLogger.info(message);
          log.info(message);
        },
        error: (message: string) => {
          fileLogger.error(message);
          log.error(message);
        },
      };
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      const daemon = new SchedulerDaemon({
        store,
        workerId: record.workerId,
        maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
        spawnInvocation: createInvocationSpawner({
          invocation: createBundledRollInvocation(),
          logPath: paths.logPath,
        }),
        logger,
      });
      const processSignal = createProcessAbortController();
      try {
        await daemon.run(processSignal.controller.signal);
      } finally {
        processSignal.release();
        store.close();
        removeDaemonRecord(paths.daemonRecordPath, record);
        lock.release();
      }
    });
  },
});
```

- [ ] **Step 6: 实现 schedule-status.ts**

```ts
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { inspectDaemon } from "../../scheduler-host/daemon-record.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import { log } from "../utils/output.ts";
import { loadRuntime, openScheduleStore, printJson, runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "查看 daemon 存活状态与定时任务统计" },
  args: {
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const paths = createSchedulerPaths(config.scheduler.dataDir);
      const daemon = inspectDaemon(paths.daemonRecordPath);
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        const schedules = store.listSchedules();
        const nextWakeAtMs = store.nextWakeAtMs();
        const status = {
          daemon: {
            liveness: daemon.liveness,
            pid: daemon.record?.pid,
            startedAt: daemon.record?.startedAt,
            logPath: paths.logPath,
          },
          schedules: {
            total: schedules.length,
            active: schedules.filter((s) => s.status === runtime.SCHEDULE_STATUSES.active).length,
            paused: schedules.filter((s) => s.status === runtime.SCHEDULE_STATUSES.paused).length,
          },
          nextWakeAt: nextWakeAtMs === undefined ? undefined : new Date(nextWakeAtMs).toISOString(),
        };
        if (args.json) {
          printJson(status);
          return;
        }
        log.info(`daemon: ${status.daemon.liveness}${status.daemon.pid ? ` (pid ${String(status.daemon.pid)})` : ""}`);
        log.info(`任务: ${String(status.schedules.total)} 个（active ${String(status.schedules.active)} / paused ${String(status.schedules.paused)}）`);
        log.info(`下次唤醒: ${status.nextWakeAt ?? "-"}`);
        log.info(`日志: ${paths.logPath}`);
      } finally {
        store.close();
      }
    });
  },
});
```

- [ ] **Step 7: 实现 schedule-run-now.ts**

```ts
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createBundledRollInvocation } from "../../companion-host/invocation.ts";
import { inspectDaemon, DAEMON_LIVENESS } from "../../scheduler-host/daemon-record.ts";
import { createSchedulerPaths } from "../../scheduler-host/paths.ts";
import { createInvocationSpawner } from "../../scheduler-host/spawn-invocation.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  requireSchedule,
  runScheduleCommand,
  serializeInvocation,
} from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "立即手动触发一次定时任务（默认入队交给 daemon；--inline 在当前进程等待完成）" },
  args: {
    id: { type: "positional", description: "定时任务 ID", required: true },
    inline: { type: "boolean", description: "在当前进程内执行并等待结果", default: false },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      const paths = createSchedulerPaths(config.scheduler.dataDir);
      const runtime = await loadRuntime();
      const store = openScheduleStore(config, runtime);
      try {
        requireSchedule(store, args.id);
        const queued = store.enqueueManualInvocation(args.id);
        if (!args.inline) {
          if (inspectDaemon(paths.daemonRecordPath).liveness !== DAEMON_LIVENESS.running) {
            log.warn("daemon 未运行，该次触发会等到 daemon 启动后才执行；或改用 --inline。");
          }
          if (args.json) {
            printJson(serializeInvocation(queued));
          } else {
            log.success(`已入队 invocation ${queued.id}`);
          }
          return;
        }
        const claim = store.claimPendingInvocation(queued.id, `inline-${String(process.pid)}`);
        if (claim === undefined) {
          throw new Error(`invocation ${queued.id} 已被 daemon 接管，请用 roll schedule runs ${args.id} 查看`);
        }
        const handle = createInvocationSpawner({
          invocation: createBundledRollInvocation(),
          logPath: paths.logPath,
        })(claim);
        const renew = setInterval(() => {
          store.renewLease(claim.invocation.id, claim.ownershipToken);
        }, runtime.SCHEDULER_LIMITS.leaseRenewIntervalMs);
        let code: number | null;
        try {
          code = await handle.exited;
        } finally {
          clearInterval(renew);
        }
        store.failInvocation(
          claim.invocation.id,
          claim.ownershipToken,
          `exec 进程退出 code=${code === null ? "null" : String(code)}，未写入执行结果`,
        );
        const final = store.getInvocation(queued.id);
        if (final === undefined) {
          throw new Error(`invocation ${queued.id} 不存在`);
        }
        if (args.json) {
          printJson(serializeInvocation(final));
        } else {
          log.info(`invocation ${final.id}: ${final.status}${final.threadId ? ` thread=${final.threadId}` : ""}${final.error ? ` error=${final.error}` : ""}`);
        }
        if (final.status === runtime.INVOCATION_STATUSES.failed) {
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });
  },
});
```

`schedule.ts` 的 `subCommands` 加 `"run-now": () => loadScheduleCommand("schedule-run-now")`、`status: …("schedule-status")`、`daemon: …("schedule-daemon")`。

- [ ] **Step 8: 验证**

Run: `pnpm --filter @roll-agent/core typecheck`；eslint + prettier；`pnpm dev -- schedule status --json`（在隔离 HOME 下：`HOME=$(mktemp -d) pnpm dev -- schedule status --json` 应打印 `"liveness": "stopped"`）；`node --experimental-strip-types --experimental-sqlite --test packages/core/src/cli/smoke-schedule.e2e.ts`。

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/scheduler-host/daemon-record.ts packages/core/src/scheduler-host/daemon-record.test.ts packages/core/src/cli/commands/schedule.ts packages/core/src/cli/commands/schedule-daemon.ts packages/core/src/cli/commands/schedule-status.ts packages/core/src/cli/commands/schedule-run-now.ts
git commit -m "feat(core): add roll schedule daemon, status and run-now" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: OS service：参数化 companion `service.ts` + `roll schedule service`

**Files:**
- Modify: `packages/core/src/companion-host/service.ts:61-168`、`:359-386`
- Modify: `packages/core/src/companion-host/application.ts:365-388`（`createDefaultCompanionApplication` 的 `serviceController`）
- Create: `packages/core/src/scheduler-host/service.ts`
- Create: `packages/core/src/cli/commands/schedule-service.ts`、`schedule-service-install.ts`、`schedule-service-uninstall.ts`、`schedule-service-status.ts`
- Modify: `packages/core/src/cli/commands/schedule.ts`（`service` 子命令）
- Test: `packages/core/src/companion-host/service.test.ts`、`packages/core/src/scheduler-host/service.test.ts`

**Interfaces:**
- Produces（companion `service.ts`）：`ServicePlanIdentity { label; plistPath; logPath; windowsTaskName; programArguments: readonly string[] }`、`companionServiceIdentity(paths, invocation)`、`createMacOsLaunchAgentPlanForIdentity(identity, uid)`、`createWindowsScheduledTaskPlanForIdentity(identity, windowsDirectory?)`、`createPlatformServiceController({ identity, platform?, uid?, runner?, windowsDirectory? })`；原 `createMacOsLaunchAgentPlan(input)` / `createWindowsScheduledTaskPlan(invocation, dir?)` 签名与行为不变
- Produces（scheduler）：`schedulerServiceIdentity(paths: SchedulerPaths, invocation: BundledRollInvocation): ServicePlanIdentity`、`createSchedulerServiceController(options: { dataDir: string; invocation?: BundledRollInvocation; platform?: NodeJS.Platform; homeDir?: string })`

- [ ] **Step 0: impact**

`impact({ target: "createPlatformServiceController", direction: "upstream", repo: "roll-agent" })`；`rg -n "createPlatformServiceController\(" packages/core/src`。预期：application.ts:845 + 测试。

- [ ] **Step 1: 写失败的测试**

`companion-host/service.test.ts` 追加：

```ts
test("identity-based plans keep companion defaults and accept other daemons", () => {
  const companion = createMacOsLaunchAgentPlan({
    paths: createCompanionPaths("/Users/tester", "darwin"),
    invocation,
    uid: 501,
  });
  const viaIdentity = createMacOsLaunchAgentPlanForIdentity(
    companionServiceIdentity(createCompanionPaths("/Users/tester", "darwin"), invocation),
    501,
  );
  assert.deepEqual(viaIdentity, companion);
  const other = createMacOsLaunchAgentPlanForIdentity(
    {
      label: "dev.roll-agent.other",
      plistPath: "/Users/tester/Library/LaunchAgents/dev.roll-agent.other.plist",
      logPath: "/Users/tester/.roll-agent/other/other.log",
      windowsTaskName: "Roll Agent Other",
      programArguments: ["/bundle/node", "/bundle/roll.js", "other", "--foreground"],
    },
    501,
  );
  assert.equal(other.label, "dev.roll-agent.other");
  assert.equal(other.serviceTarget, "gui/501/dev.roll-agent.other");
  assert.match(other.plist, /<string>dev\.roll-agent\.other<\/string>/u);
  assert.match(other.plist, /other\.log/u);
  const windows = createWindowsScheduledTaskPlanForIdentity(
    { windowsTaskName: "Roll Agent Other", programArguments: ["C:\\node.exe", "C:\\roll.js", "other"] },
    "D:\\Windows",
  );
  assert.equal(windows.taskName, "Roll Agent Other");
  assert.ok(windows.create.args.includes("Roll Agent Other"));
});
```

import 加 `companionServiceIdentity, createMacOsLaunchAgentPlanForIdentity, createWindowsScheduledTaskPlanForIdentity`。

`packages/core/src/scheduler-host/service.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBundledRollInvocation } from "../companion-host/invocation.ts";
import { createMacOsLaunchAgentPlanForIdentity } from "../companion-host/service.ts";
import { SCHEDULER_SERVICE_LABEL, createSchedulerPaths } from "./paths.ts";
import { schedulerServiceIdentity } from "./service.ts";

test("scheduler service identity 指向 roll schedule daemon --foreground", () => {
  const invocation = createBundledRollInvocation({
    command: "/bundle/node",
    cliEntrypoint: "/bundle/roll.js",
    execArgv: ["--experimental-strip-types", "--inspect"],
  });
  const identity = schedulerServiceIdentity(
    createSchedulerPaths("/Users/tester/.roll-agent/scheduler", "/Users/tester"),
    invocation,
  );
  assert.equal(identity.label, SCHEDULER_SERVICE_LABEL);
  assert.equal(
    identity.plistPath,
    "/Users/tester/Library/LaunchAgents/dev.roll-agent.scheduler.plist",
  );
  assert.equal(identity.logPath, "/Users/tester/.roll-agent/scheduler/scheduler.log");
  assert.deepEqual(identity.programArguments, [
    "/bundle/node",
    "--experimental-strip-types",
    "/bundle/roll.js",
    "schedule",
    "daemon",
    "--foreground",
  ]);
  const plan = createMacOsLaunchAgentPlanForIdentity(identity, 501);
  assert.equal(plan.serviceTarget, `gui/501/${SCHEDULER_SERVICE_LABEL}`);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/companion-host/service.test.ts packages/core/src/scheduler-host/service.test.ts`

- [ ] **Step 3: 参数化 companion service.ts**

在 `MacOsLaunchAgentPlan` 之前加：

```ts
export interface ServicePlanIdentity {
  readonly label: string;
  readonly plistPath: string;
  readonly logPath: string;
  readonly windowsTaskName: string;
  readonly programArguments: readonly string[];
}

export function companionServiceIdentity(
  paths: CompanionPaths,
  invocation: BundledRollInvocation,
): ServicePlanIdentity {
  return {
    label: COMPANION_SERVICE_LABEL,
    plistPath: paths.launchAgentPath,
    logPath: paths.logPath,
    windowsTaskName: WINDOWS_COMPANION_TASK_NAME,
    programArguments: [invocation.command, ...invocation.companionArgs],
  };
}
```

把 `createMacOsLaunchAgentPlan` 的函数体整体改名为：

```ts
export function createMacOsLaunchAgentPlanForIdentity(
  identity: ServicePlanIdentity,
  uid: number,
): MacOsLaunchAgentPlan {
  const programArguments = identity.programArguments
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  const plist = `…原模板，把 ${COMPANION_SERVICE_LABEL} 换成 ${identity.label}，两处 input.paths.logPath 换成 identity.logPath…`;
  const domainTarget = `gui/${String(uid)}`;
  return {
    label: identity.label,
    plistPath: identity.plistPath,
    plist,
    domainTarget,
    serviceTarget: `${domainTarget}/${identity.label}`,
  };
}

export function createMacOsLaunchAgentPlan(input: {
  readonly paths: CompanionPaths;
  readonly invocation: BundledRollInvocation;
  readonly uid: number;
}): MacOsLaunchAgentPlan {
  return createMacOsLaunchAgentPlanForIdentity(
    companionServiceIdentity(input.paths, input.invocation),
    input.uid,
  );
}
```

（plist 模板逐字保留原文，只替换那三处插值——不要重排 XML。）

Windows 同法：

```ts
export function createWindowsScheduledTaskPlanForIdentity(
  identity: Pick<ServicePlanIdentity, "windowsTaskName" | "programArguments">,
  windowsDirectory?: string,
): WindowsScheduledTaskPlan {
  const taskCommand = identity.programArguments.map(quoteWindowsCommandArgument).join(" ");
  …原函数体，WINDOWS_COMPANION_TASK_NAME 全部换成 identity.windowsTaskName…
}

export function createWindowsScheduledTaskPlan(
  invocation: BundledRollInvocation,
  windowsDirectory?: string,
): WindowsScheduledTaskPlan {
  return createWindowsScheduledTaskPlanForIdentity(
    {
      windowsTaskName: WINDOWS_COMPANION_TASK_NAME,
      programArguments: [invocation.command, ...invocation.companionArgs],
    },
    windowsDirectory,
  );
}
```

`createPlatformServiceController` 改签名为 `options: { readonly identity: ServicePlanIdentity; readonly platform?; readonly uid?; readonly runner?; readonly windowsDirectory? }`，内部分别调 `createMacOsLaunchAgentPlanForIdentity(options.identity, uid)` / `createWindowsScheduledTaskPlanForIdentity(options.identity, options.windowsDirectory)`；错误文案改为 `"roll service supports macOS and Windows only"`。`application.ts` 的调用改为 `createPlatformServiceController({ identity: companionServiceIdentity(paths, invocation), platform })`。`rg -n "createPlatformServiceController" packages/core/src --glob '*.test.ts'` 找到的测试调用同样改成 identity 形式。

- [ ] **Step 4: 实现 scheduler-host/service.ts**

```ts
import { createBundledRollInvocation, type BundledRollInvocation } from "../companion-host/invocation.ts";
import {
  createPlatformServiceController,
  type CompanionServiceController,
  type ServicePlanIdentity,
} from "../companion-host/service.ts";
import {
  SCHEDULER_SERVICE_LABEL,
  WINDOWS_SCHEDULER_TASK_NAME,
  createSchedulerPaths,
  type SchedulerPaths,
} from "./paths.ts";

export function schedulerServiceIdentity(
  paths: SchedulerPaths,
  invocation: BundledRollInvocation,
): ServicePlanIdentity {
  return {
    label: SCHEDULER_SERVICE_LABEL,
    plistPath: paths.launchAgentPath,
    logPath: paths.logPath,
    windowsTaskName: WINDOWS_SCHEDULER_TASK_NAME,
    programArguments: [
      invocation.command,
      ...invocation.execArgv,
      invocation.cliEntrypoint,
      "schedule",
      "daemon",
      "--foreground",
    ],
  };
}

export function createSchedulerServiceController(options: {
  readonly dataDir: string;
  readonly invocation?: BundledRollInvocation;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}): CompanionServiceController {
  const paths = createSchedulerPaths(options.dataDir, options.homeDir);
  const invocation = options.invocation ?? createBundledRollInvocation();
  return createPlatformServiceController({
    identity: schedulerServiceIdentity(paths, invocation),
    ...(options.platform ? { platform: options.platform } : {}),
  });
}
```

- [ ] **Step 5: CLI**

`schedule-service.ts`（组）：与 `companion-service.ts` 同形，子命令 `install / uninstall / status`。

`schedule-service-install.ts`：

```ts
import { mkdirSync } from "node:fs";
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { createSchedulerServiceController } from "../../scheduler-host/service.ts";
import { log } from "../utils/output.ts";
import { runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "安装并启动定时任务 daemon 的 per-user LaunchAgent 或当前用户 Scheduled Task" },
  async run() {
    await runScheduleCommand(async () => {
      const { config } = loadConfig();
      mkdirSync(config.scheduler.dataDir, { recursive: true, mode: 0o700 });
      await createSchedulerServiceController({ dataDir: config.scheduler.dataDir }).install();
      log.success("roll schedule daemon 用户服务已安装并启动。");
    });
  },
});
```

`schedule-service-uninstall.ts`：同形调用 `.uninstall()`；`schedule-service-status.ts`：`--json` 打印 `await controller.status()`，否则 `log.info("installed: … running: …")`。`schedule.ts` 加 `service: () => loadScheduleCommand("schedule-service")`。

- [ ] **Step 6: 跑测试；全部 companion 测试必须仍通过**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/companion-host/*.test.ts packages/core/src/scheduler-host/*.test.ts`；typecheck；lint；prettier。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/companion-host/service.ts packages/core/src/companion-host/service.test.ts packages/core/src/companion-host/application.ts packages/core/src/scheduler-host/service.ts packages/core/src/scheduler-host/service.test.ts packages/core/src/cli/commands/schedule.ts packages/core/src/cli/commands/schedule-service*.ts
git commit -m "feat(core): install roll schedule daemon as a user service" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: 文档、changeset、发布校验与手动验证

**Files:**
- Create: `docs/how-to-schedule-tasks.md`
- Modify: `README.md:247-293`、`CLAUDE.md:75-85`、`AGENTS.md:75-85`
- Create: `.changeset/roll-schedule.md`

- [ ] **Step 1: how-to 文档**

`docs/how-to-schedule-tasks.md`（Diátaxis how-to，≤ 120 行）：目标一句话；前置条件（LLM 已配置、`roll doctor` 通过）；步骤 ① `roll schedule add "检查未读并汇总" --name 巡检 --every 30m --cwd ~/work --now` ② `roll schedule daemon --foreground`（试跑）③ `roll schedule service install`（常驻）④ `roll schedule runs <id>` / `roll schedule status`；行为说明（无人值守：审批一律拒绝 → `needs_confirmation`；失败重试 3 次后自动 PAUSE，`roll schedule list` 显示原因；错过的触发只补一次；每次触发是新 thread，可用 `roll chat --session <threadId>` 打开）；配置段 `scheduler.*`；限制（v1 仅间隔触发、最短 60 s、最多 50 个；日历/时区、`/loop`、模型可调用工具留 v2）。

- [ ] **Step 2: CLI 参考**

`README.md` 的 `## CLI 命令参考` 代码块在 `roll doctor` 段之前加：

```
roll schedule add <prompt> --name <n> --every <30m>   登记定时任务（--cwd 指定目录，--now 立即触发）
roll schedule list|show|remove|pause|resume <id>      管理定时任务
roll schedule run-now <id> [--inline]                 手动触发一次
roll schedule runs <id>                               查看历次运行与失败原因
roll schedule status                                  daemon 状态与任务统计
roll schedule daemon --foreground                     前台运行 daemon
roll schedule service install|uninstall|status        安装为用户级常驻服务
```

`常用选项` 表加 `| roll schedule add | --every <Ns\|Nm\|Nh\|Nd> | 运行周期，最短 60s |` 与 `| roll schedule run-now | --inline | 当前进程内执行并等待结果 |`。

`CLAUDE.md` 与 `AGENTS.md` 的 CLI 命令树代码块各加一行：

```
roll schedule add|list|show|remove|pause|resume|run-now|runs|status|daemon|service   定时任务
```

- [ ] **Step 3: changeset**

`.changeset/roll-schedule.md`：

```md
---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

新增 `roll schedule` 定时任务：按周期无人值守地运行一轮 chat。

- runtime：`ScheduleStore`（SQLite，claim/lease/重试账本）、间隔触发解析、`UnattendedToolPolicy`（无人值守时 confirm 一律 deny）、`background` host mode 与来源标记（只进推理副本，不进历史）
- core：`roll schedule add|list|show|remove|pause|resume|run-now|runs|status|daemon|service`；daemon 按触发 spawn `roll schedule exec` 子进程，失败重试 3 次后自动 PAUSE 并在列表显示原因
- 配置新增 `scheduler.data-dir` / `max-schedules` / `max-concurrent-runs`
```

Run: `pnpm changeset status`（exit 0，列出 core / runtime minor）。

- [ ] **Step 4: 全量验证**

```bash
pnpm typecheck
pnpm lint
pnpm check:source-control-chars
pnpm --filter @roll-agent/runtime test
pnpm --filter @roll-agent/core test
node --experimental-strip-types --experimental-sqlite --test packages/core/src/cli/smoke-schedule.e2e.ts packages/core/src/cli/smoke-cli-surface.e2e.ts
pnpm --filter @roll-agent/core build && node packages/core/dist/cli/index.js schedule --help && node packages/core/dist/cli/index.js agent health
```

最后一条验证懒加载在 dist 下不残留 `.ts` specifier（`schedule --help` 必须列出全部子命令；`agent health` 无注册 agent 时输出「暂无已注册 Agent」）。

- [ ] **Step 5: 手动验证（需真实 LLM 配置；结果写进 PR 描述）**

```bash
export HOME_BACKUP=$HOME
roll schedule add "用一句话报告当前目录有几个文件，不要调用任何需要确认的工具" --name smoke --every 5m --cwd "$PWD" --now --json
roll schedule daemon --foreground      # 另开终端观察：15 秒内应看到「触发 smoke」与「invocation … 完成」
roll schedule runs <id> --json         # status=completed，threadId 非空
roll chat --session <threadId> --json "上一条消息是谁发的？"   # 确认历史里的用户消息就是 prompt 原文，没有 [Harness runtime context]
roll schedule run-now <id> --inline --json   # 不依赖 daemon 的路径
roll schedule remove <id>
```

再做一次失败路径：把 `roll.config.yaml` 的 `llm.providers.<p>.api-key` 改成无效值 → `run-now --inline` 应返回 `failed`，`roll schedule runs` 的 error 里有 provider 报错；连续 3 次后 `roll schedule list` 显示 `paused` 与原因；改回 key 后 `roll schedule resume <id>` 恢复。

- [ ] **Step 6: Commit**

```bash
git add docs/how-to-schedule-tasks.md README.md CLAUDE.md AGENTS.md .changeset/roll-schedule.md
git commit -m "docs: document roll schedule and add changeset" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 自查记录

- Spec 覆盖：配置（T1）、trigger 与限额（T2）、存储与派发协议（T3/T4）、无人值守审批双保险（T5 + T9 的 `runJsonTurn` reject）、`background` host mode / 无人值守段 / 不建 agent-install（T6）、来源标记只进推理副本（T7）、runtime-host 抽取（T8）、exec 子进程与真实 runner（T9）、CLI 管理面 + e2e（T10）、daemon tick/lease/重试/并发上限（T11）、daemon 单例 + 记录 + run-now（T12）、sibling service（T13）、文档/changeset/发布校验/手动验证（T14）。spec「不覆盖」项均未出现在任务中。
- 类型一致性：`ScheduleStore` 方法签名在 T4 定义，T9/T11/T12 按同名调用；`ScheduledTurnOutcome`/`ScheduledTurnRunner` 在 T9 定义并被 T9 runner 复用；`SpawnedInvocation`/`InvocationSpawner` 在 T11 定义并被 T12 复用；`ServicePlanIdentity` 在 T13 定义。`CHAT_ENGINE_SURFACES.background` 依赖 T6 先加 host mode。
- 已知需在执行时按实际代码核对的点（均已在步骤里写明 `rg` 命令）：`conversation-engine.test.ts` 的 engine options 工厂名与 `AgentSession` 上暴露 safe snapshot 的方法名（T7）、`resolveLLMCall` 附带的 import（T8）、`createPlatformServiceController` 的测试调用方（T13）。
