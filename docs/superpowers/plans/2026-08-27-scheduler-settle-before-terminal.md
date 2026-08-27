# Scheduler「先清场、再落终态」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定时运行在写终态之前先把自己拉起的整棵进程树清掉；清不掉就不写终态。

**Architecture:** runtime 只加一条「spawn 出的 bash 子进程交给调用方」的管道；core 新增 `invocation-tree.ts` 用 env 标记 ∪ exec 自己的进程组 ∪ bash 工具登记的进程组三个来源枚举 / 终止树；`executeInvocation` 在 `runTurn` 前（preflight）与写终态前（settle）各调用一次，失败则 `failInvocation` / 返回 `unsettled`。账本、daemon、inline、cancel 零改动。

**Tech Stack:** Node.js ≥ 22.6（`--experimental-strip-types`、`node:test`）、TypeScript strict、pnpm workspace；核心代码零注释，if/else 必须花括号，CLI 参数 kebab-case。

**Spec:** `docs/superpowers/specs/2026-08-27-scheduler-settle-before-terminal-design.md`

## Global Constraints

- 基线 commit `ebf3093`；从 dev 开分支 `fix/schedule-settle-before-terminal`；**不 push**；不碰工作树里既有的 `.gitignore` / `AGENTS.md` / `CLAUDE.md` / `docs/rfc-*.md` 改动（`git add` 只加本任务文件）。
- 每次修改函数前先跑 `impact({ target, direction: "upstream", repo: "roll-agent" })`；提交前跑 `detect_changes()`。基线影响分析（已跑）：`executeInvocation` / `runBashCommand` / `buildBashToolset` LOW（0 直接调用者）；`createInvocationSpawner` LOW（2 直接调用者：schedule-daemon / schedule-run-now）。
- 单测命令：`node --experimental-strip-types --experimental-sqlite --test <file>`（core 需要 `--experimental-sqlite`；runtime 不需要）。全量：`pnpm typecheck && pnpm lint && pnpm check:source-control-chars && pnpm test && pnpm test:e2e`。
- 源码里不能出现原始控制字符（`pnpm check:source-control-chars`）。
- 导入路径必须带 `.ts` 扩展名；`import type` 分离类型；禁止 `enum` / `namespace`；零 `any`；`exactOptionalPropertyTypes` 开启（可选字段用 `...(x ? { k: x } : {})` 展开）。
- 测试名用中文，风格与同目录既有测试一致；真实进程测试在 win32 上 `skip`。
- 平台常量：清场 grace 2 000 ms、轮询 250 ms、`ps` 超时 5 000 ms、`maxBuffer` 64 MiB。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `packages/runtime/src/bash/exec.ts` | `RunBashOptions.onSpawn` 回调 |
| `packages/runtime/src/tool-bridge/bash-tool.ts` | `SessionBashSettings.onCommandSpawn` → `exec({ onSpawn })` |
| `packages/runtime/src/engine/conversation-engine.ts` | `ConversationEngineOptions.onShellCommandSpawn`；导出纯函数 `buildSessionBashSettings` |
| `packages/core/src/scheduler-host/paths.ts` | `SCHEDULE_INVOCATION_ENV` |
| `packages/core/src/scheduler-host/spawn-invocation.ts` | 注入标记 |
| `packages/core/src/scheduler-host/invocation-tree.ts`（新） | 快照解析、`ProcessGroupLedger`、`collectTreeMembers`、`terminateInvocationTree` |
| `packages/core/src/scheduler-host/executor-liveness.ts` | 仅导出 `TRUSTED_PS_PATHS` |
| `packages/core/src/scheduler-host/execute-invocation.ts` | preflight / settle / `unsettled` |
| `packages/core/src/runtime-host/engine-factory.ts`、`packages/core/src/scheduler-host/run-scheduled-turn.ts`、`packages/core/src/cli/commands/schedule-exec.ts` | 接线 |
| `docs/how-to-schedule-tasks.md`、`docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md`、`.changeset/roll-schedule.md` | 文档 |

---

### Task 0: 开分支

- [ ] **Step 1: 确认基线并开分支**

```bash
git rev-parse --short HEAD          # 期望 ebf3093
git status --short                  # 只应有 .gitignore / AGENTS.md / CLAUDE.md / docs/rfc-*.md
git switch -c fix/schedule-settle-before-terminal
```

- [ ] **Step 2: 提交 spec 与本计划**

```bash
git add docs/superpowers/specs/2026-08-27-scheduler-settle-before-terminal-design.md docs/superpowers/plans/2026-08-27-scheduler-settle-before-terminal.md
git commit -m "docs(scheduler): design and plan for settling the invocation tree before writing terminal state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 1: runtime — 把 bash 子进程交给调用方

**Files:**
- Modify: `packages/runtime/src/bash/exec.ts:33-44`（`RunBashOptions`）、`:82-104`（spawn 之后）
- Modify: `packages/runtime/src/tool-bridge/bash-tool.ts:42-52`（`SessionBashSettings`）、`:282-291`（`exec(` 调用）
- Modify: `packages/runtime/src/engine/conversation-engine.ts:104-135`（options）、`:388`（字段）、`:434`（ctor）、`:526-538`（`resolveShellSettings`）
- Test: `packages/runtime/src/bash/exec.test.ts`、`packages/runtime/src/tool-bridge/bash-tool.test.ts`、`packages/runtime/src/engine/conversation-engine.test.ts`

**Interfaces:**
- Produces: `RunBashOptions.onSpawn?: (child: ChildProcess) => void`；`SessionBashSettings.onCommandSpawn?: (child: ChildProcess) => void`；`ConversationEngineOptions.onShellCommandSpawn?: (child: ChildProcess) => void`；`export function buildSessionBashSettings(input: { config: RollConfig; profile: ShellProfile; env: NodeJS.ProcessEnv; onCommandSpawn?: (child: ChildProcess) => void }): SessionBashSettings`

- [ ] **Step 1: exec.ts 失败测试**

在 `packages/runtime/src/bash/exec.test.ts` 末尾追加（`fakeExecChild` / `spawnReturning` / `opts` 已在文件顶部定义）：

```ts
test("runBashCommand 在 spawn 成功后把子进程交给 onSpawn", async () => {
  const child = fakeExecChild({ exitOnKill: false });
  const seen: ChildProcess[] = [];
  const command = runBashCommand(
    opts({
      command: "true",
      timeoutMs: 1_000,
      onSpawn: (spawned) => {
        seen.push(spawned);
      },
    }),
    { spawn: spawnReturning(child), killTreeDeadlineMs: 50, rootKillSettleTimeoutMs: 10 },
  );
  queueMicrotask(() => child.emit("exit", 0, null));
  await command;
  assert.equal(seen.length, 1);
  assert.equal(seen[0], child);
});

test("runBashCommand 在 spawn 未拿到 pid 时不回调 onSpawn", async () => {
  const child = fakeExecChild({ exitOnKill: false, started: false, initialError: new Error("ENOENT") });
  let called = 0;
  const result = await runBashCommand(
    opts({
      command: "missing",
      timeoutMs: 1_000,
      onSpawn: () => {
        called += 1;
      },
    }),
    { spawn: spawnReturning(child), killTreeDeadlineMs: 50, rootKillSettleTimeoutMs: 10 },
  );
  assert.equal(called, 0);
  assert.equal(result.spawnError, "ENOENT");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/bash/exec.test.ts`
Expected: 两个新用例 FAIL（`onSpawn` 不在 `RunBashOptions` 上 / 未被调用）。

- [ ] **Step 3: 实现 exec.ts**

`RunBashOptions` 增加字段；解构处加 `onSpawn`；spawn 成功后回调：

```ts
export interface RunBashOptions {
  readonly command: string;
  readonly workdir: string;
  readonly timeoutMs: number;
  readonly maxCaptureBytes: number;
  readonly profile: ShellProfile;
  readonly env?: NodeJS.ProcessEnv;
  readonly abortSignal?: AbortSignal;
  readonly onDelta?: (stream: BashStreamName, delta: string) => void;
  readonly onSpawn?: (child: ChildProcess) => void;
}
```

```ts
  const { command, workdir, timeoutMs, maxCaptureBytes, profile, env, abortSignal, onDelta, onSpawn } =
    options;
```

```ts
    try {
      const spec = profile.buildSpawn(command, workdir, env ?? process.env);
      segmentFile = spec.rollSegmentFile;
      child = deps.spawn(spec.file, spec.args, spec.options);
    } catch (error) {
      resolve(spawnErrorResult(errorMessage(error), timeoutMs));
      return;
    }
    if (child.pid !== undefined) {
      onSpawn?.(child);
    }
```

- [ ] **Step 4: 运行 exec.test.ts 全绿**

Run: `node --experimental-strip-types --test packages/runtime/src/bash/exec.test.ts`
Expected: PASS（含既有用例）。

- [ ] **Step 5: bash-tool.ts 失败测试**

在 `packages/runtime/src/tool-bridge/bash-tool.test.ts` 追加（`getExecute` / `settings` / `options` / `okResult` / `allowPolicy` 已定义；顶部补 `import type { ChildProcess } from "node:child_process";`）：

```ts
test("settings.onCommandSpawn 透传为 exec 的 onSpawn", async () => {
  const seen: ChildProcess[] = [];
  const sentinel = { pid: 4321 } as unknown as ChildProcess;
  const execute = getExecute(
    settings({
      onCommandSpawn: (child) => {
        seen.push(child);
      },
    }),
    { policy: allowPolicy, requestApproval: async () => ({ approved: true }) },
    async (o) => {
      o.onSpawn?.(sentinel);
      return okResult;
    },
  );
  await execute({ command: "echo ok" }, options());
  assert.deepEqual(seen, [sentinel]);
});

test("未设置 onCommandSpawn 时 exec 选项里没有 onSpawn 键", async () => {
  let keys: readonly string[] = [];
  const execute = getExecute(
    settings(),
    { policy: allowPolicy, requestApproval: async () => ({ approved: true }) },
    async (o) => {
      keys = Object.keys(o);
      return okResult;
    },
  );
  await execute({ command: "echo ok" }, options());
  assert.equal(keys.includes("onSpawn"), false);
});
```

（`execute` 的入参形状照文件里既有用例，例如 `execute({ command: "echo ok" }, options())`；若既有用例用的是 `execute({ command, explanation }, ...)`，照抄那种形状。）

- [ ] **Step 6: 运行确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/bash-tool.test.ts`
Expected: 第一个新用例 FAIL（`seen` 为空）。

- [ ] **Step 7: 实现 bash-tool.ts**

```ts
export interface SessionBashSettings {
  readonly workdir: string;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly maxCaptureBytes: number;
  readonly maxModelOutputChars: number;
  readonly profile: ShellProfile;
  readonly env?: NodeJS.ProcessEnv;
  readonly onCommandSpawn?: (child: ChildProcess) => void;
}
```

`exec(` 调用处：

```ts
            const result = await exec({
              command: input.command,
              workdir,
              timeoutMs,
              maxCaptureBytes: settings.maxCaptureBytes,
              profile: settings.profile,
              env: capturedState === "known-safe" ? withAutoApprovedShellEnv(shellEnv) : shellEnv,
              ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
              ...(onDelta ? { onDelta } : {}),
              ...(settings.onCommandSpawn ? { onSpawn: settings.onCommandSpawn } : {}),
            });
```

顶部加 `import type { ChildProcess } from "node:child_process";`。

- [ ] **Step 8: 运行 bash-tool.test.ts 全绿**

Run: `node --experimental-strip-types --test packages/runtime/src/tool-bridge/bash-tool.test.ts`
Expected: PASS。

- [ ] **Step 9: conversation-engine 失败测试**

在 `packages/runtime/src/engine/conversation-engine.test.ts` 追加（文件里已有 `powershellProfile: ShellProfile`，第 9 行已 `import { rollConfigSchema } from "@roll-agent/core/config/schema"`；把 `buildSessionBashSettings` 加进该文件对 `./conversation-engine.ts` 的既有 import）：

```ts
test("buildSessionBashSettings 只在提供 onCommandSpawn 时写入该字段", () => {
  const config = rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    runtime: { model: "runtime-model" },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
  });
  const onCommandSpawn = () => {};
  const withHook = buildSessionBashSettings({
    config,
    profile: powershellProfile,
    env: { PATH: "/usr/bin" },
    onCommandSpawn,
  });
  assert.equal(withHook.onCommandSpawn, onCommandSpawn);
  assert.equal(withHook.profile, powershellProfile);
  assert.deepEqual(withHook.env, { PATH: "/usr/bin" });
  assert.equal(withHook.turnTimeoutMs, config.runtime.turnTimeoutMs);
  const without = buildSessionBashSettings({
    config,
    profile: powershellProfile,
    env: { PATH: "/usr/bin" },
  });
  assert.equal("onCommandSpawn" in without, false);
});
```

- [ ] **Step 10: 运行确认失败**

Run: `node --experimental-strip-types --test packages/runtime/src/engine/conversation-engine.test.ts`
Expected: FAIL（`buildSessionBashSettings` 未导出）。

- [ ] **Step 11: 实现 conversation-engine.ts**

options 加字段、字段、ctor 赋值、抽纯函数：

```ts
  readonly shellEnv?: NodeJS.ProcessEnv;
  readonly onShellCommandSpawn?: (child: ChildProcess) => void;
  readonly fileToolsEnabled?: boolean;
```

```ts
export function buildSessionBashSettings(input: {
  readonly config: RollConfig;
  readonly profile: ShellProfile;
  readonly env: NodeJS.ProcessEnv;
  readonly onCommandSpawn?: (child: ChildProcess) => void;
}): SessionBashSettings {
  const shell = input.config.runtime.shell;
  return {
    workdir: process.cwd(),
    defaultTimeoutMs: shell.defaultTimeoutMs,
    maxTimeoutMs: shell.maxTimeoutMs,
    turnTimeoutMs: input.config.runtime.turnTimeoutMs,
    maxCaptureBytes: shell.maxCaptureBytes,
    maxModelOutputChars: shell.maxModelOutputChars,
    profile: input.profile,
    env: input.env,
    ...(input.onCommandSpawn ? { onCommandSpawn: input.onCommandSpawn } : {}),
  };
}
```

类内：

```ts
  private readonly onShellCommandSpawn: ((child: ChildProcess) => void) | undefined;
  // ctor
    this.onShellCommandSpawn = options.onShellCommandSpawn;
  // 替换原 resolveShellSettings 方法体
  private resolveShellSettings(profile: ShellProfile): SessionBashSettings {
    return buildSessionBashSettings({
      config: this.config,
      profile,
      env: this.shellEnv,
      ...(this.onShellCommandSpawn ? { onCommandSpawn: this.onShellCommandSpawn } : {}),
    });
  }
```

顶部加 `import type { ChildProcess } from "node:child_process";`（核心代码不写注释，上面的 `// ctor` 注释只是计划标注，不要写进源码）。

- [ ] **Step 12: 运行 runtime 全部测试与类型检查**

Run: `pnpm --filter @roll-agent/runtime typecheck && pnpm --filter @roll-agent/runtime test`
Expected: typecheck 0 错，测试全绿。

- [ ] **Step 13: 提交**

```bash
git add packages/runtime/src/bash/exec.ts packages/runtime/src/bash/exec.test.ts packages/runtime/src/tool-bridge/bash-tool.ts packages/runtime/src/tool-bridge/bash-tool.test.ts packages/runtime/src/engine/conversation-engine.ts packages/runtime/src/engine/conversation-engine.test.ts
git commit -m "feat(runtime): hand spawned bash children to the host via onShellCommandSpawn

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: core — exec 环境注入 invocation 标记

**Files:**
- Modify: `packages/core/src/scheduler-host/paths.ts:7-8`
- Modify: `packages/core/src/scheduler-host/spawn-invocation.ts:10,52-56`
- Create: `packages/core/src/scheduler-host/spawn-invocation.test.ts`

**Interfaces:**
- Produces: `export const SCHEDULE_INVOCATION_ENV = "ROLL_SCHEDULE_INVOCATION"`（paths.ts）；exec 子进程 env 含 `ROLL_SCHEDULE_INVOCATION=<claim.invocation.id>`

- [ ] **Step 1: 失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, createIntervalTrigger } from "@roll-agent/runtime";
import { createInvocationSpawner } from "./spawn-invocation.ts";
import { SCHEDULE_INVOCATION_ENV, SCHEDULE_TOKEN_ENV } from "./paths.ts";

const NOW = Date.parse("2026-08-27T09:00:00.000Z");

test("createInvocationSpawner 把 invocation id 以 ROLL_SCHEDULE_INVOCATION 注入 exec 环境", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roll-spawn-"));
  try {
    const store = new ScheduleStore(dir);
    store.createSchedule(
      {
        name: "巡检",
        prompt: "p",
        cwd: dir,
        trigger: createIntervalTrigger("30m"),
        fireImmediately: true,
      },
      NOW,
    );
    const claim = store.claimDue({ workerId: "w1", nowMs: NOW, limit: 1 })[0];
    assert.ok(claim);
    const outFile = join(dir, "env.json");
    const script = `require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ marker: process.env.${SCHEDULE_INVOCATION_ENV}, token: process.env.${SCHEDULE_TOKEN_ENV} }))`;
    const spawner = createInvocationSpawner({
      invocation: {
        command: process.execPath,
        cliEntrypoint: outFile,
        runtimeArgs: [],
        companionArgs: [],
        execArgv: ["-e", script],
      },
      dataDir: dir,
      logPath: join(dir, "exec.log"),
    });
    const handle = spawner(claim);
    assert.equal(await handle.exited, 0);
    const written = JSON.parse(readFileSync(outFile, "utf-8")) as { marker?: string; token?: string };
    assert.equal(written.marker, claim.invocation.id);
    assert.equal(written.token, claim.ownershipToken);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/spawn-invocation.test.ts`
Expected: FAIL（`SCHEDULE_INVOCATION_ENV` 未导出 / `written.marker` 为 undefined）。

- [ ] **Step 3: 实现**

`paths.ts`：

```ts
export const SCHEDULE_TOKEN_ENV = "ROLL_SCHEDULE_OWNERSHIP_TOKEN";
export const SCHEDULE_DATA_DIR_ENV = "ROLL_SCHEDULE_DATA_DIR";
export const SCHEDULE_INVOCATION_ENV = "ROLL_SCHEDULE_INVOCATION";
```

`spawn-invocation.ts`：

```ts
import { SCHEDULE_DATA_DIR_ENV, SCHEDULE_INVOCATION_ENV, SCHEDULE_TOKEN_ENV } from "./paths.ts";
```

```ts
        env: {
          ...(options.env ?? process.env),
          [SCHEDULE_TOKEN_ENV]: claim.ownershipToken,
          [SCHEDULE_DATA_DIR_ENV]: options.dataDir,
          [SCHEDULE_INVOCATION_ENV]: claim.invocation.id,
        },
```

- [ ] **Step 4: 运行通过**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/spawn-invocation.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/scheduler-host/paths.ts packages/core/src/scheduler-host/spawn-invocation.ts packages/core/src/scheduler-host/spawn-invocation.test.ts
git commit -m "feat(scheduler): mark scheduled exec trees with ROLL_SCHEDULE_INVOCATION

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: core — 快照解析与成员归集（纯函数）

**Files:**
- Create: `packages/core/src/scheduler-host/invocation-tree.ts`
- Create: `packages/core/src/scheduler-host/invocation-tree.test.ts`
- Modify: `packages/core/src/scheduler-host/executor-liveness.ts:15`（`const TRUSTED_PS_PATHS` → `export const`）

**Interfaces:**
- Consumes: `SCHEDULE_INVOCATION_ENV`（Task 2）、`TRUSTED_PS_PATHS`
- Produces:

```ts
export interface ProcessSnapshotEntry { readonly pid: number; readonly pgid: number; readonly zombie: boolean; readonly marked: boolean }
export type ProcessSnapshot = readonly ProcessSnapshotEntry[];
export function invocationMarker(invocationId: string): string;
export function parsePsSnapshot(output: string, marker: string, excludePid?: number): ProcessSnapshot;
export function parseProcStat(stat: string): { readonly pgid: number; readonly zombie: boolean } | undefined;
export function snapshotProcesses(marker: string, platform?: NodeJS.Platform): ProcessSnapshot | undefined;
export interface TrackedProcessGroup { readonly pgid: number; readonly leaderExited: () => boolean }
export class ProcessGroupLedger { track(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">): void; groups(): readonly TrackedProcessGroup[] }
export interface InvocationTreeScope { readonly invocationId: string; readonly selfPid: number; readonly trackedGroups: readonly TrackedProcessGroup[]; readonly previousExecutorPid?: number }
export interface TreeMembers { readonly pids: readonly number[]; readonly skippedReusedGroups: readonly number[] }
export function collectTreeMembers(snapshot: ProcessSnapshot, scope: InvocationTreeScope): TreeMembers;
```

- [ ] **Step 1: 失败测试（纯函数部分）**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProcessGroupLedger,
  collectTreeMembers,
  invocationMarker,
  parseProcStat,
  parsePsSnapshot,
  type ProcessSnapshot,
} from "./invocation-tree.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const MARKER = invocationMarker(ID);

test("parsePsSnapshot 解析 pid/pgid/stat/command 并按边界匹配标记、排除指定 pid", () => {
  const output = [
    "  100   100 Ss   /bin/bash -c sleep",
    `  101   100 S    /opt/homebrew/bin/node -e x PATH=/usr/bin ${MARKER} HOME=/Users/x`,
    `  102   102 Z    (node) ${MARKER}`,
    `  103   103 S    /usr/bin/python3 ${MARKER}0`,
    "  104   104 R+   /bin/ps -A -ww -o pid=,pgid=,stat=,command= -E",
    "garbage line",
  ].join("\n");
  assert.deepEqual(parsePsSnapshot(output, MARKER, 104), [
    { pid: 100, pgid: 100, zombie: false, marked: false },
    { pid: 101, pgid: 100, zombie: false, marked: true },
    { pid: 102, pgid: 102, zombie: true, marked: true },
    { pid: 103, pgid: 103, zombie: false, marked: false },
  ]);
});

test("parseProcStat 取 ')' 之后的 state 与 pgrp，comm 含空格和括号也不受影响", () => {
  assert.deepEqual(parseProcStat("101 (node (x) y) S 1 100 100 0 -1 4194560 0"), {
    pgid: 100,
    zombie: false,
  });
  assert.deepEqual(parseProcStat("102 (sleep) Z 1 102 102 0"), { pgid: 102, zombie: true });
  assert.equal(parseProcStat("broken"), undefined);
});

test("invocationMarker 形如 ROLL_SCHEDULE_INVOCATION=<id>", () => {
  assert.equal(MARKER, `ROLL_SCHEDULE_INVOCATION=${ID}`);
});

function snapshot(entries: readonly (readonly [number, number, boolean?, boolean?])[]): ProcessSnapshot {
  return entries.map(([pid, pgid, marked = false, zombie = false]) => ({ pid, pgid, marked, zombie }));
}

test("collectTreeMembers：标记进程无论在哪个组都算成员，自身与僵尸排除", () => {
  const members = collectTreeMembers(
    snapshot([
      [500, 500, true],
      [501, 501, true],
      [502, 900, true],
      [503, 903, true, true],
      [504, 904],
    ]),
    { invocationId: ID, selfPid: 500, trackedGroups: [] },
  );
  assert.deepEqual(members, { pids: [501, 502], skippedReusedGroups: [] });
});

test("collectTreeMembers：exec 是组首领时同组成员算成员；不是首领时不启用组判据", () => {
  const leader = collectTreeMembers(snapshot([[500, 500], [510, 500], [511, 500, false, true], [520, 520]]), {
    invocationId: ID,
    selfPid: 500,
    trackedGroups: [],
  });
  assert.deepEqual(leader.pids, [510]);
  const notLeader = collectTreeMembers(snapshot([[500, 1], [510, 1], [520, 520]]), {
    invocationId: ID,
    selfPid: 500,
    trackedGroups: [],
  });
  assert.deepEqual(notLeader.pids, []);
});

test("collectTreeMembers：登记组首领存活或已退出且 pid 未复用时整组算成员；pid 已被复用则跳过", () => {
  const alive = collectTreeMembers(snapshot([[500, 500], [600, 600], [601, 600]]), {
    invocationId: ID,
    selfPid: 500,
    trackedGroups: [{ pgid: 600, leaderExited: () => false }],
  });
  assert.deepEqual(alive.pids, [600, 601]);
  const orphaned = collectTreeMembers(snapshot([[500, 500], [601, 600]]), {
    invocationId: ID,
    selfPid: 500,
    trackedGroups: [{ pgid: 600, leaderExited: () => true }],
  });
  assert.deepEqual(orphaned, { pids: [601], skippedReusedGroups: [] });
  const reused = collectTreeMembers(snapshot([[500, 500], [600, 600], [601, 600]]), {
    invocationId: ID,
    selfPid: 500,
    trackedGroups: [{ pgid: 600, leaderExited: () => true }],
  });
  assert.deepEqual(reused, { pids: [], skippedReusedGroups: [600] });
  const zombieLeader = collectTreeMembers(snapshot([[500, 500], [600, 600, false, true], [601, 600]]), {
    invocationId: ID,
    selfPid: 500,
    trackedGroups: [{ pgid: 600, leaderExited: () => true }],
  });
  assert.deepEqual(zombieLeader.pids, [601]);
});

test("collectTreeMembers：上一任 executor pid 当作已退出的登记组处理", () => {
  const members = collectTreeMembers(snapshot([[500, 500], [701, 700], [702, 700, true]]), {
    invocationId: ID,
    selfPid: 500,
    trackedGroups: [],
    previousExecutorPid: 700,
  });
  assert.deepEqual(members.pids, [701, 702]);
  const reused = collectTreeMembers(snapshot([[500, 500], [700, 700], [701, 700]]), {
    invocationId: ID,
    selfPid: 500,
    trackedGroups: [],
    previousExecutorPid: 700,
  });
  assert.deepEqual(reused, { pids: [], skippedReusedGroups: [700] });
});

test("ProcessGroupLedger 只登记拿到 pid 的子进程，leaderExited 跟随 exitCode/signalCode", () => {
  const ledger = new ProcessGroupLedger();
  const child = { pid: 800, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  ledger.track({ pid: undefined, exitCode: null, signalCode: null });
  ledger.track(child);
  assert.equal(ledger.groups().length, 1);
  assert.equal(ledger.groups()[0]?.pgid, 800);
  assert.equal(ledger.groups()[0]?.leaderExited(), false);
  child.exitCode = 0;
  assert.equal(ledger.groups()[0]?.leaderExited(), true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/invocation-tree.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 invocation-tree.ts（本任务只写到 collectTreeMembers；terminateInvocationTree 在 Task 4 追加）**

先把 `executor-liveness.ts:15` 改为 `export const TRUSTED_PS_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;`。然后：

```ts
import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { TRUSTED_PS_PATHS } from "./executor-liveness.ts";
import { SCHEDULE_INVOCATION_ENV } from "./paths.ts";

const SNAPSHOT_TIMEOUT_MS = 5_000;
const SNAPSHOT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u;

export interface ProcessSnapshotEntry {
  readonly pid: number;
  readonly pgid: number;
  readonly zombie: boolean;
  readonly marked: boolean;
}

export type ProcessSnapshot = readonly ProcessSnapshotEntry[];

export function invocationMarker(invocationId: string): string {
  return `${SCHEDULE_INVOCATION_ENV}=${invocationId}`;
}

function isBoundary(char: string): boolean {
  return char === "" || /\s/u.test(char);
}

function containsMarker(commandLine: string, marker: string): boolean {
  let from = 0;
  while (from <= commandLine.length) {
    const at = commandLine.indexOf(marker, from);
    if (at < 0) {
      return false;
    }
    const before = at === 0 ? "" : commandLine.charAt(at - 1);
    const after = commandLine.charAt(at + marker.length);
    if (isBoundary(before) && isBoundary(after)) {
      return true;
    }
    from = at + marker.length;
  }
  return false;
}

export function parsePsSnapshot(output: string, marker: string, excludePid?: number): ProcessSnapshot {
  const entries: ProcessSnapshotEntry[] = [];
  for (const line of output.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const pid = Number.parseInt(match[1] ?? "", 10);
    const pgid = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(pgid) || pid === excludePid) {
      continue;
    }
    entries.push({
      pid,
      pgid,
      zombie: (match[3] ?? "").startsWith("Z"),
      marked: containsMarker(match[4] ?? "", marker),
    });
  }
  return entries;
}

export function parseProcStat(stat: string): { readonly pgid: number; readonly zombie: boolean } | undefined {
  const end = stat.lastIndexOf(")");
  if (end < 0) {
    return undefined;
  }
  const fields = stat.slice(end + 1).trim().split(/\s+/u);
  const pgid = Number.parseInt(fields[2] ?? "", 10);
  if (!Number.isInteger(pgid)) {
    return undefined;
  }
  return { pgid, zombie: (fields[0] ?? "").startsWith("Z") };
}

function snapshotFromProc(marker: string): ProcessSnapshot {
  const entries: ProcessSnapshotEntry[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/u.test(name)) {
      continue;
    }
    let parsed: ReturnType<typeof parseProcStat>;
    try {
      parsed = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf-8"));
    } catch {
      continue;
    }
    if (parsed === undefined) {
      continue;
    }
    let marked = false;
    try {
      marked = readFileSync(`/proc/${name}/environ`, "utf-8").split("\0").includes(marker);
    } catch {
      marked = false;
    }
    entries.push({ pid: Number.parseInt(name, 10), pgid: parsed.pgid, zombie: parsed.zombie, marked });
  }
  return entries;
}

function snapshotFromPs(marker: string): ProcessSnapshot | undefined {
  const psExecutable = TRUSTED_PS_PATHS.find((candidate) => existsSync(candidate));
  if (psExecutable === undefined) {
    return undefined;
  }
  const result = spawnSync(psExecutable, ["-A", "-ww", "-o", "pid=,pgid=,stat=,command=", "-E"], {
    encoding: "utf-8",
    env: { LC_ALL: "C", LANG: "C" },
    timeout: SNAPSHOT_TIMEOUT_MS,
    maxBuffer: SNAPSHOT_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error !== undefined) {
    return undefined;
  }
  return parsePsSnapshot(result.stdout, marker, result.pid);
}

export function snapshotProcesses(
  marker: string,
  platform: NodeJS.Platform = process.platform,
): ProcessSnapshot | undefined {
  if (platform === "win32") {
    return undefined;
  }
  if (platform === "linux" || platform === "android") {
    return snapshotFromProc(marker);
  }
  return snapshotFromPs(marker);
}

export interface TrackedProcessGroup {
  readonly pgid: number;
  readonly leaderExited: () => boolean;
}

export class ProcessGroupLedger {
  private readonly tracked: TrackedProcessGroup[] = [];

  track(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">): void {
    const pgid = child.pid;
    if (pgid === undefined) {
      return;
    }
    this.tracked.push({
      pgid,
      leaderExited: () => child.exitCode !== null || child.signalCode !== null,
    });
  }

  groups(): readonly TrackedProcessGroup[] {
    return [...this.tracked];
  }
}

export interface InvocationTreeScope {
  readonly invocationId: string;
  readonly selfPid: number;
  readonly trackedGroups: readonly TrackedProcessGroup[];
  readonly previousExecutorPid?: number;
}

export interface TreeMembers {
  readonly pids: readonly number[];
  readonly skippedReusedGroups: readonly number[];
}

export function collectTreeMembers(snapshot: ProcessSnapshot, scope: InvocationTreeScope): TreeMembers {
  const byPid = new Map(snapshot.map((entry) => [entry.pid, entry] as const));
  const groups = new Set<number>();
  const skipped: number[] = [];
  const self = byPid.get(scope.selfPid);
  if (self !== undefined && self.pgid === scope.selfPid) {
    groups.add(scope.selfPid);
  }
  const consider = (pgid: number, leaderExited: boolean): void => {
    const leader = byPid.get(pgid);
    if (leaderExited && leader !== undefined && !leader.zombie) {
      skipped.push(pgid);
      return;
    }
    groups.add(pgid);
  };
  for (const group of scope.trackedGroups) {
    consider(group.pgid, group.leaderExited());
  }
  if (scope.previousExecutorPid !== undefined && scope.previousExecutorPid !== scope.selfPid) {
    consider(scope.previousExecutorPid, true);
  }
  const pids = snapshot
    .filter((entry) => entry.pid !== scope.selfPid && !entry.zombie)
    .filter((entry) => entry.marked || groups.has(entry.pgid))
    .map((entry) => entry.pid);
  return { pids, skippedReusedGroups: skipped };
}
```

- [ ] **Step 4: 运行通过**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/invocation-tree.test.ts && node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/executor-liveness.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/scheduler-host/invocation-tree.ts packages/core/src/scheduler-host/invocation-tree.test.ts packages/core/src/scheduler-host/executor-liveness.ts
git commit -m "feat(scheduler): enumerate an invocation's process tree by marker, own pgid and tracked groups

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: core — `terminateInvocationTree`（注入矩阵 + 真实进程）

**Files:**
- Modify: `packages/core/src/scheduler-host/invocation-tree.ts`（追加）
- Modify: `packages/core/src/scheduler-host/invocation-tree.test.ts`（追加）

**Interfaces:**
- Produces:

```ts
export const INVOCATION_TREE_TEARDOWN_OUTCOMES = { clean: "clean", survivors: "survivors", unavailable: "unavailable", unsupported: "unsupported" } as const;
export type InvocationTreeTeardownOutcome = (typeof INVOCATION_TREE_TEARDOWN_OUTCOMES)[keyof typeof INVOCATION_TREE_TEARDOWN_OUTCOMES];
export interface InvocationTreeTeardown { readonly outcome: InvocationTreeTeardownOutcome; readonly terminatedPids: readonly number[]; readonly survivorPids: readonly number[]; readonly skippedReusedGroups: readonly number[] }
export interface TerminateInvocationTreeDeps { readonly platform?: NodeJS.Platform; readonly snapshot?: (marker: string) => ProcessSnapshot | undefined; readonly kill?: (pid: number, signal: NodeJS.Signals) => void; readonly sleep?: (ms: number) => Promise<void>; readonly now?: () => number; readonly graceMs?: number; readonly pollMs?: number }
export async function terminateInvocationTree(scope: InvocationTreeScope, deps?: TerminateInvocationTreeDeps): Promise<InvocationTreeTeardown>;
```

- [ ] **Step 1: 失败测试（注入矩阵）**

追加到 `invocation-tree.test.ts`（补 import：`INVOCATION_TREE_TEARDOWN_OUTCOMES, snapshotProcesses, terminateInvocationTree`，以及 `import { spawn, spawnSync } from "node:child_process"; import { once } from "node:events";`）：

```ts
function scriptedDeps(frames: readonly ProcessSnapshot[], killed: Array<[number, string]>, extra: { readonly graceMs?: number; readonly kill?: (pid: number, signal: NodeJS.Signals) => void } = {}) {
  let index = 0;
  let clock = 0;
  return {
    platform: "darwin" as const,
    snapshot: () => frames[Math.min(index++, frames.length - 1)],
    kill:
      extra.kill ??
      ((pid: number, signal: NodeJS.Signals) => {
        killed.push([pid, signal]);
      }),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    graceMs: extra.graceMs ?? 0,
    pollMs: 10,
  };
}

const SCOPE = { invocationId: ID, selfPid: 500, trackedGroups: [] as const };

test("terminateInvocationTree：没有成员直接 clean，不发信号", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(SCOPE, scriptedDeps([snapshot([[500, 500]])], killed));
  assert.deepEqual(report, {
    outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.clean,
    terminatedPids: [],
    survivorPids: [],
    skippedReusedGroups: [],
  });
  assert.deepEqual(killed, []);
});

test("terminateInvocationTree：SIGTERM 后成员消失即 clean，不再 SIGKILL", async () => {
  const killed: Array<[number, string]> = [];
  const report = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([snapshot([[500, 500], [501, 501, true]]), snapshot([[500, 500]])], killed),
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, [501]);
  assert.deepEqual(killed, [[501, "SIGTERM"]]);
});

test("terminateInvocationTree：grace 后仍在则 SIGKILL，随后消失为 clean", async () => {
  const killed: Array<[number, string]> = [];
  const frames = [snapshot([[500, 500], [501, 501, true]]), snapshot([[500, 500], [501, 501, true]]), snapshot([[500, 500]])];
  const report = await terminateInvocationTree(SCOPE, scriptedDeps(frames, killed));
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(killed, [
    [501, "SIGTERM"],
    [501, "SIGKILL"],
  ]);
});

test("terminateInvocationTree：SIGKILL 后仍在或 EPERM 的进程记为 survivors", async () => {
  const killed: Array<[number, string]> = [];
  const stuck = snapshot([[500, 500], [501, 501, true], [502, 500]]);
  const report = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([stuck, stuck, stuck], killed, {
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        if (pid === 502) {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        }
      },
    }),
  );
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.survivors);
  assert.deepEqual(report.survivorPids, [501, 502]);
  assert.deepEqual(report.terminatedPids, []);
});

test("terminateInvocationTree：ESRCH 忽略；快照不可用返回 unavailable；win32 返回 unsupported", async () => {
  const killed: Array<[number, string]> = [];
  const esrch = await terminateInvocationTree(
    SCOPE,
    scriptedDeps([snapshot([[500, 500], [501, 501, true]]), snapshot([[500, 500]])], killed, {
      kill: () => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      },
    }),
  );
  assert.equal(esrch.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  const unavailable = await terminateInvocationTree(SCOPE, { ...scriptedDeps([], killed), snapshot: () => undefined });
  assert.equal(unavailable.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  const unsupported = await terminateInvocationTree(SCOPE, { platform: "win32" });
  assert.equal(unsupported.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.unsupported);
});

test("terminateInvocationTree：清场途中新出现的成员也会被处理并计入 terminatedPids", async () => {
  const killed: Array<[number, string]> = [];
  const frames = [
    snapshot([[500, 500], [501, 501, true]]),
    snapshot([[500, 500], [503, 503, true]]),
    snapshot([[500, 500]]),
  ];
  const report = await terminateInvocationTree(SCOPE, scriptedDeps(frames, killed));
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, [501, 503]);
  assert.deepEqual(killed, [
    [501, "SIGTERM"],
    [503, "SIGKILL"],
  ]);
});
```

- [ ] **Step 2: 失败测试（真实进程，POSIX）**

```ts
const posixOnly = { skip: process.platform === "win32" };

test("真实进程：带标记的 detached 子进程被找到并终止，不同标记的对照进程不受影响", posixOnly, async () => {
  const otherId = "99999999-8888-4777-8666-555555555555";
  const target = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ROLL_SCHEDULE_INVOCATION: ID },
  });
  const control = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ROLL_SCHEDULE_INVOCATION: otherId },
  });
  try {
    await Promise.all([once(target, "spawn"), once(control, "spawn")]);
    const report = await terminateInvocationTree({ invocationId: ID, selfPid: process.pid, trackedGroups: [] });
    await once(target, "exit");
    assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
    assert.ok(report.terminatedPids.includes(target.pid ?? -1));
    assert.equal(control.exitCode, null);
    assert.equal(control.signalCode, null);
  } finally {
    control.kill("SIGKILL");
    await once(control, "exit").catch(() => undefined);
    if (target.exitCode === null && target.signalCode === null) {
      target.kill("SIGKILL");
    }
  }
});

test("真实进程：bash 工具形状的孤儿（sh 退出后留在其进程组的 /bin/sleep）经登记组被找到并终止", posixOnly, async () => {
  const ledger = new ProcessGroupLedger();
  const shell = spawn("/bin/sh", ["-c", "/bin/sleep 60 & exit 0"], { detached: true, stdio: "ignore" });
  ledger.track(shell);
  await once(shell, "exit");
  const scope = { invocationId: ID, selfPid: process.pid, trackedGroups: ledger.groups() };
  const before = collectTreeMembers(snapshotProcesses(invocationMarker(ID)) ?? [], scope);
  assert.equal(before.pids.length, 1, "sh 退出后应留下一个孤儿 sleep");
  const report = await terminateInvocationTree(scope);
  assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
  assert.deepEqual(report.terminatedPids, before.pids);
  const after = collectTreeMembers(snapshotProcesses(invocationMarker(ID)) ?? [], scope);
  assert.deepEqual(after.pids, []);
});

test("真实进程：测试进程不是组首领时不会误杀同组进程", posixOnly, async () => {
  const sibling = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  try {
    await once(sibling, "spawn");
    const marker = invocationMarker(ID);
    const snap = snapshotProcesses(marker);
    assert.ok(snap);
    const self = snap.find((entry) => entry.pid === process.pid);
    assert.ok(self);
    if (self.pgid === process.pid) {
      return;
    }
    const report = await terminateInvocationTree({ invocationId: ID, selfPid: process.pid, trackedGroups: [] });
    assert.equal(report.outcome, INVOCATION_TREE_TEARDOWN_OUTCOMES.clean);
    assert.equal(report.terminatedPids.includes(sibling.pid ?? -1), false);
    assert.equal(sibling.exitCode, null);
  } finally {
    sibling.kill("SIGKILL");
    await once(sibling, "exit").catch(() => undefined);
  }
});

test("真实进程：快照里带标记的只有那个子进程，不含做快照的 ps，测试进程自身在快照里", posixOnly, async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ROLL_SCHEDULE_INVOCATION: ID },
  });
  try {
    await once(child, "spawn");
    const snap = snapshotProcesses(invocationMarker(ID));
    assert.ok(snap);
    assert.deepEqual(
      snap.filter((entry) => entry.marked).map((entry) => entry.pid),
      [child.pid],
    );
    assert.equal(snap.some((entry) => entry.pid === process.pid), true);
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
});
```

（`ps -E` 与 `/proc/<pid>/environ` 反映的都是进程 exec 时的初始环境块，运行时改 `process.env` 不会体现，所以标记必须在 spawn 时注入——这也是生产路径的形状。）

- [ ] **Step 3: 运行确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/invocation-tree.test.ts`
Expected: 新用例 FAIL（`terminateInvocationTree` 未导出）。

- [ ] **Step 4: 实现 terminateInvocationTree**

追加到 `invocation-tree.ts`（顶部补 `import { setTimeout as sleep } from "node:timers/promises";`）：

```ts
const TEARDOWN_GRACE_MS = 2_000;
const TEARDOWN_POLL_MS = 250;

export const INVOCATION_TREE_TEARDOWN_OUTCOMES = {
  clean: "clean",
  survivors: "survivors",
  unavailable: "unavailable",
  unsupported: "unsupported",
} as const;

export type InvocationTreeTeardownOutcome =
  (typeof INVOCATION_TREE_TEARDOWN_OUTCOMES)[keyof typeof INVOCATION_TREE_TEARDOWN_OUTCOMES];

export interface InvocationTreeTeardown {
  readonly outcome: InvocationTreeTeardownOutcome;
  readonly terminatedPids: readonly number[];
  readonly survivorPids: readonly number[];
  readonly skippedReusedGroups: readonly number[];
}

export interface TerminateInvocationTreeDeps {
  readonly platform?: NodeJS.Platform;
  readonly snapshot?: (marker: string) => ProcessSnapshot | undefined;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly graceMs?: number;
  readonly pollMs?: number;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function emptyTeardown(outcome: InvocationTreeTeardownOutcome, skipped: readonly number[] = []): InvocationTreeTeardown {
  return { outcome, terminatedPids: [], survivorPids: [], skippedReusedGroups: skipped };
}

function ascending(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

export async function terminateInvocationTree(
  scope: InvocationTreeScope,
  deps: TerminateInvocationTreeDeps = {},
): Promise<InvocationTreeTeardown> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    return emptyTeardown(INVOCATION_TREE_TEARDOWN_OUTCOMES.unsupported);
  }
  const marker = invocationMarker(scope.invocationId);
  const snapshot = deps.snapshot ?? ((value: string) => snapshotProcesses(value, platform));
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const wait = deps.sleep ?? ((ms: number) => sleep(ms));
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? TEARDOWN_GRACE_MS;
  const pollMs = deps.pollMs ?? TEARDOWN_POLL_MS;
  const first = snapshot(marker);
  if (first === undefined) {
    return emptyTeardown(INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable);
  }
  const initial = collectTreeMembers(first, scope);
  if (initial.pids.length === 0) {
    return emptyTeardown(INVOCATION_TREE_TEARDOWN_OUTCOMES.clean, initial.skippedReusedGroups);
  }
  const seen = new Set<number>(initial.pids);
  const unkillable = new Set<number>();
  const signalAll = (pids: readonly number[], signal: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        kill(pid, signal);
      } catch (error) {
        if (isErrnoCode(error, "EPERM")) {
          unkillable.add(pid);
        }
      }
    }
  };
  const settle = async (): Promise<readonly number[] | undefined> => {
    const deadline = now() + graceMs;
    for (;;) {
      await wait(pollMs);
      const current = snapshot(marker);
      if (current === undefined) {
        return undefined;
      }
      const members = collectTreeMembers(current, scope).pids;
      for (const pid of members) {
        seen.add(pid);
      }
      if (members.length === 0 || now() >= deadline) {
        return members;
      }
    }
  };
  signalAll(initial.pids, "SIGTERM");
  let remaining = await settle();
  if (remaining === undefined) {
    return emptyTeardown(INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable, initial.skippedReusedGroups);
  }
  if (remaining.length > 0) {
    signalAll(remaining, "SIGKILL");
    remaining = await settle();
    if (remaining === undefined) {
      return emptyTeardown(INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable, initial.skippedReusedGroups);
    }
  }
  const survivors = new Set<number>([...remaining, ...unkillable]);
  const terminated = ascending([...seen].filter((pid) => !survivors.has(pid)));
  return {
    outcome:
      survivors.size === 0
        ? INVOCATION_TREE_TEARDOWN_OUTCOMES.clean
        : INVOCATION_TREE_TEARDOWN_OUTCOMES.survivors,
    terminatedPids: terminated,
    survivorPids: ascending(survivors),
    skippedReusedGroups: initial.skippedReusedGroups,
  };
}
```

- [ ] **Step 5: 运行通过（含真实进程）**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/invocation-tree.test.ts`
Expected: 全部 PASS。若「bash 工具形状的孤儿」用例在 macOS 上失败，先手工验证 `/bin/ps -A -o pid=,pgid= | grep <sh.pid>` 能看到孤儿 sleep 再排查解析。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/scheduler-host/invocation-tree.ts packages/core/src/scheduler-host/invocation-tree.test.ts
git commit -m "feat(scheduler): terminate an invocation's process tree with SIGTERM, grace and SIGKILL

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: core — `executeInvocation` 的 preflight / settle

**Files:**
- Modify: `packages/core/src/scheduler-host/execute-invocation.ts`
- Modify: `packages/core/src/scheduler-host/execute-invocation.test.ts`

**Interfaces:**
- Consumes: `INVOCATION_TREE_TEARDOWN_OUTCOMES`, `InvocationTreeTeardown`（Task 4）
- Produces:

```ts
export const INVOCATION_TREE_TEARDOWN_PHASES = { preflight: "preflight", settle: "settle" } as const;
export type InvocationTreeTeardownPhase = (typeof INVOCATION_TREE_TEARDOWN_PHASES)[keyof typeof INVOCATION_TREE_TEARDOWN_PHASES];
export const EXECUTE_INVOCATION_KINDS = { ..., unsettled: "unsettled" } as const;
// ExecuteInvocationResult 新增变体
{ readonly kind: "unsettled"; readonly invocationId: string; readonly survivorPids: readonly number[]; readonly error: string }
// ExecuteInvocationOptions 新增
readonly teardownTree: (phase: InvocationTreeTeardownPhase) => Promise<InvocationTreeTeardown>;
readonly onTeardown?: (phase: InvocationTreeTeardownPhase, report: InvocationTreeTeardown) => void;
export function isTreeSettled(report: InvocationTreeTeardown): boolean;
```

- [ ] **Step 1: 改既有测试 + 失败测试**

在 `execute-invocation.test.ts` 顶部加：

```ts
import {
  INVOCATION_TREE_TEARDOWN_OUTCOMES,
  type InvocationTreeTeardown,
} from "./invocation-tree.ts";
import {
  EXECUTE_INVOCATION_KINDS,
  INVOCATION_TREE_TEARDOWN_PHASES,
  executeInvocation,
  type InvocationTreeTeardownPhase,
  type ScheduledTurnRunner,
} from "./execute-invocation.ts";

const CLEAN: InvocationTreeTeardown = {
  outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.clean,
  terminatedPids: [],
  survivorPids: [],
  skippedReusedGroups: [],
};
const cleanTeardown = () => Promise.resolve(CLEAN);
const teardownReturning = (report: InvocationTreeTeardown) => () => Promise.resolve(report);
```

既有 7 个用例的 `executeInvocation({ ... })` 都加 `teardownTree: cleanTeardown,`。追加：

```ts
test("preflight 有残留时 failInvocation 进入 retry 且不跑 turn", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3 });
    const claim = claimOne(store);
    let turns = 0;
    const phases: InvocationTreeTeardownPhase[] = [];
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn: () => {
        turns += 1;
        return Promise.resolve({ status: "completed", threadId: "t", output: "" });
      },
      teardownTree: teardownReturning({ ...CLEAN, outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.survivors, survivorPids: [4242] }),
      onTeardown: (phase) => {
        phases.push(phase);
      },
    });
    assert.ok(result.kind === EXECUTE_INVOCATION_KINDS.failed);
    assert.equal(result.outcome, INVOCATION_FAILURE_OUTCOMES.retryScheduled);
    assert.match(result.error, /4242/u);
    assert.equal(turns, 0);
    assert.deepEqual(phases, [INVOCATION_TREE_TEARDOWN_PHASES.preflight]);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.retry);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settle 有残留时不写终态、返回 unsettled、行保持 running", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    let calls = 0;
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      executor: { pid: 4321, startToken: "pst-v2:test" },
      runTurn: () => Promise.resolve({ status: "completed", threadId: "t", output: "done" }),
      teardownTree: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? CLEAN
            : { ...CLEAN, outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.survivors, survivorPids: [7, 9] },
        );
      },
    });
    assert.ok(result.kind === EXECUTE_INVOCATION_KINDS.unsettled);
    assert.deepEqual(result.survivorPids, [7, 9]);
    const record = store.getInvocation(claim.invocation.id);
    assert.equal(record?.status, INVOCATION_STATUSES.running);
    assert.deepEqual(record?.executor, { pid: 4321, startToken: "pst-v2:test" });
    assert.equal(record?.threadId, undefined);
    assert.equal(
      store.failInvocation(claim.invocation.id, claim.ownershipToken, "daemon 收尾", NOW + 11),
      INVOCATION_FAILURE_OUTCOMES.retryScheduled,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settle 无法枚举时同样 unsettled；turn 失败时也先清场再 failInvocation", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir, { retryBudget: 3 });
    const claim = claimOne(store);
    let calls = 0;
    const unavailable = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn: () => Promise.resolve({ status: "failed", error: "boom" }),
      teardownTree: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1 ? CLEAN : { ...CLEAN, outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable },
        );
      },
    });
    assert.equal(unavailable.kind, EXECUTE_INVOCATION_KINDS.unsettled);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows 的 unsupported 视同已清场，正常写终态", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn: () => Promise.resolve({ status: "completed", threadId: "t", output: "ok" }),
      teardownTree: teardownReturning({ ...CLEAN, outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.unsupported }),
    });
    assert.equal(result.kind, EXECUTE_INVOCATION_KINDS.completed);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.completed);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("完成路径的 teardown 顺序为 preflight → settle；interrupted 也做 settle 清场但不写账本", async () => {
  const dir = tempDir();
  try {
    const store = new ScheduleStore(dir);
    const claim = claimOne(store);
    const phases: InvocationTreeTeardownPhase[] = [];
    const controller = new AbortController();
    const result = await executeInvocation({
      store,
      invocationId: claim.invocation.id,
      ownershipToken: claim.ownershipToken,
      runTurn: () => {
        controller.abort(new Error("stop"));
        return Promise.resolve({ status: "failed", error: "本轮执行已收到停止请求" });
      },
      stopSignal: controller.signal,
      teardownTree: (phase) => {
        phases.push(phase);
        return Promise.resolve(
          phase === INVOCATION_TREE_TEARDOWN_PHASES.preflight
            ? CLEAN
            : { ...CLEAN, outcome: INVOCATION_TREE_TEARDOWN_OUTCOMES.survivors, survivorPids: [1] },
        );
      },
    });
    assert.equal(result.kind, EXECUTE_INVOCATION_KINDS.interrupted);
    assert.deepEqual(phases, [INVOCATION_TREE_TEARDOWN_PHASES.preflight, INVOCATION_TREE_TEARDOWN_PHASES.settle]);
    assert.equal(store.getInvocation(claim.invocation.id)?.status, INVOCATION_STATUSES.running);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/execute-invocation.test.ts`
Expected: FAIL（`INVOCATION_TREE_TEARDOWN_PHASES` 未导出 / `teardownTree` 未知选项）。

- [ ] **Step 3: 实现 execute-invocation.ts**

```ts
import { SCHEDULER_LIMITS } from "@roll-agent/runtime";
import type {
  ExecutorIdentity,
  InvocationFailureOutcome,
  InvocationRecord,
  ScheduleRecord,
  ScheduleStore,
} from "@roll-agent/runtime";
import { INVOCATION_TREE_TEARDOWN_OUTCOMES, type InvocationTreeTeardown } from "./invocation-tree.ts";

export const INVOCATION_TREE_TEARDOWN_PHASES = {
  preflight: "preflight",
  settle: "settle",
} as const;

export type InvocationTreeTeardownPhase =
  (typeof INVOCATION_TREE_TEARDOWN_PHASES)[keyof typeof INVOCATION_TREE_TEARDOWN_PHASES];

export const EXECUTE_INVOCATION_KINDS = {
  completed: "completed",
  needsConfirmation: "needs_confirmation",
  failed: "failed",
  lostClaim: "lost-claim",
  interrupted: "interrupted",
  unsettled: "unsettled",
} as const;

export type ExecuteInvocationResult =
  | { readonly kind: typeof EXECUTE_INVOCATION_KINDS.completed | typeof EXECUTE_INVOCATION_KINDS.needsConfirmation; readonly invocationId: string; readonly threadId: string }
  | { readonly kind: typeof EXECUTE_INVOCATION_KINDS.failed; readonly invocationId: string; readonly error: string; readonly outcome: InvocationFailureOutcome }
  | { readonly kind: typeof EXECUTE_INVOCATION_KINDS.lostClaim; readonly invocationId: string }
  | { readonly kind: typeof EXECUTE_INVOCATION_KINDS.interrupted; readonly invocationId: string; readonly error: string }
  | { readonly kind: typeof EXECUTE_INVOCATION_KINDS.unsettled; readonly invocationId: string; readonly survivorPids: readonly number[]; readonly error: string };

export interface ExecuteInvocationOptions {
  readonly store: ScheduleStore;
  readonly invocationId: string;
  readonly ownershipToken: string;
  readonly runTurn: ScheduledTurnRunner;
  readonly teardownTree: (phase: InvocationTreeTeardownPhase) => Promise<InvocationTreeTeardown>;
  readonly onTeardown?: (phase: InvocationTreeTeardownPhase, report: InvocationTreeTeardown) => void;
  readonly executor?: ExecutorIdentity;
  readonly now?: () => number;
  readonly maxOutputExcerptChars?: number;
  readonly stopSignal?: AbortSignal;
}

export function isTreeSettled(report: InvocationTreeTeardown): boolean {
  return (
    report.outcome === INVOCATION_TREE_TEARDOWN_OUTCOMES.clean ||
    report.outcome === INVOCATION_TREE_TEARDOWN_OUTCOMES.unsupported
  );
}

function describeUnsettled(report: InvocationTreeTeardown): string {
  if (report.outcome === INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable) {
    return "无法枚举本次运行拉起的进程，拒绝在无法验证进程树已退出时写入结果";
  }
  return `本次运行拉起的进程在强制终止后仍存活（pid ${report.survivorPids.map(String).join(", ")}），拒绝在其仍存活时写入结果`;
}

function describePreflightFailure(report: InvocationTreeTeardown): string {
  if (report.outcome === INVOCATION_TREE_TEARDOWN_OUTCOMES.unavailable) {
    return "无法枚举上一次尝试的残留进程，拒绝在无法验证时运行";
  }
  return `上一次尝试的残留进程无法终止（pid ${report.survivorPids.map(String).join(", ")}），拒绝在其仍存活时再次运行`;
}
```

主体（把类型定义 `SCHEDULED_TURN_STATUSES` / `ScheduledTurnOutcome` / `ScheduledTurnRunner` 原样保留在上方）：

```ts
export async function executeInvocation(
  options: ExecuteInvocationOptions,
): Promise<ExecuteInvocationResult> {
  const now = options.now ?? Date.now;
  const maxChars = options.maxOutputExcerptChars ?? SCHEDULER_LIMITS.maxOutputExcerptChars;
  const begun = options.store.beginInvocation(
    options.invocationId,
    options.ownershipToken,
    now(),
    options.executor,
  );
  if (begun === undefined) {
    return { kind: EXECUTE_INVOCATION_KINDS.lostClaim, invocationId: options.invocationId };
  }
  const teardown = async (phase: InvocationTreeTeardownPhase): Promise<InvocationTreeTeardown> => {
    const report = await options.teardownTree(phase);
    options.onTeardown?.(phase, report);
    return report;
  };
  const preflight = await teardown(INVOCATION_TREE_TEARDOWN_PHASES.preflight);
  if (!isTreeSettled(preflight)) {
    const message = describePreflightFailure(preflight);
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
  const interruptedBy = (error: string): ExecuteInvocationResult | undefined =>
    options.stopSignal?.aborted === true
      ? { kind: EXECUTE_INVOCATION_KINDS.interrupted, invocationId: options.invocationId, error }
      : undefined;
  const unsettledBy = (report: InvocationTreeTeardown): ExecuteInvocationResult => ({
    kind: EXECUTE_INVOCATION_KINDS.unsettled,
    invocationId: options.invocationId,
    survivorPids: report.survivorPids,
    error: describeUnsettled(report),
  });
  let outcome: ScheduledTurnOutcome;
  try {
    outcome = await options.runTurn(begun.schedule, begun.invocation);
  } catch (error) {
    const message = errorMessage(error);
    const settled = await teardown(INVOCATION_TREE_TEARDOWN_PHASES.settle);
    const interrupted = interruptedBy(message);
    if (interrupted !== undefined) {
      return interrupted;
    }
    if (!isTreeSettled(settled)) {
      return unsettledBy(settled);
    }
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
  const settled = await teardown(INVOCATION_TREE_TEARDOWN_PHASES.settle);
  if (outcome.status === SCHEDULED_TURN_STATUSES.failed) {
    const interrupted = interruptedBy(outcome.error);
    if (interrupted !== undefined) {
      return interrupted;
    }
    if (!isTreeSettled(settled)) {
      return unsettledBy(settled);
    }
    const failure = options.store.failInvocation(
      options.invocationId,
      options.ownershipToken,
      outcome.error,
      now(),
      { terminal: outcome.terminal === true },
    );
    return {
      kind: EXECUTE_INVOCATION_KINDS.failed,
      invocationId: options.invocationId,
      error: outcome.error,
      outcome: failure,
    };
  }
  if (!isTreeSettled(settled)) {
    return unsettledBy(settled);
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

- [ ] **Step 4: 运行通过**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/scheduler-host/execute-invocation.test.ts`
Expected: 全部 PASS（既有 7 + 新 5）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/scheduler-host/execute-invocation.ts packages/core/src/scheduler-host/execute-invocation.test.ts
git commit -m "feat(scheduler): tear down the invocation tree before running and before writing terminal state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 接线 — engine-factory / run-scheduled-turn / schedule-exec

**Files:**
- Modify: `packages/core/src/runtime-host/engine-factory.ts:45-61,78-102`
- Modify: `packages/core/src/scheduler-host/run-scheduled-turn.ts:18-24,98-120`
- Modify: `packages/core/src/cli/commands/schedule-exec.ts`

**Interfaces:**
- Consumes: `ConversationEngineOptions.onShellCommandSpawn`（Task 1）、`ProcessGroupLedger` / `terminateInvocationTree`（Task 3/4）、`EXECUTE_INVOCATION_KINDS.unsettled` / `onTeardown`（Task 5）
- Produces: `CreateChatEngineInput.onShellCommandSpawn?: (child: ChildProcess) => void`；`CreateScheduledTurnRunnerInput.onShellCommandSpawn?: (child: ChildProcess) => void`

- [ ] **Step 1: engine-factory.ts**

```ts
import type { ChildProcess } from "node:child_process";
```

`CreateChatEngineInput` 末尾加 `readonly onShellCommandSpawn?: (child: ChildProcess) => void;`；`createChatEngine` 的 `new ConversationEngine({...})` 里 `shellEnv` 那行之后加：

```ts
    ...(input.onShellCommandSpawn ? { onShellCommandSpawn: input.onShellCommandSpawn } : {}),
```

- [ ] **Step 2: run-scheduled-turn.ts**

```ts
import type { ChildProcess } from "node:child_process";

export interface CreateScheduledTurnRunnerInput {
  readonly config: RollConfig;
  readonly runtime: RuntimeModule;
  readonly shellEnv?: NodeJS.ProcessEnv;
  readonly stopSignal?: AbortSignal;
  readonly onShellCommandSpawn?: (child: ChildProcess) => void;
}
```

`createChatEngine({ ... })` 调用里 `shellEnv` 展开之后加：

```ts
      ...(input.onShellCommandSpawn ? { onShellCommandSpawn: input.onShellCommandSpawn } : {}),
```

- [ ] **Step 3: schedule-exec.ts**

```ts
import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { takeScheduleExecEnv } from "../../scheduler-host/exec-env.ts";
import {
  EXECUTE_INVOCATION_KINDS,
  INVOCATION_TREE_TEARDOWN_PHASES,
  executeInvocation,
  type InvocationTreeTeardownPhase,
} from "../../scheduler-host/execute-invocation.ts";
import { readExecutorIdentityWithRetry } from "../../scheduler-host/executor-liveness.ts";
import {
  ProcessGroupLedger,
  terminateInvocationTree,
  type InvocationTreeTeardown,
} from "../../scheduler-host/invocation-tree.ts";
import { createScheduledTurnRunner } from "../../scheduler-host/run-scheduled-turn.ts";
import { installStopSignals } from "../../scheduler-host/stop-signals.ts";
import { log } from "../utils/output.ts";
import {
  loadRuntime,
  openScheduleStore,
  printJson,
  runScheduleCommand,
} from "./schedule-command-utils.ts";

const PHASE_LABELS = {
  [INVOCATION_TREE_TEARDOWN_PHASES.preflight]: "运行前",
  [INVOCATION_TREE_TEARDOWN_PHASES.settle]: "运行结束时",
} as const satisfies Record<InvocationTreeTeardownPhase, string>;

function reportTeardown(
  invocationId: string,
  phase: InvocationTreeTeardownPhase,
  report: InvocationTreeTeardown,
): void {
  if (report.terminatedPids.length > 0) {
    log.warn(
      `invocation ${invocationId} ${PHASE_LABELS[phase]}终止了 ${String(report.terminatedPids.length)} 个残留进程：pid ${report.terminatedPids.map(String).join(", ")}`,
    );
  }
  if (report.skippedReusedGroups.length > 0) {
    log.warn(
      `invocation ${invocationId} 登记的进程组 ${report.skippedReusedGroups.map(String).join(", ")} 首领 PID 已被复用，跳过`,
    );
  }
}
```

`run` 内：

```ts
      try {
        const executor = readExecutorIdentityWithRetry();
        if (executor === undefined) {
          store.failInvocation(
            args.invocation,
            execEnv.ownershipToken,
            `无法验证 exec 进程 (PID: ${String(process.pid)}) 的 OS 启动身份，拒绝无人值守执行`,
            Date.now(),
            { terminal: true },
          );
          throw new Error("无法验证 exec 进程的 OS 启动身份");
        }
        const previousExecutorPid = store.getInvocation(args.invocation)?.executor?.pid;
        const ledger = new ProcessGroupLedger();
        const { config } = loadConfig();
        const result = await executeInvocation({
          store,
          invocationId: args.invocation,
          ownershipToken: execEnv.ownershipToken,
          executor,
          runTurn: createScheduledTurnRunner({
            config,
            runtime,
            stopSignal: stop.controller.signal,
            onShellCommandSpawn: (child) => ledger.track(child),
          }),
          stopSignal: stop.controller.signal,
          teardownTree: () =>
            terminateInvocationTree({
              invocationId: args.invocation,
              selfPid: process.pid,
              trackedGroups: ledger.groups(),
              ...(previousExecutorPid !== undefined ? { previousExecutorPid } : {}),
            }),
          onTeardown: (phase, report) => reportTeardown(args.invocation, phase, report),
        });
        printJson(result);
        if (result.kind === EXECUTE_INVOCATION_KINDS.failed) {
          log.warn(`invocation ${args.invocation} 执行失败：${result.error}`);
          process.exitCode = 1;
        }
        if (result.kind === EXECUTE_INVOCATION_KINDS.interrupted) {
          log.warn(
            `invocation ${args.invocation} 被停止信号中断，未写入结果，交由发起方收尾：${result.error}`,
          );
          process.exitCode = 1;
        }
        if (result.kind === EXECUTE_INVOCATION_KINDS.unsettled) {
          log.error(
            `invocation ${args.invocation} 的进程树未能清理干净，未写入结果，行保持 running：${result.error}`,
          );
          process.exitCode = 1;
        }
      } finally {
```

- [ ] **Step 4: 类型检查、lint、构建自检**

Run: `pnpm typecheck && pnpm lint && pnpm check:source-control-chars`
Expected: 0 错。

Run: `pnpm --filter @roll-agent/core build && node packages/core/dist/cli/index.js agent health`
Expected: 输出「暂无已注册 Agent」（CLAUDE.md 要求的懒加载发布自检）。

- [ ] **Step 5: 跑 core 与 runtime 全量测试**

Run: `pnpm --filter @roll-agent/runtime test && pnpm --filter @roll-agent/core test`
Expected: 全绿（`ui.test.ts` 若因 home/cwd 假设在非仓库路径挂掉，以仓库内运行为准）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/runtime-host/engine-factory.ts packages/core/src/scheduler-host/run-scheduled-turn.ts packages/core/src/cli/commands/schedule-exec.ts
git commit -m "feat(scheduler): wire the process-group ledger and tree teardown into schedule exec

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 文档与 changeset

**Files:**
- Modify: `docs/how-to-schedule-tasks.md:50`
- Modify: `docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md`（第九轮反驳者补充条目之后、「待拍板」之前插入一条）
- Modify: `.changeset/roll-schedule.md`（POSIX 那条末尾追加）

- [ ] **Step 1: how-to 第 50 行段落**

在「命令若自行再次 `setsid` / daemonize，或 exec 遭外部 SIGKILL / 系统崩溃，仍可能逃离这条协作清理链。」之前插入：

```markdown
**运行结束先清场再落账**（POSIX）：每次运行开始前和写入结果前，exec 会枚举并终止自己拉起的整棵进程树——带 `ROLL_SCHEDULE_INVOCATION` 环境标记的进程、exec 自己进程组里的进程、以及内建 shell 工具每条命令各自的进程组（`&` / `nohup` 留下的后台进程也在内）——先 SIGTERM，2 秒后仍在则 SIGKILL。清干净才写 `completed` / `needs_confirmation` / 失败结果；强制终止后仍有进程存活（罕见：D 状态或无权限）时不写结果、退出码 1，记录保持 `running` 由 daemon / `--inline` 按既有规则收尾，重试前会再次清场，仍清不掉则该次触发用完重试后 `paused` 并附残留 pid。因此定时任务里刻意 `&` 起的服务不会活过本轮；常驻服务请用 `roll agent start`。macOS 只对非 Apple 平台二进制展示环境变量，`/bin/bash`、`/bin/sleep` 这类进程只能通过进程组找到；纯平台二进制且已 `setsid` 离开 shell 工具进程组的守护进程仍是残余边界。Windows 不做清场（沿用只确认根进程的边界）。
```

并把该段里旧句「POSIX 内建 shell 工具仍在自己的独立进程组中；」保留（描述的是取消路径）。

- [ ] **Step 2: spec 2026-08-25 追加条目**

在「- 待拍板（产品取舍，未改）」那一行之前插入：

```markdown
- 第十轮（先清场再落终态；设计见 `2026-08-27-scheduler-settle-before-terminal-design.md`）：成功路径此前在进程树仍存活时就写 `completed` 并释放单例，bash 工具 `&` 留下的后台进程与 MCP 孙进程无人回收且对 `cancel` / `stop` / `uninstall` 不可见。exec 现在在 `runTurn` 前（preflight）与写终态前（settle）各清场一次：树 = env 标记 `ROLL_SCHEDULE_INVOCATION` ∪ exec 自身进程组 ∪ bash 工具登记的进程组（runtime 经 `onShellCommandSpawn` 交出子进程），SIGTERM → 2 s → SIGKILL，清不掉不写终态（新 kind `unsettled`，行保持 running 交给既有收尾），preflight 清不掉直接 `failInvocation` 不跑 turn。账本 / daemon / inline / cancel 零改动；`descendants-alive` 探针保留。实测边界：macOS 26 的 `ps -E` 只对非平台二进制展示 env，平台二进制靠进程组覆盖；`setsid` 后的纯平台二进制守护进程仍为残余；Windows 不清场
```

- [ ] **Step 3: changeset**

在 `.changeset/roll-schedule.md` 里「- POSIX：scheduled exec 收到取消……」那条的末尾追加一句：

```markdown
；scheduled exec 在运行前与写入结果前会清理自己拉起的整棵进程树（env 标记 `ROLL_SCHEDULE_INVOCATION`、exec 进程组、内建 shell 每条命令的进程组，含 `&` / `nohup` 后台进程），SIGTERM 2 秒后升级 SIGKILL，清不干净则不写结果并保持 `running`，重试前再次清场
```

- [ ] **Step 4: 校验 changeset 与格式**

Run: `pnpm changeset status && pnpm prettier --check docs/how-to-schedule-tasks.md .changeset/roll-schedule.md docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md docs/superpowers/specs/2026-08-27-scheduler-settle-before-terminal-design.md docs/superpowers/plans/2026-08-27-scheduler-settle-before-terminal.md`
Expected: 无错误（prettier 报格式问题就 `pnpm prettier --write` 同一组文件）。

- [ ] **Step 5: 提交**

```bash
git add docs/how-to-schedule-tasks.md docs/superpowers/specs/2026-08-25-scheduled-tasks-design.md .changeset/roll-schedule.md
git commit -m "docs(scheduler): describe tree teardown before terminal state and its platform boundaries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: 全量门禁、影响面、对抗性验证

- [ ] **Step 1: 全量门禁**

Run: `pnpm typecheck && pnpm lint && pnpm check:source-control-chars && pnpm test && pnpm test:e2e`
Expected: 全绿。`runtime-server.test.ts`「1.1 Turn timeout」若偶发，隔离重跑一次即可（已知负载抖动）。

- [ ] **Step 2: detect_changes**

Run: `detect_changes({ repo: "roll-agent", scope: "compare", base_ref: "dev" })`（GitNexus 索引过期先 `node .gitnexus/run.cjs analyze`）。
Expected: 受影响执行流全在 scheduler exec / daemon / run-now 与 runtime bash 工具内；风险 HIGH 时向用户说明来自 `executeInvocation` / `ConversationEngine` hub。

- [ ] **Step 3: 重跑本会话探针（对抗）**

探针在 `/private/tmp/claude-501/-Users-rensiwen-Documents-react-projects-Next-PJ-nano-agent/07497deb-6006-4745-a150-af681cf28329/scratchpad/probe-settlement.ts`。它直接调用 Store API 模拟旧 exec 行为，改动后预期**不变**（Store 语义没改）；真正的验证是下面的 exec 级探针：写一个临时脚本 `probe-exec-settle.ts`，用真实 `ScheduleStore` + `executeInvocation` + 真实 `terminateInvocationTree`，`runTurn` 里 `spawn("/bin/sh", ["-c", "/bin/sleep 300 & exit 0"], { detached: true })` 并把 child 交给 ledger，断言：返回 `completed`、`ps -A -o pid=,pgid=` 里不再有该 pgid 的成员、账本 `completed`。再做一个变体：`runTurn` 里 spawn 一个带标记且 `SIGTERM` 被忽略的 node 子进程（`process.on("SIGTERM", () => {})`），断言 SIGKILL 后仍 `completed`。

- [ ] **Step 4: 独立反驳者（Workflow，≤ 5 个 agent）**

三个 lens 各一个反驳者，提示词要求「默认 refuted=true，除非给出 file:line 级证据」：
1. 内核 / 竞态：PID 复用守卫、快照与 kill 之间的窗口、`ps` 自身排除、exec 非首领时的 B 守卫。
2. 账本状态机：`unsettled` 后 daemon `onExit` / `settleInlineInvocation` / `claimDue` reclaim / `cancel` 各格是否仍收敛；preflight 的 retry 计数与 `maxAttempts`；interrupted 路径。
3. 跨平台：Linux `/proc` 解析（comm 含空格 / 括号、EACCES）、macOS 平台二进制、Windows `unsupported`、`env -i`；runtime `onSpawn` 对 `roll chat` 是否零影响。
每条被证实的发现按「本质问题 / blast radius / 更小切口」三步独立判断后再修，修完重跑门禁。

- [ ] **Step 5: 真实环境（需要 `roll.config.yaml` 有可用 LLM）**

```bash
pnpm dev -- schedule add --name settle-probe --every 1h --prompt '用 bash 执行 `nohup /bin/sleep 300 >/dev/null 2>&1 &` ，然后只回复 done' --cwd "$PWD"
pnpm dev -- schedule run-now <schedule-id> --inline
pnpm dev -- schedule runs <schedule-id>
/bin/ps -A -o pid=,pgid=,command= | grep "sleep 300"      # 期望为空
pnpm dev -- schedule remove <schedule-id>
```

Expected：`runs` 显示 `completed`，exec 日志里有「运行结束时终止了 1 个残留进程」，`ps` 无 `sleep 300`。没有 LLM 配置时在汇报里标「需实测」。

- [ ] **Step 6: 汇报**

汇报包含：每个 task 的测试数、门禁结果、detect_changes 摘要、反驳者发现与处置、真实环境结果（或未跑原因）、剩余边界。不 push、不合 dev，等用户拍板。
