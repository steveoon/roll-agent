---
"@roll-agent/core": minor
"@roll-agent/browser": patch
"@roll-agent/browser-use-agent": minor
"@roll-agent/sdk": patch
---

Agent runtime management v1 and browser-use tools migration

**@roll-agent/core**
- Three-layer agent model: source / transport / runtime ownership
- Store schema v2 with backward-compatible migration
- package.json#rollAgent manifest support for agent discovery
- PID-based process management for core-managed agents
- CLI lifecycle commands: install/start/stop/health/update/remove
- Argument extractor and extraction schema improvements
- LLM router tool description fix

**@roll-agent/browser-use-agent**
- Migrate all 11 zhipin tools from ai-sdk-computer-use
- Add chat-navigation helper with ensureChatOpen for single-shot mode
- Anti-detection: randomDelay, humanDelay, scroll patterns
- Fix DOM selectors for exchange-wechat, say-hello, get-candidate-list
- Add navigate_active_tab tool
- Publish as @roll-agent/browser-use-agent with rollAgent manifest

**@roll-agent/browser**
- Add page listing, selection, and navigation APIs to context-manager

**@roll-agent/sdk**
- HTTP transport shutdown order fix
