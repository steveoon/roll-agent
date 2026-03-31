---
name: notify-agent
description: 通用消息通知 Agent。向飞书等渠道发送纯文本消息，消息内容由调用方组织，不内置模板。
metadata:
  roll-env-file: references/env.yaml
---

# Notify Agent

轻量通知 Agent，负责将调用方已组织好的纯文本消息发送到外部渠道（当前支持飞书自定义机器人）。

不内置消息模板、不绑定业务场景。消息内容（包括格式、字段、标题）完全由调用方（LLM / 编排层 / 脚本）负责组织。

## Tools

- `send_feishu_message(text)` — 向飞书自定义机器人发送纯文本消息

## 返回结果

`send_feishu_message` 返回结构化结果，调用方可直接按字段判断：

- `success=true`：发送成功，包含 `responseCode` 和 `responseMessage`
- `success=false`：发送失败，包含 `errorType` 和 `error`

常见 `errorType`：

- `config` — Webhook 未配置或 URL 非法
- `network` / `timeout` — 网络失败或超时
- `http` — HTTP 状态码异常
- `invalid-response` — 飞书返回体不是预期 JSON 结构
- `provider` — 飞书业务错误（如签名、关键字、频控等）

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `FEISHU_BOT_WEBHOOK` | 是 | 飞书自定义机器人的 Webhook 地址 |

通过 `roll.config.yaml` 的 `agents.env.notify-agent` 注入，或直接设置系统环境变量。

## 边界条件

- 只负责发送**已组织好的纯文本**，不负责模板拼装
- 不负责 Markdown、富文本卡片、图片或文件消息
- 不负责重试、去重、回执查询或通知审计
- 如需多渠道（如企业微信、钉钉、邮件），应新增独立 tool 或扩展渠道层

## 典型跨 Agent 工作流

### 招聘候选人微信通知

1. `browser-use-agent.open_platform("zhipin")` — 打开 BOSS 直聘
2. `browser-use-agent.zhipin_get_username()` — 获取当前登录账号
3. `browser-use-agent.zhipin_get_candidate_info(candidateName)` — 获取候选人资料
4. `browser-use-agent.zhipin_exchange_wechat(candidateName)` — 交换微信
5. 编排层组织通知文本（拼接账号、候选人、微信号等）
6. `notify-agent.send_feishu_message(text)` — 发送飞书通知

### 任务状态通知

1. 编排层完成某项任务或遇到异常
2. 编排层组织通知文本
3. `notify-agent.send_feishu_message(text)` — 发送飞书通知
