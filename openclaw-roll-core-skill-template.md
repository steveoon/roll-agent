# OpenClaw `roll-core` SKILL 模板

这个模板用于把 `roll` 作为一个可编排 CLI skill 接入 OpenClaw。

默认调用策略：

- 已知 `agent + tool` 时优先 `roll run --json`
- 只知道自然语言意图时使用 `roll ask --json`
- 不要默认使用 `roll chat`，它当前仍是 experimental 骨架

## 推荐模板

````markdown
---
name: roll-core
description: Use roll to invoke registered MCP agents through a stable CLI surface.
---

## When to use

- Use `roll run --json <agent> <tool> ...` when the target agent and tool are known.
- Use `roll ask --json "<message>"` only when you know the intent but do not know which agent/tool to call.
- Do not use `roll chat` by default; it is experimental.

## Available Agents

### browser-use-agent (HTTP, persistent)

浏览器操控 Agent。建议先通过 `roll agent install @roll-agent/browser-use-agent` 安装，再用 `roll agent start browser-use-agent` 启动。session 跨调用持久。

**Chat tools:**
- `zhipin_read_messages(limit?, onlyUnread?, sortBy?)` — 读取消息列表
- `zhipin_open_chat(candidateName?, index?)` — 打开聊天窗口
- `zhipin_get_candidate_info(candidateName?, index?, maxMessages?)` — 提取候选人资料+聊天记录
- `zhipin_send_reply(message, candidateName?)` — 发送消息
- `zhipin_exchange_wechat(candidateName?)` — 交换微信
- `zhipin_get_username()` — 获取当前登录用户名

**Recommend tools:**
- `zhipin_get_candidate_list(maxResults?)` — 获取推荐列表候选人
- `zhipin_say_hello(indices)` — 批量打招呼
- `zhipin_open_resume(index)` / `zhipin_close_resume()` — 查看/关闭简历

**Generic tools:**
- `browser_status()` — 浏览器状态
- `navigate_active_tab(url)` — 页面跳转
- `open_platform(platform)` — 打开平台主页

### smart-reply-agent (stdio, per-call)

智能回复 Agent。每次调用启动新进程，无需预先启动。

- `generate_reply(candidateMessage, conversationHistory, candidateInfo)` — 生成回复
- `sync_brand_data(cityName, brandAlias?)` — 同步品牌门店数据

## Command Strategy

1. Prefer deterministic execution with `roll run --json`.
2. If the user request is underspecified, use `roll ask --json`.
3. If `roll ask --json` returns `needs_input`, gather the missing structured fields and switch to `roll run --json --input-json`.
4. Treat `roll ask` as single-shot. Do not expect multi-step planning, session memory, or background orchestration.
5. For multi-step workflows, chain multiple `roll run` calls sequentially.

## Output Handling

- Parse JSON from stdout.
- Treat non-zero exit codes as failures or gated states.
- For `roll ask --json`, handle these statuses:
  - `success`
  - `needs_input`
  - `needs_confirmation`
  - `failed`

## Error Handling

- If browser-use-agent returns connection error, the HTTP service may not be running.
- `"未找到候选人"` errors mean the candidateName didn't match any chat list entry.
- smart-reply-agent 401 errors indicate expired LLM API keys in `roll.config.yaml`.

## Examples

### Known agent + tool

```bash
# 读取未读消息
roll run browser-use-agent zhipin_read_messages --input-json '{"onlyUnread":true,"limit":10}' --json

# 发送消息（自动打开对应聊天）
roll run browser-use-agent zhipin_send_reply --input-json '{"candidateName":"张童琳","message":"你好"}' --json

# 批量打招呼
roll run browser-use-agent zhipin_say_hello --input-json '{"indices":[0,1,2]}' --json

# 生成智能回复
roll run smart-reply-agent generate_reply --input-json '{"candidateMessage":"请问招兼职吗","conversationHistory":["求职者: 请问招兼职吗"],"candidateInfo":{"name":"张童琳","education":"大专","communicationPosition":"必胜客-日结服务员"}}' --json

# 同步品牌数据
roll run smart-reply-agent sync_brand_data --input-json '{"cityName":"上海市","brandAlias":"肯德基"}' --json
```

### Known intent, unknown tool

```bash
roll ask "帮我查看有哪些未读消息" --json
roll ask "和张童琳换微信" --json
roll ask "给推荐列表前5个人打招呼" --json
```

### Multi-step workflow (reply to candidate)

```bash
# 1. 获取候选人资料和聊天记录
roll run browser-use-agent zhipin_get_candidate_info --input-json '{"candidateName":"张童琳"}' --json

# 2. 用聊天记录生成回复（将 step 1 的输出组装为 generate_reply 的输入）
roll run smart-reply-agent generate_reply --input-json '{"candidateMessage":"...","conversationHistory":[...],"candidateInfo":{...}}' --json

# 3. 发送回复
roll run browser-use-agent zhipin_send_reply --input-json '{"candidateName":"张童琳","message":"..."}' --json
```

### Page navigation before operations

```bash
# 先跳转到推荐页，再执行打招呼
roll run browser-use-agent navigate_active_tab --input-json '{"url":"https://www.zhipin.com/web/chat/recommend"}' --json
roll run browser-use-agent zhipin_say_hello --input-json '{"indices":[0,1,2]}' --json
```
````
