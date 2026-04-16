---
name: smart-reply-agent
description: 招聘智能回复 Agent。根据候选人消息、品牌数据和回复策略，生成个性化招聘回复。
metadata:
  roll-env-file: references/env.yaml
---

# Smart Reply Agent

招聘场景智能回复 Agent，负责把候选人消息转发到 Reply Authority Service，返回建议回复和带 Ed25519 签名的发送信封。

npm 包名：`@roll-agent/smart-reply-agent`

## 适用场景

当任务是以下类型时，应优先选择本 Agent：

- 根据候选人消息生成一条招聘回复
- 结合对话历史、候选人信息和品牌数据草拟回复
- 判断当前沟通处于哪个招聘漏斗阶段
- 按既定回复策略生成更稳妥、更合规的回复
- 同步 Duliday 品牌/岗位数据，供后续回复生成使用

## 能力边界

本 Agent 只负责**向 Reply Authority Service 请求已签名回复**，以及**维护 `sync_brand_data` 所需品牌数据**。

不会：打开聊天页面、读取候选人资料页面、抓取当前聊天记录、直接发送消息、交换微信、执行浏览器自动化。

如果任务需要页面操作或消息发送，应选择 `browser-use-agent`；如果只是基于已给定的 `candidateMessage`、`conversationHistory`、`candidateInfo` 和 `target` 获取已签名回复，应选择本 Agent。

## Tools

- `generate_reply(candidateMessage, conversationHistory?, candidateInfo?, preferredBrand?, channelType?, defaultWechatId?, industryVoiceId?, turnIndex?, modelConfig?, target)`
  调用 Reply Authority Service 的 `POST /generate-signed-reply`，返回 `suggestedReply`、`signedEnvelope`、`envelopeExp`、`confidence`、`stage` 和可选 `diagnostics`。`target` 为必填，至少包含 `platform=zhipin`、`tenantId`、`conversationId`、`candidateId`。
- `sync_brand_data(cityName, brandAlias?)`
  从 Duliday API 拉取并同步品牌配置数据（门店、岗位、薪资等）到本地。`cityName` 为必填城市名称，`brandAlias` 为可选品牌过滤。适用于首次初始化、定期刷新或切换城市/品牌数据源的场景。

## Reply Authority 集成说明

- `generate_reply` 不再保留本地 pipeline fallback
- 若缺少 `REPLY_AUTHORITY_URL` 或 `REPLY_AUTHORITY_BEARER_TOKEN`，tool 会直接报错
- 实际回复生成、reply-policy、FactGate、ReplyGate、年龄校验都在云端执行
- 返回的 `signedEnvelope` 已绑定 `tenantId + conversationId + candidateId`，供 `browser-use-agent.zhipin_send_reply` 本地验签后发送

## Environment Variables

机器可读的 env 契约见 `references/env.yaml`。如果你是上层编排 Agent，请优先读取它来生成/校验 `agents.env.smart-reply-agent` 配置。

- `REPLY_AUTHORITY_URL` — Reply Authority Service 基础地址
- `REPLY_AUTHORITY_BEARER_TOKEN` — 调用 `POST /generate-signed-reply` 的 Bearer token
- `DULIDAY_TOKEN` / `DULIDAY_BRAND_LIST_URL` / `DULIDAY_JOB_LIST_URL` — 仅 `sync_brand_data` 需要

## 典型跨 Agent 工作流

1. `browser-use-agent` 读取候选人资料、聊天记录或当前页面上下文
2. 调用方整理出 `candidateMessage`、`conversationHistory`、`candidateInfo`，并从 `zhipin_read_messages` / `zhipin_get_candidate_info` 获取 `conversationId + candidateId`
3. 调用方补上 `target.tenantId`
4. `smart-reply-agent.generate_reply(..., target)` 获取 `suggestedReply + signedEnvelope`
5. `browser-use-agent.zhipin_send_reply(signedEnvelope)` 本地验签后发送

## Recommended roll.config.yaml

建议通过 `roll-core` 的 `agents.env` 为本 Agent 注入环境变量，而不是要求终端用户手工 `export`：

```yaml
agents:
  env:
    smart-reply-agent:
      REPLY_AUTHORITY_URL: https://reply-authority.duliday.com
      REPLY_AUTHORITY_BEARER_TOKEN: ${REPLY_AUTHORITY_BEARER_TOKEN}
      DULIDAY_TOKEN: ${DULIDAY_TOKEN}                   # 仅 sync_brand_data 需要
      DULIDAY_BRAND_LIST_URL: ${DULIDAY_BRAND_LIST_URL} # 仅 sync_brand_data 需要
      DULIDAY_JOB_LIST_URL: ${DULIDAY_JOB_LIST_URL}     # 仅 sync_brand_data 需要
```
