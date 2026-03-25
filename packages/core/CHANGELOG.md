# @roll-agent/core

## 0.2.2

### Patch Changes

- [#15](https://github.com/steveoon/roll-agent/pull/15) [`04a1f9a`](https://github.com/steveoon/roll-agent/commit/04a1f9a17f18722ec958af89e0085714f10e8097) Thanks [@steveoon](https://github.com/steveoon)! - Switch the qwen provider integration to the official `@ai-sdk/alibaba` provider.
  This fixes `roll ask` / `roll run` compatibility when using DashScope Qwen models through the core LLM layer.

## 0.2.1

### Patch Changes

- [#10](https://github.com/steveoon/roll-agent/pull/10) [`0d86a7c`](https://github.com/steveoon/roll-agent/commit/0d86a7cafc515be6d240377fdf21894ea072c4f3) Thanks [@steveoon](https://github.com/steveoon)! - Improve breaking config schema handling by adding `roll config migrate`, stronger `roll update` migration reminders, `roll doctor` config compatibility reporting, and by ensuring deprecated `router` config does not block agent management commands that only need the local agent registry.

## 0.2.0

### Minor Changes

- [#5](https://github.com/steveoon/roll-agent/pull/5) [`4b55128`](https://github.com/steveoon/roll-agent/commit/4b551281215d1848ca87c5da86866e3831189b3e) Thanks [@steveoon](https://github.com/steveoon)! - Agent runtime management v1 and browser-use tools migration

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
