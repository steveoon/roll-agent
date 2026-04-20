---
name: smart-reply-agent
description: 招聘智能回复 Agent。根据候选人消息和上下文，向 Reply Authority Service 请求已签名回复。
metadata:
  roll-env-file: references/env.yaml
---

# Smart Reply Agent

招聘场景智能回复 Agent，负责把候选人消息转发到 Reply Authority Service，返回建议回复和带 Ed25519 签名的发送信封。

npm 包名：`@roll-agent/smart-reply-agent`

## 适用场景

当任务是以下类型时，应优先选择本 Agent：

- 根据候选人消息生成一条招聘回复
- 结合对话历史和候选人信息草拟回复
- 判断当前沟通处于哪个招聘漏斗阶段
- 按既定回复策略生成更稳妥、更合规的回复

## 能力边界

本 Agent 只负责**向 Reply Authority Service 请求已签名回复**。

不会：打开聊天页面、读取候选人资料页面、抓取当前聊天记录、直接发送消息、交换微信、执行浏览器自动化。

如果任务需要页面操作或消息发送，应选择 `browser-use-agent`；如果只是基于已给定的 `candidateMessage`、`conversationHistory`、`candidateInfo` 和 `target` 获取已签名回复，应选择本 Agent。

## Tools

完整 inputSchema 可通过 `roll agent tools smart-reply-agent`（或 `--json`）查询。

- `generate_reply(candidateMessage, conversationHistory?, candidateInfo?, preferredBrand?, channelType?, defaultWechatId?, industryVoiceId?, turnIndex?, modelConfig?, target)`
  调用 Reply Authority Service 的 `POST /generate-signed-reply`，返回 `suggestedReply`、`signedEnvelope`、`envelopeExp`、`confidence`、`stage` 和可选 `diagnostics`。`target` 为必填，至少包含 `platform=zhipin`、`conversationId`、`candidateId`，以及以下两种 recruiter 绑定方式之一：
  1. 直接传完整绑定：`tenantId + recruiterBinding`
  2. 便利代理模式：`recruiterUsername`（smart-reply 会先调用 `POST /resolve-recruiter-binding` 解析出 `tenantId + recruiterBinding`）

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
- 返回的 `signedEnvelope` 为 v2 信封，已绑定 `tenantId + recruiterBinding + conversationId + candidateId`，供 `browser-use-agent.zhipin_send_reply` 本地验签后发送
- 调用失败时抛 `ReplyAuthorityRequestError`，携带 `meta: {url, timeoutMs, requestId}` 与 `Error.cause` 链。通过 `roll run` 运行时 stderr 会展开 `cause: ...` 行用于定位；透传的 `x-request-id` 可跨服务端追踪

## Environment Variables

机器可读的 env 契约见 `references/env.yaml`。如果你是上层编排 Agent，请优先读取它来生成/校验 `agents.env.smart-reply-agent` 配置。

- `REPLY_AUTHORITY_URL` — Reply Authority Service 基础地址（必填）
- `REPLY_AUTHORITY_BEARER_TOKEN` — 调用 `POST /generate-signed-reply` 的 Bearer token（必填）
- `REPLY_AUTHORITY_TIMEOUT_MS` — Reply Authority Service HTTP 请求超时毫秒数（可选，默认 `30000`）。非正整数或非法值会被静默忽略并回落到默认值

## 典型跨 Agent 工作流

1. `browser-use-agent.zhipin_get_username()` → 获取当前 BOSS 账号 `username`
2. `browser-use-agent` 读取候选人资料、聊天记录或当前页面上下文，并从 `zhipin_read_messages` / `zhipin_get_candidate_info` 获取 `conversationId + candidateId`
3. 调用 `smart-reply-agent.generate_reply(..., target)`：
   - 直接模式：传 `target.tenantId + target.recruiterBinding`
   - 代理模式：只传 `target.recruiterUsername=username`，由 smart-reply 代调用 `POST /resolve-recruiter-binding`
4. `smart-reply-agent.generate_reply(..., target)` 获取 `suggestedReply + signedEnvelope`
5. `browser-use-agent.zhipin_send_reply(signedEnvelope)` 本地验签并校验 recruiter 绑定后发送

## Recommended roll.config.yaml

建议通过 `roll-core` 的 `agents.env` 为本 Agent 注入环境变量，而不是要求终端用户手工 `export`：

```yaml
agents:
  env:
    smart-reply-agent:
      REPLY_AUTHORITY_URL: https://reply-authority.duliday.com
      REPLY_AUTHORITY_BEARER_TOKEN: ${REPLY_AUTHORITY_BEARER_TOKEN}
      # 可选：自定义 HTTP 超时（毫秒，默认 30000）
      # REPLY_AUTHORITY_TIMEOUT_MS: "45000"
```
