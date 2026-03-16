---
name: smart-reply-agent
description: 招聘智能回复 Agent。根据候选人消息、品牌数据和回复策略，生成个性化招聘回复。
metadata:
  roll-transport: stdio
  roll-command: node --experimental-strip-types src/index.ts
---

# Smart Reply Agent

招聘场景智能回复 Agent，支持策略驱动的多阶段对话管理。

## Tools

- `generate_reply` — 根据候选人消息生成智能回复。输入候选人消息、对话历史、候选人信息等，输出建议回复文本、置信度、漏斗阶段等。内部流程：回合规划 → needs 驱动上下文构建 → 年龄资格校验 → 策略化回复生成 → FactGate 校验。
- `sync_brand_data` — 同步品牌配置数据（门店、岗位、薪资等）和回复策略到本地。Agent 运行依赖该数据，首次使用前需先调用此工具写入数据。

## Environment Variables

- `ANTHROPIC_API_KEY` — Anthropic/OpenAI/OhMyGPT 统一鉴权 key（回退读取 `OPENAI_API_KEY`）
- `SMART_REPLY_PROXY_BASE_URL` — 可选，统一代理地址（同时覆盖 anthropic/openai/ohmygpt 端点）
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
      DULIDAY_TOKEN: ${DULIDAY_TOKEN}
      DULIDAY_BRAND_LIST_URL: ${DULIDAY_BRAND_LIST_URL}
      DULIDAY_JOB_LIST_URL: ${DULIDAY_JOB_LIST_URL}
```
