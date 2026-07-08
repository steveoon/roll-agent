---
"@roll-agent/core": minor
---

新增 `roll skills install <source>`：把 skill 安装到 orchestrator（Claude Code / Codex / 通用 `.agents`）的 skills 目录，打通新设备上外部编排器获取 roll-core 等 skill 的路径（企业内部 repo 分发，不经公开 npm）。

- source 支持本地目录（直含 SKILL.md 或多 skill 子目录集合）与 Git 仓库 URL（克隆到 `<dataDir>/skill-repos/`，重复安装自动 pull）
- 目标解析：`--dir` 自定义目录 > `--target claude-code,codex,agents|all` > TTY 交互多选（默认勾选检测到使用痕迹的 orchestrator）> 非交互报错；`--project` 切换到项目级目录（如 `.claude/skills`）
- 安装即托管：重复安装先删目标目录再整目录复制（覆盖前警告列出将被覆盖项），`--skill` 可只装集合中的指定项，`--json` 输出结构化安装结果
- SKILL.md frontmatter 校验 name/description 非空，无效项跳过并告警
- 配套重构：git clone/pull 抽为共享 `cli/utils/git-source.ts`（`roll agent add` 改用，行为不变）；`ConfigPromptAdapter` 新增 `multiselect`；`expandTilde` 从 config loader 导出
