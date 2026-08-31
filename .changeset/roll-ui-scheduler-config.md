---
"@roll-agent/core": patch
---

roll ui 的定时任务配置语义补全：

- `scheduler.data-dir` 在 Web 表单中只读（新增 `config/edit-policy.ts` overlay），展示当前值并引导使用 `roll config set`；账本不搬迁的迁移提示由生效说明兜底
- 保存 `scheduler.max-concurrent-runs` 时，变更审阅对话框明确提示需要 `roll schedule service restart` 及重启代价（不重置间隔计时、窗口内到期任务补跑一次、有任务执行时 restart 会拒绝）
- 保存 `scheduler.data-dir`（YAML 模式或 CLI）标记为人工迁移步骤并要求确认
