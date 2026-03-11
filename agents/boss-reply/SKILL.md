---
name: boss-reply-agent
description: BOSS直聘自动回复。查看未读消息、回复候选人、批量回复。
metadata:
  roll-transport: stdio
  roll-command: node --experimental-strip-types src/index.ts
---

# Boss Reply Agent

BOSS直聘招聘自动回复 Agent。

## Tools

- `get_unread` - 获取未读消息列表
- `reply_candidate` - 回复指定候选人
- `batch_reply` - 批量回复所有未读
