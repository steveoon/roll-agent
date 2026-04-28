---
"@roll-agent/browser": minor
"@roll-agent/browser-use-agent": patch
"@roll-agent/core": patch
---

Add native CDP primitives and migrate the BOSS Zhipin main workflow to the native backend.

`@roll-agent/browser` now exposes native CDP controller utilities for page inspection,
DOM evaluation, mouse input, keyboard input, text insertion, and native locators without
requiring a Playwright page attach.

`browser-use-agent` now routes the BOSS Zhipin chat, reply sending, WeChat exchange,
recommend-list reading, filtering, scrolling, and greet flows through the native backend.
The remaining resume popup tools stay Playwright-backed and share their DOM contract through
`resume-dom-contract.ts`.

`roll ask` preflight validation now catches array `minItems` constraints before dispatching
tool calls, so underspecified semantic requests can return `needs_input` instead of reaching
MCP tool validation.
