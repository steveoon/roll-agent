---
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

模型 context window 改为按 models.dev 官方目录解析，不再依赖内置子串表

- runtime 新增 `ModelCatalog` / `resolveModelContextWindow()`：`runtime.context-window` 覆盖 → 目录官方 provider 条目（`limit.input ?? limit.context`，随包内置快照 + `~/.roll-agent/cache/model-catalog.json` 每日后台刷新）→ 内置家族规则；`ConversationEngine.switchModel()` 需要 `provider` 并返回解析结果与来源
- `/model` 切换提示显示 `ctx` 与来源（模型目录 / 内置规则 / 配置覆盖）；gpt-5.6 系列、gemini-3.8 等新模型不再被识别成 400k
- 新增 `pnpm catalog:refresh` 重新生成内置快照
