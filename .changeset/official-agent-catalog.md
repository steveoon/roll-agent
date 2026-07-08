---
"@roll-agent/core": minor
---

新增官方 Agent Catalog 声明层，解决新设备"不知道有什么可装"的发现断裂。

- `registry/catalog.ts`：内置官方 agent 清单（browser-use、smart-reply、reply-policy-tuner、octopus），单一数据源供 CLI 短名安装 / `roll setup` / chat onboarding 后续消费；`getAgentCatalog(config?)` 预留企业私有 catalog 合并点（本期不实现 schema）
- `registry/catalog-discovery.ts`：**动态 catalog 发现**——`npm search` 扫描 `@roll-agent` scope，按 `package.json#rollAgent` manifest 判定"可安装 agent"（sdk/core 等非 agent 包自动排除），`npm view` 补齐描述；短名从包名派生（去 scope 与 `-agent` 后缀，冲突回退完整名）；结果缓存 `~/.roll-agent/catalog-cache.json`（TTL 24h，按 `install.registry` 隔离——registry 变更后缓存视为 miss，私有 registry 发现的条目不会泄漏到其他 registry 环境），与内置清单合并（内置元数据优先），离线/失败降级缓存→内置。CLI 命令（`agent install`/`list --available`/`setup`）走缓存优先并可联网刷新；chat 引擎只读缓存，启动不被网络阻塞
- `roll agent install <短名>`：支持 `browser-use` / `browser-use@0.21.1` 等短名与短名带版本解析为完整 npm spec，命中时 stderr 明示解析结果；非 catalog 输入行为不变
- `roll agent list --available`：列出 catalog 中可安装 agent 及安装状态（未装 / 已装版本 / 其他来源已装）、npm latest 版本（复用 update-check 24h 缓存，离线降级 unknown）与必需环境变量摘要；`--json` 输出结构化数组
