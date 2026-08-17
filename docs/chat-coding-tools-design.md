# roll chat coding 工具扩展设计（P2：检索 + 验证 + 批准记忆）

> 状态：已定稿，配套实施计划见 `docs/superpowers/plans/2026-08-14-chat-coding-tools.md`
> 前置：`docs/chat-file-tools-design.md`（第一轮，PR #221）；本轮在 `feat/chat-file-tools` 同分支继续
> 目标画像（用户已确认）：**开发者自用，多语言并重**

## 1. 背景与目标

第一轮交付了「编辑动作的状态同步」（read/edit/write/list + staleness 门 + 归一化 + 诊断）。coding 场景确认为必须覆盖后，剩余差距按第一轮结论收敛为三段：

1. **检索层**：大目录找内容/找文件（grep/glob）——两家都有，接口语义已收敛，直接采用 + roll 适配
2. **验证层**：编辑成功 ≠ 改对了。代码有便宜的真值检验器（tsc/ruff/eslint），把「编辑→验证」做进协议闭环是超越两家的差异化点（Codex/grok-build 都留给模型自觉）
3. **效率层**：当前最大速度税不是 token 是**确认弹窗**——每次写操作都确认。做会话级批准记忆

核心原则延续：状态同步协议——grep 结果直接可接 read/edit（契约耦合），verify 结果直接告诉模型改坏了哪里，弹窗记忆消灭重复确认轮。

## 2. Scope

**做**：`roll__grep`、`roll__glob`、`roll__verify_file`、批准记忆（文件工具范围）、write 导流与缩水防护、prompt 纪律更新。

**不做（本轮 non-goals，含论证）**：
- **patch/diff 编辑形态**——Codex 的 freeform 依赖 OpenAI grammar 约束解码（qwen/anthropic 无对应物，Codex 自己也只对自家模型开）；无约束 patch 对弱模型格式税更高；公开 benchmark（aider，训练语料记忆未实测）显示 search/replace 优于 unified diff。替代：write_file 导流 + 缩水防护
- **LSP**——留 P3，且路径已定：走 MCP agent 接入（roll 的 MCP 原生架构红利），不内建
- **bash 命令的批准记忆**——命令 key 语义复杂（同名命令不同参数风险不同），留真实场景验证后决定
- **hashline / 方言系统**——同第一轮结论

## 3. 工具契约

### 3.1 `roll__grep`

- 后端：**@vscode/ripgrep**（runtime 新增依赖，1.18 通过 optionalDependencies 平台包分发，无 lifecycle script；不做系统 rg 探测双路径——YAGNI）
- 输入：`pattern`（rg 正则）、`path?`（默认 workdir）、`glob?`（`-g` 过滤）、`context?`（`-C` 行数，默认 0）、`ignore_case?`、`max_results?`（默认 100 命中）
- 输出契约（与 read/edit 耦合）：按文件分组，命中行渲染为 `行号→内容`（与 read_file 行号前缀同构），文件头一行绝对路径——模型可从结果直接接 `read_file offset` 或复制内容作 `old_string`
- 0 命中诊断：若 pattern 含归一化折叠表（CHAR_FOLD）中的字符（全角标点/智能引号），提示归一化变体：「pattern 含全角/智能标点，文件中可能是半角形式，试试：<normalizeForMatch(pattern).text>」——归一化资产延伸到检索层，两家都没有
- 安全：workdir 外 path 走确认门（`escapesWorkdir` 复用）；readOnly annotations；resources `file:<canonical>` read
- 执行：`execFile(rgPath, argv)`（无 shell）、10s 超时、输出超限截断（沿用 maxOutputChars）；rg 默认尊重 .gitignore（`--no-ignore?` 不暴露，保持默认）

### 3.2 `roll__glob`

- 后端：同一个 rg（`rg --files --glob <pattern>`）——**零额外依赖**
- 输入：`pattern`（glob，如 `**/*.ts`）、`path?`
- 输出：文件列表按 mtime 降序（工具层 statSync 排序），上限 200 条 + 截断提示
- 安全同 grep

### 3.3 `roll__verify_file`

- 输入：`path`、`level?`（`"fast"` 默认 | `"project"`）
- **验证器注册表**（`VERIFIER_REGISTRY`）：按扩展名映射候选验证器，每个验证器 = `{ id, level, executesProjectCode, detect(workdir, filePath), command(filePath), timeoutMs }`。detect 做零配置探测（config 文件存在 + 二进制可达），探测不过则跳过

| 扩展名 | fast（默认；纯解析免确认，eslint 等会执行项目代码的验证器需确认一次） | project（显式 level，走确认门、不吃记忆） |
|---|---|---|
| .ts/.tsx/.mts/.cts | eslint（项目本地 `node_modules/.bin/eslint`，有 eslint 配置才启用） | tsc --noEmit（本地 typescript + tsconfig） |
| .js/.jsx/.mjs/.cjs | eslint（同上） | — |
| .py | ruff check --no-fix（PATH 探测）；无 ruff 时 `python3 -m py_compile` 兜底 | — |
| .json | 内建 JSON.parse（零依赖） | — |
| .yaml/.yml | yaml 解析（动态 import("yaml")，不可用则如实跳过） | — |
| .sh/.bash | `bash -n`（语法检查） | — |
| .go | `gofmt -l`（格式） | `go vet ./...` |
| .rs | — | `cargo check`（Cargo.toml + cargo 探测） |

- **执行安全**：argv 数组 execFile（无 shell 注入面）；cwd=workdir；只跑注册表白名单（**绝不**从 package.json scripts 取命令——那是任意代码）；fast 超时 10s / project 120s；输出截断。project 级走确认门的理由：cargo check 会执行 build.rs、go vet 会触发构建——任意代码执行面，须用户可见。准入时记录「路径归属 + 探测到的验证器集合」，执行前复核：同批次里先写入 `node_modules/.bin/eslint` / `eslint.config.*` 再 verify 这类顺序，会因验证器集合变化被阻止并要求重提（重提时走确认门）
- **fail-honest**（与 extraction schema 原则同源）：验证器探测不过 → 结果明确写「<id>: 未安装/未配置，跳过」；全部不可用 → 「该文件类型无可用验证器」——**绝不把「没验证」表述成「验证通过」**
- 返回：逐验证器 `✓ 通过` / `✗ 失败 + 错误输出（截断）` / `– 跳过（原因）`；模型据此决定修复或汇报
- capability role：新增 `file-verify`（approval mode 走 runtimePolicy——fast 级纯解析免确认，eslint 等会执行项目代码的验证器需确认一次；project 走确认门、不吃记忆）
- **不自动执行**：编辑成功后不自动跑（延迟 + project 级安全面），靠 prompt 纪律引导模型调用。真实场景验证后再评估自动化

### 3.4 write 导流与缩水防护

- **导流**：edit_file 的 no-match 诊断尾部追加一行「若修改面较大或文件已大幅变化，可改用 roll__write_file 整文件重写（需先 read_file）」
- **缩水防护**（防 lazy rewrite——模型抄写长文件偷懒丢内容，aider 社区反复踩的坑，两家都没做）：write_file 的 prepare 中，目标已存在且 `原行数 >= 20 且 新行数 < 原行数 × 0.5` 时，explanation 追加「⚠ 新内容 N 行，比原文件 M 行减少 X%，请确认是有意删减」且**强制走确认（不吃批准记忆）**

## 4. 批准记忆（会话级）

分层设计，协议影响最小化：

- **内核**（runtime）：`ApprovalDecision` 加可选字段 `scope?: "once" | "session"`（内部类型，零破坏）；新模块 `approval/approval-memory.ts` 的 `SessionApprovalMemory { isGranted(key): boolean; grant(key): void }`
- **集成点**：`ToolBridgeContext` 加 `approvalMemory?: SessionApprovalMemory`；`gateToolCall` 的 display options 加 `memoryKey?: string`——confirm 决策时先查记忆命中即放行；`requestApproval` 返回 `scope === "session"` 且有 memoryKey 时写入记忆。**不传 memoryKey 的工具（bash、MCP）完全不受影响**
- **key 粒度**：
  - **write 家族**（`edit_file` / `write_file`）：仅 workdir 内传 `memoryKey`（`${tool}:workdir`）；workdir 外逐次确认、不吃记忆
  - **read 家族**（`read_file` / `list_dir` / `grep` / `glob` / `verify_file` 的 external 门）：external 确认可记，key 为 `${tool}:external`
- **UI**（core 包 TUI）：仅当本次确认可写入记忆时展示第三选项「允许并且本会话内不再询问」，并显示授权范围文案；无记忆的确认（bash / MCP / project verify / 缩水写入 / external write）只显示 Yes / No
- **协议**：本轮 session scope 仅进程内（Ink TUI 直接持有 AgentSession 调用 `approve(scope)`）。1.1+ 的 wire 审批通道是 `approval.request` result，当前无 scope；1.0 的 `approval.respond` 也不接受 scope。wire 支持需要协议 1.5（capability 协商，避免新客户端对旧 server 发未知字段被 strict 拒绝）
- **生命周期**：AgentSession 实例字段，session 结束即失效；**不持久化**（重启后重新确认——保守默认，真实场景验证后再议）
- **缩水防护强制确认优先于记忆**（见 3.4）

## 5. prompt 纪律更新

文件工具节追加三条：
- 在文件中搜索内容用 roll__grep（不要用 bash 的 grep/rg——结果格式与 read/edit 衔接）；按名字找文件用 roll__glob
- 修改代码文件（.ts/.py/.go 等）后调用 roll__verify_file 验证，验证失败先修复再汇报完成
- grep 结果的行号可直接用作 read_file 的 offset

## 6. 真实场景验证方案（落地后）

自动化测试之外，在真实 LLM（默认 qwen）下人工观察一组脚本化任务（样例 repo）：
1. 「把项目里所有 `oldName` 改成 `newName`」——观察 grep→edit(replace_all)→verify 链路与轮次数
2. 「这个 YAML 配置加一段」——观察中文内容编辑一次成功率
3. 「重构 <大文件> 的 N 处」——观察导流提示是否被采纳、缩水防护是否误伤
4. 连续 5 次编辑同一目录——观察批准记忆的弹窗减少量与用户体感
观察指标：每任务工具调用轮次、匹配失败率、弹窗次数。据此决定 P3（LSP agent 接入、verify 自动化、bash 记忆）优先级。

## 7. 决策记录

| 决策 | 理由 |
|---|---|
| grep/glob 共用 @vscode/ripgrep，不探测系统 rg | 双路径的行为差异（版本/flag）比依赖体积更贵；glob 走 `rg --files` 零额外依赖；1.18 用 optionalDependencies 平台包，无 postinstall |
| verify 白名单注册表，拒绝 package.json scripts | scripts 是任意代码；注册表 + argv execFile 无 shell 面 |
| fast 级会执行项目代码的验证器（eslint）需确认一次 | 与 cargo/go vet 相同：会加载项目本地配置/插件 = 任意代码执行面；纯解析类仍免确认 |
| project 级验证器走确认门 | cargo check/go vet 触发 build 脚本 = 任意代码执行面 |
| verify 不自动执行 | fast 也有秒级延迟；project 有安全面；先靠 prompt 引导，真实数据说话 |
| 批准记忆 opt-in（用户在弹窗选）且不持久化 | 保守默认；粒度 `${tool}:${workdir|external}` 是甜点，逐文件太碎、全局太粗 |
| bash 不接记忆 | 命令 key 语义复杂，误放行面大；留验证反馈 |
| 缩水防护强制确认不吃记忆 | 整文件覆盖丢内容是最难自救的事故类型 |
| session scope 仅进程内，不改 wire | 1.1+ 审批走 `approval.request` result（无 scope）；1.0 `approval.respond` 保持冻结。wire 支持留给协议 1.5 + capability 协商 |
