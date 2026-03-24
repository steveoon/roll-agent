# Workflows

## Preflight Check

```bash
roll agent health --json
```

If `browser-use-agent` is unhealthy:

```bash
roll agent start browser-use-agent
```

## Known Agent + Tool

```bash
roll run browser-use-agent zhipin_read_messages --input-json '{"onlyUnread":true,"limit":10}' --json

roll run browser-use-agent zhipin_get_candidate_info --input-json '{"candidateName":"烨烨烨"}' --json

roll run browser-use-agent zhipin_send_reply --input-json '{"candidateName":"烨烨烨","message":"你好"}' --json

roll run smart-reply-agent generate_reply --input-json '{"candidateMessage":"请问招兼职吗","conversationHistory":["求职者: 请问招兼职吗"],"candidateInfo":{"name":"张童琳","education":"大专","communicationPosition":"必胜客-日结服务员"}}' --json
```

## Known Intent, Unknown Tool

```bash
roll ask "帮我查看有哪些未读消息" --json
roll ask "和烨烨烨换微信" --json
roll ask "给推荐列表前5个人打招呼" --json
```

## Page Context Switching

```bash
roll run browser-use-agent navigate_active_tab --input-json '{"url":"https://www.zhipin.com/web/chat/recommend"}' --json
roll run browser-use-agent zhipin_say_hello --input-json '{"indices":[0,1,2]}' --json

roll run browser-use-agent navigate_active_tab --input-json '{"url":"https://www.zhipin.com/web/geek/chat"}' --json
roll run browser-use-agent zhipin_read_messages --input-json '{"onlyUnread":true}' --json
```

## Reply Workflow

```bash
# 1. Get candidate info and chat history
roll run browser-use-agent zhipin_get_candidate_info --input-json '{"candidateName":"烨烨烨"}' --json

# 2. Generate reply from structured input
roll run smart-reply-agent generate_reply --input-json '{"candidateMessage":"...","conversationHistory":[...],"candidateInfo":{...}}' --json

# 3. Send reply
roll run browser-use-agent zhipin_send_reply --input-json '{"candidateName":"烨烨烨","message":"..."}' --json
```

## Batch Greeting Workflow

```bash
# 1. Switch to recommend page
roll run browser-use-agent navigate_active_tab --input-json '{"url":"https://www.zhipin.com/web/chat/recommend"}' --json

# 2. Read candidate list
roll run browser-use-agent zhipin_get_candidate_list --input-json '{"maxResults":10}' --json

# 3. Greet a subset
roll run browser-use-agent zhipin_say_hello --input-json '{"indices":[0,1,2,3,4]}' --json
```
