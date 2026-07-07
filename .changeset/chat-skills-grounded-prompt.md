---
"@roll-agent/core": minor
"@roll-agent/runtime": minor
---

roll chat 接入 Agent Skills 标准生态 + 重写 system prompt 工具接地纪律（修复模型不调用工具却谎报完成）。

**Skills 接入（对齐 `npx skills add` 标准范式）**

- 零配置自动发现 canonical 路径：项目级 `.agents/skills/*/SKILL.md`（从 cwd 向上查找）与用户级 `~/.agents/skills/`，与 Claude Code / Codex / Cursor 等共享同一批已安装 skill；`skills.dirs` 配置可追加额外目录（支持"目录即 skill"与"skill 集合目录"两种布局）
- 已注册 Agent 的 SKILL.md 一并纳入目录（agent > project > user > config 优先级去重），chat 模型首次能看到子 Agent 的业务流程指导
- 渐进式披露：system prompt 只注入 name + description 目录，模型按需调用内建只读工具 `roll__skill` 加载完整 SKILL.md 正文；`reference` 参数可加载 `references/` 下的引用文件（含路径逃逸防护）
- 手动指定：Ink TUI 的 `/` 弹窗合并展示内置命令与可加载 skill；`/skills` 列出全部 skill；`/<skill-name> [/<skill-name> ...] 用户请求` 会隐藏注入加载对应 skill 的接地指令。基础 REPL 同样支持 `/skills` 和 skill 前缀
- 新增 `@roll-agent/core/skills/library`（`createSkillLibrary`）与 config `skills.dirs` 段（含 `roll config explain skills.dirs` 指引）

**System prompt 重写（借鉴 Codex CLI 的 prompt 结构）**

- 新增工具接地纪律：禁止虚构工具调用或其结果、没有成功工具结果不得声称操作完成、批量任务逐项真实执行并如实汇报成败、工具失败不得掩盖
- 新增任务推进指导：持续推进直到完成或阻塞、默认实际执行而非只给分析
- 保留原输出通道规则（thinking/text 分离、不复述输入）；`AgentSessionOptions` 支持 `systemPrompt` / `skillLibrary` 注入，`ConversationEngine` 自动组装

**上下文压缩接地**

- 压缩摘要的转写不再把工具结果渲染为 `[工具结果]` 占位符，改为携带成功/失败状态与截断摘录；摘要指令明确"只把有成功工具结果佐证的操作记为已完成"，防止编造的完成声明经压缩固化为事实
