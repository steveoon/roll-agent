# Runtime Protocol 1.4 对齐修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `@roll-agent/protocol` / `@roll-agent/runtime` / Electron 示例 / 六份文档全部对齐 Runtime Protocol 1.4：修掉 1.4 会话上取消通知永不送达的 bug，补齐 `./schema/1.4` 导出与 `fixtures/v1.4`，把 Electron 示例从「对最新 runtime 启动即失败」修回来，并用全版本矩阵测试 + docs-sync 测试堵住「新增版本时手写清单漏项」这一整类回归。

**Architecture:** protocol 侧把两个 Server Request 投影函数从版本字面量链改为按 `RUNTIME_PROTOCOL_CAPABILITIES` 派生 wire 形状（复用既有 `satisfies Record<RuntimeProtocolVersion, …>` 穷举表，新增版本漏表即编译报错）；runtime 侧 coordinator 的取消投影失败改走 `onDiagnostic` 而非静默吞掉；packaging 侧补 exports 与 fixtures 并各配一条按 `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS` 遍历的测试；文档侧参考文档全量修订 + 其余五份修「最新版本」声明与列表字面量，由 `docs-sync.test.ts` 钉到源码常量。

**Tech Stack:** TypeScript（Node type stripping，`.ts` import、`import type`、零 `any`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、if/else 必须花括号、核心代码零注释、Prettier 100 列）、node:test + node:assert/strict、zod 3.25（`zod/v4` 仅构建脚本用）、ajv（构建期 fixture 校验）、esbuild（Electron 示例）。

**Spec:** `docs/superpowers/specs/2026-08-21-runtime-protocol-1-4-alignment-design.md`

## Global Constraints

- 不新增 `@roll-agent/protocol` 公开导出；形状派生 helper 与常量为模块私有。两个投影函数的签名、返回类型、抛错消息文本保持不变。
- 投影分支只能依据 `getRuntimeProtocolCapabilities(version)` 派生，**禁止**再写 `version === "1.x"` 字面量链。
- invalid fixture 只能依赖 JSON Schema 可表达的约束（`maxItems`、`pattern`、`enum`、`required`、`additionalProperties`），**禁止**依赖 zod `.refine()`（`z.toJSONSchema` 会丢弃 refine，导致 `generate-schema.mjs` 构建期断言失败）。
- 文档中的版本列表字面量：凡首元素不是 `"1.1"` / `"1.0"` 的，必须以 `RUNTIME_PROTOCOL_VERSION`（当前 `"1.4"`）开头。
- 测试命令：protocol 用 `node --experimental-strip-types --test <file>`；runtime 用 `node --experimental-strip-types --experimental-sqlite --test <file>`。改完 `.ts` / `.mjs` / `.json` 跑 `npx prettier --write <files>`，`.ts` / `.mjs` 再跑 `npx eslint <files>`。`*.md` 在 `.prettierignore` 里，文档**不跑** prettier，手工保持表格对齐与 100 列左右换行。
- 提交信息遵循仓库风格（`fix(protocol): …` / `test(runtime): …` / `docs(protocol): …` / `chore: …`），末尾附 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- **不要执行** `git restore` / `git checkout -- <file>` / `git reset` / `git stash`（工作树可能有其他会话的未提交改动）。
- 文中行号以 commit `6dbba27` 为准；编辑后行号会漂移，**按内容定位**，不要按行号盲改。
- 引用的标识符（`RUNTIME_V14_MAX_*`、`attachmentStage` 等）写入前先在 `packages/protocol/src/index.ts` 中 grep 确认存在。

## 并行建议

- Task 1 → Task 2 有依赖（Task 2 的回归测试要等 Task 1 修复后才转绿）。
- Task 3、Task 4、Task 8 互相独立，也独立于 Task 1/2，可并行。
- Task 5（docs-sync 测试，先红）→ Task 6 + Task 7（文档修订，转绿）有依赖；Task 6 与 Task 7 互相独立。
- Task 9 最后执行。

---

### Task 1: protocol —— 按能力派生 Server Request wire 形状，修复 1.4 投影

**Files:**
- Modify: `packages/protocol/src/index.ts:152-156`（`getRuntimeProtocolCapabilities` 之后插入 helper）、`:2854-2895`（两个投影函数）
- Test: `packages/protocol/src/index.test.ts`（文件末尾追加）

**Interfaces:**
- Consumes: `getRuntimeProtocolCapabilities(version)`（`index.ts:152`）、`RUNTIME_SERVER_REQUEST_METHODS`、`approvalRequestParamsV12Schema` / `approvalRequestParamsV11Schema`、`runtimeServerRequestCancelParamsV12Schema` / `V11Schema`、`runtimeServerRequestCancelProjectionInputSchema`、`runtimeProtocolSchemaUnavailable`
- Produces: 模块私有 `resolveRuntimeServerRequestWireShape(version): "interaction" | "legacy" | null`；`projectRuntimeServerRequestCancelParams("1.4", …)` 与 `projectRuntimeServerRequestParams("1.4", …)` 不再抛错（Task 2 依赖此行为）

GitNexus impact（已跑）：两个函数 upstream 仅 `index.test.ts`，risk LOW。

- [ ] **Step 1: 写失败测试（全版本矩阵）**

在 `packages/protocol/src/index.test.ts` 文件末尾追加：

```ts
test("server request projections cover every wire version that supports server requests", () => {
  const cancelInput = {
    interactionId: interactionIdSchema.parse(IDS.interaction),
    serverRequestId: "rpc-7",
    approvalId: approvalIdSchema.parse(IDS.approval),
    reason: "turn-cancelled",
  } as const;
  const approvalInput = {
    interactionId: IDS.interaction,
    threadId: IDS.thread,
    turnId: IDS.turn,
    expiresAt: "2026-07-29T12:10:00.000Z",
    sensitivity: "normal",
    approval: {
      id: IDS.approval,
      turnId: IDS.turn,
      agentName: "browser-use-agent",
      toolName: "click",
      preview: { selector: "#submit" },
    },
  } as const;
  const userInputInput = userInputRequestParams([
    { type: "boolean", id: "dry-run", label: "仅预演", required: true },
  ]);

  for (const version of SUPPORTED_RUNTIME_PROTOCOL_VERSIONS) {
    const capabilities = getRuntimeProtocolCapabilities(version);
    if (!capabilities.serverRequests) {
      assert.throws(() => projectRuntimeServerRequestCancelParams(version, cancelInput), version);
      assert.throws(
        () =>
          projectRuntimeServerRequestParams(
            version,
            RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
            approvalInput,
          ),
        version,
      );
      continue;
    }

    const cancel = projectRuntimeServerRequestCancelParams(version, cancelInput);
    assert.deepEqual(
      parseRuntimeServerRequestCancelParamsForVersion(version, cancel),
      cancel,
      version,
    );
    assert.equal("interactionId" in cancel, capabilities.serverRequestCapabilityNegotiation, version);

    const approval = projectRuntimeServerRequestParams(
      version,
      RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
      approvalInput,
    );
    assert.deepEqual(
      parseRuntimeServerRequestParamsForVersion(
        version,
        RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
        approval,
      ),
      approval,
      version,
    );

    if (
      isRuntimeServerRequestMethodAvailable(version, RUNTIME_SERVER_REQUEST_METHODS.userInputRequest)
    ) {
      const userInput = projectRuntimeServerRequestParams(
        version,
        RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
        userInputInput,
      );
      assert.deepEqual(
        parseRuntimeServerRequestParamsForVersion(
          version,
          RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
          userInput,
        ),
        userInput,
        version,
      );
    } else {
      assert.throws(
        () =>
          projectRuntimeServerRequestParams(
            version,
            RUNTIME_SERVER_REQUEST_METHODS.userInputRequest,
            userInputInput,
          ),
        version,
      );
    }
  }
});
```

所有用到的名字（`interactionIdSchema`、`approvalIdSchema`、`IDS`、`userInputRequestParams`、`SUPPORTED_RUNTIME_PROTOCOL_VERSIONS`、`getRuntimeProtocolCapabilities`、`projectRuntimeServerRequestCancelParams`、`projectRuntimeServerRequestParams`、`parseRuntimeServerRequestCancelParamsForVersion`、`parseRuntimeServerRequestParamsForVersion`、`isRuntimeServerRequestMethodAvailable`、`RUNTIME_SERVER_REQUEST_METHODS`）在该测试文件 1-221 行已导入或定义，无需新增 import。

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --test packages/protocol/src/index.test.ts 2>&1 | grep -E "^(not ok|ok) |does not support|fail [0-9]"`
Expected: 新测试 `not ok`，错误信息含 `Runtime Protocol 1.4 does not support server request cancellation`；其余 35 个 `ok`。

- [ ] **Step 3: 新增形状派生 helper**

在 `packages/protocol/src/index.ts` 中 `getRuntimeProtocolCapabilities` 函数（约 152-156 行）**之后**插入：

```ts
const RUNTIME_SERVER_REQUEST_WIRE_SHAPES = {
  interaction: "interaction",
  legacy: "legacy",
} as const;

type RuntimeServerRequestWireShape =
  (typeof RUNTIME_SERVER_REQUEST_WIRE_SHAPES)[keyof typeof RUNTIME_SERVER_REQUEST_WIRE_SHAPES];

function resolveRuntimeServerRequestWireShape(
  version: RuntimeProtocolVersion,
): RuntimeServerRequestWireShape | null {
  const capabilities = getRuntimeProtocolCapabilities(version);
  if (!capabilities.serverRequests) {
    return null;
  }
  return capabilities.serverRequestCapabilityNegotiation
    ? RUNTIME_SERVER_REQUEST_WIRE_SHAPES.interaction
    : RUNTIME_SERVER_REQUEST_WIRE_SHAPES.legacy;
}
```

- [ ] **Step 4: 改写两个投影函数**

把 `export function projectRuntimeServerRequestParams<…>` 整个函数替换为：

```ts
export function projectRuntimeServerRequestParams<
  TVersion extends RuntimeProtocolVersion,
  TMethod extends RuntimeServerRequestMethodForVersion<"1.3">,
>(
  version: TVersion,
  method: TMethod,
  value: RuntimeServerRequestInputForVersion<"1.3", TMethod>,
): ProjectedRuntimeServerRequestParams<TVersion, TMethod> {
  const latest = parseRuntimeServerRequestParamsForVersion("1.3", method, value);
  const shape = resolveRuntimeServerRequestWireShape(version);
  if (shape === RUNTIME_SERVER_REQUEST_WIRE_SHAPES.interaction) {
    return latest as ProjectedRuntimeServerRequestParams<TVersion, TMethod>;
  }
  if (
    shape === RUNTIME_SERVER_REQUEST_WIRE_SHAPES.legacy &&
    method === RUNTIME_SERVER_REQUEST_METHODS.approvalRequest
  ) {
    const approval = approvalRequestParamsV12Schema.parse(latest);
    return approvalRequestParamsV11Schema.parse({
      threadId: approval.threadId,
      approval: approval.approval,
      expiresAt: approval.expiresAt,
    }) as ProjectedRuntimeServerRequestParams<TVersion, TMethod>;
  }
  return runtimeProtocolSchemaUnavailable(version, "server request", method);
}
```

把 `export function projectRuntimeServerRequestCancelParams<…>` 整个函数替换为：

```ts
export function projectRuntimeServerRequestCancelParams<TVersion extends RuntimeProtocolVersion>(
  version: TVersion,
  value: RuntimeServerRequestCancelProjectionInput,
): RuntimeServerRequestCancelParamsForVersion<TVersion> {
  const input = runtimeServerRequestCancelProjectionInputSchema.parse(value);
  const shape = resolveRuntimeServerRequestWireShape(version);
  if (shape === RUNTIME_SERVER_REQUEST_WIRE_SHAPES.interaction) {
    return runtimeServerRequestCancelParamsV12Schema.parse({
      interactionId: input.interactionId,
      reason: input.reason,
    }) as RuntimeServerRequestCancelParamsForVersion<TVersion>;
  }
  if (shape === RUNTIME_SERVER_REQUEST_WIRE_SHAPES.legacy) {
    return runtimeServerRequestCancelParamsV11Schema.parse({
      serverRequestId: input.serverRequestId,
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
      reason: input.reason,
    }) as RuntimeServerRequestCancelParamsForVersion<TVersion>;
  }
  return runtimeProtocolSchemaUnavailable(version, "server request cancellation");
}
```

改完确认不再有字面量链：`grep -n 'version === "1.3" || version === "1.2"' packages/protocol/src/index.ts` 应无输出。

- [ ] **Step 5: 运行测试、格式、lint、类型检查**

Run:
```bash
node --experimental-strip-types --test packages/protocol/src/index.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail) "
npx prettier --write packages/protocol/src/index.ts packages/protocol/src/index.test.ts
npx eslint packages/protocol/src/index.ts packages/protocol/src/index.test.ts
pnpm --filter @roll-agent/protocol typecheck
```
Expected: `tests 36 / pass 36 / fail 0`；prettier、eslint、typecheck 均无输出或 exit 0。

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts
git commit -m "$(cat <<'EOF'
fix(protocol): derive server request wire shape from capabilities so 1.4 projects

projectRuntimeServerRequestCancelParams and projectRuntimeServerRequestParams
branched on version literals and had no "1.4" case, so every 1.4 session hit
runtimeProtocolSchemaUnavailable. Both now derive the wire shape from
RUNTIME_PROTOCOL_CAPABILITIES (serverRequests / serverRequestCapabilityNegotiation),
which is already exhaustively typed per RuntimeProtocolVersion, and a matrix test
walks every supported version.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: runtime —— coordinator 1.4 取消通知回归测试，投影失败走 diagnose

**Files:**
- Modify: `packages/runtime/src/server/runtime-client-request-coordinator.ts:3-21`（import）、`:597-620`（`sendCancellation`）
- Test: `packages/runtime/src/server/runtime-client-request-coordinator.test.ts`（文件末尾追加）

**Interfaces:**
- Consumes: Task 1 修复后的 `projectRuntimeServerRequestCancelParams`；既有 `this.diagnose(message)`（`coordinator.ts:702-708`）；测试 helper `MemoryResponder` / `approvalRequestInputV12()` / `requestMessages()` / 常量 `scopeId` `approvalId` `interactionId`（测试文件 24-82 行）
- Produces: `RuntimeClientRequestCoordinator` 在 `protocolVersion: "1.4"` 下取消请求时向 responder 发出 `runtime.serverRequest.cancel`

- [ ] **Step 1: 写回归测试**

在 `packages/runtime/src/server/runtime-client-request-coordinator.test.ts` 文件末尾追加：

```ts
test("Protocol 1.4 cancellation is delivered with the interaction shape", async () => {
  const responder = new MemoryResponder();
  const responderId = createRuntimeClientResponderId();
  const diagnostics: string[] = [];
  const coordinator = new RuntimeClientRequestCoordinator({
    onDiagnostic: (message) => {
      diagnostics.push(message);
    },
  });
  coordinator.attachResponder(
    {
      id: responderId,
      scopeId,
      send: (message) => responder.send(message),
      close: () => responder.close(),
    },
    {
      acceptedServerRequestMethods: [RUNTIME_SERVER_REQUEST_METHODS.approvalRequest],
      capabilitiesAcknowledged: true,
    },
  );
  const pending = coordinator.request(
    RUNTIME_SERVER_REQUEST_METHODS.approvalRequest,
    approvalRequestInputV12(),
    {
      key: approvalId,
      scopeId,
      eligibleResponderId: responderId,
      approvalId,
      expiresAt: approvalRequestInputV12().expiresAt,
      protocolVersion: "1.4",
    },
  );
  assert.equal(requestMessages(responder).length, 1);

  assert.equal(coordinator.cancel(approvalId, "turn cancelled"), true);
  await assert.rejects(
    pending.result,
    (error: unknown) =>
      error instanceof RuntimeClientRequestCancelledError && error.reason === "turn cancelled",
  );
  const cancellation = responder.sent.find(
    (message) =>
      "method" in message && message.method === RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  );
  assert.ok(cancellation && "params" in cancellation);
  assert.deepEqual(cancellation.params, { interactionId, reason: "turn cancelled" });
  assert.deepEqual(diagnostics, []);
});
```

- [ ] **Step 2: 运行**

Run: `node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/server/runtime-client-request-coordinator.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail) "`
Expected: `fail 0`。这条测试守的是 coordinator 层行为；红灯证据已在 Task 1 Step 2 的协议层矩阵测试中呈现（Task 1 未合入时，`assert.ok(cancellation …)` 会失败，因为投影抛错被 `catch {}` 吞掉、通知从未发出）。

- [ ] **Step 3: 拆分 `sendCancellation` 的 catch**

在 `packages/runtime/src/server/runtime-client-request-coordinator.ts` 顶部 `from "@roll-agent/protocol"` 的 import 列表中，紧挨着 `type RuntimeProtocolVersion,` 增加：

```ts
  type RuntimeServerRequestCancelParamsForVersion,
```

把 `private sendCancellation(...)` 整个方法替换为：

```ts
  private sendCancellation(
    interaction: ManagedRuntimeClientInteraction,
    delivery: ManagedRuntimeClientDelivery | undefined,
    reason: string,
  ): void {
    if (delivery === undefined) {
      return;
    }
    let params: RuntimeServerRequestCancelParamsForVersion<RuntimeProtocolVersion>;
    try {
      params = projectRuntimeServerRequestCancelParams(interaction.protocolVersion, {
        interactionId: interaction.interactionId,
        serverRequestId: delivery.id,
        ...(interaction.legacyApprovalId !== undefined
          ? { approvalId: interaction.legacyApprovalId }
          : {}),
        reason,
      });
    } catch (error: unknown) {
      this.diagnose(
        `Runtime Protocol ${interaction.protocolVersion} 取消通知投影失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    try {
      delivery.attachment.responder.send({
        jsonrpc: "2.0",
        method: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
        params,
      });
    } catch {
      // The transport may already be gone. Local settlement remains fail-closed.
    }
  }
```

（保留原有的那一行英文注释，不新增注释。`diagnose` 路径在当前版本矩阵下不可达 —— `coordinator.request` 对 1.0 会在 `:242-245` 先行拒绝 —— 故不为它单独写测试；它是给未来漏表留的可见性。）

- [ ] **Step 4: 运行测试、格式、lint、类型检查**

Run:
```bash
node --experimental-strip-types --experimental-sqlite --test packages/runtime/src/server/runtime-client-request-coordinator.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail) "
npx prettier --write packages/runtime/src/server/runtime-client-request-coordinator.ts packages/runtime/src/server/runtime-client-request-coordinator.test.ts
npx eslint packages/runtime/src/server/runtime-client-request-coordinator.ts packages/runtime/src/server/runtime-client-request-coordinator.test.ts
pnpm --filter @roll-agent/runtime typecheck
```
Expected: `fail 0`；其余无输出。

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/server/runtime-client-request-coordinator.ts packages/runtime/src/server/runtime-client-request-coordinator.test.ts
git commit -m "$(cat <<'EOF'
fix(runtime): surface cancel projection failures instead of swallowing them

sendCancellation wrapped both the protocol projection and the transport send in
one bare catch, so the missing 1.4 projection branch never produced a signal.
Projection failures now go through onDiagnostic and return; only the transport
send stays fail-silent. Adds a 1.4 regression asserting the cancel notification
reaches the responder with the interaction shape.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: protocol —— 补 `./schema/1.4` 导出并用测试钉住全部版本

**Files:**
- Modify: `packages/protocol/package.json:13-25`（`exports`）、`:28-40`（`publishConfig.exports`）
- Create: `packages/protocol/src/package-exports.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS`
- Produces: `@roll-agent/protocol/schema/1.4` 可解析

- [ ] **Step 1: 写失败测试**

创建 `packages/protocol/src/package-exports.test.ts`：

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { SUPPORTED_RUNTIME_PROTOCOL_VERSIONS } from "./index.ts";

const exportsMapSchema = z.record(z.unknown());
const manifestSchema = z.object({
  exports: exportsMapSchema,
  publishConfig: z.object({ exports: exportsMapSchema }),
});

const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
);

test("every supported Runtime Protocol version has a schema subpath export", () => {
  for (const [label, exportsMap] of [
    ["exports", manifest.exports],
    ["publishConfig.exports", manifest.publishConfig.exports],
  ] as const) {
    for (const version of SUPPORTED_RUNTIME_PROTOCOL_VERSIONS) {
      assert.equal(
        exportsMap[`./schema/${version}`],
        `./dist/schema/roll-runtime-protocol-v${version}.schema.json`,
        `${label} 缺少 ./schema/${version}`,
      );
    }
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --test packages/protocol/src/package-exports.test.ts 2>&1 | grep -E "not ok|缺少"`
Expected: `not ok`，消息含 `exports 缺少 ./schema/1.4`。

- [ ] **Step 3: 补两处 exports**

`packages/protocol/package.json` 的 `exports` 对象中，在 `"./schema/latest"` 行之后、`"./schema/1.3"` 行之前插入：

```json
    "./schema/1.4": "./dist/schema/roll-runtime-protocol-v1.4.schema.json",
```

`publishConfig.exports` 对象中同位置插入同一行（该块缩进多两格）。

- [ ] **Step 4: 运行测试 + 真实解析验证**

Run:
```bash
node --experimental-strip-types --test packages/protocol/src/package-exports.test.ts 2>&1 | grep -E "^ℹ (pass|fail) "
npx prettier --check packages/protocol/package.json
cd packages/client-node && node --input-type=module -e 'console.log(import.meta.resolve("@roll-agent/protocol/schema/1.4").split("/").pop())'; cd ../..
```
Expected: `pass 1 / fail 0`；prettier 通过；最后一行输出 `roll-runtime-protocol-v1.4.schema.json`（`import.meta.resolve` 只查 exports 映射，不要求 dist 已构建）。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/package.json packages/protocol/src/package-exports.test.ts
git commit -m "$(cat <<'EOF'
fix(protocol): export ./schema/1.4 subpath

generate-schema.mjs already emits roll-runtime-protocol-v1.4.schema.json and it
ships in the tarball, but neither exports map listed it, so the current version
was the only one consumers could not pin. A test now walks
SUPPORTED_RUNTIME_PROTOCOL_VERSIONS against both maps.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: protocol —— `fixtures/v1.4` golden fixtures + 构建期与测试期双向校验

**Files:**
- Create: `packages/protocol/fixtures/v1.4/*.json`（11 个文件，见下）
- Modify: `packages/protocol/scripts/generate-schema.mjs:18-31`（`fixtureSuites`）
- Modify: `packages/protocol/src/index.test.ts:182-186`（新增 `fixtureV14` helper）+ 文件末尾追加测试

**Interfaces:**
- Consumes: `parseRuntimeMethodParamsForVersion` / `parseRuntimeMethodResultForVersion` / `projectThreadSnapshotForVersion` / `projectRuntimeEventEnvelopeForVersion` / `isRuntimeMethodAvailable` / `RUNTIME_METHODS`（测试文件均已导入）
- Produces: `@roll-agent/protocol/fixtures/v1.4/*`（`package.json#files` 已含 `fixtures`，自动随包分发）

固定值：thread `00000000-0000-4000-8000-000000000002`、turn `…0003`、stream `…0004`、attachment `00000000-0000-4000-8000-0000000000a1`、requestId 依次 `…00b1` ~ `…00b5`、sha256 `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`、时间 `2026-08-21T12:00:00.000Z`。

- [ ] **Step 1: 创建 11 个 fixture**

`packages/protocol/fixtures/v1.4/valid-initialize-response.json`：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "1.4",
    "runtimeInstanceId": "00000000-0000-4000-8000-000000000001",
    "server": { "name": "roll-runtime", "version": "0.18.0", "runtimeVersion": "0.18.0" },
    "features": [
      "thread-management",
      "snapshots",
      "turns",
      "approvals",
      "tool-streaming",
      "reasoning-summary",
      "operation-projection",
      "process-local-sequence",
      "attachments"
    ],
    "limits": {
      "maxFrameBytes": 4194304,
      "maxPageSize": 500,
      "eventReplay": true,
      "idempotencyCacheEntries": 10000,
      "maxAttachmentBytes": 16777216,
      "maxAttachmentChunkBytes": 2097152,
      "maxTurnAttachments": 8,
      "maxStagedAttachments": 16
    }
  }
}
```

`valid-attachment-stage-request.json`：
```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "attachment.stage",
  "params": {
    "requestId": "00000000-0000-4000-8000-0000000000b1",
    "threadId": "00000000-0000-4000-8000-000000000002",
    "fileName": "diagram.png",
    "mediaType": "image/png",
    "bytes": 2048,
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "source": "chunks"
  }
}
```

`valid-attachment-stage-response.json`：
```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "result": { "attachmentId": "00000000-0000-4000-8000-0000000000a1", "state": "staged" }
}
```

`valid-attachment-chunk-request.json`：
```json
{
  "jsonrpc": "2.0",
  "id": 21,
  "method": "attachment.chunk",
  "params": {
    "requestId": "00000000-0000-4000-8000-0000000000b2",
    "threadId": "00000000-0000-4000-8000-000000000002",
    "attachmentId": "00000000-0000-4000-8000-0000000000a1",
    "sequence": 0,
    "dataBase64": "iVBORw0KGgo="
  }
}
```

`valid-attachment-commit-request.json`：
```json
{
  "jsonrpc": "2.0",
  "id": 22,
  "method": "attachment.commit",
  "params": {
    "requestId": "00000000-0000-4000-8000-0000000000b3",
    "threadId": "00000000-0000-4000-8000-000000000002",
    "attachmentId": "00000000-0000-4000-8000-0000000000a1"
  }
}
```

`valid-attachment-commit-response.json`：
```json
{
  "jsonrpc": "2.0",
  "id": 22,
  "result": {
    "descriptor": {
      "attachmentId": "00000000-0000-4000-8000-0000000000a1",
      "fileName": "diagram.png",
      "displayName": "diagram.png",
      "mediaType": "image/png",
      "bytes": 2048,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "source": "chunks",
      "createdAt": "2026-08-21T12:00:00.000Z"
    }
  }
}
```

`valid-attachment-release-request.json`：
```json
{
  "jsonrpc": "2.0",
  "id": 23,
  "method": "attachment.release",
  "params": {
    "requestId": "00000000-0000-4000-8000-0000000000b4",
    "threadId": "00000000-0000-4000-8000-000000000002",
    "attachmentId": "00000000-0000-4000-8000-0000000000a1"
  }
}
```

`valid-turn-start-with-attachments-request.json`：
```json
{
  "jsonrpc": "2.0",
  "id": 24,
  "method": "turn.start",
  "params": {
    "requestId": "00000000-0000-4000-8000-0000000000b5",
    "threadId": "00000000-0000-4000-8000-000000000002",
    "turnId": "00000000-0000-4000-8000-000000000003",
    "input": { "text": "", "attachments": ["00000000-0000-4000-8000-0000000000a1"] }
  }
}
```

`invalid-turn-start-too-many-attachments-request.json`（9 个引用 > `maxTurnAttachments` 8，JSON Schema `maxItems` 可表达）：
```json
{
  "jsonrpc": "2.0",
  "id": 25,
  "method": "turn.start",
  "params": {
    "requestId": "00000000-0000-4000-8000-0000000000b5",
    "threadId": "00000000-0000-4000-8000-000000000002",
    "turnId": "00000000-0000-4000-8000-000000000003",
    "input": {
      "text": "too many",
      "attachments": [
        "00000000-0000-4000-8000-0000000000a1",
        "00000000-0000-4000-8000-0000000000a2",
        "00000000-0000-4000-8000-0000000000a3",
        "00000000-0000-4000-8000-0000000000a4",
        "00000000-0000-4000-8000-0000000000a5",
        "00000000-0000-4000-8000-0000000000a6",
        "00000000-0000-4000-8000-0000000000a7",
        "00000000-0000-4000-8000-0000000000a8",
        "00000000-0000-4000-8000-0000000000a9"
      ]
    }
  }
}
```

`invalid-attachment-stage-sha256-request.json`（`sha256` 不满足 `^[a-f0-9]{64}$`，JSON Schema `pattern` 可表达）：
```json
{
  "jsonrpc": "2.0",
  "id": 26,
  "method": "attachment.stage",
  "params": {
    "requestId": "00000000-0000-4000-8000-0000000000b1",
    "threadId": "00000000-0000-4000-8000-000000000002",
    "fileName": "diagram.png",
    "mediaType": "image/png",
    "bytes": 2048,
    "sha256": "not-a-sha256",
    "source": "chunks"
  }
}
```

`valid-thread-snapshot-attachment-part-response.json`：
```json
{
  "jsonrpc": "2.0",
  "id": 27,
  "result": {
    "thread": {
      "id": "00000000-0000-4000-8000-000000000002",
      "title": "Attachment transcript",
      "model": "fixture-model",
      "createdAt": "2026-08-21T12:00:00.000Z",
      "updatedAt": "2026-08-21T12:00:00.000Z",
      "messageCount": 1
    },
    "messages": {
      "items": [
        {
          "sequence": 0,
          "role": "user",
          "createdAt": "2026-08-21T12:00:00.000Z",
          "parts": [
            { "type": "text", "text": "看看这张图" },
            {
              "type": "attachment",
              "mediaType": "image/png",
              "bytes": 2048,
              "displayName": "diagram.png"
            }
          ]
        }
      ],
      "nextBeforeSequence": null
    },
    "operations": { "items": [], "nextBeforeSequence": null },
    "pendingApprovals": [],
    "pendingInteractions": [],
    "transcriptCompleteness": "complete",
    "eventCursor": null
  }
}
```

`valid-runtime-durable-event-notification.json`（复制 `fixtures/v1.3/valid-runtime-durable-event-notification.json`，仅把 `"protocolVersion": "1.3"` 改为 `"1.4"`）：
```json
{
  "jsonrpc": "2.0",
  "method": "runtime.event",
  "params": {
    "protocolVersion": "1.4",
    "runtimeInstanceId": "00000000-0000-4000-8000-000000000001",
    "sequence": 8,
    "timestamp": "2026-07-30T12:00:00.000Z",
    "threadId": "00000000-0000-4000-8000-000000000002",
    "turnId": "00000000-0000-4000-8000-000000000003",
    "durability": "durable",
    "eventId": "00000000-0000-4000-8000-000000000007",
    "cursor": "rte1:00000000-0000-4000-8000-000000000008:0:00000000-0000-4000-8000-000000000007",
    "event": {
      "type": "message.completed",
      "streamId": "00000000-0000-4000-8000-000000000004",
      "text": "hello"
    }
  }
}
```

- [ ] **Step 2: 写 golden fixture 测试**

在 `packages/protocol/src/index.test.ts` 的 `fixtureV13` 函数之后新增：

```ts
function fixtureV14(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/v1.4/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}
```

文件末尾追加：

```ts
test("Protocol 1.4 golden fixtures keep attachment requests, responses and snapshots compatible", () => {
  const initialized = parseRuntimeMethodResultForVersion(
    "1.4",
    RUNTIME_METHODS.initialize,
    fixtureV14("valid-initialize-response.json").result,
  );
  assert.equal(initialized.protocolVersion, "1.4");
  assert.equal(initialized.features.includes("attachments"), true);
  assert.equal(initialized.limits.maxTurnAttachments, 8);

  const stage = fixtureV14("valid-attachment-stage-request.json");
  assert.equal(
    parseRuntimeMethodParamsForVersion("1.4", RUNTIME_METHODS.attachmentStage, stage.params).source,
    "chunks",
  );
  assert.equal(isRuntimeMethodAvailable("1.3", RUNTIME_METHODS.attachmentStage), false);
  assert.throws(() =>
    parseRuntimeMethodParamsForVersion(
      "1.4",
      RUNTIME_METHODS.attachmentStage,
      fixtureV14("invalid-attachment-stage-sha256-request.json").params,
    ),
  );
  assert.equal(
    parseRuntimeMethodResultForVersion(
      "1.4",
      RUNTIME_METHODS.attachmentStage,
      fixtureV14("valid-attachment-stage-response.json").result,
    ).state,
    "staged",
  );
  assert.equal(
    parseRuntimeMethodParamsForVersion(
      "1.4",
      RUNTIME_METHODS.attachmentChunk,
      fixtureV14("valid-attachment-chunk-request.json").params,
    ).sequence,
    0,
  );
  assert.equal(
    parseRuntimeMethodResultForVersion(
      "1.4",
      RUNTIME_METHODS.attachmentCommit,
      fixtureV14("valid-attachment-commit-response.json").result,
    ).descriptor.displayName,
    "diagram.png",
  );
  for (const name of [
    "valid-attachment-commit-request.json",
    "valid-attachment-release-request.json",
  ] as const) {
    const request = fixtureV14(name);
    assert.equal(
      typeof request.method === "string" && isRuntimeMethodAvailable("1.4", request.method),
      true,
      name,
    );
  }

  const turn = fixtureV14("valid-turn-start-with-attachments-request.json");
  const turnParams = parseRuntimeMethodParamsForVersion("1.4", RUNTIME_METHODS.turnStart, turn.params);
  assert.equal(turnParams.input.text, "");
  assert.equal(turnParams.input.attachments?.length, 1);
  assert.throws(() => parseRuntimeMethodParamsForVersion("1.3", RUNTIME_METHODS.turnStart, turn.params));
  assert.throws(() =>
    parseRuntimeMethodParamsForVersion(
      "1.4",
      RUNTIME_METHODS.turnStart,
      fixtureV14("invalid-turn-start-too-many-attachments-request.json").params,
    ),
  );

  const snapshot = fixtureV14("valid-thread-snapshot-attachment-part-response.json");
  assert.equal(projectThreadSnapshotForVersion("1.4", snapshot.result).messages.items[0]?.parts.length, 2);
  assert.deepEqual(projectThreadSnapshotForVersion("1.3", snapshot.result).messages.items[0]?.parts, [
    { type: "text", text: "看看这张图" },
  ]);

  const event = fixtureV14("valid-runtime-durable-event-notification.json");
  assert.equal(projectRuntimeEventEnvelopeForVersion("1.4", event.params).protocolVersion, "1.4");
});
```

- [ ] **Step 3: 运行（fixture 是数据，测试应直接绿；红灯由 fixture 缺失/错误体现）**

Run: `node --experimental-strip-types --test packages/protocol/src/index.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail) |^not ok"`
Expected: `tests 37 / pass 37 / fail 0`。若有 `not ok`，说明某个 fixture 与 schema 不符 —— 修 fixture，不要改 schema。

- [ ] **Step 4: 把 v1.4 套件接入构建期 ajv 校验**

`packages/protocol/scripts/generate-schema.mjs` 的 `fixtureSuites` 数组**开头**插入：

```js
  {
    directory: resolve(import.meta.dirname, "../fixtures/v1.4"),
    defaultVersion: "1.4",
  },
```

- [ ] **Step 5: 构建验证（ajv 对 11 个 fixture 做 valid/invalid 双向断言）**

Run: `pnpm --filter @roll-agent/protocol build 2>&1 | tail -5 && ls packages/protocol/dist/schema/`
Expected: 构建 exit 0，无 `fixture … expected` 报错；目录含 `roll-runtime-protocol-v1.4.schema.json`。

- [ ] **Step 6: 格式化并提交**

```bash
npx prettier --write packages/protocol/fixtures/v1.4/*.json packages/protocol/scripts/generate-schema.mjs packages/protocol/src/index.test.ts
npx eslint packages/protocol/src/index.test.ts packages/protocol/scripts/generate-schema.mjs
git add packages/protocol/fixtures/v1.4 packages/protocol/scripts/generate-schema.mjs packages/protocol/src/index.test.ts
git commit -m "$(cat <<'EOF'
test(protocol): add Runtime Protocol 1.4 golden fixtures

Covers initialize limits/features, the four attachment.* methods, turn.start
with attachments, the attachment message part and the 1.4 event envelope.
Invalid fixtures only use JSON-Schema-expressible constraints (maxItems,
pattern) so the build-time ajv pass and the zod tests agree.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: protocol —— docs-sync 测试（先红）

**Files:**
- Create: `packages/protocol/src/docs-sync.test.ts`

**Interfaces:**
- Consumes: `RUNTIME_PROTOCOL_VERSION`、`SUPPORTED_RUNTIME_PROTOCOL_VERSIONS`、`RUNTIME_METHODS`、`RUNTIME_ERROR_CODES`、`runtimeLimitsV14Schema`
- Produces: Task 6 / Task 7 的验收标准

- [ ] **Step 1: 写测试**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  RUNTIME_ERROR_CODES,
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_VERSION,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  runtimeLimitsV14Schema,
} from "./index.ts";

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const DOCS = {
  "docs/runtime-protocol-v1-reference.md": readRepoFile(
    "../../../docs/runtime-protocol-v1-reference.md",
  ),
  "docs/client-node-reference.md": readRepoFile("../../../docs/client-node-reference.md"),
  "docs/runtime-protocol-architecture.md": readRepoFile(
    "../../../docs/runtime-protocol-architecture.md",
  ),
  "docs/tutorial-runtime-ui-quickstart.md": readRepoFile(
    "../../../docs/tutorial-runtime-ui-quickstart.md",
  ),
  "packages/protocol/README.md": readRepoFile("../README.md"),
  "packages/client-node/README.md": readRepoFile("../../client-node/README.md"),
} as const;

type DocName = keyof typeof DOCS;

const LATEST_VERSION_CLAIMS: ReadonlyArray<{ readonly doc: DocName; readonly pattern: RegExp }> = [
  {
    doc: "docs/runtime-protocol-v1-reference.md",
    pattern: /\| 最新 Wire protocol \| `"([0-9.]+)"` \|/u,
  },
  {
    doc: "docs/client-node-reference.md",
    pattern: /\| 最新协议 \| Roll Runtime Protocol `"([0-9.]+)"` \|/u,
  },
  {
    doc: "docs/runtime-protocol-architecture.md",
    pattern: /当前最新版本为 `"([0-9.]+)"`/u,
  },
];

const LEGACY_LIST_HEADS: ReadonlySet<string> = new Set(["1.1", "1.0"]);
const VERSION_LIST_LITERAL = /\[\s*"1\.\d"(?:\s*,\s*"1\.\d")*\s*\]/gu;
const RUNTIME_LIMIT_KEYS = [
  "maxFrameBytes",
  "maxPageSize",
  "eventReplay",
  "idempotencyCacheEntries",
  "maxAttachmentBytes",
  "maxAttachmentChunkBytes",
  "maxTurnAttachments",
  "maxStagedAttachments",
] as const;

test("docs declare RUNTIME_PROTOCOL_VERSION as the latest wire version", () => {
  for (const { doc, pattern } of LATEST_VERSION_CLAIMS) {
    const match = pattern.exec(DOCS[doc]);
    assert.ok(match, `${doc} 缺少最新版本声明`);
    assert.equal(match[1], RUNTIME_PROTOCOL_VERSION, doc);
  }
});

test("docs version list literals start with the latest version unless they depict a legacy client", () => {
  for (const [doc, text] of Object.entries(DOCS)) {
    for (const literal of text.match(VERSION_LIST_LITERAL) ?? []) {
      const head = (literal.match(/1\.\d/u) ?? [])[0];
      if (head !== undefined && !LEGACY_LIST_HEADS.has(head)) {
        assert.equal(head, RUNTIME_PROTOCOL_VERSION, `${doc}: ${literal}`);
      }
    }
  }
});

test("reference doc initialize example advertises every supported version in order", () => {
  const expected = `"protocolVersions": ["${SUPPORTED_RUNTIME_PROTOCOL_VERSIONS.join('", "')}"]`;
  assert.ok(DOCS["docs/runtime-protocol-v1-reference.md"].includes(expected), expected);
});

test("reference doc lists every method, rollCode and latest limits field", () => {
  const reference = DOCS["docs/runtime-protocol-v1-reference.md"];
  for (const method of Object.values(RUNTIME_METHODS)) {
    assert.ok(reference.includes(`\`${method}\``), method);
  }
  for (const code of Object.values(RUNTIME_ERROR_CODES)) {
    assert.ok(reference.includes(`\`${code}\``), code);
  }
  const probe = Object.fromEntries(
    RUNTIME_LIMIT_KEYS.map((key) => [key, key === "eventReplay" ? true : 1]),
  );
  assert.equal(runtimeLimitsV14Schema.safeParse(probe).success, true);
  for (const key of RUNTIME_LIMIT_KEYS) {
    assert.ok(reference.includes(`\`${key}\``), key);
  }
});
```

（`RUNTIME_LIMIT_KEYS` 手写清单的正确性由 `runtimeLimitsV14Schema.safeParse(probe)` 保证：schema 是 `.strict()` 且全字段必填，清单多一个或少一个都会 parse 失败。）

- [ ] **Step 2: 运行确认失败**

Run: `node --experimental-strip-types --test packages/protocol/src/docs-sync.test.ts 2>&1 | grep -E "^(not ok|ok) "`
Expected: 4 条全部 `not ok`（当前文档：最新版本 `"1.3"`、6 处列表以 `"1.3"` 开头、缺 4 方法 / 8 错误码 / 4 限额 —— 已用脚本核对过正是这些缺口）。

- [ ] **Step 3: 格式化、lint，提交（红灯测试单独提交，便于 review 看到它守住了什么）**

```bash
npx prettier --write packages/protocol/src/docs-sync.test.ts
npx eslint packages/protocol/src/docs-sync.test.ts
git add packages/protocol/src/docs-sync.test.ts
git commit -m "$(cat <<'EOF'
test(protocol): pin protocol docs to RUNTIME_PROTOCOL_VERSION and registries

Fails until the docs stop calling 1.3 the latest version: checks the latest
claim in three docs, every version list literal in six docs, the initialize
example, and full method / rollCode / limits coverage in the reference.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: docs —— `runtime-protocol-v1-reference.md` 全量对齐 1.4

**Files:**
- Modify: `docs/runtime-protocol-v1-reference.md`

**Interfaces:**
- Produces: Task 5 中与参考文档相关的 3 条断言转绿

下面每个 `diff` 块里 `-` 行是 `6dbba27` 原文（已逐行核对），`+` 行是替换后文本；无 `-` 的块为新增行，插入位置见说明。按内容定位。

- [ ] **Step 1: 版本与入口表（L7-L24）**

```diff
-| 最新 Wire protocol | `"1.3"` |
-| 兼容 Wire protocol | `"1.2"`、`"1.1"`、`"1.0"` |
+| 最新 Wire protocol | `"1.4"` |
+| 兼容 Wire protocol | `"1.3"`、`"1.2"`、`"1.1"`、`"1.0"` |
```

```diff
-| 1.3 Client 入站帧最低能力 | `17 MiB`；预算更低的 Client 不得广告 1.3 |
-| Event replay | 1.3 只重放 durable event；1.2/1.1/1.0 不支持 |
+| 1.4/1.3 Client 入站帧最低能力 | `17 MiB`；预算更低的 Client 不得广告 1.4 或 1.3 |
+| Event replay | 1.4/1.3 只重放 durable event；1.2/1.1/1.0 不支持 |
+| Attachments | 1.4 新增 `attachment.stage` / `attachment.chunk` / `attachment.commit` / `attachment.release` 与 `turn.start.input.attachments`；仅当 `initialize` 结果 `features` 含 `"attachments"` 时可用 |
```

```diff
-`@roll-agent/protocol/schema`，或显式读取 `schema/1.3`、`schema/1.2`、`schema/1.1`、
+`@roll-agent/protocol/schema`，或显式读取 `schema/1.4`、`schema/1.3`、`schema/1.2`、`schema/1.1`、
```

```diff
-跨语言 fixture 位于 `@roll-agent/protocol/fixtures/v1.3/*` 与
-`@roll-agent/protocol/fixtures/v1.2/*`；冻结的 1.1/1.0 fixture 继续共用
+跨语言 fixture 位于 `@roll-agent/protocol/fixtures/v1.4/*`、`@roll-agent/protocol/fixtures/v1.3/*`
+与 `@roll-agent/protocol/fixtures/v1.2/*`；冻结的 1.1/1.0 fixture 继续共用
```

- [ ] **Step 2: 版本矩阵与帧预算段（L63-L81）**

```diff
-新代码处理 1.3/1.2/1.1/1.0 矩阵时应按协商版本调用 version-aware helper，避免把新版字段
+新代码处理 1.4/1.3/1.2/1.1/1.0 矩阵时应按协商版本调用 version-aware helper，避免把新版字段
```

```diff
-`RollNodeClient` 会按强制 handler 规则生成版本列表，并在 1.3/1.2 初始化后自动完成
+`RollNodeClient` 会按强制 handler 规则生成版本列表，并在 1.4/1.3/1.2 初始化后自动完成
```

```diff
-Protocol 1.3 的单条 durable event record 最多为 `16 MiB`；加上 Runtime envelope 与
-JSON-RPC notification 元数据后，广告 `"1.3"` 即声明 Client 能接收至少 `17 MiB` 的单个
-Runtime→Client NDJSON 帧。本地入站预算低于该值的 Client 必须省略 `"1.3"`。初始化结果中的
+Protocol 1.4/1.3 的单条 durable event record 最多为 `16 MiB`；加上 Runtime envelope 与
+JSON-RPC notification 元数据后，广告 `"1.4"` 或 `"1.3"` 即声明 Client 能接收至少 `17 MiB` 的单个
+Runtime→Client NDJSON 帧。本地入站预算低于该值的 Client 必须同时省略 `"1.4"` 与 `"1.3"`。初始化结果中的
```

- [ ] **Step 3: 初始化段（L95-L149）**

```diff
-    "protocolVersions": ["1.3", "1.2", "1.1", "1.0"],
+    "protocolVersions": ["1.4", "1.3", "1.2", "1.1", "1.0"],
```

```diff
-结果包含协商版本、`runtimeInstanceId`、Server 信息、能力和限制。`limits` 会返回
-`maxFrameBytes`、`maxPageSize`、`eventReplay` 和 `idempotencyCacheEntries`；客户端发送
-前必须遵守协商后的单帧上限。当前 Runtime 默认返回：
+结果包含协商版本、`runtimeInstanceId`、Server 信息、能力和限制。`limits` 会返回
+`maxFrameBytes`、`maxPageSize`、`eventReplay` 和 `idempotencyCacheEntries`，1.4 还返回
+`maxAttachmentBytes`、`maxAttachmentChunkBytes`、`maxTurnAttachments` 与 `maxStagedAttachments`；
+客户端发送前必须遵守协商后的单帧上限。当前 Runtime 默认返回：
```

```diff
-| `eventReplay` | 1.3 为 `true`；旧版本为 `false` | 是否提供 durable event 持久重放 |
 | `idempotencyCacheEntries` | `10,000` | 已完成 mutation 的进程内缓存窗口 |
+| `eventReplay` | 1.4/1.3 为 `true`；旧版本为 `false` | 是否提供 durable event 持久重放 |
+| `idempotencyCacheEntries` | `10,000` | 已完成 mutation 的进程内缓存窗口 |
+| `maxAttachmentBytes` | `16 * 1024 * 1024` | 1.4：单个附件原始字节上限 |
+| `maxAttachmentChunkBytes` | `2 * 1024 * 1024` | 1.4：`attachment.chunk` 单片原始字节上限 |
+| `maxTurnAttachments` | `8` | 1.4：单个 `turn.start` 可引用的附件数 |
+| `maxStagedAttachments` | `16` | 1.4：同时处于 staged 状态的附件数 |
```

```diff
-| 已注册 `approval.request` handler | `["1.3","1.2","1.1","1.0"]` | `"1.3"` | capability ACK 后的 Server Request |
-| 未注册 Server Request handler | `["1.3","1.2","1.0"]` | `"1.3"` | ACK 空集合；Runtime 不投递 Approval |
+| 已注册 `approval.request` handler | `["1.4","1.3","1.2","1.1","1.0"]` | `"1.4"` | capability ACK 后的 Server Request |
+| 未注册 Server Request handler | `["1.4","1.3","1.2","1.0"]` | `"1.4"` | ACK 空集合；Runtime 不投递 Approval |
```

```diff
-| 字段 | `"1.3"` | `"1.2"` | `"1.1"` | `"1.0"` |
-|---|---|---|---|---|
-| `serverRequests` | `true` | `true` | `true` | `false` |
-| `serverRequestCapabilityNegotiation` | `true` | `true` | `false` | `false` |
-| `approvalResolvedEvents` | `true` | `true` | `true` | `false` |
-| `clientApprovalResponses` | `false` | `false` | `false` | `true` |
-| `requiredServerRequestMethods` | `[]` | `[]` | `["approval.request"]` | `[]` |
+| 字段 | `"1.4"` | `"1.3"` | `"1.2"` | `"1.1"` | `"1.0"` |
+|---|---|---|---|---|---|
+| `serverRequests` | `true` | `true` | `true` | `true` | `false` |
+| `serverRequestCapabilityNegotiation` | `true` | `true` | `true` | `false` | `false` |
+| `approvalResolvedEvents` | `true` | `true` | `true` | `true` | `false` |
+| `clientApprovalResponses` | `false` | `false` | `false` | `false` | `true` |
+| `requiredServerRequestMethods` | `[]` | `[]` | `[]` | `["approval.request"]` | `[]` |
```

```diff
-新 Client 向旧 Runtime 发送 `["1.3","1.2","1.1","1.0"]` 时，旧 Runtime 可选择 `"1.2"`、`"1.1"`
-或 `"1.0"`；strict `initialize` params 没有增加 capability 字段。协商结果属于当前
-连接，1.0/1.1 连接不能动态开启 1.3/1.2 capability。`@roll-agent/client-node` 总能广告
-没有强制 handler 的 1.2；使用至少 17 MiB 本地入站预算时也会广告 1.3。只有覆盖
+新 Client 向旧 Runtime 发送 `["1.4","1.3","1.2","1.1","1.0"]` 时，旧 Runtime 可选择 `"1.3"`、`"1.2"`、
+`"1.1"` 或 `"1.0"`；strict `initialize` params 没有增加 capability 字段。协商结果属于当前
+连接，1.0/1.1 连接不能动态开启 1.4/1.3/1.2 capability。`@roll-agent/client-node` 总能广告
+没有强制 handler 的 1.2；使用至少 17 MiB 本地入站预算时也会广告 1.4 与 1.3。只有覆盖
```

```diff
-Client handler，是从上述能力表派生的兼容导出。1.3/1.2 registry 包含可选的
-`approval.request` 与 `userInput.request`；未来 method 也必须通过 1.3/1.2 capability 集合显式
+Client handler，是从上述能力表派生的兼容导出。1.4/1.3/1.2 registry 包含可选的
+`approval.request` 与 `userInput.request`；未来 method 也必须通过 1.4/1.3/1.2 capability 集合显式
```

```diff
-### 1.3/1.2 Client capability handshake
+### 1.4/1.3/1.2 Client capability handshake
 
-协商到 `"1.3"` 或 `"1.2"` 后，Client 必须先调用：
+协商到 `"1.4"`、`"1.3"` 或 `"1.2"` 后，Client 必须先调用：
```

```diff
-`CAPABILITY_UNAVAILABLE`。这个边界防止 1.3/1.2/1.1 Approval 绕过 Server Request 控制路径。
+`CAPABILITY_UNAVAILABLE`。这个边界防止 1.4/1.3/1.2/1.1 Approval 绕过 Server Request 控制路径。
```

- [ ] **Step 4: ID 类型与方法段（L197-L244）**

```diff
-| `interactionId` | `string` | 1.3/1.2 逻辑 Interaction UUID；显式重投时保持稳定 |
-| `eventId` | `string` | 1.3 durable event UUID；只用于事件去重 |
-| `cursor` / Snapshot `eventCursor` | `string` | 1.3 不透明 `rte1:<eventLogId>:<threadSequence>:<eventId>`；不得拆解生成 |
+| `interactionId` | `string` | 1.4/1.3/1.2 逻辑 Interaction UUID；显式重投时保持稳定 |
+| `eventId` | `string` | 1.4/1.3 durable event UUID；只用于事件去重 |
+| `cursor` / Snapshot `eventCursor` | `string` | 1.4/1.3 不透明 `rte1:<eventLogId>:<threadSequence>:<eventId>`；不得拆解生成 |
```

```diff
-- 1.3/1.2 `interactionId` 标识逻辑交互，显式重投会换 JSON-RPC `id` 但保持它；
+- 1.4/1.3/1.2 `interactionId` 标识逻辑交互，显式重投会换 JSON-RPC `id` 但保持它；
```

```diff
-| `client.capabilities.set` | `"1.3"` / `"1.2"` 握手扩展 | `revision`, `serverRequestMethods` | revision 与 Runtime registry 交集 |
+| `client.capabilities.set` | `"1.4"` / `"1.3"` / `"1.2"` 握手扩展 | `revision`, `serverRequestMethods` | revision 与 Runtime registry 交集 |
```

```diff
-| `runtime.events.resume` | `"1.3"` 恢复 | `threadId`, `afterCursor` | replay barrier `{ throughCursor, replayedCount }` |
+| `runtime.events.resume` | `"1.4"` / `"1.3"` 恢复 | `threadId`, `afterCursor` | replay barrier `{ throughCursor, replayedCount }` |
```

```diff
-| `turn.start` | mutation | `requestId`, `threadId`, `turnId`, 文本输入 | 立即返回 `accepted` |
+| `turn.start` | mutation | `requestId`, `threadId`, `turnId`, 文本输入；1.4 可加 `attachments` | 立即返回 `accepted` |
```

在 `` | `operation.get` | 只读 | … | `` 这一行之后新增：

```diff
+| `attachment.stage` | `"1.4"` mutation | `requestId`, `threadId`, `fileName`, `mediaType`, `bytes`, `sha256`, `source`, `sourcePath?` | `{ attachmentId, state, descriptor? }` |
+| `attachment.chunk` | `"1.4"` mutation | `requestId`, `threadId`, `attachmentId`, `sequence`, `dataBase64` | `{ receivedBytes, nextSequence }` |
+| `attachment.commit` | `"1.4"` mutation | `requestId`, `threadId`, `attachmentId` | `{ descriptor }` |
+| `attachment.release` | `"1.4"` mutation | `requestId`, `threadId`, `attachmentId` | `{ released }` |
```

~~~diff
-mutation 幂等缓存，也不应被客户端自动重试。`turn.start` 的输入在 v1 仅支持：
+mutation 幂等缓存，也不应被客户端自动重试。`turn.start` 的输入在 1.3 及更早版本仅支持
+`{ "text": "用户消息" }`；1.4 额外接受 `attachments`（1..8 个已 `commit` 的 `attachmentId`），
+引用附件时 `text` 可为空：
 
 ```json
-{ "text": "用户消息" }
+{ "text": "", "attachments": ["00000000-0000-4000-8000-0000000000a1"] }
 ```
~~~

- [ ] **Step 5: Snapshot 与事件段（L258-L374）**

```diff
-pendingInteractions[]        1.3/1.2；必需字段，可为空
-eventCursor                  仅 1.3；必需字段，可为 null
+pendingInteractions[]        1.4/1.3/1.2；必需字段，可为空
+eventCursor                  1.4/1.3；必需字段，可为 null
```

```diff
-`pendingInteractions` 同时存在于 1.3 与 1.2；`eventCursor` 只存在于 1.3。1.2/1.1/1.0
-adapter 会剥离 `eventCursor` 与所有 1.3 event envelope 字段。
+`pendingInteractions` 存在于 1.4/1.3/1.2；`eventCursor` 存在于 1.4/1.3。1.2/1.1/1.0 adapter 会剥离
+`eventCursor` 与所有 1.3+ event envelope 字段。1.4 的 `messages.items[].parts` 可含 `attachment` 安全元数据
+part（`mediaType` / `bytes` / `displayName?`，不含二进制与本地路径）；投影到 1.3 及更早版本时非 `text` part
+会被静默剥离，纯附件消息会变成 `parts: []`。
```

```diff
-1.3/1.2 的 `activeTurn.status` 为 `running | cancelling | waiting-for-user`；冻结的 1.1/1.0
+1.4/1.3/1.2 的 `activeTurn.status` 为 `running | cancelling | waiting-for-user`；冻结的 1.1/1.0
```

```diff
-`thread.snapshot` 会完全剥离 `pendingInteractions`。1.3/1.2 Interaction 若缺少 Runtime 提供的
+`thread.snapshot` 会完全剥离 `pendingInteractions`。1.4/1.3/1.2 Interaction 若缺少 Runtime 提供的
```

```diff
-所有事件通过完整的 JSON-RPC Notification 发送。1.3 envelope 显式区分 durable 与
+所有事件通过完整的 JSON-RPC Notification 发送。1.4/1.3 envelope 显式区分 durable 与
```

```diff
-    "protocolVersion": "1.3",
+    "protocolVersion": "1.4",
```

```diff
-| 1.3 durability | event allowlist | 恢复语义 |
+| 1.4/1.3 durability | event allowlist | 恢复语义 |
```

```diff
-`approval.required` 在 `"1.0"` 是控制事件；在 1.3/1.2/1.1 仅为只读 View Event。
+`approval.required` 在 `"1.0"` 是控制事件；在 1.4/1.3/1.2/1.1 仅为只读 View Event。
```

```diff
-### 持久事件恢复（1.3）
+### 持久事件恢复（1.4/1.3）
 
-`runtime.events.resume` 只在 1.3 可用。`afterCursor` 是该 Thread 已应用的 checkpoint；首次从
+`runtime.events.resume` 只在 1.4/1.3 可用。`afterCursor` 是该 Thread 已应用的 checkpoint；首次从
```

```diff
-`thread.snapshot({ threadId, limit: 1, recovery: true })`。1.3 Response 带
+`thread.snapshot({ threadId, limit: 1, recovery: true })`。1.4/1.3 Response 带
```

- [ ] **Step 6: Server Request、取消、错误、幂等段（L391-L650）**

```diff
-`"1.3"`、`"1.2"` 与 `"1.1"` 的 Approval 只有一条可写控制路径：Runtime 发出
+`"1.4"`、`"1.3"`、`"1.2"` 与 `"1.1"` 的 Approval 只有一条可写控制路径：Runtime 发出
```

```diff
-`approval.respond`；在这三个版本上调用该方法会返回 `CAPABILITY_UNAVAILABLE`。
-1.3/1.2 还要求 `approval.request` 已出现在最近一次 ACK 的 capability 集合中。
-1.3/1.2 的 User Input 同样只有 `userInput.request` Result 这一条写入路径，并要求该 method
+`approval.respond`；在这四个版本上调用该方法会返回 `CAPABILITY_UNAVAILABLE`。
+1.4/1.3/1.2 还要求 `approval.request` 已出现在最近一次 ACK 的 capability 集合中。
+1.4/1.3/1.2 的 User Input 同样只有 `userInput.request` Result 这一条写入路径，并要求该 method
```

```diff
-1.3/1.2 Runtime Request：
+1.4/1.3/1.2 Runtime Request：
```

```diff
-### User Input 1.3/1.2
+### User Input 1.4/1.3/1.2
```

```diff
-再按 control 定义顺序规范化。等待期间 1.3/1.2 Snapshot 使用 `waiting-for-user`，默认 deadline
+再按 control 定义顺序规范化。等待期间 1.4/1.3/1.2 Snapshot 使用 `waiting-for-user`，默认 deadline
```

```diff
-JSON-RPC `id` 只负责当前投递的 Request/Response 关联；1.3/1.2 `interactionId` 负责逻辑
+JSON-RPC `id` 只负责当前投递的 Request/Response 关联；1.4/1.3/1.2 `interactionId` 负责逻辑
```

```diff
-1.3/1.2 形状是：
+1.4/1.3/1.2 形状是：
```

```diff
-Interaction。1.3 的事件恢复不会重放 Server Request；断线后没有持久 Interaction
+Interaction。1.4/1.3 的事件恢复不会重放 Server Request；断线后没有持久 Interaction
```

```diff
-| `CAPABILITY_REVISION_CONFLICT` | 1.3/1.2 capability revision 过旧，或同 revision 配不同集合 |
-| `EVENT_CURSOR_EXPIRED` | 1.3 checkpoint 已被连续前缀裁剪；重新读取 Snapshot |
-| `EVENT_CURSOR_GAP` | 1.3 cursor 不属于可连续恢复的 Thread 日志；重新读取 Snapshot |
+| `CAPABILITY_REVISION_CONFLICT` | 1.4/1.3/1.2 capability revision 过旧，或同 revision 配不同集合 |
+| `EVENT_CURSOR_EXPIRED` | 1.4/1.3 checkpoint 已被连续前缀裁剪；重新读取 Snapshot |
+| `EVENT_CURSOR_GAP` | 1.4/1.3 cursor 不属于可连续恢复的 Thread 日志；重新读取 Snapshot |
+| `ATTACHMENT_NOT_FOUND` | 1.4：`attachmentId` 不存在、已释放或已过期回收 |
+| `ATTACHMENT_NOT_COMMITTED` | 1.4：`turn.start` 引用了尚未 `commit` 的附件 |
+| `ATTACHMENT_TOO_LARGE` | 1.4：声明或实际字节数超过 `maxAttachmentBytes`，或 chunks 累计超过声明字节数 |
+| `ATTACHMENT_TYPE_UNSUPPORTED` | 1.4：`mediaType` 不在支持列表，或文件扩展名与 `mediaType` 不匹配 |
+| `ATTACHMENT_HASH_MISMATCH` | 1.4：`commit` 时实际内容 sha256 与声明不符，附件被回收 |
+| `ATTACHMENT_QUOTA_EXCEEDED` | 1.4：staged 附件数已达 `maxStagedAttachments` |
+| `ATTACHMENT_UPLOAD_INCOMPLETE` | 1.4：chunks 来源 `commit` 时累计字节数不等于声明值 |
+| `ATTACHMENT_PATH_REJECTED` | 1.4：local-path 来源不是绝对路径、不可 `lstat`、是 symlink 或不是普通文件 |
```

（8 条附件错误码的含义依据 `packages/runtime/src/service/attachment-store.ts` 各触发点：`:183/:286/:456` TOO_LARGE、`:190/:197/:425` TYPE_UNSUPPORTED、`:204` QUOTA_EXCEEDED、`:311` UPLOAD_INCOMPLETE、`:320/:471` HASH_MISMATCH、`:357` NOT_COMMITTED、`:418/:435/:442/:449` PATH_REJECTED、`:489` NOT_FOUND。）

```diff
-- `"1.0"` 进入 mutation 幂等缓存的七个方法是 `thread.create`、`thread.rename`、
-  `thread.delete`、`thread.detach`、`turn.start`、`turn.cancel` 和
-  `approval.respond`；`"1.3"` / `"1.2"` / `"1.1"` 不使用最后一个方法。上述 mutation 都携带 UUID
-  `requestId`；
+- 进入 mutation 幂等缓存的方法：`thread.create`、`thread.rename`、`thread.delete`、
+  `thread.detach`、`turn.start`、`turn.cancel`（全部版本）；`approval.respond`（仅 `"1.0"`）；
+  `attachment.stage`、`attachment.chunk`、`attachment.commit`、`attachment.release`（仅 `"1.4"`）。
+  上述 mutation 都携带 UUID `requestId`；
```

- [ ] **Step 7: 验证**

Run:
```bash
node --experimental-strip-types --test packages/protocol/src/docs-sync.test.ts 2>&1 | grep -E "^(not ok|ok) "
grep -n '1\.3' docs/runtime-protocol-v1-reference.md | grep -v '1\.4'
```
Expected: 与参考文档相关的 3 个测试 `ok`（`docs version list literals …` 在 Task 7 完成前仍 `not ok`，因其他文档未改）；最后一条 grep 输出的每一行都必须是下列合法例外之一，否则就是遗漏：`schema/1.3`、`fixtures/v1.3`、兼容版本表里的 `` `"1.3"`、`"1.2"` ``、「1.3 及更早」、旧 Runtime 回退选项。

- [ ] **Step 8: Commit**

```bash
git add docs/runtime-protocol-v1-reference.md
git commit -m "$(cat <<'EOF'
docs(protocol): align Runtime Protocol reference with 1.4

1.4 shipped on 2026-08-12 but the reference still named 1.3 as the latest wire
version, scoped the frame floor / capability handshake / events.resume /
eventCursor to 1.3 only, described turn.start input as text-only, and listed
seven idempotent methods. Adds the 1.4 column, four attachment methods, four
attachment limits, eight ATTACHMENT_* codes, and the attachment message part
downgrade rule.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: docs —— 其余五份文档的「最新版本」声明与版本列表字面量

**Files:**
- Modify: `docs/client-node-reference.md:9-10,158-161,239`
- Modify: `docs/runtime-protocol-architecture.md:53`
- Modify: `packages/protocol/README.md:89-90,96-97`
- Modify: `packages/client-node/README.md:76-79`

**Interfaces:**
- Produces: Task 5 的 `docs version list literals …` 与 `docs declare RUNTIME_PROTOCOL_VERSION …` 转绿

- [ ] **Step 1: `docs/client-node-reference.md`**

```diff
-| 最新协议 | Roll Runtime Protocol `"1.3"` |
-| 无 Server Request handler 时 | 默认帧预算下广告 `["1.3","1.2","1.0"]`；1.3/1.2 capability 集合为空 |
+| 最新协议 | Roll Runtime Protocol `"1.4"` |
+| 无 Server Request handler 时 | 默认帧预算下广告 `["1.4","1.3","1.2","1.0"]`；1.4/1.3/1.2 capability 集合为空 |
```

```diff
-| 注册 `approval.request` | `["1.3","1.2","1.1","1.0"]` | 新 Runtime 为 `"1.3"`；旧 Runtime 可逐级回退 |
-| 仅注册 `userInput.request` | `["1.3","1.2","1.0"]` | 新 Runtime 为 `"1.3"`；旧 Runtime 可回退 1.2/1.0 |
-| 无 handler / 空对象 | `["1.3","1.2","1.0"]` | 新 Runtime 为 `"1.3"` 且 ACK 空 capability；旧 Runtime 可回退 1.2/1.0 |
-| 任意 handlers，`maxFrameBytes < 17 MiB` | 上述列表移除 `"1.3"` | 不会协商 1.3；按 handler 规则回落到旧版本 |
+| 注册 `approval.request` | `["1.4","1.3","1.2","1.1","1.0"]` | 新 Runtime 为 `"1.4"`；旧 Runtime 可逐级回退 |
+| 仅注册 `userInput.request` | `["1.4","1.3","1.2","1.0"]` | 新 Runtime 为 `"1.4"`；旧 Runtime 可回退 1.3/1.2/1.0 |
+| 无 handler / 空对象 | `["1.4","1.3","1.2","1.0"]` | 新 Runtime 为 `"1.4"` 且 ACK 空 capability；旧 Runtime 可回退 1.3/1.2/1.0 |
+| 任意 handlers，`maxFrameBytes < 17 MiB` | 上述列表移除 `"1.4"` 与 `"1.3"` | 不会协商 1.4/1.3；按 handler 规则回落到旧版本 |
```

```diff
-不支持持久 Server Request replay/resume：1.3 只恢复 durable View Event，不恢复控制请求。
+不支持持久 Server Request replay/resume：1.4/1.3 只恢复 durable View Event，不恢复控制请求。
```

- [ ] **Step 2: `docs/runtime-protocol-architecture.md`**

```diff
-协议版本从 `"1.0"` 开始，当前最新版本为 `"1.3"`，与 npm 包版本独立。未来增加
+协议版本从 `"1.0"` 开始，当前最新版本为 `"1.4"`，与 npm 包版本独立。未来增加
```

- [ ] **Step 3: `packages/protocol/README.md`**

```diff
-- `@roll-agent/protocol/schema/1.3`、`/1.2`、`/1.1`、`/1.0`：严格按协商版本隔离的 Schema；
+- `@roll-agent/protocol/schema/1.4`、`/1.3`、`/1.2`、`/1.1`、`/1.0`：严格按协商版本隔离的 Schema；
+- `@roll-agent/protocol/fixtures/v1.4/*`：Protocol 1.4 attachment / turn.start / snapshot fixtures；
 - `@roll-agent/protocol/fixtures/v1.3/*`：Protocol 1.3 durable event/replay fixtures；
```

```diff
-`["1.3", "1.2", "1.1", "1.0"]`。`initialize` 请求保持旧 strict 形状；协商到 `"1.2"`
-或 `"1.3"` 后，
+`["1.4", "1.3", "1.2", "1.1", "1.0"]`。`initialize` 请求保持旧 strict 形状；协商到 `"1.2"`、
+`"1.3"` 或 `"1.4"` 后，
```

- [ ] **Step 4: `packages/client-node/README.md`**

```diff
-- `"1.3"` / `"1.2"` 没有强制 Handler；使用默认帧预算时，即使没有 Handler 也会广告
-  `["1.3","1.2","1.0"]`，并以 revision 1 ACK 空能力集合；只有 `userInput.request` 时
+- `"1.4"` / `"1.3"` / `"1.2"` 没有强制 Handler；使用默认帧预算时，即使没有 Handler 也会广告
+  `["1.4","1.3","1.2","1.0"]`，并以 revision 1 ACK 空能力集合；只有 `userInput.request` 时
```

```diff
-- 显式把 `maxFrameBytes` 设为低于 `17 MiB` 时不会广告 `"1.3"`，因为该预算无法保证接收
+- 显式把 `maxFrameBytes` 设为低于 `17 MiB` 时不会广告 `"1.4"` 与 `"1.3"`，因为该预算无法保证接收
```

- [ ] **Step 5: 验证**

Run:
```bash
node --experimental-strip-types --test packages/protocol/src/docs-sync.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail) "
```
Expected: `tests 4 / pass 4 / fail 0`。

- [ ] **Step 6: Commit**

```bash
git add docs/client-node-reference.md docs/runtime-protocol-architecture.md packages/protocol/README.md packages/client-node/README.md
git commit -m "$(cat <<'EOF'
docs: stop calling Runtime Protocol 1.3 the latest version

client-node reference, architecture overview and both package READMEs still
advertised ["1.3", ...] lists and named 1.3 as latest; the published package
READMEs link to these pages from npm.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Electron 示例 —— 版本列表从协议能力派生，修复对最新 runtime 启动即失败

**Files:**
- Modify: `examples/electron-runtime-client/supported-protocols.ts`（整文件重写）
- Modify: `examples/electron-runtime-client/main.ts:279`（错误文案）
- Modify: `examples/electron-runtime-client/README.md:60-61,70,73`

**Interfaces:**
- Consumes: `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS`、`getRuntimeProtocolCapabilities`、`RuntimeProtocolVersion`（`@roll-agent/protocol`，esbuild alias 到 `packages/protocol/src/index.ts`）
- Produces: `ElectronRuntimeProtocolVersion`、`isElectronRuntimeProtocolVersion`、`ELECTRON_RUNTIME_PROTOCOL_VERSIONS`（`main.ts:23-24` 与 `preload.ts:13` 继续按原名导入）

- [ ] **Step 1: 重写 `supported-protocols.ts`**

```ts
import {
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  getRuntimeProtocolCapabilities,
  type RuntimeProtocolVersion,
} from "@roll-agent/protocol";

export type ElectronRuntimeProtocolVersion = Exclude<RuntimeProtocolVersion, "1.0">;

export function isElectronRuntimeProtocolVersion(
  value: RuntimeProtocolVersion,
): value is ElectronRuntimeProtocolVersion {
  return getRuntimeProtocolCapabilities(value).serverRequests;
}

export const ELECTRON_RUNTIME_PROTOCOL_VERSIONS: readonly ElectronRuntimeProtocolVersion[] =
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS.filter(isElectronRuntimeProtocolVersion);
```

- [ ] **Step 2: 改 `main.ts` 错误文案**

```diff
-    throw new Error("This Electron reference requires Runtime Protocol 1.3, 1.2 or 1.1");
+    throw new Error(
+      "This Electron reference requires a Runtime Protocol version with Server Request support (1.1 or newer)",
+    );
```

- [ ] **Step 3: 改 README**

```diff
-This reference accepts Runtime Protocol `"1.3"`, `"1.2"`, and the N-2 `"1.1"` fallback. Its startup
-`approval.request` and named `userInput.request` handlers are included in the 1.3/1.2
+This reference accepts every Runtime Protocol version with Server Request support — currently `"1.4"`,
+`"1.3"`, `"1.2"`, and the `"1.1"` fallback — derived from `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS` so it
+tracks `@roll-agent/protocol` automatically. Its startup
+`approval.request` and named `userInput.request` handlers are included in the 1.4/1.3/1.2
```

```diff
-interaction. The renderer token is never treated as a Runtime JSON-RPC `id`, 1.3/1.2 `interactionId`,
+interaction. The renderer token is never treated as a Runtime JSON-RPC `id`, 1.4/1.3/1.2 `interactionId`,
```

```diff
-The User Input dialog renders all five 1.3/1.2 controls (`text`, `multiline`, `number`, `boolean`, and
+The User Input dialog renders all five 1.4/1.3/1.2 controls (`text`, `multiline`, `number`, `boolean`, and
```

- [ ] **Step 4: 验证**

Run:
```bash
pnpm verify:example:electron 2>&1 | tail -5
npx prettier --write examples/electron-runtime-client/supported-protocols.ts examples/electron-runtime-client/main.ts
npx eslint examples/electron-runtime-client/supported-protocols.ts examples/electron-runtime-client/main.ts
node --experimental-strip-types --input-type=module -e '
  const m = await import("./packages/protocol/src/index.ts");
  const ok = m.SUPPORTED_RUNTIME_PROTOCOL_VERSIONS.filter((v) => m.getRuntimeProtocolCapabilities(v).serverRequests);
  console.log(JSON.stringify(ok));
' 2>&1 | grep -v Warning
```
Expected: esbuild + verify-build exit 0；最后一行输出 `["1.4","1.3","1.2","1.1"]`。

说明：示例不在 `pnpm typecheck` / `pnpm test` 流水线内（无 tsconfig / package.json），`verify:example:electron` 是唯一的自动校验。本任务**未实跑** Electron 对真实 runtime 的连接；「启动即失败」的判断来自静态链路（`packages/client-node/src/index.ts:75,624-629` → `packages/runtime/src/service/runtime-service.ts:572-578` → `examples/electron-runtime-client/main.ts:276-279`）。

- [ ] **Step 5: Commit**

```bash
git add examples/electron-runtime-client/supported-protocols.ts examples/electron-runtime-client/main.ts examples/electron-runtime-client/README.md
git commit -m "$(cat <<'EOF'
fix(examples/electron): derive accepted protocol versions from capabilities

RollNodeClient advertises every supported version (1.4 first under the default
17 MiB frame budget), Runtime negotiates 1.4, and the hand-written
["1.3","1.2","1.1"] guard rejected it at startup. `satisfies readonly
RuntimeProtocolVersion[]` only checks membership, not coverage, so widening the
union never failed. The list is now SUPPORTED_RUNTIME_PROTOCOL_VERSIONS filtered
by serverRequests support.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: changeset、全仓验证、GitNexus 变更核对

**Files:**
- Create: `.changeset/runtime-protocol-1-4-alignment.md`

- [ ] **Step 1: 写 changeset**

```md
---
"@roll-agent/protocol": patch
"@roll-agent/runtime": patch
---

Runtime Protocol 1.4 对齐修复

- protocol：`projectRuntimeServerRequestCancelParams` / `projectRuntimeServerRequestParams` 改按 `RUNTIME_PROTOCOL_CAPABILITIES` 派生 wire 形状，修复 1.4 会话上 `runtime.serverRequest.cancel` 投影抛错、取消通知从未送达（待处理 `approval.request` / `userInput.request` 到期或取消后客户端得不到通知）；新增全版本矩阵回归测试
- protocol：补齐 `@roll-agent/protocol/schema/1.4` 子路径导出（产物已存在但未导出）；新增 `fixtures/v1.4/*` 跨语言 golden fixture；新增 docs-sync 测试把协议文档钉到 `RUNTIME_PROTOCOL_VERSION`
- runtime：`RuntimeClientRequestCoordinator` 取消通知投影失败时通过 `onDiagnostic` 上报而不再静默吞掉；补 1.4 取消通知回归测试
```

- [ ] **Step 2: 验证 changeset 与全仓检查**

Run:
```bash
pnpm changeset status 2>&1 | tail -8
pnpm lint
pnpm typecheck
pnpm --filter @roll-agent/protocol test 2>&1 | grep -E "^ℹ (tests|pass|fail) "
pnpm --filter @roll-agent/runtime test 2>&1 | grep -E "^ℹ (tests|pass|fail) "
pnpm --filter @roll-agent/client-node test 2>&1 | grep -E "^ℹ (tests|pass|fail) "
```
Expected: changeset status 列出 protocol / runtime 各 patch 且无错误；lint / typecheck 无输出；三个包 `fail 0`。

- [ ] **Step 3: GitNexus 变更核对**

调用 `detect_changes({ repo: "roll-agent", scope: "compare", base_ref: "main" })`，确认受影响的生产符号仅为：`projectRuntimeServerRequestParams`、`projectRuntimeServerRequestCancelParams`、新增的 `resolveRuntimeServerRequestWireShape`、`RuntimeClientRequestCoordinator.sendCancellation`、Electron 的 `isElectronRuntimeProtocolVersion`；其余均为测试文件。出现其他生产符号即停下来解释。

- [ ] **Step 4: Commit**

```bash
git add .changeset/runtime-protocol-1-4-alignment.md
git commit -m "$(cat <<'EOF'
chore: changeset for Runtime Protocol 1.4 alignment

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## 后续（不在本计划内）

- `docs/client-node-reference.md`（26 处）、`docs/tutorial-runtime-ui-quickstart.md`（13 处）、`packages/client-node/README.md`（13 处）中逐句的「1.3/1.2」能力措辞扫描
- `docs/runtime-protocol-v1-reference.md` 增加 changelog 段（目前没有）
- `examples/python-runtime-client` 若要升级到 1.4，需要实现 capability handshake 与 `interactionId` 取消语义，是独立任务
