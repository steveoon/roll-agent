---
name: smoke-test-agent
description: CLI smoke test fixture agent.
metadata:
  roll-transport: stdio
  roll-command: node --experimental-strip-types src/index.ts
---

# Smoke Test Agent

最小的 stdio Agent，用于 CLI smoke E2E。

## Tools

- `ping` - 返回固定的空消息列表
