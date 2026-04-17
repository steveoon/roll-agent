---
"@roll-agent/core": patch
---

refactor(core): 引入统一的 config key codec 消除 kebab↔camel 反复打补丁

**根因**：loader 过去用递归 deep-transform 把 YAML 所有键统一转 camelCase，对 `agents.env` / `llm.providers` 这类 dynamic record 的用户键（agent 名、provider 名）也做了错误改写，导致 `roll config get` 输出与 YAML 原文不一致，`helpers.ts` 需要 camelCase 兜底，`config set` 需要 SCREAMING_SNAKE_CASE 特判绕开把 `REPLY_AUTHORITY_URL` 打成 `-r-e-p-l-y_-...`。过去两次都是下游打补丁，没修到病灶。

**改动**：

- 新增 `config/key-codec.ts`：显式 codec tree 声明哪些节点是 schema 固定字段（kebab↔camel 转换），哪些是 dynamic record（键原样保留）。导出 `decodeFromYaml` / `encodePathToYaml` / `normalizeUserPath` 供 loader / `config set` / `config get` 使用。
- `loader.ts` 的 `kebabToCamelDeep` 改走 `decodeFromYaml`，删除 `DYNAMIC_RECORD_PATHS` 硬编码白名单。
- `config set` 的 `camelToKebab` 替换为 `encodePathToYaml`，删除 SCREAMING_SNAKE_CASE 特判。
- `config get` 接入 `normalizeUserPath`，用户输 kebab 或 camel 路径均可命中 schema 字段；record 键保持原样查找。
- `helpers.ts` 的 `getAgentEnvFromMap` 删除 camelCase 兜底，只保留 exact match。
- `migration.ts` 新增 `legacy-agent-env-keys` 规则：存量 non-canonical agent 名（`smartReplyAgent`、`smart-Reply-agent`、`smart_reply_agent` 等）在 `loadConfig` 阶段报错并引导 `roll config migrate`；可安全 `camelToKebab` 的自动改名，mixed-case / 含非法字符 / 与 kebab 版本同存的情况视为 blocking 要求手动处理。
- `migration.ts` 引入 `ConfigMigrationScope`（`"llm" | "ask" | "agents"`），每条规则标注 scopes；`detectKnownConfigMigrations` 支持按 scope 过滤。`loadAgentsConfig` 只跑 `scope=agents` 规则，避免 router-to-ask 误伤 `agent list` / `doctor` 等命令在仅 router 段 legacy 时的降级可用性；`loadConfig` 跑全量规则。两者共用 `parseAndCheckMigrations` helper，补上此前 `loadAgentsConfig` 绕过 migration 检测的旁路。

所有 read / write / lookup 路径现在都经过同一个 codec 作为唯一真相源；`roll config init` / `get` / `set` / `migrate` 四个子命令语义对齐。
