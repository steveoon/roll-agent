# roll chat 工作区 AGENTS.md / CLAUDE.md 自动注入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `roll chat` 自动发现工作区最近一层的 `AGENTS.md`（优先）/ `CLAUDE.md`，以独立段落稳定注入 system prompt，每轮按 mtime/size 刷新，超 32 000 字符截断并告警，`chat.instructions: auto | off | <path>` 可关闭或指定。

**Architecture:** 新增 runtime 模块 `workspace-instructions.ts`（发现 + 缓存 + 截断 + issue 回调），`system-prompt.ts` 新增「工作区工程约定」段；`AgentSession` 持有 source，每轮 `send()` 开始用引用比较判断是否重编译 system prompt；`ConversationEngine` 按 config + `process.cwd()` 构造 engine 级 source 并传给所有 session，三入口（REPL / Ink / `--server`）共用；core 侧加 config schema / loader / guidance / banner / README。

**Tech Stack:** TypeScript（Node type stripping，`.ts` import、`import type`、零 `any`、`exactOptionalPropertyTypes`、if/else 必须花括号、核心代码零注释、Prettier 100 列）、node:test + node:assert/strict、zod、Ink。

**Spec:** `docs/superpowers/specs/2026-08-19-chat-workspace-instructions-design.md`

## Global Constraints

- 文件名常量：`["AGENTS.md", "CLAUDE.md"] as const`，同目录 `AGENTS.md` 优先；从 cwd 向上到文件系统根，最近一层命中即停，不合并。
- 上限常量 `WORKSPACE_INSTRUCTIONS_MAX_CHARS = 32_000`；截断保留前 32 000 字符。
- 刷新：每轮 `statSync`（`mtimeMs` + `size`）比对，未变化必须返回**同一对象引用**。
- 告警只走 `onIssue` 回调（CLI 侧 `log.warn` → stderr）；同一 (path, mtimeMs) 截断告警只报一次；同一 (path, 错误信息) 读取/缺失告警只报一次；`auto` 模式下找不到文件零输出。
- 配置键 `chat.instructions`，schema 为普通 `z.string().trim().min(1).default("auto")`；`"auto"` / `"off"` 字面量，其余视为路径（相对 cwd 解析，`~` 由 loader 展开）。
- system prompt 段标题固定 `# 工作区工程约定`，位于 `# 输出` 段之后、「压缩历史回查」与「附加会话指令」之前。
- 不改 Runtime Protocol；不改 Ink 以外的展示（banner 仅加一个 tag）。
- 测试命令：`node --experimental-strip-types --experimental-sqlite --test <file>`；改完文件跑 `npx prettier --write <files>`、`npx eslint <files>`。
- 不要执行 `git restore` / `git checkout -- <file>` / `git reset` / `git stash`（工作树有用户未提交改动：AGENTS.md / CLAUDE.md 的 GitNexus 统计行、roll.config.yaml）。

## 并行建议

Task 1（runtime 模块）、Task 2（system-prompt 段）、Task 4（core config）三者文件互不相交，可并行；Task 3 依赖 1+2；Task 5 依赖 1+3+4；Task 6 依赖 5；Task 7 最后。

---

### Task 1: `workspace-instructions.ts` — 发现、缓存、截断、告警

**Files:**
- Create: `packages/runtime/src/engine/workspace-instructions.ts`
- Test: `packages/runtime/src/engine/workspace-instructions.test.ts`

**Interfaces:**
- Produces: `WORKSPACE_INSTRUCTION_FILE_NAMES`, `WORKSPACE_INSTRUCTIONS_MAX_CHARS`, `WORKSPACE_INSTRUCTIONS_MODES`, `WorkspaceInstructions`, `WorkspaceInstructionsSetting`, `WorkspaceInstructionsSource`, `CreateWorkspaceInstructionsSourceOptions`, `parseWorkspaceInstructionsSetting(value, cwd)`, `findWorkspaceInstructionsPath(cwd)`, `createWorkspaceInstructionsSource(options)`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/runtime/src/engine/workspace-instructions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WORKSPACE_INSTRUCTIONS_MAX_CHARS,
  createWorkspaceInstructionsSource,
  findWorkspaceInstructionsPath,
  parseWorkspaceInstructionsSetting,
} from "./workspace-instructions.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "roll-instructions-"));
}

test("parseWorkspaceInstructionsSetting 区分 auto / off / 路径", () => {
  assert.deepEqual(parseWorkspaceInstructionsSetting("auto", "/w"), { kind: "auto" });
  assert.deepEqual(parseWorkspaceInstructionsSetting(" off ", "/w"), { kind: "off" });
  assert.deepEqual(parseWorkspaceInstructionsSetting("docs/RULES.md", "/w"), {
    kind: "path",
    path: resolve("/w", "docs/RULES.md"),
  });
  assert.deepEqual(parseWorkspaceInstructionsSetting("/abs/RULES.md", "/w"), {
    kind: "path",
    path: resolve("/abs/RULES.md"),
  });
});

test("findWorkspaceInstructionsPath 同目录 AGENTS.md 优先于 CLAUDE.md", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "claude\n");
    writeFileSync(join(dir, "AGENTS.md"), "agents\n");
    assert.equal(findWorkspaceInstructionsPath(dir), join(dir, "AGENTS.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWorkspaceInstructionsPath 只有 CLAUDE.md 时选它，并向上查找最近一层", () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "AGENTS.md"), "root agents\n");
    const mid = join(root, "mid");
    const leaf = join(mid, "leaf");
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(mid, "CLAUDE.md"), "mid claude\n");
    assert.equal(findWorkspaceInstructionsPath(leaf), join(mid, "CLAUDE.md"));
    assert.equal(findWorkspaceInstructionsPath(mid), join(mid, "CLAUDE.md"));
    assert.equal(findWorkspaceInstructionsPath(root), join(root, "AGENTS.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findWorkspaceInstructionsPath 目录是文件名同名目录时跳过", () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, "AGENTS.md"));
    assert.equal(findWorkspaceInstructionsPath(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 在 auto 模式下返回内容，未变化时返回同一引用，变化后重读", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "rule one\n");
    const issues: string[] = [];
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "auto" },
      onIssue: (message) => issues.push(message),
    });
    const first = source.current();
    assert.ok(first);
    assert.equal(first.path, path);
    assert.equal(first.content, "rule one");
    assert.equal(first.truncated, false);
    assert.equal(first.totalChars, "rule one".length);
    assert.equal(source.current(), first);

    writeFileSync(path, "rule one\nrule two\n");
    utimesSync(path, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    const second = source.current();
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(second.content, "rule one\nrule two");
    assert.deepEqual(issues, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 文件消失后返回 undefined，重新出现后再次注入", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "CLAUDE.md");
    writeFileSync(path, "rules\n");
    const source = createWorkspaceInstructionsSource({ cwd: dir, setting: { kind: "auto" } });
    assert.ok(source.current());
    rmSync(path);
    assert.equal(source.current(), undefined);
    writeFileSync(path, "rules again\n");
    assert.equal(source.current()?.content, "rules again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 空文件视为没有约定，不告警", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "\n  \n");
    const issues: string[] = [];
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "auto" },
      onIssue: (message) => issues.push(message),
    });
    assert.equal(source.current(), undefined);
    assert.deepEqual(issues, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 超过上限时截断并只告警一次", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "x".repeat(50));
    const issues: string[] = [];
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "auto" },
      maxChars: 20,
      onIssue: (message) => issues.push(message),
    });
    const value = source.current();
    assert.ok(value);
    assert.equal(value.truncated, true);
    assert.equal(value.content, "x".repeat(20));
    assert.equal(value.totalChars, 50);
    source.current();
    source.current();
    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? "", /共 50 字符/u);
    assert.match(issues[0] ?? "", /超过上限 20/u);
    assert.match(issues[0] ?? "", /请精简该文件/u);
    assert.ok(issues[0]?.includes(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("默认上限为 32000 字符", () => {
  assert.equal(WORKSPACE_INSTRUCTIONS_MAX_CHARS, 32_000);
});

test("source.current() 显式路径缺失时告警一次并返回 undefined，文件出现后生效", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "docs", "RULES.md");
    const issues: string[] = [];
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "path", path },
      onIssue: (message) => issues.push(message),
    });
    assert.equal(source.current(), undefined);
    assert.equal(source.current(), undefined);
    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? "", /chat\.instructions/u);
    assert.ok(issues[0]?.includes(path));
    mkdirSync(join(dir, "docs"));
    writeFileSync(path, "explicit rules\n");
    assert.equal(source.current()?.content, "explicit rules");
    assert.equal(issues.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 显式路径优先于 auto 发现", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "auto rules\n");
    const explicit = join(dir, "RULES.md");
    writeFileSync(explicit, "explicit rules\n");
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "path", path: explicit },
    });
    assert.equal(source.current()?.path, explicit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source.current() 在 off 模式下永远返回 undefined", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "rules\n");
    const issues: string[] = [];
    const source = createWorkspaceInstructionsSource({
      cwd: dir,
      setting: { kind: "off" },
      onIssue: (message) => issues.push(message),
    });
    assert.equal(source.current(), undefined);
    assert.deepEqual(issues, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/workspace-instructions.test.ts`
Expected: 失败（模块不存在）。

- [ ] **Step 3: 实现模块**

```ts
// packages/runtime/src/engine/workspace-instructions.ts
import { readFileSync, statSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WORKSPACE_INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
export const WORKSPACE_INSTRUCTIONS_MAX_CHARS = 32_000;
export const WORKSPACE_INSTRUCTIONS_MODES = { auto: "auto", off: "off" } as const;

export type WorkspaceInstructionsMode =
  (typeof WORKSPACE_INSTRUCTIONS_MODES)[keyof typeof WORKSPACE_INSTRUCTIONS_MODES];

export interface WorkspaceInstructions {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly totalChars: number;
}

export type WorkspaceInstructionsSetting =
  | { readonly kind: typeof WORKSPACE_INSTRUCTIONS_MODES.auto }
  | { readonly kind: typeof WORKSPACE_INSTRUCTIONS_MODES.off }
  | { readonly kind: "path"; readonly path: string };

export interface WorkspaceInstructionsSource {
  current(): WorkspaceInstructions | undefined;
}

export interface CreateWorkspaceInstructionsSourceOptions {
  readonly cwd: string;
  readonly setting: WorkspaceInstructionsSetting;
  readonly maxChars?: number;
  readonly onIssue?: (message: string) => void;
}

interface CachedWorkspaceInstructions {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly value: WorkspaceInstructions | undefined;
}

export function parseWorkspaceInstructionsSetting(
  value: string,
  cwd: string,
): WorkspaceInstructionsSetting {
  const trimmed = value.trim();
  if (trimmed === WORKSPACE_INSTRUCTIONS_MODES.auto) {
    return { kind: WORKSPACE_INSTRUCTIONS_MODES.auto };
  }
  if (trimmed === WORKSPACE_INSTRUCTIONS_MODES.off) {
    return { kind: WORKSPACE_INSTRUCTIONS_MODES.off };
  }
  return { kind: "path", path: resolve(cwd, trimmed) };
}

function statFile(path: string): Stats | undefined {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats : undefined;
  } catch {
    return undefined;
  }
}

export function findWorkspaceInstructionsPath(cwd: string): string | undefined {
  let dir = resolve(cwd);
  while (true) {
    for (const name of WORKSPACE_INSTRUCTION_FILE_NAMES) {
      const candidate = join(dir, name);
      if (statFile(candidate) !== undefined) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildWorkspaceInstructions(
  path: string,
  raw: string,
  maxChars: number,
): WorkspaceInstructions | undefined {
  const text = raw.trim();
  if (text.length === 0) {
    return undefined;
  }
  if (text.length <= maxChars) {
    return { path, content: text, truncated: false, totalChars: text.length };
  }
  return { path, content: text.slice(0, maxChars), truncated: true, totalChars: text.length };
}

export function createWorkspaceInstructionsSource(
  options: CreateWorkspaceInstructionsSourceOptions,
): WorkspaceInstructionsSource {
  const maxChars = options.maxChars ?? WORKSPACE_INSTRUCTIONS_MAX_CHARS;
  const reported = new Set<string>();
  let cached: CachedWorkspaceInstructions | undefined;

  const report = (key: string, message: string): void => {
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    options.onIssue?.(message);
  };

  const resolvePath = (): string | undefined => {
    switch (options.setting.kind) {
      case WORKSPACE_INSTRUCTIONS_MODES.off:
        return undefined;
      case "path":
        return options.setting.path;
      default:
        return findWorkspaceInstructionsPath(options.cwd);
    }
  };

  return {
    current(): WorkspaceInstructions | undefined {
      const path = resolvePath();
      if (path === undefined) {
        cached = undefined;
        return undefined;
      }
      let stats: Stats;
      try {
        stats = statSync(path);
      } catch (error) {
        cached = undefined;
        if (options.setting.kind === "path") {
          const message = errorText(error);
          report(
            `missing:${path}:${message}`,
            `chat.instructions 指向的文件不可读：${path}（${message}）`,
          );
        }
        return undefined;
      }
      if (!stats.isFile()) {
        cached = undefined;
        if (options.setting.kind === "path") {
          report(`not-file:${path}`, `chat.instructions 指向的路径不是文件：${path}`);
        }
        return undefined;
      }
      if (
        cached !== undefined &&
        cached.path === path &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.size === stats.size
      ) {
        return cached.value;
      }
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (error) {
        cached = undefined;
        const message = errorText(error);
        report(`read:${path}:${message}`, `工作区约定 ${path} 读取失败：${message}`);
        return undefined;
      }
      const value = buildWorkspaceInstructions(path, raw, maxChars);
      if (value?.truncated === true) {
        report(
          `truncated:${path}:${String(stats.mtimeMs)}`,
          `工作区约定 ${path} 共 ${String(value.totalChars)} 字符，超过上限 ${String(maxChars)}，仅注入前 ${String(maxChars)} 字符，请精简该文件`,
        );
      }
      cached = { path, mtimeMs: stats.mtimeMs, size: stats.size, value };
      return value;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过；prettier + eslint**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/workspace-instructions.test.ts && npx prettier --write packages/runtime/src/engine/workspace-instructions.ts packages/runtime/src/engine/workspace-instructions.test.ts && npx eslint packages/runtime/src/engine/workspace-instructions.ts packages/runtime/src/engine/workspace-instructions.test.ts`
Expected: 12 pass；lint 无输出。

- [ ] **Step 5: 导出（runtime index）**

在 `packages/runtime/src/index.ts` 紧跟 `export type { SessionAttachment, SessionSendInput } from "./engine/session-attachments.ts";` 之后追加：

```ts
export {
  WORKSPACE_INSTRUCTION_FILE_NAMES,
  WORKSPACE_INSTRUCTIONS_MAX_CHARS,
  WORKSPACE_INSTRUCTIONS_MODES,
  createWorkspaceInstructionsSource,
  findWorkspaceInstructionsPath,
  parseWorkspaceInstructionsSetting,
} from "./engine/workspace-instructions.ts";
export type {
  WorkspaceInstructions,
  WorkspaceInstructionsSetting,
  WorkspaceInstructionsSource,
} from "./engine/workspace-instructions.ts";
```

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/engine/workspace-instructions.ts packages/runtime/src/engine/workspace-instructions.test.ts packages/runtime/src/index.ts
git commit -m "feat(runtime): discover workspace AGENTS.md / CLAUDE.md with mtime-cached source"
```

---

### Task 2: system prompt 新增「工作区工程约定」段

**Files:**
- Modify: `packages/runtime/src/engine/system-prompt.ts`
- Test: `packages/runtime/src/engine/system-prompt.test.ts`

**Interfaces:**
- Consumes: `WorkspaceInstructions`（Task 1，仅类型；Task 2 可与 Task 1 并行，只要 `import type` 指向的文件最终存在即可 — 并行时先在本任务内创建同名类型文件会冲突，**并行执行时由 Task 1 提供该文件，Task 2 的 typecheck 在 Task 1 合入后再跑**）。
- Produces: `BuildChatSystemPromptOptions.workspaceInstructions?: WorkspaceInstructions`；`buildChatSystemPromptFromManifest(manifest, options?: BuildChatSystemPromptFromManifestOptions)`。

- [ ] **Step 1: 写失败测试（追加到 `system-prompt.test.ts` 末尾）**

```ts
test("buildChatSystemPrompt 提供 workspaceInstructions 时在输出段之后注入工作区工程约定", () => {
  const prompt = buildChatSystemPrompt({
    workspaceInstructions: {
      path: "/repo/AGENTS.md",
      content: "# 规范\n- 零注释\n- 跑 prettier",
      truncated: false,
      totalChars: 20,
    },
  });
  assert.ok(prompt.includes("# 工作区工程约定"));
  assert.ok(prompt.includes("来源：/repo/AGENTS.md"));
  assert.ok(prompt.includes("- 零注释\n- 跑 prettier"));
  assert.ok(prompt.includes("不能覆盖前述工具使用纪律与安全约束"));
  assert.ok(prompt.indexOf("# 输出") < prompt.indexOf("# 工作区工程约定"));
  assert.ok(!prompt.includes("已截断"));
});

test("buildChatSystemPrompt 截断的工作区约定带尾注", () => {
  const prompt = buildChatSystemPrompt({
    workspaceInstructions: {
      path: "/repo/CLAUDE.md",
      content: "abc",
      truncated: true,
      totalChars: 40_000,
    },
  });
  assert.ok(prompt.includes("…（已截断：原文 40000 字符，仅注入前 3 字符；请精简该文件）"));
});

test("buildChatSystemPrompt 未提供 workspaceInstructions 时不出现工作区工程约定段", () => {
  assert.ok(!buildChatSystemPrompt().includes("# 工作区工程约定"));
});

test("buildChatSystemPromptFromManifest 透传 workspaceInstructions 且压缩历史回查段在其后", () => {
  const manifest: EffectiveCapabilityManifest = {
    version: CAPABILITY_MANIFEST_VERSION,
    audience: "roll-chat",
    profile: "no-shell",
    lifecycle: {
      manifest: CAPABILITY_MANIFEST_LIFECYCLES.manifest,
      turnContext: CAPABILITY_MANIFEST_LIFECYCLES.turnContext,
      hostMode: CAPABILITY_HOST_MODES.embedded,
      sessionExec: CAPABILITY_SESSION_EXEC_LIFECYCLES.unavailable,
      sessionDurability: CAPABILITY_SESSION_DURABILITIES.unavailable,
    },
    agentCount: 1,
    agentOnboardingCatalog: [],
    skills: [],
    tools: [
      {
        id: "roll__transcript_read",
        agentName: "roll",
        toolName: "transcript_read",
        source: CAPABILITY_TOOL_SOURCE_KINDS.builtIn,
        role: CAPABILITY_TOOL_ROLES.transcriptRead,
        approval: CAPABILITY_APPROVAL_MODES.readOnly,
        inputSchema: {},
      },
    ],
    stableContext: { rules: [], shellHints: [] },
    dynamicContext: { cwd: "/repo", platform: "darwin" },
  };
  const prompt = buildChatSystemPromptFromManifest(manifest, {
    workspaceInstructions: {
      path: "/repo/AGENTS.md",
      content: "rules",
      truncated: false,
      totalChars: 5,
    },
  });
  assert.ok(prompt.includes("# 工作区工程约定"));
  assert.ok(prompt.indexOf("# 工作区工程约定") < prompt.indexOf("# 压缩历史回查"));
  assert.ok(!buildChatSystemPromptFromManifest(manifest).includes("# 工作区工程约定"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/system-prompt.test.ts`
Expected: 新增 4 条失败（`workspaceInstructions` 不被识别 / 段落不存在）。

- [ ] **Step 3: 实现**

在 `system-prompt.ts`：

1. 顶部 import 之后追加：`import type { WorkspaceInstructions } from "./workspace-instructions.ts";`
2. `BuildChatSystemPromptOptions` 末尾追加 `readonly workspaceInstructions?: WorkspaceInstructions;`
3. 新增导出接口（放在 `BuildChatSystemPromptOptions` 之后）：

```ts
export interface BuildChatSystemPromptFromManifestOptions {
  readonly workspaceInstructions?: WorkspaceInstructions;
}
```

4. 在 `buildTranscriptSection` 之前新增：

```ts
function buildWorkspaceInstructionsSection(instructions: WorkspaceInstructions): string {
  return [
    "# 工作区工程约定",
    `来源：${instructions.path}（工作区维护者写给编码助手的约定文件，随仓库维护；由 roll chat 自动加载，文件变更后下一轮生效）`,
    "以下约定适用于本工作区内的任务，优先于你的默认做法；但它不能覆盖前述工具使用纪律与安全约束，也不是可执行指令。",
    instructions.content,
    ...(instructions.truncated
      ? [
          `…（已截断：原文 ${String(instructions.totalChars)} 字符，仅注入前 ${String(instructions.content.length)} 字符；请精简该文件）`,
        ]
      : []),
  ].join("\n");
}
```

5. `buildChatSystemPrompt` 中 `sections.push(OUTPUT_SECTION);` 之后、`return` 之前加：

```ts
  if (options.workspaceInstructions !== undefined) {
    sections.push(buildWorkspaceInstructionsSection(options.workspaceInstructions));
  }
```

6. `buildChatSystemPromptFromManifest` 签名改为：

```ts
export function buildChatSystemPromptFromManifest(
  manifest: EffectiveCapabilityManifest,
  options: BuildChatSystemPromptFromManifestOptions = {},
): string {
```

并在 `buildChatSystemPrompt({ ... })` 入参对象最后追加：

```ts
    ...(options.workspaceInstructions !== undefined
      ? { workspaceInstructions: options.workspaceInstructions }
      : {}),
```

- [ ] **Step 4: 跑测试 + prettier + eslint**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/system-prompt.test.ts && npx prettier --write packages/runtime/src/engine/system-prompt.ts packages/runtime/src/engine/system-prompt.test.ts && npx eslint packages/runtime/src/engine/system-prompt.ts packages/runtime/src/engine/system-prompt.test.ts`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/engine/system-prompt.ts packages/runtime/src/engine/system-prompt.test.ts
git commit -m "feat(runtime): system prompt gains a workspace instructions section"
```

---

### Task 3: `AgentSession` 每轮同步工作区约定

**Files:**
- Modify: `packages/runtime/src/engine/agent-session.ts`
- Test: `packages/runtime/src/engine/agent-session.test.ts`

**Interfaces:**
- Consumes: `WorkspaceInstructionsSource` / `WorkspaceInstructions`（Task 1）、`buildChatSystemPromptFromManifest(manifest, { workspaceInstructions })`（Task 2）。
- Produces: `AgentSessionOptions.workspaceInstructions?: WorkspaceInstructionsSource`。

- [ ] **Step 1: 写失败测试（追加到 `agent-session.test.ts` 末尾）**

```ts
test("AgentSession 把工作区约定注入 system prompt，文件变化后下一轮重编译", async () => {
  const captured: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const first = options.prompt[0];
      captured.push(first && first.role === "system" ? first.content : "");
      return streamChunks(textStep("ok"));
    },
  });
  let version = 0;
  let current = { path: "/repo/AGENTS.md", content: "rule v0", truncated: false, totalChars: 7 };
  const session = new AgentSession({
    id: "ws-1",
    model,
    sources: [],
    maxSteps: 2,
    systemPrompt: "EXTRA_PROMPT",
    workspaceInstructions: {
      current: () => {
        if (version === 1 && current.content === "rule v0") {
          current = { path: "/repo/AGENTS.md", content: "rule v1", truncated: false, totalChars: 7 };
        }
        return current;
      },
    },
  });

  await collect(session.send("one"));
  assert.match(captured[0] ?? "", /# 工作区工程约定/u);
  assert.match(captured[0] ?? "", /来源：\/repo\/AGENTS\.md/u);
  assert.match(captured[0] ?? "", /rule v0/u);
  assert.ok((captured[0] ?? "").indexOf("# 工作区工程约定") < (captured[0] ?? "").indexOf("# 附加会话指令"));
  assert.match(captured[0] ?? "", /EXTRA_PROMPT/u);

  await collect(session.send("two"));
  assert.match(captured[1] ?? "", /rule v0/u);

  version = 1;
  await collect(session.send("three"));
  assert.match(captured[2] ?? "", /rule v1/u);
  assert.doesNotMatch(captured[2] ?? "", /rule v0/u);
  assert.match(captured[2] ?? "", /EXTRA_PROMPT/u);
});

test("AgentSession 工作区约定在自动压缩后的下一轮仍在 system prompt 中", async () => {
  const captured: string[] = [];
  let index = 0;
  const steps = [textStep("a"), textStep("b"), textStep("c"), textStep("d")];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const first = options.prompt[0];
      captured.push(first && first.role === "system" ? first.content : "");
      const chunks = steps[index] ?? steps[steps.length - 1] ?? [];
      index += 1;
      return streamChunks(chunks);
    },
  });
  const session = new AgentSession({
    id: "ws-compact",
    model,
    sources: [],
    maxSteps: 2,
    contextWindow: 1,
    compaction: {
      enabled: true,
      strategy: "truncate",
      threshold: 0.75,
      keepRecentTurns: 1,
      keepRecentTokens: 1,
    },
    workspaceInstructions: {
      current: () => ({ path: "/repo/CLAUDE.md", content: "keep me", truncated: false, totalChars: 7 }),
    },
  });

  await collect(session.send("t1"));
  await collect(session.send("t2"));
  const events = await collect(session.send("t3"));
  assert.ok(events.some((event) => event.type === "context-compacted"));
  await collect(session.send("t4"));
  assert.match(captured.at(-1) ?? "", /# 工作区工程约定/u);
  assert.match(captured.at(-1) ?? "", /keep me/u);
});

test("AgentSession 工作区约定源返回 undefined 时不注入该段", async () => {
  let capturedSystem = "";
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const first = options.prompt[0];
      capturedSystem = first && first.role === "system" ? first.content : "";
      return streamChunks(textStep("ok"));
    },
  });
  const session = new AgentSession({
    id: "ws-none",
    model,
    sources: [],
    maxSteps: 2,
    workspaceInstructions: { current: () => undefined },
  });
  await collect(session.send("hi"));
  assert.doesNotMatch(capturedSystem, /# 工作区工程约定/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/agent-session.test.ts 2>&1 | tail -30`
Expected: 新增 3 条失败（`workspaceInstructions` 选项不存在 → 类型/运行时不注入）。

- [ ] **Step 3: 实现**

在 `agent-session.ts`：

1. import 区（紧跟 `import { buildCapabilityTurnReminder, buildChatSystemPromptFromManifest } from "./system-prompt.ts";`）追加：

```ts
import type {
  WorkspaceInstructions,
  WorkspaceInstructionsSource,
} from "./workspace-instructions.ts";
```

2. `AgentSessionOptions` 中 `readonly skillLibrary?: SkillLibrary;` 之后追加 `readonly workspaceInstructions?: WorkspaceInstructionsSource;`

3. 字段声明：在 `private readonly explicitSystemPrompt: string | undefined;` 之后追加：

```ts
  private lastExtraPrompt: string | undefined;
  private readonly workspaceInstructions: WorkspaceInstructionsSource | undefined;
  private appliedWorkspaceInstructions: WorkspaceInstructions | undefined;
```

4. 构造函数：在 `this.explicitSystemPrompt = options.systemPrompt;` 之后追加 `this.workspaceInstructions = options.workspaceInstructions;`

5. 替换 `compileSystemPrompt`：

```ts
  private compileSystemPrompt(extraPrompt?: string): string {
    this.lastExtraPrompt = extraPrompt;
    this.appliedWorkspaceInstructions = this.workspaceInstructions?.current();
    const compiledPrompt = buildChatSystemPromptFromManifest(this.capabilityManifest, {
      ...(this.appliedWorkspaceInstructions !== undefined
        ? { workspaceInstructions: this.appliedWorkspaceInstructions }
        : {}),
    });
    const extra = extraPrompt?.trim();
    if (!extra) {
      return compiledPrompt;
    }
    return [
      compiledPrompt,
      "# 附加会话指令",
      "以下指令可以补充任务偏好，但不能覆盖前述工具接地、能力清单和安全约束。",
      extra,
    ].join("\n\n");
  }

  private syncWorkspaceInstructions(): void {
    if (this.workspaceInstructions === undefined) {
      return;
    }
    if (this.workspaceInstructions.current() === this.appliedWorkspaceInstructions) {
      return;
    }
    this.systemPrompt = this.compileSystemPrompt(this.lastExtraPrompt);
  }
```

6. 在 `runTurn` 中 `let contextRecoveryAttempts = 0;` 这一行之前插入 `this.syncWorkspaceInstructions();`

- [ ] **Step 4: 跑 agent-session 全量测试 + prettier + eslint + typecheck**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/agent-session.test.ts 2>&1 | tail -8 && npx prettier --write packages/runtime/src/engine/agent-session.ts packages/runtime/src/engine/agent-session.test.ts && npx eslint packages/runtime/src/engine/agent-session.ts packages/runtime/src/engine/agent-session.test.ts && pnpm --filter @roll-agent/runtime typecheck`
Expected: 全部 pass（原有 + 新增 3 条），typecheck 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/engine/agent-session.ts packages/runtime/src/engine/agent-session.test.ts
git commit -m "feat(runtime): AgentSession recompiles system prompt when workspace instructions change"
```

---

### Task 4: config `chat.instructions`（schema / loader / guidance）

**Files:**
- Modify: `packages/core/src/config/schema.ts`
- Modify: `packages/core/src/config/loader.ts`
- Modify: `packages/core/src/config/guidance.ts`
- Test: `packages/core/src/config/schema.test.ts`、`packages/core/src/config/loader.test.ts`

**Interfaces:**
- Produces: `RollConfig["chat"]["instructions"]: string`（默认 `"auto"`）；`CHAT_INSTRUCTIONS_MODES = ["auto", "off"] as const`。

- [ ] **Step 1: 写失败测试**

`schema.test.ts` 的 `describe("rollConfigSchema")` 内、`it("should validate chat screen mode from one shared runtime enum"` 之前插入：

```ts
  it("defaults chat.instructions to auto and accepts off or a path", () => {
    assert.equal(DEFAULT_CONFIG.chat.instructions, "auto");
    for (const value of ["auto", "off", "docs/RULES.md", "~/rules.md"]) {
      const result = rollConfigSchema.safeParse({
        llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
        ask: {},
        agents: { dataDir: "~/.roll-agent/agents" },
        chat: { instructions: value },
      });
      assert.equal(result.success, true, value);
      assert.equal(result.success ? result.data.chat.instructions : undefined, value);
    }
    const empty = rollConfigSchema.safeParse({
      llm: { defaultProvider: "x", defaultModel: "y", providers: {} },
      ask: {},
      agents: { dataDir: "~/.roll-agent/agents" },
      chat: { instructions: "   " },
    });
    assert.equal(empty.success, false);
  });
```

`loader.test.ts` 在 `it("should expand tilde in dataDir"` 之后插入：

```ts
  it("expands tilde in chat.instructions path but keeps auto / off literal", () => {
    const base = `
llm:
  default-provider: anthropic
  default-model: test
  providers: {}
agents:
  data-dir: ~/my-agents
`;
    writeFileSync(resolve(tmpDir, "roll.config.yaml"), `${base}chat:\n  instructions: ~/rules.md\n`);
    const expanded = loadConfig({ cwd: tmpDir }).config.chat.instructions;
    assert.ok(!expanded.startsWith("~"));
    assert.ok(expanded.endsWith("rules.md"));

    writeFileSync(resolve(tmpDir, "roll.config.yaml"), `${base}chat:\n  instructions: off\n`);
    assert.equal(loadConfig({ cwd: tmpDir }).config.chat.instructions, "off");

    writeFileSync(resolve(tmpDir, "roll.config.yaml"), base);
    assert.equal(loadConfig({ cwd: tmpDir }).config.chat.instructions, "auto");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/config/schema.test.ts packages/core/src/config/loader.test.ts 2>&1 | tail -20`
Expected: 新增 2 条失败。

- [ ] **Step 3: 实现**

`schema.ts`：

1. `export const CHAT_THINKING_DISPLAY_MODES = [...]` 之后追加：`export const CHAT_INSTRUCTIONS_MODES = ["auto", "off"] as const;`
2. `chatConfigSchema` 的 `thinkingDisplay` 之后追加：

```ts
  /**
   * 工作区工程约定注入：`auto` 自动发现 AGENTS.md / CLAUDE.md，`off` 关闭，
   * 其余值视为约定文件路径（相对 roll chat 工作目录，支持 `~`）。
   */
  instructions: z.string().trim().min(1).default("auto"),
```

`loader.ts` `expandPaths`：在 `runtime: {...}` 之前加：

```ts
    chat: {
      ...config.chat,
      instructions: expandChatInstructions(config.chat.instructions),
    },
```

并在 `expandPaths` 之前新增：

```ts
function expandChatInstructions(value: string): string {
  return value === "auto" || value === "off" ? value : expandTilde(value);
}
```

（`loader.ts` 已有 `expandTilde`；若 `schema.ts` 的 `CHAT_INSTRUCTIONS_MODES` 已导入可用 `(CHAT_INSTRUCTIONS_MODES as readonly string[]).includes(value)`，两种写法皆可，保持零注释。）

`guidance.ts`：在 `chat.thinking-display` 条目之后追加：

```ts
  {
    path: "chat.instructions",
    title: "工作区工程约定注入",
    purpose:
      "控制 `roll chat` 是否把工作区的 AGENTS.md / CLAUDE.md 作为工程约定注入 system prompt：`auto` 从工作目录逐级向上找最近一层（同目录 AGENTS.md 优先），`off` 关闭，其他值视为约定文件路径（相对工作目录，支持 `~`）。",
    defaultBehavior:
      "默认值为 `auto`；找不到文件时不注入也不提示。文件超过 32000 字符会被截断并在 stderr 提示一次；每轮开始按修改时间检查变化。",
    example: `chat:\n  instructions: ${DEFAULT_CONFIG.chat.instructions}`,
  },
```

- [ ] **Step 4: 跑 config 相关测试 + catalog 测试 + prettier + eslint + typecheck**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/config/schema.test.ts packages/core/src/config/loader.test.ts packages/core/src/config/catalog.test.ts 2>&1 | tail -8 && npx prettier --write packages/core/src/config/schema.ts packages/core/src/config/loader.ts packages/core/src/config/guidance.ts packages/core/src/config/schema.test.ts packages/core/src/config/loader.test.ts && npx eslint packages/core/src/config/schema.ts packages/core/src/config/loader.ts packages/core/src/config/guidance.ts && pnpm --filter @roll-agent/core typecheck`
Expected: 全部 pass（catalog 测试要求每个 leaf 有 guidance，新条目即为此）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/config/loader.ts packages/core/src/config/guidance.ts packages/core/src/config/schema.test.ts packages/core/src/config/loader.test.ts
git commit -m "feat(core): add chat.instructions config (auto | off | path)"
```

---

### Task 5: `ConversationEngine` 接线 + `getContextSummary().instructionsPath`

**Files:**
- Modify: `packages/runtime/src/engine/conversation-engine.ts`
- Test: `packages/runtime/src/engine/conversation-engine.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `createWorkspaceInstructionsSource` / `parseWorkspaceInstructionsSetting` / `WorkspaceInstructionsSource`；Task 3 的 `AgentSessionOptions.workspaceInstructions`；Task 4 的 `config.chat.instructions`。
- Produces: `ConversationEngineOptions.workspaceInstructions?: WorkspaceInstructionsSource | null`、`ConversationEngineOptions.onWorkspaceInstructionsIssue?: (message: string) => void`、`EngineContextSummary.instructionsPath?: string`。

- [ ] **Step 1: 写失败测试（追加到 `conversation-engine.test.ts` 末尾）**

```ts
function engineConfigWithInstructions(instructions: string) {
  return rollConfigSchema.parse({
    llm: {
      defaultProvider: "mock",
      defaultModel: "default-model",
      providers: { mock: { apiKey: "test" } },
    },
    ask: {},
    agents: { dataDir: "/tmp/roll-engine-test" },
    chat: { instructions },
  });
}

function capturingModel(captured: Array<{ readonly role: string; readonly content: unknown }>) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      captured.push(...options.prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] } as const,
            { type: "text-start", id: "t" } as const,
            { type: "text-delta", id: "t", delta: "ok" } as const,
            { type: "text-end", id: "t" } as const,
            {
              type: "finish",
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              finishReason: { unified: "stop", raw: "stop" },
            } as const,
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

test("ConversationEngine 把显式 workspaceInstructions source 注入 session system prompt 并暴露 instructionsPath", async () => {
  const captured: Array<{ readonly role: string; readonly content: unknown }> = [];
  const engine = new ConversationEngine({
    config: engineConfigWithInstructions("auto"),
    model: capturingModel(captured),
    sources: [],
    skillLibrary: null,
    workspaceInstructions: {
      current: () => ({
        path: "/repo/AGENTS.md",
        content: "engine rules",
        truncated: false,
        totalChars: 12,
      }),
    },
  });
  const summary = await engine.getContextSummary();
  assert.equal(summary.instructionsPath, "/repo/AGENTS.md");
  const session = await engine.createSession();
  await drain(session.send("hi"));
  const system = captured.find((message) => message.role === "system");
  assert.ok(system);
  assert.ok(String(system.content).includes("# 工作区工程约定"));
  assert.ok(String(system.content).includes("engine rules"));
  await engine.dispose();
});

test("ConversationEngine workspaceInstructions 为 null 或 config off 时不注入", async () => {
  for (const variant of ["null", "off"] as const) {
    const captured: Array<{ readonly role: string; readonly content: unknown }> = [];
    const engine = new ConversationEngine({
      config: engineConfigWithInstructions(variant === "off" ? "off" : "auto"),
      model: capturingModel(captured),
      sources: [],
      skillLibrary: null,
      ...(variant === "null" ? { workspaceInstructions: null } : {}),
    });
    const summary = await engine.getContextSummary();
    assert.equal(summary.instructionsPath, undefined, variant);
    const session = await engine.createSession();
    await drain(session.send("hi"));
    const system = captured.find((message) => message.role === "system");
    assert.ok(system, variant);
    assert.ok(!String(system.content).includes("# 工作区工程约定"), variant);
    await engine.dispose();
  }
});

test("ConversationEngine 按 config 构造 source 时把告警转给 onWorkspaceInstructionsIssue", async () => {
  const dir = tempDir();
  try {
    const missing = join(dir, "nope.md");
    const issues: string[] = [];
    const engine = new ConversationEngine({
      config: engineConfigWithInstructions(missing),
      model: new MockLanguageModelV4({}),
      sources: [],
      skillLibrary: null,
      onWorkspaceInstructionsIssue: (message) => issues.push(message),
    });
    const summary = await engine.getContextSummary();
    assert.equal(summary.instructionsPath, undefined);
    assert.equal(issues.length, 1);
    assert.ok(issues[0]?.includes(missing));
    await engine.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

（`tempDir`、`drain`、`rollConfigSchema`、`MockLanguageModelV4`、`simulateReadableStream`、`join`、`rmSync` 该测试文件已有导入；若 `join` / `rmSync` 缺失则补 `import { join } from "node:path"` / 在现有 `node:fs` import 中加 `rmSync`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/conversation-engine.test.ts 2>&1 | tail -30`
Expected: 新增 3 条失败。

- [ ] **Step 3: 实现**

`conversation-engine.ts`：

1. import：在 `import { resolveContextWindow } from "./context-window.ts";` 之后追加：

```ts
import {
  createWorkspaceInstructionsSource,
  parseWorkspaceInstructionsSetting,
  type WorkspaceInstructionsSource,
} from "./workspace-instructions.ts";
```

2. `ConversationEngineOptions`：在 `readonly onSkillLibraryIssue?: (message: string) => void;` 之后追加：

```ts
  readonly workspaceInstructions?: WorkspaceInstructionsSource | null;
  readonly onWorkspaceInstructionsIssue?: (message: string) => void;
```

3. `EngineContextSummary` 追加 `readonly instructionsPath?: string;`

4. 字段：在 `private readonly onSkillLibraryIssue: ...` 之后追加 `private readonly workspaceInstructions: WorkspaceInstructionsSource | undefined;`

5. 构造函数：在 `this.onSkillLibraryIssue = options.onSkillLibraryIssue;` 之后追加 `this.workspaceInstructions = resolveWorkspaceInstructionsSource(options);`

6. 在 `export class ConversationEngine` 之前新增模块级函数：

```ts
function resolveWorkspaceInstructionsSource(
  options: ConversationEngineOptions,
): WorkspaceInstructionsSource | undefined {
  if (options.workspaceInstructions === null) {
    return undefined;
  }
  if (options.workspaceInstructions !== undefined) {
    return options.workspaceInstructions;
  }
  const cwd = process.cwd();
  return createWorkspaceInstructionsSource({
    cwd,
    setting: parseWorkspaceInstructionsSetting(options.config.chat.instructions, cwd),
    ...(options.onWorkspaceInstructionsIssue
      ? { onIssue: options.onWorkspaceInstructionsIssue }
      : {}),
  });
}
```

7. `buildSession` 里 `new AgentSession({ ... })` 的 `...(skillLibrary ? { skillLibrary } : {}),` 之后追加：

```ts
      ...(this.workspaceInstructions ? { workspaceInstructions: this.workspaceInstructions } : {}),
```

8. `getContextSummary()`：

```ts
  async getContextSummary(): Promise<EngineContextSummary> {
    const context = await this.ensureReady();
    this.assertAcceptingSessions();
    const instructionsPath = this.workspaceInstructions?.current()?.path;
    return {
      agentCount: context.sources.length,
      toolCount: context.sources.reduce((total, source) => total + source.tools.length, 0),
      skillCount: context.skillLibrary?.list().length ?? 0,
      ...(instructionsPath !== undefined ? { instructionsPath } : {}),
    };
  }
```

- [ ] **Step 4: 跑 engine 测试 + runtime 全量 + prettier + eslint + typecheck**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/conversation-engine.test.ts 2>&1 | tail -8 && npx prettier --write packages/runtime/src/engine/conversation-engine.ts packages/runtime/src/engine/conversation-engine.test.ts && npx eslint packages/runtime/src/engine/conversation-engine.ts packages/runtime/src/engine/conversation-engine.test.ts && pnpm --filter @roll-agent/runtime typecheck && pnpm --filter @roll-agent/runtime test 2>&1 | tail -8`
Expected: 全部 pass。注意：未传 `workspaceInstructions: null` 的既有 engine 测试会按 `auto` 读取仓库根的 AGENTS.md（system prompt 变长但无断言依赖）；若有测试因此失败，给该测试加 `workspaceInstructions: null`，并在报告中列出。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/engine/conversation-engine.ts packages/runtime/src/engine/conversation-engine.test.ts
git commit -m "feat(runtime): ConversationEngine wires workspace instructions from chat.instructions"
```

---

### Task 6: CLI 接线 — stderr 告警 + banner tag

**Files:**
- Modify: `packages/core/src/cli/commands/chat.ts`
- Modify: `packages/core/src/cli/chat/banner.ts`
- Test: `packages/core/src/cli/chat/banner.test.ts`

**Interfaces:**
- Consumes: `ConversationEngineOptions.onWorkspaceInstructionsIssue`、`EngineContextSummary.instructionsPath`（Task 5）。
- Produces: `BannerInfo.instructionsFile?: string`。

- [ ] **Step 1: 写失败测试（追加到 `banner.test.ts` 末尾）**

```ts
test("info 行在提供 instructionsFile 时追加约定文件名，缺省时不显示", () => {
  const withFile = texts(buildBannerLines({ ...INFO, instructionsFile: "AGENTS.md" }, 120));
  assert.ok(withFile.includes("26 skills · AGENTS.md"));
  const without = texts(buildBannerLines(INFO, 120));
  assert.ok(!without.includes("AGENTS.md"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/cli/chat/banner.test.ts 2>&1 | tail -12`
Expected: 新增 1 条失败。

- [ ] **Step 3: 实现**

`banner.ts`：

1. `BannerInfo` 追加 `readonly instructionsFile?: string;`
2. `infoLine` 中 `if (info.skillCount > 0) {...}` 之后追加：

```ts
  if (info.instructionsFile !== undefined) {
    parts.push(info.instructionsFile);
  }
```

`chat.ts`：

1. `import { join } from "node:path";` → `import { basename, join } from "node:path";`
2. `reportSkillLibraryIssue` 之后新增：

```ts
function reportWorkspaceInstructionsIssue(message: string): void {
  log.warn(`工作区约定：${message}`);
}
```

3. `createChatEngine` 的 `onSkillLibraryIssue: reportSkillLibraryIssue,` 之后追加 `onWorkspaceInstructionsIssue: reportWorkspaceInstructionsIssue,`
4. banner 组装处（`const banner: BannerInfo = {` 块）在 `skillCount: summary.skillCount,` 之后追加：

```ts
          ...(summary.instructionsPath !== undefined
            ? { instructionsFile: basename(summary.instructionsPath) }
            : {}),
```

- [ ] **Step 4: 跑 banner 测试 + chat 相关测试 + prettier + eslint + core typecheck**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/core/src/cli/chat/banner.test.ts packages/core/src/cli/commands/chat.test.ts 2>&1 | tail -8 && npx prettier --write packages/core/src/cli/commands/chat.ts packages/core/src/cli/chat/banner.ts packages/core/src/cli/chat/banner.test.ts && npx eslint packages/core/src/cli/commands/chat.ts packages/core/src/cli/chat/banner.ts packages/core/src/cli/chat/banner.test.ts && pnpm --filter @roll-agent/core typecheck`
Expected: 全部 pass。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli/commands/chat.ts packages/core/src/cli/chat/banner.ts packages/core/src/cli/chat/banner.test.ts
git commit -m "feat(core): roll chat reports workspace instruction issues and shows the file in the banner"
```

---

### Task 7: 文档、changeset、全量验证、真实环境验证

**Files:**
- Modify: `README.md`（「`roll chat` 终端界面模式」段之后）
- Modify: `CLAUDE.md`、`AGENTS.md`（「roll chat 的 Skills 接入与 system prompt」段）
- Create: `.changeset/chat-workspace-instructions.md`

- [ ] **Step 1: README 新增小节**

在 README「`--screen-mode` 只适用于没有起始 message 的交互会话…」段落之后、`## CLI 命令参考` 之前插入：

```markdown
### `roll chat` 工作区工程约定（AGENTS.md / CLAUDE.md）

`roll chat` 启动时从工作目录逐级向上查找最近一层的 `AGENTS.md`（优先）或 `CLAUDE.md`，
把内容作为独立的「工作区工程约定」段注入 system prompt（标注来源路径）。它不在对话历史里，
因此不随 compaction 丢失，也无需在提示里手动要求「先读 AGENTS.md」。

```yaml
chat:
  instructions: auto # auto | off | <path>
```

- `auto`（默认）：同目录两者都在取 `AGENTS.md`；只有一个时用存在的那个；都没有时不注入、不提示
- `off`：关闭注入
- `<path>`：显式指定约定文件（相对工作目录解析，支持 `~`）；文件缺失时 stderr 提示一次
- 刷新：每轮开始按文件修改时间 / 大小检查，变化后下一轮生效；恢复会话时按当前工作目录重新发现
- 上限：超过 32 000 字符会截断并在 stderr 提示一次，请精简约定文件
- 只注入、不执行：约定内容是给模型的说明，不会被当作命令运行；`roll chat`、`roll chat --server`、全屏 TUI 行为一致
```

（嵌套代码块请用四反引号包裹外层或把 yaml 块放在列表之前 — 以 README 现有写法为准，保证 Markdown 渲染正确。）

- [ ] **Step 2: CLAUDE.md 与 AGENTS.md 各加一条**

在两份文件「roll chat 的 Skills 接入与 system prompt」列表的 `- **测试封闭性**…` 之前插入：

```markdown
- **工作区工程约定**：`packages/runtime/src/engine/workspace-instructions.ts` 从 cwd 向上找最近一层 `AGENTS.md`（优先）/ `CLAUDE.md`，每轮按 mtime/size 缓存刷新；`system-prompt.ts` 的 `# 工作区工程约定` 段在 `# 输出` 之后；`ConversationEngine` 按 `chat.instructions`（auto | off | path）构造 source，三入口共用；告警走 `onWorkspaceInstructionsIssue` → stderr
```

并把 `- **测试封闭性**` 那条改为：

```markdown
- **测试封闭性**：引擎/会话测试需传 `skillLibrary: null`（引擎）或不传 `skillLibrary`（会话）避免读取真实 `~/.agents/skills`；需要隔离工作区约定时引擎传 `workspaceInstructions: null`（会话不传 `workspaceInstructions`）
```

**提交注意**：这两份文件工作树里已有用户未提交的 GitNexus 统计行改动（`15510 symbols, 43213 relationships`）。提交前先 `git diff CLAUDE.md AGENTS.md` 确认只有「我的 hunk + 那一行」，然后：

```bash
sed -i '' 's/15510 symbols, 43213 relationships/14821 symbols, 41048 relationships/' CLAUDE.md AGENTS.md
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: describe roll chat workspace instructions injection and chat.instructions"
sed -i '' 's/14821 symbols, 41048 relationships/15510 symbols, 43213 relationships/' CLAUDE.md AGENTS.md
git diff --stat CLAUDE.md AGENTS.md   # 期望仍各 1 行（用户的统计行改动保留在工作树）
```

- [ ] **Step 3: changeset**

```markdown
---
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

roll chat 自动注入工作区 AGENTS.md / CLAUDE.md 作为工程约定（#222）

- runtime：新增 `workspace-instructions.ts`，从工作目录逐级向上找最近一层 `AGENTS.md`（优先）/ `CLAUDE.md`，`AgentSession` 每轮按 mtime/size 检查变化并重编译 system prompt；内容以 `# 工作区工程约定` 段注入（标注来源路径），不在消息历史里、不受 compaction 影响；超过 32 000 字符截断并通过 issue 回调告警一次
- runtime：`ConversationEngine` 新增 `workspaceInstructions`（显式 source 或 `null` 关闭）与 `onWorkspaceInstructionsIssue` 选项，`getContextSummary()` 暴露 `instructionsPath`
- core：新增配置 `chat.instructions: auto | off | <path>`（默认 `auto`，路径支持 `~`）；`roll chat` 把截断 / 缺失告警写到 stderr，banner 显示已加载的约定文件名；README 与 config guidance 同步
```

Run: `pnpm changeset status` → 期望列出两个包。

```bash
git add .changeset/chat-workspace-instructions.md
git commit -m "chore: changeset for roll chat workspace instructions"
```

- [ ] **Step 4: 全量验证**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @roll-agent/runtime test 2>&1 | tail -6 && pnpm --filter @roll-agent/core test 2>&1 | tail -6`
Expected: typecheck / lint 干净；两个包测试全 pass。

- [ ] **Step 5: 真实环境验证（tmux）**

1. 建临时工作区 `/private/tmp/claude-501/.../scratchpad/ws-222/`，写入 `AGENTS.md`（含一条易识别的怪规则，如「回答结尾必须带 🍙」）与一个 `CLAUDE.md`（内容不同）。
2. 在该目录用 tmux 启动 `pnpm --dir <repo> dev -- chat`（或 `cd` 后 `node <repo>/packages/core/src/cli/index.ts` 对应的 dev 命令），确认 banner info 行出现 `AGENTS.md`。
3. 发一条「你现在的 system prompt 里有工作区工程约定吗？来源文件路径是什么？只回答路径」，期望回答 `<ws>/AGENTS.md`；再发一条普通问题，期望结尾出现 🍙（AGENTS.md 优先于 CLAUDE.md 的实证）。
4. 不退出，修改 AGENTS.md 把 🍙 换成 🥟，再发一条普通问题，期望结尾变为 🥟（mtime 刷新实证）。
5. 把 AGENTS.md 写成 40 000 个字符，发一条消息，期望 stderr（TUI 退出后或 inline 模式）出现「超过上限 32000」告警；`roll chat --screen-mode inline` 下更易观察。
6. 在 `roll.config.yaml`（临时工作区内建一份最小配置或用 `--config`）设 `chat: { instructions: off }`，重启，确认 banner 无 `AGENTS.md` 且回答不带表情。
7. 把观察结果（截屏文字）记入最终汇报。

- [ ] **Step 6: 收尾**

`git log --oneline dev..HEAD`，确认提交链完整；按 superpowers:finishing-a-development-branch 向用户呈现合并 / PR / 保留三选项。
