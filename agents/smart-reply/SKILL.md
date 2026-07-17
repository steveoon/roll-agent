---
name: smart-reply-agent
description: 根据显式提供的候选人消息和上下文向 Reply Authority Service 请求并透传已签名回复协议；不负责 BOSS 页面、发送、双稿 Judge 或 feedback。需要浏览器发送闭环时使用 browser-use-agent。
metadata:
  roll-env-file: references/env.yaml
---

# Smart Reply Agent

招聘场景智能回复 Agent，负责把候选人消息转发到 Reply Authority Service，返回建议回复、带 Ed25519 签名的发送信封，以及服务端可选的双稿协议数据。

npm 包名：`@roll-agent/smart-reply-agent`

## 适用场景

当任务是以下类型时，应优先选择本 Agent：

- 根据候选人消息生成一条招聘回复
- 结合对话历史和候选人信息草拟回复
- 判断当前沟通处于哪个招聘漏斗阶段
- 按既定回复策略生成更稳妥、更合规的回复

## 能力边界

本 Agent 只负责**向 Reply Authority Service 请求并透传已签名回复协议**。

不会：打开聊天页面、读取候选人资料页面、抓取当前聊天记录、执行双稿 Judge、调用 `/reply-feedback`、维护 feedback outbox、直接发送消息、交换微信、执行浏览器自动化。

如果任务需要 BOSS 页面操作、消息发送或双稿闭环，应从生成阶段开始选择 `browser-use-agent`；如果只是基于已给定的 `candidateMessage`、`conversationHistory`、`candidateInfo` 和 `target` 获取协议响应，且调用方自行负责后续发送与 feedback 终态，才选择本 Agent。

## Tools

完整 inputSchema 可通过 `roll agent tools smart-reply-agent`（或 `--json`）查询。

- `generate_reply(candidateMessage, conversationHistory?, candidateInfo?, preferredBrand?, preferredBrandId?, channelType?, defaultWechatId?, industryVoiceId?, turnIndex?, modelConfig?, target)`
  调用 Reply Authority Service 的 `POST /generate-signed-reply`，返回 `suggestedReply`、`signedEnvelope`、`envelopeExp`、`confidence`、`stage`、可选 `diagnostics`，以及服务端启用双稿时的 `replyVariants`。RFC V3 的 `replyVariants` 包含 `groupId`、`recommended`、`findings`、`items`、`rubricVersion` / `rubricHash`、服务端权威 `feedbackExpiresAt` 和两份已签名候选稿；`feedbackExpiresAt` 是 Unix 秒终态截止时间，本 Agent 不会据此建立 outbox 或自动回调。`target` 为必填，至少包含 `platform=zhipin`、`conversationId`、`candidateId`，以及以下两种 recruiter 绑定方式之一：
  1. 直接传完整绑定：`tenantId + recruiterBinding`
  2. 便利代理模式：`recruiterUsername`（smart-reply 会先调用 `POST /resolve-recruiter-binding` 解析出 `tenantId + recruiterBinding`）

  `modelConfig.reasoning` 为可选 thinking/reasoning 控制：

  - `enabled`：`true` 表示请求 Reply Authority Service 使用模型 reasoning/thinking；`false` 表示显式请求关闭
  - `effort`：可选，`"low"` / `"medium"` / `"high"`，不传由服务端使用默认值
  - `scope`：可选，`"reply"` 只影响回复生成与 gate rewrite，`"all"` 也影响 turn planning
  - 不传 `modelConfig.reasoning` 时，沿用 Reply Authority Service 的 provider 默认策略

  `target.conversationId` / `target.candidateId` 的来源约束：

  - 应直接复用 `browser-use-agent.zhipin_read_messages`、`browser-use-agent.zhipin_open_chat` 或 `browser-use-agent.zhipin_get_candidate_info` 的真实输出
  - 不要由 orchestrator 根据 `candidateName` 或左侧列表 `index` 自行重建
  - 不要跨轮次缓存 `index` 再推断 target；BOSS 左侧消息列表会实时重排，`index` 不是稳定主键

  招聘场景调用约束：

  - 调用前应先尝试从页面读取 `candidateInfo.communicationPosition`、`candidateInfo.expectedLocation`、`candidateInfo.expectedPosition`
  - 能读到就如实透传；读不到就省略该字段
  - `preferredBrand` / `preferredBrandId` 为可选页面信号，只能原样透传 `browser-use-agent` `zhipin_get_candidate_info` 的输出字段：沟通职位带 `[品牌ID]` 尾缀（如 `咖啡早班店员-接受小白-免费咖啡[10027]`）时工具会输出 `preferredBrandId`，只透传它；老格式 `品牌名-职位` 时工具输出 `preferredBrand`，只透传它；都读不到就都省略
  - 不要自行从 `communicationPosition` 解析品牌（服务端会以 `candidateInfo.communicationPosition` 为权威自行提取品牌 ID 并对账）；严禁把通用岗位名（如“餐饮兼职服务员”“门店服务员”）、候选人现/前雇主公司名或新格式的第一段塞进 `preferredBrand`

  Minimal valid input 示例（代理模式）：

  ```json
  {
    "candidateMessage": "你好，我想了解一下这个岗位",
    "target": {
      "platform": "zhipin",
      "conversationId": "642438677-0",
      "candidateId": "642438677-0",
      "recruiterUsername": "郭晓阳"
    }
  }
  ```

  启用 reasoning 示例：

  ```json
  {
    "candidateMessage": "你好，我想了解一下这个岗位",
    "modelConfig": {
      "reasoning": {
        "enabled": true,
        "effort": "medium",
        "scope": "reply"
      }
    },
    "target": {
      "platform": "zhipin",
      "conversationId": "642438677-0",
      "candidateId": "642438677-0",
      "recruiterUsername": "郭晓阳"
    }
  }
  ```

  Minimal valid input 示例（直接模式）：

  ```json
  {
    "candidateMessage": "你好，我想了解一下这个岗位",
    "target": {
      "platform": "zhipin",
      "tenantId": "chengdu-liujie",
      "conversationId": "642438677-0",
      "candidateId": "642438677-0",
      "recruiterBinding": { "platform": "zhipin", "username": "郭晓阳" }
    }
  }
  ```

- `diagnostic_status()` — 返回本 agent 进程里声明过的 env key 的 `{present, fingerprint}`（SHA256 前 8 位，不泄漏 value）。`roll doctor` / `roll agent info` 据此对比 yaml 声明与运行态，检测 env drift（详见 roll-core skill template）。

## Reply Authority 集成说明

- `generate_reply` 不再保留本地 pipeline fallback
- 若缺少 `REPLY_AUTHORITY_URL` 或 `REPLY_AUTHORITY_BEARER_TOKEN`，tool 会直接报错
- 实际回复生成、reply-policy、FactGate、ReplyGate、年龄校验都在云端执行
- `modelConfig.reasoning` 会透传给 Reply Authority Service；raw reasoning/thinking 文本不会作为业务输出返回
- 返回的 `signedEnvelope` 为 v2 信封，已绑定 `tenantId + recruiterBinding + conversationId + candidateId`；浏览器发送主链路应优先使用 `browser-use-agent.zhipin_generate_reply_preview(...) -> zhipin_send_prepared_reply(preparedReplyId)`
- 若服务端返回 `replyVariants`，`generate_reply` 只做协议透传；它不会隐藏 `signedEnvelope`，也不会执行 Judge、提交 `selected/not_learned`、调用 `/reply-feedback` 或维护 outbox。直接调用方必须自行发送且在 Unix 秒 `feedbackExpiresAt` 前关闭终态，不能只取顶层推荐稿后忽略 group
- 在 Roll 的 BOSS 发送链路中，应在生成前就选择 `browser-use-agent.zhipin_generate_reply_preview(...) -> zhipin_send_prepared_reply(preparedReplyId, variantDecision?)`。send 缺少显式 `variantDecision` 时会内部执行并缓存默认 Judge；`zhipin_judge_prepared_reply(...)` 仅用于可选预览，不是默认必经步骤
- 调用失败时抛 `ReplyAuthorityRequestError`，携带 `meta: {url, timeoutMs, requestId}` 与 `Error.cause` 链。通过 `roll run` 运行时 stderr 会展开 `cause: ...` 行用于定位；透传的 `x-request-id` 可跨服务端追踪
- `diagnostics.brandResolutionSource="none"`、`diagnostics.resolvedBrand=""`、`diagnostics.ageGate.status="unknown"` 都是合法服务端结果，不代表 tool 调用失败。是否补问用户或转人工，是 orch 层策略，不是本 Agent 的重试条件

## Environment Variables

机器可读的 env 契约见 `references/env.yaml`。如果你是上层编排 Agent，请优先读取它来生成/校验 `agents.env.smart-reply-agent` 配置。

- `REPLY_AUTHORITY_URL` — Reply Authority Service 基础地址（必填）
- `REPLY_AUTHORITY_BEARER_TOKEN` — 调用 `POST /generate-signed-reply`，以及代理模式下 `POST /resolve-recruiter-binding` 的 Bearer token（必填）；必须能访问目标 tenant。本 Agent 不使用它调用 rubric 或 `/reply-feedback`，因此自身不要求 `reply-feedback:write`；外部调用方若自行完成双稿 rubric/feedback，则须另行保证对应客户端/token 具备该 scope
- `REPLY_AUTHORITY_TIMEOUT_MS` — Reply Authority Service HTTP 请求超时毫秒数（可选，客户端默认 `60000`）。非正整数或非法值会被静默忽略并回落到默认值；该默认值高于 RFC 当前 `50000ms` 的完整请求截止时间，让服务端能先返回带 phase 证据的 `504`。生产仍建议显式声明以便 `roll doctor` 核验

## 典型跨 Agent 工作流

以下流程只适用于“获取协议响应但不由 Roll 直接发送”，或调用方已经自行实现双稿发送与 `/reply-feedback` 终态的场景。若最终要通过 BOSS 浏览器发送，应直接使用后面的 browser-use prepared-reply 主链路，不要先调用 `smart-reply-agent.generate_reply` 再丢弃其 `replyVariants` group。

1. `browser-use-agent.zhipin_get_username()` → 获取当前 BOSS 账号 `username`
2. `browser-use-agent` 读取候选人资料、聊天记录或当前页面上下文，并从 `zhipin_read_messages` / `zhipin_get_candidate_info` 获取 `conversationId + candidateId`
   - 一旦拿到这两个 ID，后续整个链路都应原样复用，不要再退回 `index`
3. 调用前先尝试补齐页面信号：
   - `candidateInfo.communicationPosition`
   - `candidateInfo.expectedLocation`
   - `candidateInfo.expectedPosition`
   - `preferredBrand` / `preferredBrandId`：原样透传 `zhipin_get_candidate_info` 的输出字段（新命名 `…[品牌ID]` 给 `preferredBrandId`，老命名“品牌-职位”给 `preferredBrand`，互斥）；否则保持缺省
   - 如果读不到，保持缺省；不要用通用岗位名或候选人公司名冒充品牌
4. 调用 `smart-reply-agent.generate_reply(..., target)`：
   - 直接模式：传 `target.tenantId + target.recruiterBinding`
   - 代理模式：只传 `target.recruiterUsername=username`，由 smart-reply 代调用 `POST /resolve-recruiter-binding`
5. `smart-reply-agent.generate_reply(..., target)` 获取 `suggestedReply + signedEnvelope`，并在服务端开启双稿时透传 `replyVariants`
6. 若返回 `replyVariants`，调用方必须自行发送并按 RFC V3 关闭终态；本 Agent 不提供该回传 tool：
   - Judge 或 orchestrator 确定 A/B 选择：提交 `feedbackOutcome:"selected"`，`decisionSource:"judge"|"orchestrator"`，并按实际核实结果提供 `confirmedFindingCodes`
   - rubric/Judge fallback 或显式 no-Judge：只发送服务推荐稿，提交 `feedbackOutcome:"not_learned"`，使用 `decisionSource:"service_recommended_fallback"|"explicit_no_judge"`，且不得携带 `confirmedFindingCodes`

Roll 的 BOSS prepared-reply 主链路：

```text
browser-use-agent.zhipin_generate_reply_preview(...)
  -> [可选预览] browser-use-agent.zhipin_judge_prepared_reply(preparedReplyId)
  -> browser-use-agent.zhipin_send_prepared_reply(preparedReplyId, variantDecision?)
     # 缺省时 send 内部 Judge；发送成功后自动持久化并回传 selected/not_learned
```

不要把 `signedEnvelope` 作为跨 Agent 编排参数传递，也不要为了修复 `feedbackStatus:"queued"|"failed"` 而重复发送候选人消息。

## Recommended roll.config.yaml

建议通过 `roll-core` 的 `agents.env` 为本 Agent 注入环境变量，而不是要求终端用户手工 `export`：

```yaml
agents:
  env:
    smart-reply-agent:
      REPLY_AUTHORITY_URL: https://reply-authority.duliday.com
      REPLY_AUTHORITY_BEARER_TOKEN: ${REPLY_AUTHORITY_BEARER_TOKEN}
      # RFC 完整请求截止时间为 50000ms 时，调用方需保留响应缓冲
      REPLY_AUTHORITY_TIMEOUT_MS: "60000"
```
