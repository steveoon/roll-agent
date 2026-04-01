---
name: smart-reply-agent
description: 招聘智能回复 Agent。根据候选人消息、品牌数据和回复策略，生成个性化招聘回复。
metadata:
  roll-env-file: references/env.yaml
---

# Smart Reply Agent

招聘场景智能回复 Agent，支持策略驱动的多阶段对话管理。

## Tools

- `generate_reply(candidateMessage, conversationHistory?, candidateInfo?, preferredBrand?, channelType?, defaultWechatId?, industryVoiceId?, modelConfig?)` — 根据候选人消息生成智能回复。输出建议回复文本、置信度、漏斗阶段等。内部流程：回合规划 → needs 驱动上下文构建 → 年龄资格校验 → 策略化回复生成 → FactGate 校验。
- `sync_brand_data(cityName, brandAlias?)` — 从 Duliday API 拉取并同步品牌配置数据（门店、岗位、薪资等）到本地。`cityName` 为必填城市名称（如"上海市"），`brandAlias` 为可选品牌别名过滤。Agent 运行依赖该数据，首次使用前需先调用此工具同步。

## Environment Variables

机器可读的 env 契约见 `references/env.yaml`。如果你是上层编排 Agent，请优先读取它来生成/校验 `agents.env.smart-reply-agent` 配置。

- `ANTHROPIC_API_KEY` — Anthropic/OpenAI/OhMyGPT 统一鉴权 key（回退读取 `OPENAI_API_KEY`）
- `SMART_REPLY_PROXY_BASE_URL` — 可选，统一代理地址（同时覆盖 anthropic/openai/ohmygpt 端点）
- `SMART_REPLY_CLASSIFY_MODEL` / `SMART_REPLY_REPLY_MODEL` — 可选，覆盖默认分类/回复模型；未设置时分别回退到 `openai/gpt-5-mini` / `openai/gpt-5.4`
- `DULIDAY_TOKEN` — Duliday 品牌别名 & 岗位 API 鉴权 token
- `DULIDAY_BRAND_LIST_URL` / `DULIDAY_JOB_LIST_URL` — 必填，Duliday 品牌/岗位 API 端点；public 仓库中不内置默认地址

## Recommended roll.config.yaml

建议通过 `roll-core` 的 `agents.env` 为本 Agent 注入环境变量，而不是要求终端用户手工 `export`：

```yaml
agents:
  env:
    smart-reply-agent:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      SMART_REPLY_PROXY_BASE_URL: ${SMART_REPLY_PROXY_BASE_URL}
      SMART_REPLY_CLASSIFY_MODEL: qwen/qwen-plus-latest
      SMART_REPLY_REPLY_MODEL: qwen/qwen-plus-latest
      DULIDAY_TOKEN: ${DULIDAY_TOKEN}
      DULIDAY_BRAND_LIST_URL: ${DULIDAY_BRAND_LIST_URL}
      DULIDAY_JOB_LIST_URL: ${DULIDAY_JOB_LIST_URL}
```
