# RFC: 多账号 Recruiter Binding + 显式 Tenant Resolution + Envelope 账号绑定校验

> Status: Draft (Phase A+B 并行落地)
> Date: 2026-04-17
> Authors: @steveoon, Codex (%0 nano-agent pane), Codex (%3 reply-authority-service pane), Claude (Opus 4.7)
> Supersedes: 无；补充 `docs/rfc-reply-authority-service.md` 的 target/envelope 设计

## 0. 快速导航（给实施方）

- **%0 Codex（nano-agent 侧）**：实现 §5 客户端改动（`agents/smart-reply`、`agents/browser-use`），对齐 §3 的 envelope schema 和 §4 的 resolver endpoint 契约
- **%3 Codex（reply-authority-service 侧）**：实现 §4 服务端改动（tenant schema 扩展、resolver endpoint、envelope signer），对齐 §3 的 envelope schema
- **共用真理源**：§3（envelope schema）和 §4.2（resolver endpoint request/response）是跨 repo 契约，不许单方改动

## 1. 背景

### 1.1 当前状态

- `smart-reply-agent.generate_reply` 的 `target.tenantId` 在客户端 schema 必填（`agents/smart-reply/src/types/reply-authority.ts:8`）；服务端 schema 也必填（`reply-authority-service/src/routes/generate-reply.ts` → 400 `body/target must have required property 'tenantId'`）
- 调用端 LLM orchestrator（`roll ask` / OpenClaw）**没有任何运行时路径**能自主得到合法 `tenantId`：
  - `browser-use-agent` 的 DOM 抽取工具（`zhipin_get_candidate_info` / `zhipin_read_messages`）只返回 `conversationId + candidateId`
  - `roll.config.yaml` / `agents/smart-reply/references/env.yaml` / `SKILL.md` 都没有 `tenantId` 注入约定
  - 经 curl 实测，bearer token `client-test-token` 对任意 tenant 名都返回 `403 Requested tenant is unavailable` —— 服务端严格校验 `token → tenantIds[]` 白名单
- `zhipin_send_reply` 本地验签时**不比对 tenantId**（`agents/browser-use/src/tools/zhipin-send-reply.ts:70-75`），只比对 `conversationId + candidateId` —— 执行层缺口

### 1.2 新加入的业务前提（来自用户）

> 一个 OpenClaw 实例通过 roll-agent **同时控制多个 BOSS 招聘账号**。每个账号上聊的岗位不同，所以**岗位数据（brand-config）需要按账号隔离**；但 **reply-policy 在账号间是共享的**。

这排除了以下方案：
- ❌ "`ROLL_TENANT_ID` 单值 env 注入"：单值无法描述"当前操作的是哪个账号"
- ❌ "所有账号塞进同一 tenant，tenant 内再做 account scope 子隔离"：服务端当前没有 sub-scope brand-config 模型，需重做 config-loader / tenant-sync / admin API
- ❌ "browser-use 信任 envelope 不做本地校验"：会永久保留执行层缺口

## 2. 设计原则

1. **`tenant` 与 `recruiter` 是两个层面的概念**：
   - `tenant` = 岗位/品牌数据隔离单元（服务端概念）
   - `recruiter` = 绑定到 tenant 的**执行身份**（客户端 ground truth，可从 DOM 稳定读出）
2. **browser-use 不维护 tenant 映射表**：客户端只知道 `current recruiter username`，把 tenant 解析责任推给服务端
3. **Envelope 成为跨 agent 的 tenant+recruiter 绑定载体**：smart-reply 签发时把 `recruiterBinding` 一并签进 envelope，browser-use 发送前只比对 `current_recruiter === envelope.recruiterBinding`（客户端能稳定拿到的 ground truth）
4. **reply-policy 共享不需要动**：服务端已有 `tenant-file → global-file → default` 的 fallback 链（`reply-authority-service/src/services/config-loader.ts:309`），多账号拿各自 tenant 但共享全局 reply-policy 是天然支持的

## 3. Envelope Schema 变更（跨 repo 契约 — 锁死）

### 3.1 新 payload 结构

在 `docs/rfc-reply-authority-service.md §3.1` 原 `EnvelopePayload` 基础上 **新增 `recruiterBinding` 字段**：

```typescript
interface EnvelopePayload {
  v: 2;                          // 版本升级：breaking change
  kid: string;
  jti: string;
  iat: number;
  exp: number;
  aud: "browser-use-agent/zhipin_send_reply";
  platform: "zhipin";
  tenantId: string;
  conversationId: string;
  candidateId: string;
  reply: string;
  policyVersion: string;

  /** 🆕 绑定到签发时的招聘者执行身份，browser-use 发送前本地比对 */
  recruiterBinding: {
    /** 平台标识，当前为 "zhipin" */
    platform: "zhipin";
    /** 从 zhipin_get_username() 读到的用户名；v1 唯一来源 */
    username: string;
    /**
     * 可选强标识，为未来 BOSS 能稳定暴露 accountId 时保留。
     * v1 不填；browser-use 比对时若 accountId 存在则优先比 accountId，否则 fallback username。
     */
    accountId?: string;
  };
}
```

### 3.2 Schema 版本与密钥轮换

- `v: 1 → v: 2` 是 **breaking change**：browser-use v2 必须拒绝 v1 envelope（`unexpected envelope version`）；服务端 v2 只签发 v2
- **双 kid 并行期**（可选简化方案）：服务端可在过渡期同时发放 v1 和 v2（按 client 请求头 `X-Envelope-Version` 选），但推荐**硬切** —— 本 RFC 的客户端和服务端**同 PR 合并、同步发版**，无历史 envelope 存留（jti 默认 5 分钟过期），不需要双写

### 3.3 browser-use 侧本地校验逻辑（Phase B）

在 `zhipin_send_reply` 现有验签链（`verifier.ts` + `zhipin-send-reply.ts:70`）基础上新增：

```
验签 → 版本校验（v===2） → aud/platform/exp/jti（原有）
     → conversationId/candidateId 比对（原有）
     → 🆕 当前 recruiter 身份比对：
        const current = await zhipin_get_username(activePage)
        if (envelope.recruiterBinding.accountId) {
          assert current.accountId === envelope.recruiterBinding.accountId
        } else {
          assert current.username === envelope.recruiterBinding.username
        }
     → 发送
```

失败错误码建议：`"recruiter 绑定不匹配：当前账号 X 与签发时 Y 不一致"`

## 4. 服务端改动（%3 Codex 负责）

### 4.1 Tenant Manifest 扩展

在 `reply-authority-service/src/types/tenant.ts` 的 `TenantManifestSchema` 基础上新增 `bindings` 字段：

```typescript
const RecruiterBindingSchema = z.object({
  platform: z.literal("zhipin"),
  username: z.string().min(1),
  accountId: z.string().min(1).optional(),
});

const TenantManifestSchema = z.object({
  tenantId: z.string(),
  displayName: z.string(),
  status: ...,  // 原有
  syncParams: ...,  // 原有
  /** 🆕 该 tenant 绑定的所有招聘者身份 */
  bindings: z.object({
    zhipinRecruiters: z.array(RecruiterBindingSchema).default([]),
  }).default({ zhipinRecruiters: [] }),
});
```

本地 tenant manifest 文件示例（`data/tenants/<tenantId>/tenant.json`）：

```json
{
  "tenantId": "duliday-main",
  "displayName": "独立日（主账号）",
  "bindings": {
    "zhipinRecruiters": [
      { "platform": "zhipin", "username": "recruiter-alice" }
    ]
  }
}
```

### 4.2 Resolver Endpoint（跨 repo 契约 — 锁死）

新增 `POST /resolve-recruiter-binding`：

**Request**:
```typescript
interface ResolveRecruiterBindingRequest {
  platform: "zhipin";
  username: string;
  accountId?: string;
}
```

**Response (200)**:
```typescript
interface ResolveRecruiterBindingResponse {
  tenantId: string;                // 该 recruiter 唯一归属的 tenant
  recruiterBinding: {
    platform: "zhipin";
    username: string;
    accountId?: string;
  };
}
```

**Response (404)** — recruiter 未注册到任何 tenant：
```typescript
{ statusCode: 404, error: "Not Found", message: "recruiter 未绑定到任何 tenant：<username>" }
```

**Response (409)** — recruiter 在多个 tenant 中（本应不发生，作为一致性 guard）：
```typescript
{ statusCode: 409, error: "Conflict", message: "recruiter <username> 在多个 tenant 中（<t1>, <t2>），请联系管理员" }
```

**鉴权**：沿用现有 `Authorization: Bearer <token>` + `assertTenantAccess` 机制（响应的 `tenantId` 必须在 token 的 `tenantIds[]` 范围内，否则 `403`）

### 4.3 Generate-Signed-Reply 改动

- 输入 schema 保持 `target.tenantId` 必填，**新增 `target.recruiterBinding`** 必填
- 签发前校验：`recruiterBinding` 必须在该 `tenantId` 的 `bindings.zhipinRecruiters` 里（否则 `403 recruiterBinding 与 tenantId 不匹配`）—— 这一层防止客户端伪造 recruiter 绑定
- Envelope signer 把 `recruiterBinding` 签进 v2 payload

### 4.4 填充入口（%3 Codex 实施时请评估）

用户如何往 `data/tenants/<tenantId>/tenant.json` 的 `bindings.zhipinRecruiters` 里写数据？三种候选：

1. **手动改 JSON 文件 + sync**（最小可落地）
2. **扩展 admin API**：`POST /admin/tenants/:tenantId/bindings/zhipin-recruiters` 增删
3. **Duliday 同步**：如果 Duliday 后端有 recruiter 映射表，`tenant-sync.ts` 拉下来

**Phase A 要求至少 (1)**；(2) 和 (3) 可作为后续增强。Codex 请在实施前 ACK 选哪个路线。

### 4.5 测试要求

- 单测：resolver endpoint 的 200/404/409/403 四种路径
- 单测：envelope signer 输出包含 `recruiterBinding`，v2 schema 通过
- 集成：`generate-signed-reply` 在 `recruiterBinding` 与 `tenantId` 不匹配时 403
- 保留现有 reply-policy fallback 链测试不被破坏

## 5. 客户端改动（%0 Codex 负责）

### 5.1 smart-reply-agent

文件：`agents/smart-reply/src/types/reply-authority.ts`

- `ReplyAuthorityTargetSchema` 新增 `recruiterBinding` 必填字段（schema 同 §3.1 `recruiterBinding`）
- `GenerateReplyToolInputSchema.target` 同步更新
- `GenerateSignedReplyResponseSchema` 的 `signedEnvelope` 描述更新为 v2

文件：`agents/smart-reply/src/services/reply-authority-client.ts` — **无业务逻辑改动**（它只转发 input → HTTP）

文件：`agents/smart-reply/SKILL.md`
- Tools 章节更新 tool signature：`generate_reply(..., target: { tenantId, recruiterBinding, conversationId, candidateId })`
- "典型跨 Agent 工作流"章节更新为：
  1. `browser-use.zhipin_get_username()` → `{ username }`
  2. `POST reply-authority-service/resolve-recruiter-binding` → `{ tenantId, recruiterBinding }`
  3. `browser-use.zhipin_get_candidate_info(...)` → `{ conversationId, candidateId }`
  4. `smart-reply.generate_reply({ candidateMessage, target: { tenantId, recruiterBinding, conversationId, candidateId } })` → `signedEnvelope`
  5. `browser-use.zhipin_send_reply(signedEnvelope)` → 本地校验 recruiterBinding + 发送

### 5.2 browser-use-agent

文件：`agents/browser-use/src/reply-authority/schemas.ts`
- `EnvelopePayloadSchema` 加 `recruiterBinding` 必填 + `v: z.literal(2)`

文件：`agents/browser-use/src/reply-authority/verifier.ts`
- 版本校验：`payload.v !== 2` → 抛 `"unexpected envelope version"`

文件：`agents/browser-use/src/tools/zhipin-send-reply.ts`
- 在现有 `conversationId + candidateId` 比对后、发送前，新增 recruiter 校验（见 §3.3 伪代码）
- 需要调用 `zhipin_get_username` 的底层实现（不走 MCP，直接复用同包下的 `agents/browser-use/src/tools/zhipin-get-username.ts` 的函数提取）—— `%0 Codex` 实施时把 `zhipin-get-username.ts` 的 DOM 抽取逻辑提取为可复用函数，tool handler 调用它，`zhipin-send-reply` 也调用它

文件：`agents/browser-use/src/tools/zhipin-get-username.ts`
- 现在返回 `{ username: string }` 即可；`accountId` v1 不实现，保持接口为未来扩展

### 5.3 Resolver HTTP 客户端

**放在哪？** 两个选项：
- **A. smart-reply 内部**：调用 `generate_reply` 前自己先 `resolve-recruiter-binding`。但这要求 smart-reply 能拿到 `username`，违反了 §2 "browser-use 不维护 tenant 映射" 的精神（实际是反向：smart-reply 也不该知道 recruiter）
- **B. 编排层（调用方）**：`roll ask` 路由阶段 / OpenClaw 显式串 `get_username → resolve → generate_reply`。符合当前 agent 无状态架构

**推荐 B**。但 `roll ask` 当前的 LLM 提参阶段（`packages/core/src/router/extraction-schema.ts`）只会从对话上下文提取参数，不会主动调 resolver endpoint。所以**当前 PR 不改 `roll ask` 编排**，而是：

- **v1 落地**：`agents/smart-reply/src/services/reply-authority-client.ts` 接到 input 缺 `recruiterBinding` 时，如果 input 里带了 `target.recruiterUsername`（新增字段），就**代为** resolve 一次再签发。换言之 smart-reply 提供一层便利 resolver 代理，隐藏 endpoint 细节
- **调用方契约**：可以传 `target.recruiterBinding`（完整）**或** 只传 `target.recruiterUsername`（由 smart-reply 代 resolve）
- **roll ask 编排升级**：作为后续独立 issue，让 `roll ask` 在提参阶段主动调 `zhipin_get_username` + resolver —— 这涉及 `packages/core` 改动，**本 RFC 范围外**

### 5.4 roll.config.yaml 样例更新（nano-agent 项目根）

不需要改（`REPLY_AUTHORITY_URL` 仍然指向服务端；resolver 共用同一 base URL + bearer token）。

### 5.5 测试要求

- `smart-reply` 单测：新 schema 的 input 解析；resolver 代理模式（input 只传 username 时的代理逻辑 —— mock HTTP）
- `browser-use` 单测：v2 envelope 验签；recruiterBinding 不匹配拒绝发送
- `browser-use` 单测：`zhipin_get_username` DOM 抽取逻辑单独可测（从 tool handler 剥离出来后）
- Smoke（`packages/core/src/cli/smoke.e2e.ts`）：用 `node:http` 起 mock reply-authority-service 实现 `/resolve-recruiter-binding` + `/generate-signed-reply`，端到端跑 `roll run smart-reply generate_reply`

## 6. 我（Claude）的补充点（两边实施时请注意）

### 6.1 userName 不是理想强标识
DOM 抽取的 username 可能是显示名，存在：(a) 同用户显示名变更；(b) 多账号显示名重复。v1 可用，但在 RFC "后续演进" 里明确记一笔"计划升级 accountId 作为强标识"。

### 6.2 账号切换场景
OpenClaw 控制多账号时，browser 切换账号后 `zhipin_get_username` 必须**实时读（不缓存）**。`zhipin-get-username.ts` 和 `zhipin-send-reply.ts` 在本 RFC 下不得加任何 recruiter identity 缓存。

### 6.3 Envelope Schema 变更是 breaking change
**同 PR 合并、同步发版**是推荐路径。过渡期 jti TTL 默认 5 分钟，新版本发布后很快所有历史 envelope 失效，不需要双写 v1/v2。

### 6.4 Recruiter Binding 数据填充
Phase A 最小要求 §4.4 的 (1) 手动 JSON + sync 就够了。(2) admin API 和 (3) Duliday 同步可以留到后续 issue —— 但 %3 Codex 实施时需要选一个明确写进 PR。

## 7. 分 PR 策略（建议）

不强制要求 monorepo 统一 PR。两个 repo 独立 PR + 同日 merge + 同版本发布：

1. **`reply-authority-service` PR（%3 Codex）**
   - 标题：`feat: recruiter binding + v2 envelope + resolver endpoint`
   - §4 所有改动
   - 需 bump 服务端版本（minor）
2. **`nano-agent` PR（%0 Codex）**
   - 标题：`feat(smart-reply,browser-use): recruiter binding 执行层绑定`
   - §5 所有改动
   - 两个包的 changeset：`@roll-agent/smart-reply-agent` minor（schema 扩展）、`@roll-agent/browser-use-agent` minor（v2 envelope + 本地校验）

**合并顺序**：service 先上线（但不能独立部署，因为当前 client 不懂 v2）→ 验证 health 正常 → client PR 合并并发版 → 客户端升级到新版本 → 联调。过渡期（service 已部署但 client 未升级）会导致所有 `generate-signed-reply` 因 `recruiterBinding` 必填而 400，所以**实际部署窗口应尽可能短**。

## 8. 非目标

- **不做 session context**（roll chat 骨架尚未完成，见 `packages/core/src/cli/commands/chat.ts:5`） —— 本 RFC 不进入 `packages/core`
- **不做 `/auth-context` 或 `/whoami` 通用 endpoint** —— 只做面向 recruiter 的 `/resolve-recruiter-binding`，语义更窄
- **不改 reply-policy 共享机制** —— 已天然支持
- **不处理 Duliday 同步**（§4.4 (3)） —— 另起 issue

## 9. 开放问题 / 需要两边 ACK

实施前请两个 Codex 都 ACK（在各自 pane 打印 "ACK §3/§4.2"）或 push back：

1. **§3.1 envelope v2 的 recruiterBinding.accountId 是否 v1 就要实现**？（当前建议 v1 只填 username）
2. **§4.4 recruiter binding 填充入口**选 (1) / (2) / (3) 中的哪个？
3. **§5.3 resolver 客户端放在 smart-reply 内**（代理模式）还是**编排层**？（当前建议 smart-reply 内做代理，保持调用方 API 简洁）
4. **§3.2 是否双 kid 并行**？（当前建议硬切）

## 10. 变更记录

- 2026-04-17 初稿（Claude 整理 Codex %0 结论 + 用户业务前提）
