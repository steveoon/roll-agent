---
"@roll-agent/browser": patch
"@roll-agent/browser-use-agent": patch
---

Add native CDP page navigation support and move `navigate_active_tab` onto the native CDP path. The tool now avoids Playwright attach, reuses native platform tabs, opens non-platform URLs in a native page, and blocks direct BOSS `/web/chat/*` backend navigation in favor of semantic BOSS navigation tools.
