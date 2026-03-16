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

## Environment Notes

- `anthropic` / `openai` / `ohmygpt` 默认都走 `hash070` 代理，优先读取 `ANTHROPIC_API_KEY` 作为统一鉴权 key。
- 为兼容仓库里已有的接入示例，如果未提供 `ANTHROPIC_API_KEY`，会回退读取 `OPENAI_API_KEY`。
