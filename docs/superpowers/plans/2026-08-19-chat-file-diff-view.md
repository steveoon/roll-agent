# Chat File Diff View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `roll chat` 的 `edit_file` / `write_file` 在审批前预览和应用后展示 unified diff（含 `+N −M`），覆盖 Ink TUI、基础 REPL、`--server` 三条路径，模型可见输出不变。

**Architecture:** runtime 侧用手写行级 Myers 生成 `FileChangeDiff`（Zod schema 定义在 `@roll-agent/protocol`），审批时随 `ApprovalRequest.diff` → `confirmation-required.diff` → `--server` 的 `preview.diff` 传递；结果时 `display` 变为 `{ text, diff }` 对象（`model` 显式保持文本快照），沿既有 `display` 通道自动流经所有跳。core 侧新增 unified diff 解析/着色、Ink `DiffBlock`/`DiffSummary`、`/diff` 会话级折叠开关，审批框内嵌预览。

**Tech Stack:** TypeScript（Node 22 type stripping，`.ts` import 后缀，`erasableSyntaxOnly`）、zod（protocol 用 `zod/v4`，runtime 用 `zod` v3）、Ink 7 + `createElement`（无 JSX）、chalk 5、node:test + ink-testing-library。

**Spec:** `docs/superpowers/specs/2026-08-19-chat-file-diff-view-design.md`

## Global Constraints

- 零 `any`；`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` 开启：可选字段用条件 spread `...(x !== undefined ? { x } : {})`。
- 导入路径必须带 `.ts` 后缀；`import type` 分离类型；禁止 `enum`/`namespace`。
- 核心代码零注释（WHAT/WHY 交给命名与 changeset）。
- if/else 必须加花括号。
- CLI 参数 kebab-case；stdout 只输出数据，日志/状态/着色一律 stderr。
- 上限常量（来自 spec §7）：unified 生产上限 `12_000` 字符（行边界截断）；schema 上限 `20_000`；输入合计 > `1_048_576` 字节只给统计；Myers 编辑距离上限 `1_000`；TUI/REPL 折叠阈值正文 > `40` 行。
- 不引入新 npm 依赖；不 bump Runtime Protocol 版本；不改任何 `.strict()` 协议 schema 的顶层字段。
- 每个 Task 结束时：`pnpm --filter <pkg> typecheck` + 相关测试文件通过再 commit。全部完成后 `pnpm typecheck && pnpm lint && pnpm test`。
- 测试运行方式：`node --experimental-strip-types --experimental-sqlite --test <file>`（runtime 需要 `--experimental-sqlite`；core / protocol 不需要）。
- 改动符号前按 GitNexus 规则跑 `impact`（`mcp__gitnexus__impact`），提交前跑 `detect_changes`。

---

### Task 1: protocol — `FileChangeDiff` schema、accessor、README

**Files:**
- Modify: `packages/protocol/src/index.ts`（常量区 `:34-35` 附近；schema 区 `:285-289` 后；类型区 `:2242-2260`；helper 区 `:2327-2336` 后）
- Modify: `packages/protocol/README.md:157-163` 之后追加一段
- Test: `packages/protocol/src/index.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const APPROVAL_DIFF_PREVIEW_KEY = "diff" as const;
  export const FILE_CHANGE_DIFF_PATH_MAX_CHARS = 4_096;
  export const FILE_CHANGE_DIFF_UNIFIED_MAX_CHARS = 20_000;
  export const FILE_CHANGE_KINDS = ["create", "modify"] as const;
  export const fileChangeDiffSchema: z.ZodReadonly<z.ZodObject<...>>;
  export const fileChangeDisplaySchema: z.ZodReadonly<z.ZodObject<...>>;
  export type FileChangeKind = (typeof FILE_CHANGE_KINDS)[number];
  export type FileChangeDiff = z.infer<typeof fileChangeDiffSchema>;
  export type FileChangeDisplay = z.infer<typeof fileChangeDisplaySchema>;
  export function getApprovalDiffPreview(approval: Pick<PendingApproval, "preview">): FileChangeDiff | undefined;
  export function getFileChangeDisplay(display: unknown): FileChangeDisplay | undefined;
  ```
  两个 schema **不加 `.strict()`**（默认 strip 未知键）：它们描述的是嵌在 `preview` / `display` JSON 槽位里的「约定键」，旧 GUI 对未来新增字段应容忍而非报错。这与顶层协议 schema 的 strict 约定不冲突（顶层未动）。

- [ ] **Step 1: 写失败测试**（追加到 `packages/protocol/src/index.test.ts` 末尾，import 处补 `APPROVAL_DIFF_PREVIEW_KEY, fileChangeDiffSchema, fileChangeDisplaySchema, getApprovalDiffPreview, getFileChangeDisplay, FILE_CHANGE_DIFF_UNIFIED_MAX_CHARS`）

```ts
const FILE_DIFF_FIXTURE = {
  path: "src/a.ts",
  change: "modify",
  added: 1,
  removed: 1,
  hunks: 1,
  unified: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
  truncated: false,
} as const;

test("file change diff rides inside approval preview and tool display without touching strict top-level schemas", () => {
  const approval = pendingApprovalSchema.parse({
    id: IDS.approval,
    turnId: IDS.turn,
    agentName: "roll",
    toolName: "edit_file",
    preview: {
      file_path: "src/a.ts",
      explanation: "修改 src/a.ts：1 处编辑",
      [APPROVAL_DIFF_PREVIEW_KEY]: FILE_DIFF_FIXTURE,
    },
  });
  assert.deepEqual(getApprovalDiffPreview(approval), FILE_DIFF_FIXTURE);
  assert.equal(getApprovalExplanation(approval), "修改 src/a.ts：1 处编辑");
  for (const preview of [
    { file_path: "src/a.ts" },
    { diff: null },
    { diff: "not an object" },
    { diff: { ...FILE_DIFF_FIXTURE, change: "delete" } },
    { diff: { ...FILE_DIFF_FIXTURE, added: -1 } },
    { diff: { ...FILE_DIFF_FIXTURE, unified: "x".repeat(FILE_CHANGE_DIFF_UNIFIED_MAX_CHARS + 1) } },
    [],
    null,
  ]) {
    assert.equal(getApprovalDiffPreview({ ...approval, preview }), undefined);
  }
  assert.deepEqual(
    getApprovalDiffPreview({
      ...approval,
      preview: { diff: { ...FILE_DIFF_FIXTURE, futureField: 1 } },
    }),
    FILE_DIFF_FIXTURE,
  );
  const statsOnly = { ...FILE_DIFF_FIXTURE, unified: undefined };
  const { unified: _dropped, ...statsOnlyExpected } = FILE_DIFF_FIXTURE;
  assert.deepEqual(getApprovalDiffPreview({ ...approval, preview: { diff: statsOnly } }), statsOnlyExpected);
  assert.throws(() => pendingApprovalSchema.parse({ ...approval, diff: FILE_DIFF_FIXTURE }));

  for (const protocolVersion of ["1.4", "1.1", "1.0"] as const) {
    const parsed = runtimeEventEnvelopeSchema.parse({
      protocolVersion,
      runtimeInstanceId: IDS.runtime,
      sequence: 1,
      timestamp: "2026-08-19T12:10:00.000Z",
      threadId: IDS.thread,
      turnId: IDS.turn,
      event: { type: "approval.required", approval },
    });
    assert.deepEqual(
      parsed.event.type === "approval.required" ? getApprovalDiffPreview(parsed.event.approval) : undefined,
      FILE_DIFF_FIXTURE,
    );
    const completed = runtimeEventEnvelopeSchema.parse({
      protocolVersion,
      runtimeInstanceId: IDS.runtime,
      sequence: 2,
      timestamp: "2026-08-19T12:10:01.000Z",
      threadId: IDS.thread,
      turnId: IDS.turn,
      event: {
        type: "tool.completed",
        toolCallId: "call-1",
        agentName: "roll",
        toolName: "edit_file",
        display: { text: "已完成 1 处修改并写入 src/a.ts：", diff: FILE_DIFF_FIXTURE },
      },
    });
    assert.deepEqual(
      completed.event.type === "tool.completed" ? getFileChangeDisplay(completed.event.display) : undefined,
      { text: "已完成 1 处修改并写入 src/a.ts：", diff: FILE_DIFF_FIXTURE },
    );
  }
  assert.equal(getFileChangeDisplay("plain text"), undefined);
  assert.equal(getFileChangeDisplay({ text: "x" }), undefined);
  assert.equal(getFileChangeDisplay({ text: 1, diff: FILE_DIFF_FIXTURE }), undefined);
  assert.equal(fileChangeDiffSchema.safeParse(FILE_DIFF_FIXTURE).success, true);
  assert.equal(fileChangeDisplaySchema.safeParse({ text: "", diff: FILE_DIFF_FIXTURE }).success, true);
});
```

注意：`runtimeEventEnvelopeSchema` 的 `protocolVersion` 若不接受 `"1.4"`（它可能是 V11 冻结 schema），把 `"1.4"` 那次改用 `runtimeEventEnvelopeV14Schema`（grep 确认名称：`grep -n "export const runtimeEventEnvelope" packages/protocol/src/index.ts`）。`IDS` 是该测试文件已有的常量对象。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test packages/protocol/src/index.test.ts`
Expected: FAIL（`APPROVAL_DIFF_PREVIEW_KEY` 等未导出 / 类型报错）

- [ ] **Step 3: 实现**

在 `packages/protocol/src/index.ts` 常量区（`APPROVAL_EXPLANATION_MAX_CHARS` 之后）加：

```ts
export const APPROVAL_DIFF_PREVIEW_KEY = "diff" as const;
export const FILE_CHANGE_DIFF_PATH_MAX_CHARS = 4_096;
export const FILE_CHANGE_DIFF_UNIFIED_MAX_CHARS = 20_000;
export const FILE_CHANGE_KINDS = ["create", "modify"] as const;
```

在 `approvalExplanationSchema` 定义之后加：

```ts
export const fileChangeDiffSchema = z
  .object({
    path: z.string().min(1).max(FILE_CHANGE_DIFF_PATH_MAX_CHARS),
    change: z.enum(FILE_CHANGE_KINDS),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    hunks: z.number().int().nonnegative(),
    unified: z.string().max(FILE_CHANGE_DIFF_UNIFIED_MAX_CHARS).optional(),
    truncated: z.boolean(),
  })
  .readonly();

export const fileChangeDisplaySchema = z
  .object({
    text: z.string(),
    diff: fileChangeDiffSchema,
  })
  .readonly();
```

类型区（`ApprovalExplanation` 旁）加：

```ts
export type FileChangeKind = (typeof FILE_CHANGE_KINDS)[number];
export type FileChangeDiff = z.infer<typeof fileChangeDiffSchema>;
export type FileChangeDisplay = z.infer<typeof fileChangeDisplaySchema>;
```

`getApprovalExplanation` 之后加：

```ts
export function getApprovalDiffPreview(
  approval: Pick<PendingApproval, "preview">,
): FileChangeDiff | undefined {
  const preview = approval.preview;
  if (typeof preview !== "object" || preview === null || Array.isArray(preview)) {
    return undefined;
  }
  const parsed = fileChangeDiffSchema.safeParse(preview[APPROVAL_DIFF_PREVIEW_KEY]);
  return parsed.success ? parsed.data : undefined;
}

export function getFileChangeDisplay(display: unknown): FileChangeDisplay | undefined {
  const parsed = fileChangeDisplaySchema.safeParse(display);
  return parsed.success ? parsed.data : undefined;
}
```

若 zod v4 对 `unified: undefined`（键存在值为 undefined）报错，把测试里的 `statsOnly` 改成 `const { unified: _u, ...statsOnly } = FILE_DIFF_FIXTURE;`（键不存在）——两种形态都要能被 accessor 接受，因为 `safeJson` 会保留 `undefined` 值为缺席键。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test packages/protocol/src/index.test.ts && pnpm --filter @roll-agent/protocol typecheck`
Expected: PASS

- [ ] **Step 5: README**

在 `packages/protocol/README.md` 「Shell 审批的模型说明位于 …」那段之后追加：

```markdown
文件编辑类审批（`edit_file` / `write_file`）的变更预览位于 `approval.preview.diff`，形状为
`fileChangeDiffSchema`（`path`、`change: "create" | "modify"`、`added`、`removed`、`hunks`、可选的
`unified` 文本、`truncated`）；`getApprovalDiffPreview()` 完成校验。写入成功后的
`tool.completed.display` / `operationView.display` 为 `{ text, diff }` 对象（`fileChangeDisplaySchema`），
`getFileChangeDisplay()` 读取；`text` 是与旧版本一致的人类可读摘要。两者同样刻意放在既有 JSON
槽位内：strict 顶层结构不变，旧客户端把它们当普通 JSON 忽略；`unified` 缺席表示只有统计（超大文件），
`truncated: true` 表示正文按上限截断。
```

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts packages/protocol/README.md
git commit -m "feat(protocol): file change diff schema inside approval preview and tool display"
```

---

### Task 2: runtime — 行级 Myers diff 与 unified 生成 `text-diff.ts`

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/text-diff.ts`
- Test: `packages/runtime/src/tool-bridge/file-tools/text-diff.test.ts`

**Interfaces:**
- Consumes: `FileChangeDiff`, `FileChangeKind` 类型（`@roll-agent/protocol`）
- Produces:
  ```ts
  export const FILE_CHANGE_DIFF_LIMITS = {
    maxUnifiedChars: 12_000,
    maxInputBytes: 1_048_576,
    maxEditDistance: 1_000,
    contextLines: 3,
  } as const;
  export type LineOp =
    | { readonly kind: "equal"; readonly oldIndex: number; readonly newIndex: number }
    | { readonly kind: "delete"; readonly oldIndex: number }
    | { readonly kind: "insert"; readonly newIndex: number };
  export function splitLinesKeepingNewline(content: string): string[];   // "a\nb" → ["a\n","b"]；"a\n" → ["a\n"]；"" → []
  export function diffLines(before: readonly string[], after: readonly string[], maxEditDistance: number): LineOp[];
  export interface BuildFileChangeDiffInput {
    readonly path: string;
    readonly change: FileChangeKind;
    readonly before: string;
    readonly after: string;
    readonly limits?: Partial<typeof FILE_CHANGE_DIFF_LIMITS>;
  }
  export function buildFileChangeDiff(input: BuildFileChangeDiffInput): FileChangeDiff;
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILE_CHANGE_DIFF_LIMITS,
  buildFileChangeDiff,
  diffLines,
  splitLinesKeepingNewline,
  type LineOp,
} from "./text-diff.ts";

function replay(before: readonly string[], after: readonly string[], ops: readonly LineOp[]): string[] {
  const out: string[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const op of ops) {
    if (op.kind === "equal") {
      assert.equal(op.oldIndex, oldIndex);
      assert.equal(op.newIndex, newIndex);
      assert.equal(before[oldIndex], after[newIndex]);
      out.push(after[newIndex] ?? "");
      oldIndex += 1;
      newIndex += 1;
    } else if (op.kind === "delete") {
      assert.equal(op.oldIndex, oldIndex);
      oldIndex += 1;
    } else {
      assert.equal(op.newIndex, newIndex);
      out.push(after[newIndex] ?? "");
      newIndex += 1;
    }
  }
  assert.equal(oldIndex, before.length);
  assert.equal(newIndex, after.length);
  return out;
}

test("splitLinesKeepingNewline 保留行尾换行并区分末行是否有换行", () => {
  assert.deepEqual(splitLinesKeepingNewline(""), []);
  assert.deepEqual(splitLinesKeepingNewline("a"), ["a"]);
  assert.deepEqual(splitLinesKeepingNewline("a\n"), ["a\n"]);
  assert.deepEqual(splitLinesKeepingNewline("a\nb"), ["a\n", "b"]);
  assert.deepEqual(splitLinesKeepingNewline("a\r\nb\r\n"), ["a\r\n", "b\r\n"]);
});

test("diffLines 对相同输入只产出 equal，对空输入产出纯 insert / delete", () => {
  assert.deepEqual(diffLines(["a", "b"], ["a", "b"], 100), [
    { kind: "equal", oldIndex: 0, newIndex: 0 },
    { kind: "equal", oldIndex: 1, newIndex: 1 },
  ]);
  assert.deepEqual(diffLines([], ["x", "y"], 100), [
    { kind: "insert", newIndex: 0 },
    { kind: "insert", newIndex: 1 },
  ]);
  assert.deepEqual(diffLines(["x"], [], 100), [{ kind: "delete", oldIndex: 0 }]);
});

test("diffLines 产出最小编辑脚本并可重放得到 after", () => {
  const before = ["a", "b", "c", "d", "e"];
  const after = ["a", "x", "c", "e", "f"];
  const ops = diffLines(before, after, 100);
  assert.deepEqual(replay(before, after, ops), after);
  const changes = ops.filter((op) => op.kind !== "equal").length;
  assert.equal(changes, 4);
});

test("diffLines 在随机输入上重放正确（性质测试）", () => {
  let seed = 20260819;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = ["a", "b", "c", "d"];
  for (let round = 0; round < 300; round += 1) {
    const before = Array.from({ length: rand(12) }, () => alphabet[rand(alphabet.length)] ?? "a");
    const after = Array.from({ length: rand(12) }, () => alphabet[rand(alphabet.length)] ?? "a");
    const ops = diffLines(before, after, 100);
    assert.deepEqual(replay(before, after, ops), after);
  }
});

test("diffLines 超过编辑距离上限时退化为前后缀外整段替换，仍可重放", () => {
  const before = ["same", "1", "2", "3", "4", "tail"];
  const after = ["same", "a", "b", "c", "d", "e", "tail"];
  const ops = diffLines(before, after, 1);
  assert.deepEqual(replay(before, after, ops), after);
  assert.deepEqual(ops[0], { kind: "equal", oldIndex: 0, newIndex: 0 });
  assert.deepEqual(ops.at(-1), { kind: "equal", oldIndex: 5, newIndex: 6 });
  assert.equal(ops.filter((op) => op.kind === "delete").length, 4);
  assert.equal(ops.filter((op) => op.kind === "insert").length, 5);
});

test("buildFileChangeDiff 生成带文件头、hunk 头与 3 行上下文的 unified", () => {
  const before = Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`).join("\n") + "\n";
  const after = before.replace("line 6", "line six");
  const diff = buildFileChangeDiff({ path: "src/a.ts", change: "modify", before, after });
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks, 1);
  assert.equal(diff.truncated, false);
  assert.equal(
    diff.unified,
    [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,7 +3,7 @@",
      " line 3",
      " line 4",
      " line 5",
      "-line 6",
      "+line six",
      " line 7",
      " line 8",
      " line 9",
      "",
    ].join("\n"),
  );
});

test("buildFileChangeDiff 相距超过 6 行的改动拆成两个 hunk，≤ 6 行合并为一个", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `l${String(i + 1)}`);
  const far = [...lines];
  far[1] = "L2";
  far[20] = "L21";
  const farDiff = buildFileChangeDiff({ path: "f", change: "modify", before: lines.join("\n"), after: far.join("\n") });
  assert.equal(farDiff.hunks, 2);
  assert.match(farDiff.unified ?? "", /^@@ -1,5 \+1,5 @@$/mu);
  const near = [...lines];
  near[9] = "L10";
  near[16] = "L17";
  const nearDiff = buildFileChangeDiff({ path: "f", change: "modify", before: lines.join("\n"), after: near.join("\n") });
  assert.equal(nearDiff.hunks, 1);
});

test("buildFileChangeDiff 新建文件使用 /dev/null 头且全部为新增", () => {
  const diff = buildFileChangeDiff({ path: "new.txt", change: "create", before: "", after: "a\nb\n" });
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 0);
  assert.equal(diff.unified, "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");
});

test("buildFileChangeDiff 末行无换行时输出标准标记", () => {
  const diff = buildFileChangeDiff({ path: "f", change: "modify", before: "a\nb", after: "a\nb\n" });
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(
    diff.unified,
    "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n",
  );
});

test("buildFileChangeDiff 按字符上限在行边界截断并标记 truncated，统计不受影响", () => {
  const before = Array.from({ length: 400 }, (_, i) => `row ${String(i)}`).join("\n");
  const after = Array.from({ length: 400 }, (_, i) => `ROW ${String(i)}`).join("\n");
  const diff = buildFileChangeDiff({
    path: "f",
    change: "modify",
    before,
    after,
    limits: { maxUnifiedChars: 200 },
  });
  assert.equal(diff.added, 400);
  assert.equal(diff.removed, 400);
  assert.equal(diff.truncated, true);
  assert.ok((diff.unified?.length ?? 0) <= 200);
  assert.ok(diff.unified?.endsWith("\n"));
});

test("buildFileChangeDiff 输入超过字节上限时只给统计不给正文", () => {
  const before = "keep\n" + "x".repeat(600) + "\nkeep2\n";
  const after = "keep\n" + "y".repeat(600) + "\nkeep2\n";
  const diff = buildFileChangeDiff({
    path: "big.txt",
    change: "modify",
    before,
    after,
    limits: { maxInputBytes: 1_000 },
  });
  assert.equal(diff.unified, undefined);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks, 1);
  assert.equal(diff.truncated, false);
});

test("buildFileChangeDiff 默认上限与常量一致且 unified 长度不超过生产上限", () => {
  assert.equal(FILE_CHANGE_DIFF_LIMITS.maxUnifiedChars, 12_000);
  const before = Array.from({ length: 2_000 }, (_, i) => `row ${String(i)}`).join("\n");
  const after = Array.from({ length: 2_000 }, (_, i) => `ROW ${String(i)}`).join("\n");
  const diff = buildFileChangeDiff({ path: "f", change: "modify", before, after });
  assert.ok((diff.unified?.length ?? 0) <= 12_000);
  assert.equal(diff.truncated, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/tool-bridge/file-tools/text-diff.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `text-diff.ts`**

```ts
import type { FileChangeDiff, FileChangeKind } from "@roll-agent/protocol";

export const FILE_CHANGE_DIFF_LIMITS = {
  maxUnifiedChars: 12_000,
  maxInputBytes: 1_048_576,
  maxEditDistance: 1_000,
  contextLines: 3,
} as const;

export type LineOp =
  | { readonly kind: "equal"; readonly oldIndex: number; readonly newIndex: number }
  | { readonly kind: "delete"; readonly oldIndex: number }
  | { readonly kind: "insert"; readonly newIndex: number };

export interface BuildFileChangeDiffInput {
  readonly path: string;
  readonly change: FileChangeKind;
  readonly before: string;
  readonly after: string;
  readonly limits?: Partial<typeof FILE_CHANGE_DIFF_LIMITS>;
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

export function splitLinesKeepingNewline(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let start = 0;
  while (start < content.length) {
    const nl = content.indexOf("\n", start);
    if (nl === -1) {
      lines.push(content.slice(start));
      break;
    }
    lines.push(content.slice(start, nl + 1));
    start = nl + 1;
  }
  return lines;
}

interface TrimmedRange {
  readonly prefix: number;
  readonly suffix: number;
}

function trimCommon(before: readonly string[], after: readonly string[]): TrimmedRange {
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, suffix };
}

function myersMiddle(
  a: readonly string[],
  b: readonly string[],
  maxEditDistance: number,
): LineOp[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEditDistance);
  const offset = max + 1;
  const width = 2 * max + 3;
  let v = new Int32Array(width);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v);
    const next = new Int32Array(v);
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(next);
        return backtrack(trace, offset, n, m, d);
      }
    }
    v = next;
  }
  return undefined;
}

function backtrack(
  trace: readonly Int32Array[],
  offset: number,
  n: number,
  m: number,
  finalD: number,
): LineOp[] {
  const reversed: LineOp[] = [];
  let x = n;
  let y = m;
  for (let d = finalD; d >= 0; d -= 1) {
    const v = trace[d];
    if (v === undefined) {
      break;
    }
    const k = x - y;
    const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : (v[offset + prevK] ?? 0);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      reversed.push({ kind: "equal", oldIndex: x, newIndex: y });
    }
    if (d > 0) {
      if (down) {
        y -= 1;
        reversed.push({ kind: "insert", newIndex: y });
      } else {
        x -= 1;
        reversed.push({ kind: "delete", oldIndex: x });
      }
    }
  }
  return reversed.reverse();
}

function replaceAllOps(oldStart: number, oldCount: number, newStart: number, newCount: number): LineOp[] {
  const ops: LineOp[] = [];
  for (let i = 0; i < oldCount; i += 1) {
    ops.push({ kind: "delete", oldIndex: oldStart + i });
  }
  for (let i = 0; i < newCount; i += 1) {
    ops.push({ kind: "insert", newIndex: newStart + i });
  }
  return ops;
}

function shiftOps(ops: readonly LineOp[], oldDelta: number, newDelta: number): LineOp[] {
  return ops.map((op) => {
    if (op.kind === "equal") {
      return { kind: "equal", oldIndex: op.oldIndex + oldDelta, newIndex: op.newIndex + newDelta };
    }
    if (op.kind === "delete") {
      return { kind: "delete", oldIndex: op.oldIndex + oldDelta };
    }
    return { kind: "insert", newIndex: op.newIndex + newDelta };
  });
}

export function diffLines(
  before: readonly string[],
  after: readonly string[],
  maxEditDistance: number,
): LineOp[] {
  const { prefix, suffix } = trimCommon(before, after);
  const ops: LineOp[] = [];
  for (let i = 0; i < prefix; i += 1) {
    ops.push({ kind: "equal", oldIndex: i, newIndex: i });
  }
  const midBefore = before.slice(prefix, before.length - suffix);
  const midAfter = after.slice(prefix, after.length - suffix);
  const middle = myersMiddle(midBefore, midAfter, maxEditDistance);
  ops.push(
    ...(middle === undefined
      ? replaceAllOps(prefix, midBefore.length, prefix, midAfter.length)
      : shiftOps(middle, prefix, prefix)),
  );
  for (let i = 0; i < suffix; i += 1) {
    ops.push({
      kind: "equal",
      oldIndex: before.length - suffix + i,
      newIndex: after.length - suffix + i,
    });
  }
  return ops;
}

interface Hunk {
  readonly ops: readonly LineOp[];
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

function groupHunks(ops: readonly LineOp[], contextLines: number): Hunk[] {
  const changeIndexes = ops.flatMap((op, index) => (op.kind === "equal" ? [] : [index]));
  if (changeIndexes.length === 0) {
    return [];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(ops.length - 1, index + contextLines);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges.map((range) => {
    const slice = ops.slice(range.start, range.end + 1);
    const oldIndexes = slice.flatMap((op) => (op.kind === "insert" ? [] : [op.oldIndex]));
    const newIndexes = slice.flatMap((op) => (op.kind === "delete" ? [] : [op.newIndex]));
    const oldFirst = oldIndexes[0];
    const newFirst = newIndexes[0];
    return {
      ops: slice,
      oldStart: oldFirst === undefined ? anchorLine(slice, "old") : oldFirst + 1,
      oldCount: oldIndexes.length,
      newStart: newFirst === undefined ? anchorLine(slice, "new") : newFirst + 1,
      newCount: newIndexes.length,
    };
  });
}

function anchorLine(slice: readonly LineOp[], side: "old" | "new"): number {
  const first = slice[0];
  if (first === undefined) {
    return 0;
  }
  if (side === "old") {
    return first.kind === "insert" ? 0 : first.oldIndex;
  }
  return first.kind === "delete" ? 0 : first.newIndex;
}

function renderLine(prefix: " " | "-" | "+", token: string): string[] {
  if (token.endsWith("\n")) {
    return [`${prefix}${token.slice(0, -1)}`];
  }
  return [`${prefix}${token}`, NO_NEWLINE_MARKER];
}

function renderHunk(hunk: Hunk, before: readonly string[], after: readonly string[]): string[] {
  const lines = [
    `@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`,
  ];
  for (const op of hunk.ops) {
    if (op.kind === "equal") {
      lines.push(...renderLine(" ", after[op.newIndex] ?? ""));
    } else if (op.kind === "delete") {
      lines.push(...renderLine("-", before[op.oldIndex] ?? ""));
    } else {
      lines.push(...renderLine("+", after[op.newIndex] ?? ""));
    }
  }
  return lines;
}

function joinWithinBudget(lines: readonly string[], maxChars: number): { text: string; truncated: boolean } {
  let total = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const cost = line.length + 1;
    if (total + cost > maxChars) {
      return { text: kept.map((l) => `${l}\n`).join(""), truncated: true };
    }
    kept.push(line);
    total += cost;
  }
  return { text: kept.map((l) => `${l}\n`).join(""), truncated: false };
}

function statsOnlyDiff(input: BuildFileChangeDiffInput, before: readonly string[], after: readonly string[]): FileChangeDiff {
  const { prefix, suffix } = trimCommon(before, after);
  const removed = before.length - prefix - suffix;
  const added = after.length - prefix - suffix;
  return {
    path: input.path,
    change: input.change,
    added,
    removed,
    hunks: added + removed > 0 ? 1 : 0,
    truncated: false,
  };
}

export function buildFileChangeDiff(input: BuildFileChangeDiffInput): FileChangeDiff {
  const limits = { ...FILE_CHANGE_DIFF_LIMITS, ...input.limits };
  const before = splitLinesKeepingNewline(input.before);
  const after = splitLinesKeepingNewline(input.after);
  if (Buffer.byteLength(input.before, "utf8") + Buffer.byteLength(input.after, "utf8") > limits.maxInputBytes) {
    return statsOnlyDiff(input, before, after);
  }
  const ops = diffLines(before, after, limits.maxEditDistance);
  const hunks = groupHunks(ops, limits.contextLines);
  const header = [
    input.change === "create" ? "--- /dev/null" : `--- a/${input.path}`,
    `+++ b/${input.path}`,
  ];
  const body = hunks.flatMap((hunk) => renderHunk(hunk, before, after));
  const { text, truncated } = joinWithinBudget([...header, ...body], limits.maxUnifiedChars);
  return {
    path: input.path,
    change: input.change,
    added: ops.filter((op) => op.kind === "insert").length,
    removed: ops.filter((op) => op.kind === "delete").length,
    hunks: hunks.length,
    unified: text,
    truncated,
  };
}
```

实现要点（写错最常见处）：
- Myers 的 `v` 索引用 `offset + k`，`offset = max + 1`，数组宽 `2*max+3`，保证 `k±1` 不越界；初始 `v[offset+1] = 0`。
- `trace[d]` 保存的是**进入第 d 轮之前**的 V；回溯时用 `trace[d]` 判断来路。第 0 轮 `prevX = 0`。
- `groupHunks` 的合并条件 `start <= last.end + 1`：两处改动之间 equal 行数 ≤ 2×context 时合并（context=3 → ≤ 6 行）。
- `hunk` 头 `oldStart` 在 oldCount = 0 时是「插入点前一行的 1-based 行号」= 首个 op 的 `oldIndex`（0-based）——`anchorLine` 处理；空文件新建得 `-0,0`。
- 截断只在 `joinWithinBudget` 做，统计始终来自完整 `ops`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/tool-bridge/file-tools/text-diff.test.ts && pnpm --filter @roll-agent/runtime typecheck`
Expected: PASS。若 `far` hunk 头断言（`@@ -1,5 +1,5 @@`）不符，先打印 `farDiff.unified` 核对：改动在第 2 行，上文只有 1 行、下文 3 行 → 5 行；如实现无误但期望写错，改期望而非改实现。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/text-diff.ts packages/runtime/src/tool-bridge/file-tools/text-diff.test.ts
git commit -m "feat(runtime): line-level Myers diff and unified diff builder for file tools"
```

---

### Task 3: runtime — 抽出纯函数 `planEdits`（`edit-plan.ts`）

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/edit-plan.ts`
- Modify: `packages/runtime/src/tool-bridge/file-tools/edit-file-tool.ts`（删除 `AppliedEdit`/`detectCrlfOnly`/`adaptLineEndings`/`shiftApplied`/`applySpan`/`applyReplaceAll`/`NO_MATCH_STEERING`，`executeEditFile` 改调 `planEdits`）
- Test: `packages/runtime/src/tool-bridge/file-tools/edit-plan.test.ts`；既有 `edit-file-tool.test.ts` 必须保持全绿（它是行为回归网）

**Interfaces:**
- Produces:
  ```ts
  export interface EditEntry { readonly old_string: string; readonly new_string: string; readonly replace_all?: boolean }
  export interface AppliedEdit { readonly position: number; readonly length: number }
  export type EditPlan =
    | { readonly ok: true; readonly next: string; readonly applied: readonly AppliedEdit[] }
    | { readonly ok: false; readonly result: NormalizedToolResult };
  export function planEdits(content: string, edits: readonly EditEntry[]): EditPlan;
  ```
  失败分支的 `result` 与今天 `executeEditFile` 在同一情形返回的完全一致（同 outcome kind、同 display 文本），包括「所有编辑应用后内容与原文件相同」那条 invalidInput。

- [ ] **Step 1: 先跑 impact**：`mcp__gitnexus__impact({target: "executeEditFile", direction: "upstream"})`，确认调用方只有 `buildEditFileTool` 与测试。

- [ ] **Step 2: 写失败测试 `edit-plan.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planEdits } from "./edit-plan.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

test("planEdits 顺序应用多条编辑并记录位置", () => {
  const plan = planEdits("alpha beta gamma\n", [
    { old_string: "alpha", new_string: "A" },
    { old_string: "gamma", new_string: "GAMMA" },
  ]);
  assert.ok(plan.ok);
  assert.equal(plan.next, "A beta GAMMA\n");
  assert.deepEqual(plan.applied, [
    { position: 0, length: 1 },
    { position: 7, length: 5 },
  ]);
});

test("planEdits 在 CRLF 文件上适配行尾", () => {
  const plan = planEdits("first\r\nsecond\r\n", [{ old_string: "first\nsecond", new_string: "first\nchanged" }]);
  assert.ok(plan.ok);
  assert.equal(plan.next, "first\r\nchanged\r\n");
});

test("planEdits 无匹配返回 tool_failed 且不产出 next", () => {
  const plan = planEdits("alpha\nbeta", [{ old_string: "不存在", new_string: "x" }]);
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.equal(plan.result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
    assert.match(String(plan.result.display), /roll__write_file 整文件重写/u);
  }
});

test("planEdits 内容无变化返回 invalid_input", () => {
  const plan = planEdits("alpha beta\n", [
    { old_string: "alpha", new_string: "gamma" },
    { old_string: "gamma", new_string: "alpha" },
  ]);
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.equal(plan.result.outcome.kind, TOOL_OUTCOME_KINDS.invalidInput);
    assert.match(String(plan.result.display), /与原文件完全相同/u);
  }
});

test("planEdits replace_all 替换全部并记录每处位置", () => {
  const plan = planEdits("x-x-x", [{ old_string: "x", new_string: "yy", replace_all: true }]);
  assert.ok(plan.ok);
  assert.equal(plan.next, "yy-yy-yy");
  assert.equal(plan.applied.length, 3);
});
```

- [ ] **Step 3: 跑测试确认失败**：`node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/tool-bridge/file-tools/edit-plan.test.ts` → FAIL（模块不存在）

- [ ] **Step 4: 实现 `edit-plan.ts`**（把 `edit-file-tool.ts:60-115` 与 `executeEditFile` 中 `const crlfOnly = …` 到 `if (working === loaded.content) {…}` 之间的循环逐字搬过来）

```ts
import { TOOL_OUTCOME_KINDS, failedToolResult, type NormalizedToolResult } from "../normalize-result.ts";
import {
  findAllExact,
  findOldString,
  formatMultiMatchDiagnosis,
  formatNoMatchDiagnosis,
  type MatchSpan,
} from "./match-pipeline.ts";

export interface EditEntry {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

export interface AppliedEdit {
  position: number;
  length: number;
}

export type EditPlan =
  | { readonly ok: true; readonly next: string; readonly applied: readonly AppliedEdit[] }
  | { readonly ok: false; readonly result: NormalizedToolResult };

const NO_MATCH_STEERING =
  "若修改面较大或文件已大幅变化，可改用 roll__write_file 整文件重写（需先 read_file）";

function detectCrlfOnly(content: string): boolean { /* 原样搬运 */ }
function adaptLineEndings(value: string, crlfOnly: boolean): string { /* 原样搬运 */ }
function shiftApplied(applied: AppliedEdit[], at: number, delta: number): void { /* 原样搬运 */ }
function applySpan(working: string, span: MatchSpan, replacement: string, applied: AppliedEdit[]): string { /* 原样搬运 */ }
function applyReplaceAll(working: string, spans: readonly MatchSpan[], replacement: string, applied: AppliedEdit[]): string { /* 原样搬运 */ }

function failed(result: NormalizedToolResult): EditPlan {
  return { ok: false, result };
}

export function planEdits(content: string, edits: readonly EditEntry[]): EditPlan {
  const crlfOnly = detectCrlfOnly(content);
  let working = content;
  const applied: AppliedEdit[] = [];
  for (const [index, edit] of edits.entries()) {
    const label = `第 ${String(index + 1)} 条编辑（共 ${String(edits.length)} 条）`;
    if (edit.old_string === edit.new_string) {
      return failed(failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, `${label}：new_string 与 old_string 相同，没有可应用的变化。未写入任何修改。`));
    }
    const oldAdapted = adaptLineEndings(edit.old_string, crlfOnly);
    const newAdapted = adaptLineEndings(edit.new_string, crlfOnly);
    if (oldAdapted === newAdapted) {
      return failed(failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, `${label}：该文件使用 CRLF 换行，行尾会自动适配，这条编辑在适配后 new_string 与 old_string 相同（只改换行符不会产生变化）。未写入任何修改。`));
    }
    if (edit.replace_all === true) {
      const spans = findAllExact(working, oldAdapted);
      if (spans.length === 0) {
        return failed(failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, `${label}失败，未写入任何修改。\n${formatNoMatchDiagnosis(working, oldAdapted)}\n${NO_MATCH_STEERING}`));
      }
      working = applyReplaceAll(working, spans, newAdapted, applied);
      continue;
    }
    const match = findOldString(working, oldAdapted);
    if (match.kind === "none") {
      return failed(failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, `${label}失败，未写入任何修改。\n${formatNoMatchDiagnosis(working, oldAdapted)}\n${NO_MATCH_STEERING}`));
    }
    if (match.kind === "multiple") {
      return failed(failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, `${label}失败，未写入任何修改。\n${formatMultiMatchDiagnosis(working, match.spans)}`));
    }
    working = applySpan(working, match.span, newAdapted, applied);
  }
  if (working === content) {
    return failed(failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, "所有编辑应用后文件内容与原文件完全相同，没有可写入的变化。未写入任何修改。"));
  }
  return { ok: true, next: working, applied };
}
```

（"原样搬运" 处必须把 `edit-file-tool.ts` 现有函数体逐字复制过来，然后从 `edit-file-tool.ts` 删除。）

`edit-file-tool.ts` 中 `executeEditFile` 改为：

```ts
export function executeEditFile(settings, tracker, input): NormalizedToolResult {
  const payloadRejected = rejectInvalidEditPayloads(input);
  if (payloadRejected !== undefined) { return payloadRejected; }
  const path = resolveFilePath(settings.workdir, input.file_path);
  const loaded = loadTextFile(path, { maxFileBytes: settings.maxFileBytes });
  if (!loaded.ok) { return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, loaded.message); }
  const stale = editFreshnessGuard(tracker, path, loaded);
  if (stale !== undefined) { return stale; }
  const plan = planEdits(loaded.content, input.edits);
  if (!plan.ok) { return plan.result; }
  saveTextFile(path, plan.next, loaded.hadBom);
  tracker.recordKnownContent(loaded.key, plan.next);
  return successfulToolResult(renderEditSuccess(path, plan.next, plan.applied, settings.maxOutputChars));
}
```

并新增（同文件）：

```ts
function editFreshnessGuard(tracker: FileStateTracker, path: string, loaded: LoadedTextFile): NormalizedToolResult | undefined {
  const freshness = tracker.checkFreshness(loaded.key, loaded.content);
  if (freshness === FILE_FRESHNESS.unread) {
    return failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, `尚未读取过 ${path}。请先用 roll__read_file 读取文件，再基于读到的内容编辑。`);
  }
  if (freshness === FILE_FRESHNESS.stale) {
    return failedToolResult(TOOL_OUTCOME_KINDS.toolFailed, `${path} 在你上次读取后已被修改（可能是用户或其他程序改动）。请重新 roll__read_file 获取最新内容，再基于最新内容编辑，不要用旧内容重试。`);
  }
  return undefined;
}
```

（`LoadedTextFile` 从 `./file-io.ts` `import type`；`renderEditSuccess` 的 `applied` 参数类型改为 `readonly AppliedEdit[]` 并从 `./edit-plan.ts` 导入。）

- [ ] **Step 5: 跑测试**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/tool-bridge/file-tools/edit-plan.test.ts packages/runtime/src/tool-bridge/file-tools/edit-file-tool.test.ts && pnpm --filter @roll-agent/runtime typecheck`
Expected: 全部 PASS（既有 edit-file-tool 测试逐字消息不变）

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/edit-plan.ts packages/runtime/src/tool-bridge/file-tools/edit-plan.test.ts packages/runtime/src/tool-bridge/file-tools/edit-file-tool.ts
git commit -m "refactor(runtime): extract pure planEdits from edit_file execute path"
```

---

### Task 4: runtime — 审批请求携带 diff（build-tools / events / agent-session）

**Files:**
- Modify: `packages/runtime/src/tool-bridge/build-tools.ts:49-71`（两个接口）、`:407-416`（透传）
- Modify: `packages/runtime/src/types/events.ts:65-77`
- Modify: `packages/runtime/src/engine/agent-session.ts:2296-2310`
- Modify: `packages/runtime/src/index.ts`（re-export protocol 的 diff 类型与 helper）
- Test: `packages/runtime/src/tool-bridge/build-tools.test.ts`（在现有 `gateToolCall` 测试旁加一条）

**Interfaces:**
- Consumes: `FileChangeDiff`（Task 1）
- Produces:
  ```ts
  // build-tools.ts
  export interface ApprovalRequest { …; readonly diff?: FileChangeDiff }
  interface ApprovalDisplayOptions { …; readonly diff?: FileChangeDiff }
  // events.ts confirmation-required 变体
  readonly diff?: FileChangeDiff;
  // runtime index.ts
  export { APPROVAL_DIFF_PREVIEW_KEY, fileChangeDiffSchema, fileChangeDisplaySchema, getApprovalDiffPreview, getFileChangeDisplay } from "@roll-agent/protocol";
  export type { FileChangeDiff, FileChangeDisplay, FileChangeKind } from "@roll-agent/protocol";
  ```

- [ ] **Step 1: impact**：`mcp__gitnexus__impact({target: "gateToolCall", direction: "upstream"})`（预期：file tools 的 prepare、bash/session-exec、build-tools.test）。

- [ ] **Step 2: 写失败测试**（`build-tools.test.ts`，仿照现有 `gateToolCall` 用例，`ctx` 的 `requestApproval` 记录请求）

```ts
test("gateToolCall 把 display.diff 原样透传进 ApprovalRequest", async () => {
  const requests: ApprovalRequest[] = [];
  const ctx: ToolBridgeContext = {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      requests.push(request);
      return Promise.resolve({ approved: true });
    },
  };
  const diff = {
    path: "a.txt",
    change: "modify",
    added: 1,
    removed: 1,
    hunks: 1,
    unified: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n",
    truncated: false,
  } as const;
  const denied = await gateToolCall(ctx, "roll", "edit_file", { file_path: "a.txt" }, undefined, {
    explanation: "修改 a.txt：1 处编辑",
    diff,
  });
  assert.equal(denied, undefined);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.diff, diff);
  await gateToolCall(ctx, "roll", "edit_file", { file_path: "a.txt" }, undefined, { explanation: "无 diff" });
  assert.equal(Object.hasOwn(requests[1] ?? {}, "diff"), false);
});
```

（若 `DefaultToolPolicy` 对 `roll.edit_file` 不是 `confirm`，改用文件里既有测试所用的会触发 confirm 的 policy 写法。）

- [ ] **Step 3: 跑测试确认失败**：`node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/tool-bridge/build-tools.test.ts` → FAIL（`diff` 不在类型上 / 未透传）

- [ ] **Step 4: 实现**

`build-tools.ts`：`import type { FileChangeDiff } from "@roll-agent/protocol";`；`ApprovalRequest` 与 `ApprovalDisplayOptions` 各加 `readonly diff?: FileChangeDiff;`；`ctx.requestApproval({...})` 里 `explanation` 那行之后加 `...(display?.diff !== undefined ? { diff: display.diff } : {}),`。

`events.ts`：`import type { FileChangeDiff, UserInputForm } from "@roll-agent/protocol";`；`confirmation-required` 变体在 `sessionGrantLabel?` 之后加 `readonly diff?: FileChangeDiff;`。

`agent-session.ts` `requestApproval` 的 `this.emit({...})` 里 `sessionGrantLabel` spread 之后加 `...(request.diff !== undefined ? { diff: request.diff } : {}),`。

`index.ts`：加上面 Interfaces 里的两条 export。

- [ ] **Step 5: 跑测试**：`node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/tool-bridge/build-tools.test.ts && pnpm --filter @roll-agent/runtime typecheck` → PASS

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/tool-bridge/build-tools.ts packages/runtime/src/tool-bridge/build-tools.test.ts packages/runtime/src/types/events.ts packages/runtime/src/engine/agent-session.ts packages/runtime/src/index.ts
git commit -m "feat(runtime): carry file change diff on approval requests and confirmation events"
```

---

### Task 5: runtime — `edit_file` 审批前 dry-run 预览 + 结果 `{ text, diff }`

**Files:**
- Create: `packages/runtime/src/tool-bridge/file-tools/file-change-result.ts`
- Modify: `packages/runtime/src/tool-bridge/file-tools/edit-file-tool.ts`（`prepare` 与 `executeEditFile`）
- Test: `packages/runtime/src/tool-bridge/file-tools/file-change-result.test.ts`、`edit-file-tool.test.ts`

**Interfaces:**
- Consumes: `planEdits`（Task 3）、`buildFileChangeDiff`（Task 2）、`formatPathForApproval`（file-io）
- Produces:
  ```ts
  export interface DescribeFileChangeInput {
    readonly workdir: string;
    readonly inputPath: string;
    readonly change: FileChangeKind;
    readonly before: string;
    readonly after: string;
  }
  export function describeFileChange(input: DescribeFileChangeInput): FileChangeDiff | undefined; // 内部 try/catch，失败返回 undefined
  export function fileChangeToolResult(text: string, diff: FileChangeDiff | undefined): NormalizedToolResult;
  ```

- [ ] **Step 1: 写失败测试 `file-change-result.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFileChange, fileChangeToolResult } from "./file-change-result.ts";
import { TOOL_OUTCOME_KINDS } from "../normalize-result.ts";

test("describeFileChange 使用工作目录相对路径并产出 unified", () => {
  const workdir = mkdtempSync(join(tmpdir(), "file-change-"));
  const diff = describeFileChange({
    workdir,
    inputPath: join(workdir, "src", "a.ts"),
    change: "modify",
    before: "a\n",
    after: "b\n",
  });
  assert.equal(diff?.path, join("src", "a.ts"));
  assert.equal(diff?.added, 1);
  assert.equal(diff?.removed, 1);
  assert.match(diff?.unified ?? "", /^--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n@@ -1,1 \+1,1 @@\n-a\n\+b\n$/u);
});

test("fileChangeToolResult 的 display 为 {text, diff}，model 与 raw 保持文本快照", () => {
  const diff = describeFileChange({ workdir: tmpdir(), inputPath: "x.txt", change: "create", before: "", after: "hi\n" });
  assert.ok(diff);
  const result = fileChangeToolResult("已写入 x.txt", diff);
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.deepEqual(result.display, { text: "已写入 x.txt", diff });
  assert.deepEqual(result.model, { type: "text", value: "已写入 x.txt" });
  const plain = fileChangeToolResult("已写入 x.txt", undefined);
  assert.equal(plain.display, "已写入 x.txt");
  assert.deepEqual(plain.model, { type: "text", value: "已写入 x.txt" });
});
```

- [ ] **Step 2: 跑测试确认失败**：`node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/tool-bridge/file-tools/file-change-result.test.ts` → FAIL

- [ ] **Step 3: 实现 `file-change-result.ts`**

```ts
import type { FileChangeDiff, FileChangeKind } from "@roll-agent/protocol";
import { successfulToolResult, type NormalizedToolResult } from "../normalize-result.ts";
import { formatPathForApproval } from "./file-io.ts";
import { buildFileChangeDiff } from "./text-diff.ts";

export interface DescribeFileChangeInput {
  readonly workdir: string;
  readonly inputPath: string;
  readonly change: FileChangeKind;
  readonly before: string;
  readonly after: string;
}

export function describeFileChange(input: DescribeFileChangeInput): FileChangeDiff | undefined {
  try {
    return buildFileChangeDiff({
      path: formatPathForApproval(input.workdir, input.inputPath),
      change: input.change,
      before: input.before,
      after: input.after,
    });
  } catch {
    return undefined;
  }
}

export function fileChangeToolResult(
  text: string,
  diff: FileChangeDiff | undefined,
): NormalizedToolResult {
  if (diff === undefined) {
    return successfulToolResult(text);
  }
  return successfulToolResult({ text, diff }, { model: { type: "text", value: text } });
}
```

注意 `formatPathForApproval` 对目录外路径返回 `<绝对路径>（工作目录外）`，与审批 explanation 中的路径显示一致——这是有意的。

- [ ] **Step 4: 写 `edit-file-tool.test.ts` 失败测试**（追加）

```ts
function buildEditFixture(f: Fixture, approvals: ApprovalRequest[], decision = { approved: true } as const) {
  return buildEditFileTool(f.settings, f.tracker, new ToolRegistry(), {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      approvals.push(request);
      return Promise.resolve(decision);
    },
    approvalMemory: new SessionApprovalMemory(),
  });
}

test("edit_file 审批请求携带 dry-run diff，批准后写入且结果 display 含同一 diff、model 仍为快照文本", async () => {
  const f = fixture("line1\nline2\nline3\n");
  markRead(f);
  const approvals: ApprovalRequest[] = [];
  const editTool = buildEditFixture(f, approvals).roll__edit_file;
  assert.ok(editTool?.execute !== undefined);
  const result = (await editTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "line2", new_string: "LINE2" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.diff?.path, "target.txt");
  assert.equal(approvals[0]?.diff?.added, 1);
  assert.equal(approvals[0]?.diff?.removed, 1);
  assert.match(approvals[0]?.diff?.unified ?? "", /-line2\n\+LINE2\n/u);
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  assert.equal(readFileSync(f.path, "utf8"), "line1\nLINE2\nline3\n");
  const display = result.display as { text: string; diff: unknown };
  assert.match(display.text, /已完成 1 处修改并写入/u);
  assert.deepEqual(display.diff, approvals[0]?.diff);
  assert.deepEqual(result.model, { type: "text", value: display.text });
});

test("edit_file 拒绝审批后文件未写入", async () => {
  const f = fixture("keep\n");
  markRead(f);
  const approvals: ApprovalRequest[] = [];
  const editTool = buildEditFixture(f, approvals, { approved: false }).roll__edit_file;
  assert.ok(editTool?.execute !== undefined);
  const result = (await editTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "keep", new_string: "gone" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(approvals.length, 1);
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.userRejected);
  assert.equal(readFileSync(f.path, "utf8"), "keep\n");
});

test("edit_file 未读取过 / old_string 不匹配时在审批前直接失败，不弹审批", async () => {
  const unread = fixture("abc\n");
  const approvals: ApprovalRequest[] = [];
  const unreadTool = buildEditFixture(unread, approvals).roll__edit_file;
  assert.ok(unreadTool?.execute !== undefined);
  const unreadResult = (await unreadTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "abc", new_string: "x" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(unreadResult.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(unreadResult.display), /尚未读取过/u);
  assert.equal(approvals.length, 0);

  const mismatch = fixture("abc\n");
  markRead(mismatch);
  const mismatchTool = buildEditFixture(mismatch, approvals).roll__edit_file;
  assert.ok(mismatchTool?.execute !== undefined);
  const mismatchResult = (await mismatchTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "zzz", new_string: "x" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(mismatchResult.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.equal(approvals.length, 0);
  assert.equal(readFileSync(mismatch.path, "utf8"), "abc\n");
});

test("edit_file 审批期间文件被外部改动则不写入", async () => {
  const f = fixture("v1\n");
  markRead(f);
  const approvals: ApprovalRequest[] = [];
  const tools = buildEditFileTool(f.settings, f.tracker, new ToolRegistry(), {
    policy: new DefaultToolPolicy(),
    requestApproval: (request) => {
      approvals.push(request);
      writeFileSync(f.path, "v1-external\n", "utf8");
      return Promise.resolve({ approved: true });
    },
    approvalMemory: new SessionApprovalMemory(),
  });
  const editTool = tools.roll__edit_file;
  assert.ok(editTool?.execute !== undefined);
  const result = (await editTool.execute(
    { file_path: "target.txt", edits: [{ old_string: "v1", new_string: "v2" }] },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(approvals.length, 1);
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.toolFailed);
  assert.match(String(result.display), /已被修改/u);
  assert.equal(readFileSync(f.path, "utf8"), "v1-external\n");
});
```

- [ ] **Step 5: 跑测试确认失败**（新用例失败，老用例仍绿）

- [ ] **Step 6: 实现 `edit-file-tool.ts`**

`prepare` 改为：

```ts
prepare: async (rawInput) => {
  const parsed = editFileInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, "参数校验失败: file_path 必须为非空字符串，edits 至少一条且每条含非空 old_string 与 new_string");
  }
  const payloadRejected = rejectInvalidEditPayloads(parsed.data);
  if (payloadRejected !== undefined) {
    return payloadRejected;
  }
  const path = resolveFilePath(settings.workdir, parsed.data.file_path);
  const loaded = loadTextFile(path, { maxFileBytes: settings.maxFileBytes });
  if (!loaded.ok) {
    return failedToolResult(TOOL_OUTCOME_KINDS.invalidInput, loaded.message);
  }
  const stale = editFreshnessGuard(tracker, path, loaded);
  if (stale !== undefined) {
    return stale;
  }
  const plan = planEdits(loaded.content, parsed.data.edits);
  if (!plan.ok) {
    return plan.result;
  }
  const diff = describeFileChange({
    workdir: settings.workdir,
    inputPath: parsed.data.file_path,
    change: "modify",
    before: loaded.content,
    after: plan.next,
  });
  const displayPath = formatPathForApproval(settings.workdir, parsed.data.file_path);
  const external = escapesWorkdir(settings.workdir, parsed.data.file_path);
  const memoryKey = external ? undefined : `${EDIT_FILE_TOOL_NAME}:workdir`;
  return gateToolCall(ctx, FILE_TOOLS_AGENT_NAME, EDIT_FILE_TOOL_NAME, parsed.data, EDIT_ANNOTATIONS, {
    explanation: `修改 ${displayPath}：${String(parsed.data.edits.length)} 处编辑`,
    ...(diff !== undefined ? { diff } : {}),
    ...(memoryKey !== undefined ? { memoryKey, sessionGrantLabel: "本会话内不再询问：修改工作目录内的文件" } : {}),
  });
},
```

`executeEditFile` 末尾改为：

```ts
  const diff = describeFileChange({
    workdir: settings.workdir,
    inputPath: input.file_path,
    change: "modify",
    before: loaded.content,
    after: plan.next,
  });
  saveTextFile(path, plan.next, loaded.hadBom);
  tracker.recordKnownContent(loaded.key, plan.next);
  return fileChangeToolResult(renderEditSuccess(path, plan.next, plan.applied, settings.maxOutputChars), diff);
```

- [ ] **Step 7: 跑测试**：`node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/tool-bridge/file-tools/edit-file-tool.test.ts packages/runtime/src/tool-bridge/file-tools/file-change-result.test.ts && pnpm --filter @roll-agent/runtime typecheck` → PASS。若既有测试因「以前 execute 阶段才失败、现在 prepare 就失败」而改变了 outcome（例如通过 `buildEditFileTool` 走完整链路的用例），检查断言的是 outcome kind 与消息——它们应完全相同；只有 `approvals.length` 会从 1 变 0，那是本次有意的行为变化，更新断言并在 commit message 说明。

- [ ] **Step 8: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/file-change-result.ts packages/runtime/src/tool-bridge/file-tools/file-change-result.test.ts packages/runtime/src/tool-bridge/file-tools/edit-file-tool.ts packages/runtime/src/tool-bridge/file-tools/edit-file-tool.test.ts
git commit -m "feat(runtime): edit_file previews diff before approval and returns {text, diff} display"
```

---

### Task 6: runtime — `write_file` 审批预览 + 结果 diff

**Files:**
- Modify: `packages/runtime/src/tool-bridge/file-tools/write-file-tool.ts`（`prepare` :160-198、`executeWriteFile` :110-150）
- Test: `packages/runtime/src/tool-bridge/file-tools/write-file-tool.test.ts`

**Interfaces:**
- Consumes: `describeFileChange`、`fileChangeToolResult`（Task 5）、`splitUtf8Bom`（file-io）

- [ ] **Step 1: 写失败测试**（追加；`buildWriteFixture` 是文件里已有的 helper）

```ts
test("write_file 新建文件的审批 diff 为 create 且全部新增，写入后 display 含 diff", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-diff-create-"));
  const approvals: ApprovalRequest[] = [];
  const tools = buildWriteFixture(workdir, new FileStateTracker(), approvals, new SessionApprovalMemory());
  const writeTool = tools.roll__write_file;
  assert.ok(writeTool?.execute !== undefined);
  const result = (await writeTool.execute(
    { file_path: "fresh.txt", content: "a\nb\n" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.diff?.change, "create");
  assert.equal(approvals[0]?.diff?.added, 2);
  assert.equal(approvals[0]?.diff?.removed, 0);
  assert.match(approvals[0]?.diff?.unified ?? "", /^--- \/dev\/null\n\+\+\+ b\/fresh\.txt\n/u);
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
  const display = result.display as { text: string; diff: { change: string } };
  assert.match(display.text, /已写入/u);
  assert.equal(display.diff.change, "create");
  assert.deepEqual(result.model, { type: "text", value: display.text });
});

test("write_file 覆盖已读文件时审批 diff 为 modify 并给出增删统计", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "write-tool-diff-modify-"));
  const path = join(workdir, "doc.md");
  writeFileSync(path, "one\ntwo\nthree\n", "utf8");
  const tracker = new FileStateTracker();
  tracker.recordKnownContent(canonicalFileKey(path), "one\ntwo\nthree\n");
  const approvals: ApprovalRequest[] = [];
  const tools = buildWriteFixture(workdir, tracker, approvals, new SessionApprovalMemory());
  const writeTool = tools.roll__write_file;
  assert.ok(writeTool?.execute !== undefined);
  const result = (await writeTool.execute(
    { file_path: "doc.md", content: "one\n2\nthree\nfour\n" },
    executeOptions(),
  )) as NormalizedToolResult;
  assert.equal(approvals[0]?.diff?.change, "modify");
  assert.equal(approvals[0]?.diff?.added, 2);
  assert.equal(approvals[0]?.diff?.removed, 1);
  assert.equal(result.outcome.kind, TOOL_OUTCOME_KINDS.success);
});
```

（按需补 import：`canonicalFileKey` 来自 `./file-io.ts`，`writeFileSync` 来自 `node:fs`。）

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

`prepare` 中，`detectShrink` 之后、`gateToolCall` 之前加：

```ts
const { content: newContent } = splitUtf8Bom(parsed.data.content);
const change: FileChangeKind | undefined = loaded.ok
  ? "modify"
  : loaded.code === "not-found"
    ? "create"
    : undefined;
const diff =
  change === undefined
    ? undefined
    : describeFileChange({
        workdir: settings.workdir,
        inputPath: parsed.data.file_path,
        change,
        before: loaded.ok ? loaded.content : "",
        after: newContent,
      });
```

`gateToolCall` 的 display options 中 `explanation,` 之后加 `...(diff !== undefined ? { diff } : {}),`。

`executeWriteFile`：把 `existing === true` 分支里 `loaded` 提升到外层（`let before: string | undefined`），保存后：

```ts
const diff = describeFileChange({
  workdir: settings.workdir,
  inputPath: input.file_path,
  change: before === undefined ? "create" : "modify",
  before: before ?? "",
  after: content,
});
…
return fileChangeToolResult(parts.join("\n"), diff);
```

（`existing === true` 且 `loaded.ok` 时 `before = loaded.content`；否则保持 `undefined`。`FileChangeKind` 从 `@roll-agent/protocol` `import type`。）

- [ ] **Step 4: 跑测试**：`node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/tool-bridge/file-tools/write-file-tool.test.ts && pnpm --filter @roll-agent/runtime typecheck` → PASS

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/tool-bridge/file-tools/write-file-tool.ts packages/runtime/src/tool-bridge/file-tools/write-file-tool.test.ts
git commit -m "feat(runtime): write_file previews diff before approval and returns {text, diff} display"
```

---

### Task 7: runtime — 端到端事件测试 + `--server` 投影 + 恢复证据文本

**Files:**
- Modify: `packages/runtime/src/service/runtime-service.ts:490-513`（`toPendingApproval`）
- Modify: `packages/runtime/src/engine/cancelled-turn-recovery.ts:115-125`（`formatEvidence`）
- Test: `packages/runtime/src/engine/agent-session.test.ts`（在 `AgentSession.approve 的 scope 透传…` 用例后加一条）、`packages/runtime/src/service/runtime-service.test.ts`（fixture 补 diff + 断言）、`packages/runtime/src/engine/cancelled-turn-recovery.test.ts`

- [ ] **Step 1: agent-session 端到端失败测试**

```ts
test("AgentSession 的 edit_file 确认事件携带 diff，成功后的 tool-result display 为 {text, diff}", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-session-diff-"));
  writeFileSync(join(workdir, "a.txt"), "第一行\n第二行\n", "utf8");
  const model = sequencedModel([
    toolCallStep("roll__read_file", { path: "a.txt" }),
    toolCallStep("roll__edit_file", {
      file_path: "a.txt",
      edits: [{ old_string: "第一行", new_string: "改后一" }],
    }),
    textStep("完成"),
  ]);
  const session = new AgentSession({
    id: "diff-passthrough",
    model,
    sources: [],
    fileTools: { workdir },
    maxSteps: 8,
    policy: new DefaultToolPolicy(),
  });
  const events: SessionEvent[] = [];
  for await (const event of session.send("改第一行")) {
    events.push(event);
    if (event.type === "confirmation-required") {
      session.approve(event.approvalId);
    }
  }
  const confirmation = events.find((event) => event.type === "confirmation-required");
  assert.ok(confirmation && confirmation.type === "confirmation-required");
  assert.equal(confirmation.diff?.path, "a.txt");
  assert.equal(confirmation.diff?.added, 1);
  assert.equal(confirmation.diff?.removed, 1);
  const result = events.find((event) => event.type === "tool-result" && event.toolName === "edit_file");
  assert.ok(result && result.type === "tool-result");
  const display = getFileChangeDisplay(result.display);
  assert.ok(display);
  assert.deepEqual(display.diff, confirmation.diff);
  assert.match(display.text, /已完成 1 处修改/u);
});
```

（`getFileChangeDisplay` 从 `@roll-agent/protocol` import。）

- [ ] **Step 2: runtime-service 测试**：在 `createFixture` 的 `confirmation-required` yield 里加

```ts
diff: {
  path: "demo",
  change: "modify",
  added: 1,
  removed: 1,
  hunks: 1,
  unified: "--- a/demo\n+++ b/demo\n@@ -1,1 +1,1 @@\n-secret-preview\n+new\n",
  truncated: false,
},
```

在 `tool-result` yield 的 `display` 改为 `{ text: "visible", diff: { path: "demo", change: "modify", added: 1, removed: 1, hunks: 1, unified: "--- a/demo\n+++ b/demo\n@@ -1,1 +1,1 @@\n-x\n+y\n", truncated: false }, providerOptions: { configuration: TOOL_PROVIDER_OPTIONS_SENTINEL } }` —— 注意 `fileChangeDisplaySchema` 非 strict，会剥掉 `providerOptions`，既有「display 不含 sentinel」断言不受影响。

在既有断言 `getApprovalExplanation(...) === "写入用户请求的文件…"` 旁加：

```ts
const previewDiff = getApprovalDiffPreview(approvalEvent.event.approval);
assert.equal(previewDiff?.added, 1);
assert.equal(previewDiff?.path, "demo");
assert.equal(JSON.stringify(previewDiff).includes("secret-preview"), false);
```

（`unified` 里的 `secret-preview` 会被 `safeJson` 的 `redactSecretText` 处理与否取决于其规则；若断言失败，把 fixture 里 unified 内容改为不含敏感词的 `-old\n+new\n`，并保留 `previewDiff?.added === 1` 断言即可。）在 `tool.completed` 断言旁加：

```ts
const completedEvent = events.find((event) => event.event.type === "tool.completed");
assert.ok(completedEvent?.event.type === "tool.completed");
assert.equal(getFileChangeDisplay(completedEvent.event.display)?.diff.added, 1);
```

- [ ] **Step 3: cancelled-turn-recovery 测试**：找到该文件里构造 `ToolExecutionRecord` 的 helper，添加一条用例：display 为 `{ text: "已写入 a.txt", diff: {...最小合法 diff...} }` 时，`buildModelContext`/证据里的 `displayPreview` 等于 `"已写入 a.txt"`（不含 `"unified"` 字样）。具体调用面以文件内既有测试为准。

- [ ] **Step 4: 跑三份测试确认失败**

- [ ] **Step 5: 实现**

`runtime-service.ts` `toPendingApproval`：

```ts
function toPendingApproval(turnId: TurnId, event: Extract<SessionEvent, { readonly type: "confirmation-required" }>): PendingApproval {
  const safePreview = safeJson(event.input, undefined);
  const parsedExplanation =
    event.explanation === undefined ? undefined : approvalExplanationSchema.safeParse(redactSecretText(event.explanation));
  const safeDiff = event.diff === undefined ? undefined : safeJson(event.diff, undefined);
  const preview = isRecord(safePreview)
    ? {
        ...safePreview,
        ...(parsedExplanation?.success === true ? { [APPROVAL_EXPLANATION_PREVIEW_KEY]: parsedExplanation.data } : {}),
        ...(safeDiff !== undefined ? { [APPROVAL_DIFF_PREVIEW_KEY]: safeDiff } : {}),
      }
    : safePreview;
  return { id: approvalIdSchema.parse(event.approvalId), turnId, agentName: event.agentName, toolName: event.toolName, preview, ...(event.reason !== undefined ? { reason: redactSecretText(event.reason) } : {}) };
}
```

（`APPROVAL_DIFF_PREVIEW_KEY` 加进该文件顶部 `@roll-agent/protocol` import 列表。）

`cancelled-turn-recovery.ts` `formatEvidence`：

```ts
const value = summary.display.value;
const fileChange = getFileChangeDisplay(value);
const serialized = fileChange !== undefined ? fileChange.text : typeof value === "string" ? value : JSON.stringify(value);
```

（`import { getFileChangeDisplay } from "@roll-agent/protocol";`）

- [ ] **Step 6: 跑测试**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/engine/agent-session.test.ts packages/runtime/src/service/runtime-service.test.ts packages/runtime/src/engine/cancelled-turn-recovery.test.ts && pnpm --filter @roll-agent/runtime typecheck && pnpm --filter @roll-agent/runtime test`
Expected: PASS（`agent-session.test.ts` 很大，耐心等）

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src
git commit -m "feat(runtime): project file change diff into approval preview and keep recovery evidence textual"
```

---

### Task 8: core — unified diff 解析与终端格式化 `unified-diff.ts` + `diff-display.ts`

**Files:**
- Create: `packages/core/src/cli/utils/unified-diff.ts`
- Create: `packages/core/src/cli/chat/diff-display.ts`
- Modify: `packages/core/src/cli/utils/tool-format.ts:20`（`sanitizeForDisplay` 加 `export`）
- Test: `packages/core/src/cli/utils/unified-diff.test.ts`、`packages/core/src/cli/chat/diff-display.test.ts`

**Interfaces:**
- Consumes: `FileChangeDiff`（`@roll-agent/runtime` re-export）
- Produces:
  ```ts
  // unified-diff.ts
  export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context" | "note";
  export interface DiffLine { readonly kind: DiffLineKind; readonly text: string; readonly oldLine?: number; readonly newLine?: number }
  export function parseUnifiedDiff(unified: string): readonly DiffLine[];
  export function diffBodyLines(diff: FileChangeDiff): readonly DiffLine[];   // 去掉 meta
  export function formatDiffStats(diff: FileChangeDiff): string;             // "+3 −2"
  export function formatDiffHeader(diff: FileChangeDiff): string;            // "src/a.ts  +3 −2" (+ "  新建" / "  已截断" / "  正文省略（文件过大）")
  export function formatDiffGutter(line: DiffLine, width: number): string;   // "  12   13 " 风格行号栏
  export interface FormatDiffOptions { readonly color: boolean; readonly maxBodyLines?: number; readonly collapsedHint?: string }
  export function formatFileChangeDiffLines(diff: FileChangeDiff, options: FormatDiffOptions): readonly string[];
  // diff-display.ts
  export const DIFF_DISPLAY_MODES = ["collapsed", "expanded"] as const;
  export type DiffDisplayMode = (typeof DIFF_DISPLAY_MODES)[number];
  export const DIFF_INLINE_MAX_LINES = 40;
  export function shouldExpandDiff(bodyLineCount: number, mode: DiffDisplayMode): boolean;
  export function resolveDiffDisplayToggle(arg: string, current: DiffDisplayMode): DiffDisplayMode; // on|expanded→expanded, off|collapsed→collapsed, 其它→切换
  export function diffDisplayNotice(mode: DiffDisplayMode): string;
  ```

- [ ] **Step 1: 写失败测试 `unified-diff.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { FileChangeDiff } from "@roll-agent/runtime";
import { formatDiffHeader, formatFileChangeDiffLines, parseUnifiedDiff } from "./unified-diff.ts";

const UNIFIED = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -3,4 +3,4 @@",
  " line 3",
  "-line 4",
  "+line four",
  " line 5",
  "@@ -10,1 +10,2 @@",
  " x",
  "+y",
  "\\ No newline at end of file",
  "",
].join("\n");

const DIFF: FileChangeDiff = { path: "src/a.ts", change: "modify", added: 2, removed: 1, hunks: 2, unified: UNIFIED, truncated: false };

test("parseUnifiedDiff 标注类型并跟踪新旧行号", () => {
  const lines = parseUnifiedDiff(UNIFIED);
  assert.deepEqual(lines.slice(0, 2).map((l) => l.kind), ["meta", "meta"]);
  assert.deepEqual(lines[2], { kind: "hunk", text: "@@ -3,4 +3,4 @@" });
  assert.deepEqual(lines[3], { kind: "context", text: "line 3", oldLine: 3, newLine: 3 });
  assert.deepEqual(lines[4], { kind: "del", text: "line 4", oldLine: 4 });
  assert.deepEqual(lines[5], { kind: "add", text: "line four", newLine: 4 });
  assert.deepEqual(lines[6], { kind: "context", text: "line 5", oldLine: 5, newLine: 5 });
  assert.deepEqual(lines[8], { kind: "context", text: "x", oldLine: 10, newLine: 10 });
  assert.deepEqual(lines[9], { kind: "add", text: "y", newLine: 11 });
  assert.deepEqual(lines[10], { kind: "note", text: "\\ No newline at end of file" });
});

test("parseUnifiedDiff 只在首个 hunk 之前把 ---/+++ 当文件头", () => {
  const lines = parseUnifiedDiff("--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n--- not meta\n+++ also not meta\n");
  assert.deepEqual(lines.slice(3).map((l) => l.kind), ["del", "add"]);
  assert.equal(lines[3]?.text, "-- not meta");
});

test("formatDiffHeader 含路径、统计与状态标签", () => {
  assert.equal(formatDiffHeader(DIFF), "src/a.ts  +2 −1");
  assert.equal(formatDiffHeader({ ...DIFF, change: "create" }), "src/a.ts  +2 −1  新建");
  assert.equal(formatDiffHeader({ ...DIFF, truncated: true }), "src/a.ts  +2 −1  已截断");
  const { unified: _u, ...statsOnly } = DIFF;
  assert.equal(formatDiffHeader(statsOnly), "src/a.ts  +2 −1  正文省略（文件过大）");
});

test("formatFileChangeDiffLines 无色模式输出行号栏与前缀，超过上限时折叠并给提示", () => {
  const lines = formatFileChangeDiffLines(DIFF, { color: false });
  assert.equal(lines[0], "src/a.ts  +2 −1");
  assert.ok(lines.some((l) => /^\s*4\s+-\s?line 4$/u.test(l) || l.includes("- line 4")));
  const collapsed = formatFileChangeDiffLines(DIFF, { color: false, maxBodyLines: 2, collapsedHint: "/diff on 展开" });
  assert.equal(collapsed.length, 4);
  assert.match(collapsed[3] ?? "", /另 \d+ 行/u);
  assert.match(collapsed[3] ?? "", /\/diff on 展开/u);
});

test("formatFileChangeDiffLines 着色模式剥掉 ANSI 后与无色一致，且控制字符被清洗", () => {
  const dirty: FileChangeDiff = { ...DIFF, unified: "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a[31mb\n+ok\n" };
  const colored = formatFileChangeDiffLines(dirty, { color: true }).map((l) => stripVTControlCharacters(l));
  const plain = formatFileChangeDiffLines(dirty, { color: false });
  assert.deepEqual(colored, plain);
  assert.ok(plain.every((l) => !l.includes("")));
});
```

- [ ] **Step 2: 写失败测试 `diff-display.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIFF_INLINE_MAX_LINES, resolveDiffDisplayToggle, shouldExpandDiff } from "./diff-display.ts";

test("shouldExpandDiff：collapsed 下只展开不超过阈值的 diff，expanded 下全部展开", () => {
  assert.equal(shouldExpandDiff(DIFF_INLINE_MAX_LINES, "collapsed"), true);
  assert.equal(shouldExpandDiff(DIFF_INLINE_MAX_LINES + 1, "collapsed"), false);
  assert.equal(shouldExpandDiff(9_999, "expanded"), true);
});

test("resolveDiffDisplayToggle 解析 on/off/expanded/collapsed，其余切换", () => {
  assert.equal(resolveDiffDisplayToggle("on", "collapsed"), "expanded");
  assert.equal(resolveDiffDisplayToggle("expanded", "collapsed"), "expanded");
  assert.equal(resolveDiffDisplayToggle("off", "expanded"), "collapsed");
  assert.equal(resolveDiffDisplayToggle("collapsed", "expanded"), "collapsed");
  assert.equal(resolveDiffDisplayToggle("", "collapsed"), "expanded");
  assert.equal(resolveDiffDisplayToggle("", "expanded"), "collapsed");
});
```

- [ ] **Step 3: 跑测试确认失败**：`node --experimental-strip-types --test packages/core/src/cli/utils/unified-diff.test.ts packages/core/src/cli/chat/diff-display.test.ts`

- [ ] **Step 4: 实现**

`tool-format.ts:20`：`function sanitizeForDisplay` → `export function sanitizeForDisplay`。

`unified-diff.ts`：

```ts
import chalk from "chalk";
import type { FileChangeDiff } from "@roll-agent/runtime";
import { sanitizeForDisplay } from "./tool-format.ts";

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context" | "note";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface FormatDiffOptions {
  readonly color: boolean;
  readonly maxBodyLines?: number;
  readonly collapsedHint?: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

export function parseUnifiedDiff(unified: string): readonly DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const raw = unified.endsWith("\n") ? unified.slice(0, -1) : unified;
  if (raw.length === 0) {
    return out;
  }
  for (const line of raw.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      out.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("\\")) {
      out.push({ kind: "note", text: line });
      continue;
    }
    const body = line.slice(1);
    if (line.startsWith("+")) {
      out.push({ kind: "add", text: body, newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", text: body, oldLine });
      oldLine += 1;
    } else {
      out.push({ kind: "context", text: body, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return out;
}

export function diffBodyLines(diff: FileChangeDiff): readonly DiffLine[] {
  return diff.unified === undefined ? [] : parseUnifiedDiff(diff.unified).filter((line) => line.kind !== "meta");
}

export function formatDiffStats(diff: FileChangeDiff): string {
  return `+${String(diff.added)} −${String(diff.removed)}`;
}

export function formatDiffHeader(diff: FileChangeDiff): string {
  const tags = [
    ...(diff.change === "create" ? ["新建"] : []),
    ...(diff.unified === undefined ? ["正文省略（文件过大）"] : diff.truncated ? ["已截断"] : []),
  ];
  return [sanitizeForDisplay(diff.path), formatDiffStats(diff), ...tags].join("  ");
}

function gutterWidth(lines: readonly DiffLine[]): number {
  const max = lines.reduce((acc, line) => Math.max(acc, line.oldLine ?? 0, line.newLine ?? 0), 0);
  return Math.max(1, String(max).length);
}

export function formatDiffGutter(line: DiffLine, width: number): string {
  const left = line.oldLine === undefined ? "" : String(line.oldLine);
  const right = line.newLine === undefined ? "" : String(line.newLine);
  return `${left.padStart(width)} ${right.padStart(width)} `;
}

const PREFIXES: Record<DiffLineKind, string> = { meta: "", hunk: "", add: "+", del: "-", context: " ", note: "" };

function paint(kind: DiffLineKind, text: string, color: boolean): string {
  if (!color) {
    return text;
  }
  switch (kind) {
    case "add":
      return chalk.green(text);
    case "del":
      return chalk.red(text);
    case "hunk":
      return chalk.cyan(text);
    case "note":
    case "meta":
      return chalk.dim(text);
    default:
      return text;
  }
}

export function formatFileChangeDiffLines(diff: FileChangeDiff, options: FormatDiffOptions): readonly string[] {
  const header = formatDiffHeader(diff);
  const body = diffBodyLines(diff);
  const width = gutterWidth(body);
  const limit = options.maxBodyLines === undefined ? body.length : Math.max(0, options.maxBodyLines);
  const visible = body.slice(0, limit);
  const rendered = visible.map((line) => {
    const gutter = line.kind === "hunk" || line.kind === "note" ? " ".repeat(width * 2 + 2) : formatDiffGutter(line, width);
    const text = `${PREFIXES[line.kind]}${sanitizeForDisplay(line.text)}`;
    return `${options.color ? chalk.dim(gutter) : gutter}${paint(line.kind, text, options.color)}`;
  });
  const hidden = body.length - visible.length;
  const tail =
    hidden > 0
      ? [`… 另 ${String(hidden)} 行${options.collapsedHint !== undefined ? `（${options.collapsedHint}）` : ""}`]
      : [];
  return [options.color ? chalk.bold(header) : header, ...rendered, ...tail.map((t) => (options.color ? chalk.dim(t) : t))];
}
```

`diff-display.ts`：

```ts
export const DIFF_DISPLAY_MODES = ["collapsed", "expanded"] as const;
export type DiffDisplayMode = (typeof DIFF_DISPLAY_MODES)[number];
export const DIFF_INLINE_MAX_LINES = 40;

export function shouldExpandDiff(bodyLineCount: number, mode: DiffDisplayMode): boolean {
  return mode === "expanded" || bodyLineCount <= DIFF_INLINE_MAX_LINES;
}

export function resolveDiffDisplayToggle(arg: string, current: DiffDisplayMode): DiffDisplayMode {
  const lowered = arg.trim().toLowerCase();
  if (lowered === "on" || lowered === "expanded") {
    return "expanded";
  }
  if (lowered === "off" || lowered === "collapsed") {
    return "collapsed";
  }
  return current === "collapsed" ? "expanded" : "collapsed";
}

export function diffDisplayNotice(mode: DiffDisplayMode): string {
  return mode === "expanded"
    ? "文件变更 diff 将完整显示（仅当前会话生效）"
    : `超过 ${String(DIFF_INLINE_MAX_LINES)} 行的 diff 将折叠为一行摘要，/diff on 可展开（仅当前会话生效）`;
}
```

- [ ] **Step 5: 跑测试**：上述两个测试文件 + `pnpm --filter @roll-agent/core typecheck` → PASS。若 chalk 在测试环境无色（非 TTY）导致「着色模式剥 ANSI 后一致」测试无法验证颜色，这是预期——该测试仍验证清洗与结构；不要为了它强制 `FORCE_COLOR`。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/cli/utils/unified-diff.ts packages/core/src/cli/utils/unified-diff.test.ts packages/core/src/cli/chat/diff-display.ts packages/core/src/cli/chat/diff-display.test.ts packages/core/src/cli/utils/tool-format.ts
git commit -m "feat(core): unified diff parsing, terminal formatting and diff display mode helpers"
```

---

### Task 9: core — 基础 REPL：审批消息与结果输出 diff，`/diff` 开关

**Files:**
- Modify: `packages/core/src/cli/utils/chat-renderer.ts:98-195`
- Modify: `packages/core/src/cli/commands/chat.ts:520-545`（REPL 循环加 `/diff`）
- Test: `packages/core/src/cli/utils/chat-renderer.test.ts`

**Interfaces:**
- Consumes: `formatFileChangeDiffLines`、`DIFF_INLINE_MAX_LINES`、`resolveDiffDisplayToggle`、`diffDisplayNotice`（Task 8）、`getFileChangeDisplay`（runtime re-export）
- Produces: `ChatRenderer.diffDisplay: DiffDisplayMode`（getter）、`ChatRenderer.setDiffDisplay(mode)`

- [ ] **Step 1: 写失败测试**（追加到 `chat-renderer.test.ts`；捕获 stderr 用 `process.stderr.write` 打桩）

```ts
const DIFF_FIXTURE = {
  path: "a.txt",
  change: "modify",
  added: 1,
  removed: 1,
  hunks: 1,
  unified: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
  truncated: false,
} as const;

function captureStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  return run().then(
    () => {
      process.stderr.write = original;
      return out;
    },
    (error: unknown) => {
      process.stderr.write = original;
      throw error;
    },
  );
}

test("确认消息在有 diff 时内嵌 diff 头与正文而不是原始 edits JSON", async () => {
  let message = "";
  const renderer = new ChatRenderer(async (m) => {
    message = m;
    return false;
  });
  await renderer.handle(
    {
      type: "confirmation-required",
      approvalId: "ap-1",
      agentName: "roll",
      toolName: "edit_file",
      input: { file_path: "a.txt", edits: [{ old_string: "old", new_string: "new" }] },
      explanation: "修改 a.txt：1 处编辑",
      diff: DIFF_FIXTURE,
    },
    { approve() {}, reject() {} },
  );
  const plain = stripVTControlCharacters(message);
  assert.match(plain, /^执行 roll\.edit_file\?\nAI 说明：修改 a\.txt：1 处编辑\na\.txt  \+1 −1\n/u);
  assert.match(plain, /-old/u);
  assert.match(plain, /\+new/u);
  assert.doesNotMatch(plain, /old_string/u);
});

test("tool-result 的 {text, diff} display 在 stderr 打印 diff，且受 /diff 折叠模式控制", async () => {
  const bigUnified = ["--- a/b.txt", "+++ b/b.txt", "@@ -1,50 +1,50 @@", ...Array.from({ length: 50 }, (_, i) => `-r${String(i)}`), ...Array.from({ length: 50 }, (_, i) => `+R${String(i)}`), ""].join("\n");
  const big = { ...DIFF_FIXTURE, path: "b.txt", added: 50, removed: 50, unified: bigUnified };
  const renderer = new ChatRenderer(async () => true);
  const collapsed = await captureStderr(async () => {
    await renderer.handle({ type: "tool-call", toolCallId: "c1", agentName: "roll", toolName: "write_file", input: {} }, { approve() {}, reject() {} });
    await renderer.handle({ type: "tool-result", toolCallId: "c1", agentName: "roll", toolName: "write_file", output: "", isError: false, display: { text: "已写入 b.txt", diff: big } }, { approve() {}, reject() {} });
  });
  const collapsedPlain = stripVTControlCharacters(collapsed);
  assert.match(collapsedPlain, /b\.txt  \+50 −50/u);
  assert.match(collapsedPlain, /另 \d+ 行（\/diff on 展开）/u);
  renderer.setDiffDisplay("expanded");
  assert.equal(renderer.diffDisplay, "expanded");
  const expanded = await captureStderr(async () => {
    await renderer.handle({ type: "tool-call", toolCallId: "c2", agentName: "roll", toolName: "write_file", input: {} }, { approve() {}, reject() {} });
    await renderer.handle({ type: "tool-result", toolCallId: "c2", agentName: "roll", toolName: "write_file", output: "", isError: false, display: { text: "已写入 b.txt", diff: big } }, { approve() {}, reject() {} });
  });
  assert.doesNotMatch(stripVTControlCharacters(expanded), /另 \d+ 行/u);
  assert.match(stripVTControlCharacters(expanded), /\+R49/u);
});
```

（`stripVTControlCharacters` 从 `node:util` import。ora spinner 在非 TTY 下会直接写 stderr，一并被捕获——断言用 `match` 而非 `equal`。）

- [ ] **Step 2: 跑测试确认失败**：`node --experimental-strip-types --test packages/core/src/cli/utils/chat-renderer.test.ts`

- [ ] **Step 3: 实现 `chat-renderer.ts`**

import 加：`import { getFileChangeDisplay } from "@roll-agent/runtime";`、`import { formatFileChangeDiffLines } from "./unified-diff.ts";`、`import { DIFF_INLINE_MAX_LINES, type DiffDisplayMode } from "../chat/diff-display.ts";`。

类内加：

```ts
private diffDisplayMode: DiffDisplayMode = "collapsed";

get diffDisplay(): DiffDisplayMode {
  return this.diffDisplayMode;
}

setDiffDisplay(mode: DiffDisplayMode): void {
  this.diffDisplayMode = mode;
}

private writeDiff(diff: FileChangeDiff, maxBodyLines: number | undefined, hint: string | undefined): void {
  const lines = formatFileChangeDiffLines(diff, {
    color: true,
    ...(maxBodyLines !== undefined ? { maxBodyLines } : {}),
    ...(hint !== undefined ? { collapsedHint: hint } : {}),
  });
  process.stderr.write(`${lines.join("\n")}\n`);
}
```

（`FileChangeDiff` 类型从 `@roll-agent/runtime` `import type`。）

`tool-result` 分支，`this.toolLabels.delete(...)` 之后加：

```ts
const fileChange = event.isError ? undefined : getFileChangeDisplay(event.display);
if (fileChange !== undefined) {
  this.writeDiff(
    fileChange.diff,
    this.diffDisplayMode === "expanded" ? undefined : DIFF_INLINE_MAX_LINES,
    this.diffDisplayMode === "expanded" ? undefined : "/diff on 展开",
  );
}
```

`confirmation-required` 分支把 `message` 的组装改为：

```ts
const body =
  event.diff !== undefined
    ? formatFileChangeDiffLines(event.diff, { color: true, maxBodyLines: DIFF_INLINE_MAX_LINES }).join("\n")
    : formatApprovalDetails(event.input);
const message = [header, explanation, body].filter((line) => line.length > 0).join("\n");
```

`chat.ts` REPL 循环 `if (input === "/skills")` 之前加：

```ts
if (input === "/diff" || input.startsWith("/diff ")) {
  const next = resolveDiffDisplayToggle(input.slice("/diff".length), renderer.diffDisplay);
  renderer.setDiffDisplay(next);
  log.info(diffDisplayNotice(next));
  continue;
}
```

（import `resolveDiffDisplayToggle, diffDisplayNotice` from `../chat/diff-display.ts`。）

- [ ] **Step 4: 跑测试**：`node --experimental-strip-types --test packages/core/src/cli/utils/chat-renderer.test.ts packages/core/src/cli/commands/chat.test.ts && pnpm --filter @roll-agent/core typecheck` → PASS（`chat.test.ts` 钉死的 bash 审批字符串不含 diff，不受影响）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli/utils/chat-renderer.ts packages/core/src/cli/utils/chat-renderer.test.ts packages/core/src/cli/commands/chat.ts
git commit -m "feat(core): basic REPL shows file diffs on approval and after apply, /diff toggles folding"
```

---

### Task 10: core Ink — state：tool 项与 PendingConfirm 携带 diff，`diffDisplay` 开关

**Files:**
- Modify: `packages/core/src/cli/chat/ink/state.ts`（`HistoryItem` tool 变体、`PendingConfirm`、`ChatUiState`、`ChatUiAction`、`InitialStateOptions`、`createInitialState`、`commitTool`、`confirmation-required` 分支、reducer）
- Test: `packages/core/src/cli/chat/ink/state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // HistoryItem tool 变体
  { kind: "tool"; id; name; args; ok; readonly diff?: FileChangeDiff }
  export interface PendingConfirm { …; readonly diff?: FileChangeDiff }
  export interface ChatUiState { …; readonly diffDisplay: DiffDisplayMode }
  | { readonly type: "set-diff-display"; readonly value: DiffDisplayMode }
  export interface InitialStateOptions { …; readonly diffDisplay?: DiffDisplayMode }
  ```

- [ ] **Step 1: 写失败测试**（追加到 `state.test.ts`，复用文件里的 `event(state, id, sessionEvent)` helper 与 `createInitialState`）

```ts
const STATE_DIFF = {
  path: "a.txt",
  change: "modify",
  added: 1,
  removed: 1,
  hunks: 1,
  unified: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
  truncated: false,
} as const;

test("tool-result 的 {text, diff} display 让 tool 历史项携带 diff；纯文本 display 不带", () => {
  let state = createInitialState("m", undefined);
  state = event(state, "e1", { type: "tool-call", toolCallId: "c1", agentName: "roll", toolName: "edit_file", input: { file_path: "a.txt" } });
  state = event(state, "e2", { type: "tool-result", toolCallId: "c1", agentName: "roll", toolName: "edit_file", output: "", isError: false, display: { text: "已完成", diff: STATE_DIFF } });
  const item = state.history.at(-1);
  assert.ok(item?.kind === "tool");
  assert.deepEqual(item.diff, STATE_DIFF);
  let plain = createInitialState("m", undefined);
  plain = event(plain, "e3", { type: "tool-call", toolCallId: "c2", agentName: "roll", toolName: "bash", input: {} });
  plain = event(plain, "e4", { type: "tool-result", toolCallId: "c2", agentName: "roll", toolName: "bash", output: "ok", isError: false, display: "ok" });
  const plainItem = plain.history.at(-1);
  assert.ok(plainItem?.kind === "tool");
  assert.equal(Object.hasOwn(plainItem, "diff"), false);
});

test("confirmation-required 的 diff 进入 pendingConfirm", () => {
  let state = createInitialState("m", undefined);
  state = event(state, "e1", { type: "confirmation-required", approvalId: "ap", agentName: "roll", toolName: "edit_file", input: { file_path: "a.txt" }, diff: STATE_DIFF });
  assert.deepEqual(state.pendingConfirm?.diff, STATE_DIFF);
});

test("set-diff-display 切换会话级 diff 折叠模式，默认 collapsed", () => {
  const state = createInitialState("m", undefined);
  assert.equal(state.diffDisplay, "collapsed");
  const next = chatUiReducer(state, { type: "set-diff-display", value: "expanded" });
  assert.equal(next.diffDisplay, "expanded");
});
```

（reducer 函数名以 `state.ts` 里实际导出为准，`grep -n "^export function" packages/core/src/cli/chat/ink/state.ts`。）

- [ ] **Step 2: 跑测试确认失败**：`node --experimental-strip-types --test packages/core/src/cli/chat/ink/state.test.ts`

- [ ] **Step 3: 实现**

`state.ts` import：`import { TOOL_OUTCOME_KINDS, getFileChangeDisplay, type FileChangeDiff, type SessionEvent, type SessionTokenUsage } from "@roll-agent/runtime";`、`import type { DiffDisplayMode } from "../diff-display.ts";`。

- `HistoryItem` tool 变体加 `readonly diff?: FileChangeDiff;`
- `PendingConfirm` 加 `readonly diff?: FileChangeDiff;`
- `ChatUiState` 加 `readonly diffDisplay: DiffDisplayMode;`
- `ChatUiAction` 加 `| { readonly type: "set-diff-display"; readonly value: DiffDisplayMode }`
- `InitialStateOptions` 加 `readonly diffDisplay?: DiffDisplayMode;`；`createInitialState` 返回里加 `diffDisplay: options?.diffDisplay ?? "collapsed",`
- `commitTool`：
  ```ts
  const fileChange = event.isError ? undefined : getFileChangeDisplay(event.display);
  const item: HistoryItem =
    denial !== undefined
      ? { kind: "denied", id, name, label: denial }
      : { kind: "tool", id, name, args, ok: !event.isError, ...(fileChange !== undefined ? { diff: fileChange.diff } : {}) };
  ```
- `confirmation-required` 分支 `pendingConfirm` 里加 `...(event.diff !== undefined ? { diff: event.diff } : {}),`
- reducer 加 `case "set-diff-display": return { ...state, diffDisplay: action.value };`

- [ ] **Step 4: 跑测试**：`node --experimental-strip-types --test packages/core/src/cli/chat/ink/state.test.ts packages/core/src/cli/chat/ink/live-region.test.ts && pnpm --filter @roll-agent/core typecheck`（typecheck 会暴露所有构造 `ChatUiState` 字面量的测试/代码需要补 `diffDisplay`——逐个补齐）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli/chat/ink/state.ts packages/core/src/cli/chat/ink/state.test.ts
git commit -m "feat(core): chat state carries file diffs on tool items and pending confirms, adds diffDisplay"
```

---

### Task 11: core Ink — `DiffBlock` / `DiffSummary` 组件

**Files:**
- Create: `packages/core/src/cli/chat/ink/diff-view.ts`
- Test: `packages/core/src/cli/chat/ink/diff-view.test.ts`

**Interfaces:**
- Consumes: `diffBodyLines`、`formatDiffHeader`、`formatDiffGutter`、`formatDiffStats`（Task 8）
- Produces:
  ```ts
  export interface DiffHeaderProps { readonly diff: FileChangeDiff }
  export function DiffHeader(props: DiffHeaderProps): ReactElement;   // 一行：path（bold）+ 绿色 +N + 红色 −M + dim 标签
  export interface DiffBlockProps { readonly diff: FileChangeDiff; readonly maxBodyLines?: number; readonly collapsedHint?: string }
  export function DiffBlock(props: DiffBlockProps): ReactElement;      // DiffHeader + 左边框 Box 内逐行渲染
  export interface DiffSummaryProps { readonly diff: FileChangeDiff; readonly hint?: string }
  export function DiffSummary(props: DiffSummaryProps): ReactElement;  // 一行：header + " · 已折叠" + hint
  export function diffBodyLineCount(diff: FileChangeDiff): number;
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createElement as h } from "react";
import { render } from "ink-testing-library";
import type { FileChangeDiff } from "@roll-agent/runtime";
import { DiffBlock, DiffSummary, diffBodyLineCount } from "./diff-view.ts";

const DIFF: FileChangeDiff = {
  path: "src/a.ts",
  change: "modify",
  added: 1,
  removed: 1,
  hunks: 1,
  unified: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n",
  truncated: false,
};

function frame(element: ReturnType<typeof h>): string {
  const { lastFrame, unmount } = render(element);
  try {
    return stripVTControlCharacters(lastFrame() ?? "");
  } finally {
    unmount();
  }
}

test("DiffBlock 渲染头行、hunk 头、行号栏与增删前缀", () => {
  const out = frame(h(DiffBlock, { diff: DIFF }));
  assert.match(out, /src\/a\.ts\s+\+1 −1/u);
  assert.match(out, /@@ -1,3 \+1,3 @@/u);
  assert.match(out, /1\s+1\s+ a/u);
  assert.match(out, /2\s+-b/u);
  assert.match(out, /2\s+\+B/u);
  assert.equal(diffBodyLineCount(DIFF), 5);
});

test("DiffBlock 超过 maxBodyLines 时截断并提示剩余行数", () => {
  const out = frame(h(DiffBlock, { diff: DIFF, maxBodyLines: 2, collapsedHint: "/diff on 展开" }));
  assert.match(out, /另 3 行（\/diff on 展开）/u);
  assert.doesNotMatch(out, /\+B/u);
});

test("DiffSummary 折叠为一行并带提示；正文省略时显示原因", () => {
  const out = frame(h(DiffSummary, { diff: DIFF, hint: "/diff 展开" }));
  assert.equal(out.split("\n").length, 1);
  assert.match(out, /src\/a\.ts\s+\+1 −1 · 已折叠 · \/diff 展开/u);
  const { unified: _u, ...statsOnly } = DIFF;
  assert.match(frame(h(DiffSummary, { diff: statsOnly })), /正文省略（文件过大）/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

```ts
import { createElement as h } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { FileChangeDiff } from "@roll-agent/runtime";
import { sanitizeForDisplay } from "../../utils/tool-format.ts";
import {
  diffBodyLines,
  formatDiffGutter,
  formatDiffHeader,
  type DiffLine,
} from "../../utils/unified-diff.ts";

export interface DiffHeaderProps {
  readonly diff: FileChangeDiff;
}

export interface DiffBlockProps {
  readonly diff: FileChangeDiff;
  readonly maxBodyLines?: number;
  readonly collapsedHint?: string;
}

export interface DiffSummaryProps {
  readonly diff: FileChangeDiff;
  readonly hint?: string;
}

export function diffBodyLineCount(diff: FileChangeDiff): number {
  return diffBodyLines(diff).length;
}

function headerTags(diff: FileChangeDiff): string {
  const tags = [
    ...(diff.change === "create" ? ["新建"] : []),
    ...(diff.unified === undefined ? ["正文省略（文件过大）"] : diff.truncated ? ["已截断"] : []),
  ];
  return tags.length > 0 ? `  ${tags.join("  ")}` : "";
}

export function DiffHeader({ diff }: DiffHeaderProps): ReactElement {
  return h(
    Text,
    null,
    h(Text, { bold: true }, sanitizeForDisplay(diff.path)),
    h(Text, null, "  "),
    h(Text, { color: "green" }, `+${String(diff.added)}`),
    h(Text, null, " "),
    h(Text, { color: "red" }, `−${String(diff.removed)}`),
    h(Text, { dimColor: true }, headerTags(diff)),
  );
}

function lineColor(line: DiffLine): { color?: "green" | "red" | "cyan"; dimColor?: boolean } {
  switch (line.kind) {
    case "add":
      return { color: "green" };
    case "del":
      return { color: "red" };
    case "hunk":
      return { color: "cyan" };
    case "note":
      return { dimColor: true };
    default:
      return {};
  }
}

const PREFIX: Record<DiffLine["kind"], string> = { meta: "", hunk: "", add: "+", del: "-", context: " ", note: "" };

function DiffBodyLine({ line, width }: { readonly line: DiffLine; readonly width: number }): ReactElement {
  const gutter = line.kind === "hunk" || line.kind === "note" ? " ".repeat(width * 2 + 2) : formatDiffGutter(line, width);
  return h(
    Text,
    { wrap: "wrap" },
    h(Text, { dimColor: true }, gutter),
    h(Text, lineColor(line), `${PREFIX[line.kind]}${sanitizeForDisplay(line.text)}`),
  );
}

export function DiffBlock({ diff, maxBodyLines, collapsedHint }: DiffBlockProps): ReactElement {
  const body = diffBodyLines(diff);
  const width = Math.max(1, String(body.reduce((m, l) => Math.max(m, l.oldLine ?? 0, l.newLine ?? 0), 0)).length);
  const visible = maxBodyLines === undefined ? body : body.slice(0, Math.max(0, maxBodyLines));
  const hidden = body.length - visible.length;
  return h(
    Box,
    { flexDirection: "column" },
    h(DiffHeader, { diff }),
    h(
      Box,
      { flexDirection: "column", borderStyle: "single", borderColor: "gray", borderTop: false, borderRight: false, borderBottom: false, paddingLeft: 1 },
      ...visible.map((line, index) => h(DiffBodyLine, { key: String(index), line, width })),
      hidden > 0
        ? h(Text, { dimColor: true }, `… 另 ${String(hidden)} 行${collapsedHint !== undefined ? `（${collapsedHint}）` : ""}`)
        : null,
    ),
  );
}

export function DiffSummary({ diff, hint }: DiffSummaryProps): ReactElement {
  return h(
    Text,
    null,
    h(DiffHeader, { diff }),
    h(Text, { dimColor: true }, ` · 已折叠${hint !== undefined ? ` · ${hint}` : ""}`),
  );
}
```

（`formatDiffHeader` 若未用到则不要 import，避免 lint 未使用告警。）

- [ ] **Step 4: 跑测试**：`node --experimental-strip-types --test packages/core/src/cli/chat/ink/diff-view.test.ts && pnpm --filter @roll-agent/core typecheck` → PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli/chat/ink/diff-view.ts packages/core/src/cli/chat/ink/diff-view.test.ts
git commit -m "feat(core): Ink DiffBlock and DiffSummary components"
```

---

### Task 12: core Ink — 历史项渲染 diff、`/diff` 命令、viewport/use-session/app 管线

**Files:**
- Modify: `packages/core/src/cli/chat/ink/history-item.ts:19-77`
- Modify: `packages/core/src/cli/chat/ink/transcript-viewport.ts:35-44, 63-79, 159-196`
- Modify: `packages/core/src/cli/chat/ink/use-session.ts:30-46, 285-289`
- Modify: `packages/core/src/cli/chat/ink/commands.ts:33-51`
- Modify: `packages/core/src/cli/chat/ink/app.ts`（`runSlash` 加 `/diff`；`TranscriptViewport` 传 `diffDisplay`；`useSession` 解构 `setDiffDisplay`）
- Test: `history-item.test.ts`、`commands.test.ts`（若有 SLASH_COMMANDS 快照）、`app.test.ts`

**Interfaces:**
- Consumes: `DiffBlock`/`DiffSummary`/`diffBodyLineCount`（Task 11）、`shouldExpandDiff`/`resolveDiffDisplayToggle`/`diffDisplayNotice`（Task 8）
- Produces: `HistoryItemViewProps.diffDisplay?: DiffDisplayMode`；`TranscriptViewportProps.diffDisplay: DiffDisplayMode`；`UseSessionResult.setDiffDisplay(value)`；`SLASH_COMMANDS` 新增 `/diff`

- [ ] **Step 1: 写失败测试**

`history-item.test.ts` 追加：

```ts
const ITEM_DIFF = {
  path: "src/a.ts",
  change: "modify",
  added: 1,
  removed: 1,
  hunks: 1,
  unified: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-b\n+B\n",
  truncated: false,
} as const;

test("带 diff 的 tool 项在工具行下展开小 diff", () => {
  const frame = renderFrame({ kind: "tool", id: "t1", name: "roll.edit_file", args: '{"file_path":"src/a.ts"}', ok: true, diff: ITEM_DIFF });
  assert.match(frame, /✓ roll\.edit_file/u);
  assert.match(frame, /src\/a\.ts\s+\+1 −1/u);
  assert.match(frame, /-b/u);
  assert.match(frame, /\+B/u);
});

test("超过阈值的 diff 在 collapsed 模式折叠为一行摘要，expanded 模式完整显示", () => {
  const body = Array.from({ length: 50 }, (_, i) => `+L${String(i)}`).join("\n");
  const big = { ...ITEM_DIFF, added: 50, removed: 0, unified: `--- a/f\n+++ b/f\n@@ -0,0 +1,50 @@\n${body}\n` };
  const collapsed = renderFrame({ kind: "tool", id: "t2", name: "roll.write_file", args: "", ok: true, diff: big });
  assert.match(collapsed, /已折叠 · \/diff 展开/u);
  assert.doesNotMatch(collapsed, /\+L49/u);
  const expanded = renderFrame({ kind: "tool", id: "t2", name: "roll.write_file", args: "", ok: true, diff: big }, undefined, "expanded");
  assert.match(expanded, /\+L49/u);
});
```

`renderFrame` helper 改签名为 `(item, thinkingDisplay?, diffDisplay?)` 并透传 `diffDisplay`。

`app.test.ts` 追加（仿 `/show-think` 用例 `:966-1018` 的驱动方式）：

```ts
test("/diff 切换 diff 折叠模式并给出提示", async () => {
  const { stdin, lastFrame, unmount } = render(h(ChatApp, baseProps(makeSession([]))));
  try {
    await waitFor(() => lastFrame()?.includes("›") === true);
    for (const ch of "/diff") {
      stdin.write(ch);
      await new Promise((r) => setTimeout(r, 5));
    }
    stdin.write("\r");
    await waitFor(() => stripAnsi(lastFrame() ?? "").includes("完整显示"));
    for (const ch of "/diff off") {
      stdin.write(ch);
      await new Promise((r) => setTimeout(r, 5));
    }
    stdin.write("\r");
    await waitFor(() => stripAnsi(lastFrame() ?? "").includes("折叠为一行摘要"));
  } finally {
    unmount();
  }
});
```

（`baseProps`/`makeSession`/`waitFor`/`stripAnsi` 用该文件既有 helper 的真实名字。）

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

`history-item.ts`：props 加 `readonly diffDisplay?: DiffDisplayMode;`（默认 `"collapsed"`）；tool 分支：

```ts
case "tool": {
  const args = item.args.length > 0 && item.args !== "{}" ? ` ${item.args}` : "";
  const line = h(Text, null, h(Text, item.ok ? { color: "green" } : { color: "red" }, item.ok ? "✓ " : "✗ "), h(ToolLabel, { name: item.name }), args.length > 0 ? h(Text, { dimColor: true }, args) : null);
  if (item.diff === undefined) {
    return line;
  }
  const expanded = shouldExpandDiff(diffBodyLineCount(item.diff), diffDisplay);
  return h(
    Box,
    { flexDirection: "column" },
    line,
    expanded ? h(DiffBlock, { diff: item.diff }) : h(DiffSummary, { diff: item.diff, hint: "/diff 展开" }),
  );
}
```

`transcript-viewport.ts`：`TranscriptViewportProps` 加 `readonly diffDisplay: DiffDisplayMode;`；`historyEntry(item, previous, thinkingDisplay, diffDisplay)` → `h(HistoryItemView, { item, thinkingDisplay, diffDisplay })`；`useMemo` deps 加 `props.diffDisplay`；高度缓存 `useEffect(() => { setHeights(new Map()); }, [props.width, props.thinkingDisplay, props.diffDisplay]);`。

`use-session.ts`：`UseSessionResult` 加 `readonly setDiffDisplay: (value: DiffDisplayMode) => void;`；实现 `const setDiffDisplay = useCallback((value: DiffDisplayMode) => { dispatch({ type: "set-diff-display", value }); }, []);` 并加入返回对象。

`commands.ts`：在 `/show-think` 之后加 `{ kind: "command", name: "/diff", description: "完整显示或折叠大段文件 diff (on | off)，不带参数时切换" },`。

`app.ts`：解构 `setDiffDisplay`；`runSlash` 里 `/show-think` 块之后加：

```ts
if (name === "/diff") {
  const next = resolveDiffDisplayToggle(arg, state.diffDisplay);
  setDiffDisplay(next);
  commitHistory({ kind: "notice", id: randomUUID(), text: diffDisplayNotice(next) });
  return;
}
```

`TranscriptViewport` props 加 `diffDisplay: state.diffDisplay,`。

- [ ] **Step 4: 跑测试**：`node --experimental-strip-types --test packages/core/src/cli/chat/ink/history-item.test.ts packages/core/src/cli/chat/ink/commands.test.ts packages/core/src/cli/chat/ink/transcript-viewport.test.ts packages/core/src/cli/chat/ink/app.test.ts && pnpm --filter @roll-agent/core typecheck` → PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli/chat/ink
git commit -m "feat(core): Ink transcript renders file diffs with /diff session toggle"
```

---

### Task 13: core Ink — 审批框内嵌 diff 预览

**Files:**
- Modify: `packages/core/src/cli/chat/ink/confirm-select.ts`
- Modify: `packages/core/src/cli/chat/ink/app.ts:494-507`（传 `diff`）
- Test: `packages/core/src/cli/chat/ink/confirm-select.test.ts`、`app.test.ts`

**Interfaces:**
- Consumes: `diffBodyLines`、`formatDiffHeader`、`formatDiffGutter`（Task 8）、`DiffHeader`（Task 11）
- Produces: `ConfirmSelectProps.diff?: FileChangeDiff`

- [ ] **Step 1: 写失败测试**（`confirm-select.test.ts`，仿现有 `render(h(ConfirmSelect, {...}))` + `lines` 断言）

```ts
const CONFIRM_DIFF = {
  path: "src/a.ts",
  change: "modify",
  added: 3,
  removed: 1,
  hunks: 1,
  unified: ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,4 @@", " keep", "-old", "+n1", "+n2", "+n3", ""].join("\n"),
  truncated: false,
} as const;

test("expanded 布局内嵌 diff 头与正文，隐藏原始 args，选项行仍在框内最后一行", () => {
  const { lastFrame } = render(h(ConfirmSelect, {
    prompt: "执行 roll.edit_file?",
    args: 'file_path: src/a.ts\nedits: [{"old_string":"old","new_string":"n1\\nn2\\nn3"}]',
    explanation: "修改 src/a.ts：1 处编辑",
    diff: CONFIRM_DIFF,
    width: 80,
    maxRows: 20,
    onDecide: () => {},
  }));
  const frame = stripAnsi(lastFrame() ?? "");
  assert.match(frame, /src\/a\.ts\s+\+3 −1/u);
  assert.match(frame, /-old/u);
  assert.match(frame, /\+n3/u);
  assert.doesNotMatch(frame, /old_string/u);
  const lines = frame.split("\n");
  const optionIndex = lines.findIndex((l) => /❯ No|Yes\s+❯ No/u.test(l) || l.includes("No"));
  const bottomBorder = lines.findIndex((l) => l.trimStart().startsWith("╰"));
  assert.ok(optionIndex !== -1 && bottomBorder !== -1 && optionIndex < bottomBorder);
  assert.ok(lines.length <= 20);
});

test("expanded 布局行预算不足时截断 diff 正文并提示剩余行数，选项行不被挤出", () => {
  const { lastFrame } = render(h(ConfirmSelect, {
    prompt: "执行 roll.edit_file?",
    args: "",
    diff: CONFIRM_DIFF,
    width: 80,
    maxRows: 12,
    onDecide: () => {},
  }));
  const frame = stripAnsi(lastFrame() ?? "");
  const lines = frame.split("\n");
  assert.ok(lines.length <= 12);
  assert.match(frame, /另 \d+ 行/u);
  assert.ok(lines.some((l) => l.includes("Yes")));
});

test("compact 布局只显示 diff 头行", () => {
  const { lastFrame } = render(h(ConfirmSelect, {
    prompt: "执行 roll.edit_file?",
    args: "file_path: src/a.ts",
    diff: CONFIRM_DIFF,
    width: 80,
    maxRows: 6,
    onDecide: () => {},
  }));
  const frame = stripAnsi(lastFrame() ?? "");
  assert.match(frame, /src\/a\.ts\s+\+3 −1/u);
  assert.doesNotMatch(frame, /\+n1/u);
  assert.ok(frame.split("\n").length <= 6);
});
```

（`stripAnsi` 用该测试文件既有的 `ANSI_STYLE_PATTERN` replace helper。）

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `confirm-select.ts`**

- props 加 `readonly diff?: FileChangeDiff;`
- `const showArgs = diff === undefined && args.length > 0 && args !== "{}";`
- compact：`planCompactRows(..., hasArgs: showArgs || diff !== undefined)`；渲染 `showArgsRow` 处：`diff !== undefined ? h(Text, { wrap: "truncate-end" }, truncateDisplayLine(formatDiffHeader(diff), compactContentWidth)) : h(Text, { dimColor: true }, truncateDisplayLine(args, compactContentWidth))`。
- expanded：在 `showArgs ? … : null` 之前插入 diff 块。行预算：

```ts
const explanationRows = explanation === undefined ? 0 : Math.min(2, wrapDisplayLines(`AI 说明：${explanation}`, contentWidth, 2).split("\n").length);
const fixedRows = 2 + 1 + explanationRows + (sessionGrantLabel === undefined ? 0 : 1) + 2;
const diffBudget = Math.max(0, boundedRows - 1 - fixedRows);
const diffRows = diff === undefined || diffBudget < 1 ? [] : buildConfirmDiffRows(diff, diffBudget, contentWidth);
```

新增模块内函数：

```ts
function buildConfirmDiffRows(diff: FileChangeDiff, budget: number, width: number): ReactElement[] {
  const rows: ReactElement[] = [h(DiffHeader, { key: "diff-header", diff })];
  const body = diffBodyLines(diff);
  const gutterWidth = Math.max(1, String(body.reduce((m, l) => Math.max(m, l.oldLine ?? 0, l.newLine ?? 0), 0)).length);
  const bodyBudget = budget - 1;
  const visible = body.length <= bodyBudget ? body : body.slice(0, Math.max(0, bodyBudget - 1));
  visible.forEach((line, index) => {
    const gutter = line.kind === "hunk" || line.kind === "note" ? " ".repeat(gutterWidth * 2 + 2) : formatDiffGutter(line, gutterWidth);
    const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "context" ? " " : "";
    rows.push(
      h(
        Text,
        { key: `diff-${String(index)}`, wrap: "truncate-end" },
        h(Text, { dimColor: true }, gutter),
        h(Text, line.kind === "add" ? { color: "green" } : line.kind === "del" ? { color: "red" } : line.kind === "hunk" ? { color: "cyan" } : {}, truncateDisplayLine(`${prefix}${sanitizeForDisplay(line.text)}`, Math.max(1, width - gutter.length))),
      ),
    );
  });
  const hidden = body.length - visible.length;
  if (hidden > 0) {
    rows.push(h(Text, { key: "diff-more", dimColor: true }, `… 另 ${String(hidden)} 行`));
  }
  return rows;
}
```

在 expanded 的 round Box 子元素里，`sessionGrantLabel` 行之后、`showArgs` 行之前插入 `...diffRows`。（`truncateDisplayLine` 会 `normalizeInlineText` 把多空格压成一个——diff 正文缩进会被压缩；为保留缩进，为 diff 行使用一个不做 `normalizeInlineText` 的 `clipDisplayLine(value, width)`：`displayWidth(value) <= width ? value : addEllipsis(value, width)`。）

`app.ts` `ConfirmSelect` props 加 `...(state.pendingConfirm.diff !== undefined ? { diff: state.pendingConfirm.diff } : {}),`。

- [ ] **Step 4: 跑测试**：`node --experimental-strip-types --test packages/core/src/cli/chat/ink/confirm-select.test.ts packages/core/src/cli/chat/ink/app.test.ts && pnpm --filter @roll-agent/core typecheck` → PASS（既有 `lines.length <= 7`、`^╰`、help 行为末行等断言必须继续成立）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli/chat/ink/confirm-select.ts packages/core/src/cli/chat/ink/confirm-select.test.ts packages/core/src/cli/chat/ink/app.ts packages/core/src/cli/chat/ink/app.test.ts
git commit -m "feat(core): approval prompt previews file diff within the row budget"
```

---

### Task 14: changeset、全量校验、真实终端验证

**Files:**
- Create: `.changeset/chat-file-diff-view.md`
- Verify only（无源码改动，除非校验发现问题）

- [ ] **Step 1: changeset**

```markdown
---
"@roll-agent/protocol": minor
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

roll chat 编辑文件时展示 diff 视图（审批前预览 + 应用后变更）

- runtime：`edit_file` / `write_file` 在审批前对编辑做 dry-run，把「改前 vs 改后」的 unified diff（含 `+N −M`）随审批请求一起投影；`edit_file` 对未读取 / 已过期 / 不匹配的编辑现在在弹审批前直接失败，不再出现「批准后才报错」的无效确认。写入成功后的 `display` 变为 `{ text, diff }`，模型可见输出保持原快照文本不变。diff 由内置行级 Myers 生成，正文按上限截断、超大文件只给统计，计算失败不影响写入。
- protocol：新增 `fileChangeDiffSchema` / `fileChangeDisplaySchema` 与 `getApprovalDiffPreview()` / `getFileChangeDisplay()`；diff 放在 `approval.preview.diff` 与 `tool.completed.display` 既有 JSON 槽位内，1.0–1.4 顶层 strict schema 不变，旧客户端忽略即可。
- core：Ink TUI 审批框内嵌 diff 预览（按行预算截断，替代原始 edits JSON），对话流在工具行下渲染着色 diff；超过 40 行默认折叠为一行摘要，`/diff [on|off]` 会话级切换；基础 REPL 在审批消息与结果后打印着色 unified diff，同样支持 `/diff`。
```

- [ ] **Step 2: 全量校验**

Run: `pnpm changeset status && pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿。lint 若报 `curly` / 未使用 import，就地修。

- [ ] **Step 3: GitNexus 变更范围**：`mcp__gitnexus__detect_changes({scope: "compare", base_ref: "dev"})`，确认受影响流程限于文件工具、审批、chat 渲染、runtime-service 投影。

- [ ] **Step 4: 真实终端验证（tmux，不用 expect）**

```bash
tmux new-session -d -s diffcheck -x 120 -y 40 -c "$(mktemp -d)"
tmux send-keys -t diffcheck 'printf "line1\nline2\nline3\n" > demo.txt && pnpm --dir /Users/rensiwen/Documents/react-projects/Next-PJ/nano-agent dev -- chat' Enter
# 等 TUI 起来后：
tmux send-keys -t diffcheck '请把 demo.txt 里的 line2 改成 LINE2' Enter
# 等审批框出现：
tmux capture-pane -p -t diffcheck   # 应看到 demo.txt  +1 −1、-line2 / +LINE2、Yes/No 在框内
tmux send-keys -t diffcheck 'y'
tmux capture-pane -p -t diffcheck   # 应看到 ✓ roll.edit_file 下方的 diff 块
tmux send-keys -t diffcheck '/diff' Enter
tmux capture-pane -p -t diffcheck   # 应看到「文件变更 diff 将完整显示」提示
tmux send-keys -t diffcheck '/exit' Enter
tmux kill-session -t diffcheck
```

把关键 capture 结果记进最终汇报。若 `pnpm dev -- chat` 需要 LLM 配置，用现有 `roll.config.yaml`（已在仓库根）。

- [ ] **Step 5: Commit**

```bash
git add .changeset/chat-file-diff-view.md
git commit -m "chore: changeset for chat file diff view"
```

- [ ] **Step 6: 完成后**：按 `superpowers:finishing-a-development-branch` 处理分支（推送 + PR，PR 描述只写本分支新增内容，标题 `feat(chat): 编辑文件时展示 diff 视图 (#224)`，正文末尾 `Closes #224`）。
