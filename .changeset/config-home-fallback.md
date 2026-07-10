---
"@roll-agent/core": minor
---

配置发现与写入逻辑统一到 `~/roll.config.yaml` 全局兜底，修复"配置目录级 vs 数据全局级"的旅程错位。

- **发现链**：cwd 向上查找不变（项目级配置仍优先），新增最终兜底 `~/roll.config.yaml`——在 home 之外的目录也能找到全局配置
- **写入**：`roll config init` / `roll config setup` / `roll setup` / chat 启动向导在未发现任何已有配置时，统一写入 `~/roll.config.yaml`（原为写入当前目录，导致换目录后"配置丢失"、agent 全局注册但 env 随目录失效）；已发现配置时仍写回原位置
- 测试基建：config 相关测试全部隔离 `$HOME`，避免读写开发机真实全局配置
