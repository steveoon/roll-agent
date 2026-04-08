---
"@roll-agent/core": minor
---

feat: installed-package subagent 真实版本检测

- `roll update --check` 对 installed-package 类型 Agent 做真实 npm 版本比较，不再固定显示 ⬆ 图标
- 五分类版本状态：up-to-date(✅) / update-available(⬆) / pinned-behind(📌) / unsupported-spec(?) / unknown(?)
- `InstalledAgentSource` 新增 `installedVersion` 字段，install/update 后自动记录
- 版本查询结果按包名缓存（TTL 24h），不阻塞 CLI 命令
- installed-package + core-managed Agent 升级顺序修正为 stop → install → restart
