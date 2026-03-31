---
"@roll-agent/core": patch
"@roll-agent/sdk": patch
"@roll-agent/browser": patch
---

fix(deps): upgrade zod from ^3.25.0 to ^3.25.76

zod@3.25.0 缺少 dist/ 目录，导致 tsc 和运行时均无法解析模块。锁定下限到 3.25.76 修复此问题。
