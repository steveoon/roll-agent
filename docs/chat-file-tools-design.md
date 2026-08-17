# roll chat 内建文件工具设计（File Tools as State-Sync Protocol）

> 状态：已定稿，配套实施计划见 `docs/superpowers/plans/2026-08-13-chat-file-tools.md`
> 调研依据：openai/codex @ fe01054、xai-org/grok-build @ 8adf901（GitNexus 索引 + 源码核读）

## 1. 背景与问题

roll chat 目前没有任何文件读写工具：模型只能通过 `roll__bash`（cat/sed/echo 重定向）操作文件。这带来三类痛点：

1. **犯错概率高**——shell 编辑没有匹配校验，`sed` 表达式错了会静默改坏文件
2. **重复性工作**——每次编辑前后都要 cat 确认，一次修改消耗 3–5 轮工具调用
3. **反复尝试**——失败时只有 shell 的原始报错，模型拿不到「为什么没改成」的信息，只能盲猜重试

三个痛点的共同根因：**模型对文件的心智模型与文件真实状态偏离时，没有任何机制帮它纠偏**。

roll chat 的场景约束加剧了这一点：

- **多 provider**（默认 qwen）：不能依赖单一模型的训练分布（Codex 的「shell + grammar 约束 patch」路线不可复制），必须走 harness 工程路线
- **中文文本文件为主**（话术模板、配置 YAML、SKILL.md、文案）：全角/半角标点、智能引号的混淆密度远高于英文代码；话术文件重复段落多，匹配唯一性天然更差
- **文本没有编译器兜底**：代码改错了 typecheck 会叫，文本改错了没人叫——工具返回的编辑点快照几乎是唯一验证面

## 2. 核心设计原则

**把编辑工具设计成「状态同步协议」，而不是「动作执行器」。**

每一次工具返回（无论成败）都必须缩小「模型以为的文件内容」与「文件真实内容」之间的差距：

| 时机 | 协议要求 |
|---|---|
| 读取成功 | 返回格式与编辑输入格式严格耦合（读到的片段直接可作 `old_string`） |
| 编辑成功 | 返回编辑点最新快照 +「已写入」承诺，模型无需 read-back 验证 |
| 编辑失败 | 携带纠错信息：最近似位置、首个差异点、多匹配位置列表——一次失败 → 一轮修正 |
| 状态过期 | 主动检测（内容 hash），拒绝基于过期认知的写入并引导 re-read |
| 不可分辨差异 | 工具层吸收（Unicode 归一化匹配），模型负责语义意图，工具负责字节精确 |

## 3. 调研结论与借鉴决策

| 来源 | 借鉴 | 不借鉴 |
|---|---|---|
| grok-build | `search_replace` 容错（unicode confusable 归一化回退、stale hint、read-before-edit 纪律）；`ToolKind`/read-only 分类思想；read 行号前缀契约声明 | 六方言 namespace 系统（服务于 xAI 多模型训练/评测）；hashline 锚点编辑（实验期）；工具名随机化 |
| Codex | 「shell 编辑通道不得旁路审批」的一致性意识 | freeform + Lark grammar patch（依赖 OpenAI 解码端支持）；砍掉 read 工具（依赖自家模型 terminal 训练分布） |
| Claude Code | Edit 成功免验证承诺；Write 覆盖已存在文件须先 Read | — |

**Shell 旁路现状（已核实）**：bash classifier 把 `>` 等元字符列为危险（`compound.ts` 的 `DANGEROUS_METACHARS`），`sed` 不在 safe-list——shell 改文件已落入 confirm 门，无静默旁路。因此 shell→编辑工具的语义拦截（Codex 式 intercept）降级为 future，本期只在 system prompt 中引导「改文件优先用文件工具」。

## 4. 工具面契约

四个内建工具，命名沿用 `roll__<name>` 约定（`ToolRegistry.register("roll", name)`），全部落在 `packages/runtime/src/tool-bridge/file-tools/`：

### `roll__read_file`
- 输入：`path`（相对 workdir 或绝对）、`offset?`（1-based 起始行）、`limit?`（默认 2000 行）
- 输出：首行 `文件: <绝对路径> (共 N 行)`，正文每行 `<5位右对齐行号>→<内容>`
- 行为：UTF-8 BOM 剥离后展示与记录；含 NUL 判定二进制拒绝；超 `maxFileBytes`（默认 2 MiB）拒绝；含 U+FFFD 追加编码警告；单行超 1000 字符截断
- 副作用：向 `FileStateTracker` 记录全文内容 hash（分页读取也记录全文——读过任意部分即解锁编辑，stale 检测兜底）

### `roll__edit_file`
- 输入：`file_path`、`edits: [{old_string, new_string, replace_all?}]`（≥1 条）
- 前置门（按序）：文件可读 → `unread` 拒绝（先 read）→ `stale` 拒绝（文件被外部修改，引导 re-read）
- 匹配管线（每条 edit）：精确匹配 → 唯一命中执行；0 命中 → 归一化匹配（仅唯一命中才执行，替换按原文件字节区间切割）；仍失败 → no-match 诊断；多命中 → multi-match 诊断
- **原子性**：全部 edits 在内存中顺序应用（后条基于前条结果），任何一条失败则整体不落盘，报告失败条目序号 + 诊断
- 行尾保持：全 CRLF 文件回写时 `new_string` 的 `\n` 转 `\r\n`；混合行尾不转换
- 成功返回：每处编辑点 ±3 行最新快照（带行号，位置经 delta 修正）+「N 处修改已写入」；并更新 tracker（连续编辑无需重读）
- `replace_all` 仅作用于精确匹配（归一化 + replace_all 组合拒绝，防止过度魔法）

### `roll__write_file`
- 输入：`file_path`、`content`
- 新文件：允许（自动 `mkdir -p` 父目录）；已存在文件：`unread` 拒绝（先 read 确认再覆盖）、`stale` 拒绝、`fresh` 覆盖
- 成功返回：`已写入 <path>（N 行，M 字节）` + 前 10 行快照；更新 tracker

### `roll__list_dir`
- 输入：`path?`（默认 workdir）
- 输出：目录优先、locale 排序，目录加 `/` 后缀，文件附字节数；上限 300 项截断提示

## 5. 关键机制

### 5.1 FileStateTracker（session 级）

```
recordKnownContent(key, content)    read 成功 / edit・write 落盘后调用
checkFreshness(key, current) → fresh | stale | unread
```

- 单一事实来源是**内容 sha256**（不是 mtime——编辑器 touch 会误报）
- key 为 canonical path（`realpathSync.native` best-effort）
- LRU 上限 512 文件
- fail-safe 方向：漏检（alias 路径判 unread）只多要求一次 read，不会放行过期写入

### 5.2 归一化匹配（`normalizeForMatch`）

字符级 1:1 折叠 + `\r` 删除，同时维护 `normalized index → original index` 映射，保证归一化空间的命中能精确切回原文件字节区间（**替换只动目标段，其余字节原样保留**）：

| 类别 | 折叠 |
|---|---|
| 换行 | `\r` 删除（CRLF 文件可用 LF old_string 命中） |
| 空格类 | U+3000（全角空格）、U+00A0（NBSP）→ 半角空格 |
| 引号 | " " ' '（智能引号）→ 直引号 |
| 破折号 | — – ―（U+2014/2013/2015）→ `-` |
| 全角同形标点 | ，：；！？（）．→ 半角对应 |

刻意不折叠：顿号「、」（与逗号视觉可分辨）、省略号「…」（1:3 破坏映射）、行尾空白（映射复杂度不值，留给诊断层描述）。

### 5.3 失败诊断格式

**no-match**：以 `old_string` 首个非空行为探针，在文件中找最相似行（前后缀公共长度比，阈值 0.3），渲染 ±3 行带行号上下文 + 首个差异点的双方内容对照 + re-read 引导；`old_string` 含 `行号→` 前缀模式时追加专项警告（「你把 read_file 的行号前缀带进来了」）。

**multi-match**：列出每处命中的行号与该行内容，给两条明确出路：扩展 `old_string` 上下文使其唯一，或 `replace_all`。

### 5.4 Policy 与 capability 接入

- 工具名与 `DefaultToolPolicy` 动词启发式天然对齐（已核实 `default-policy.ts`）：`read_file`/`list_dir` 命中 READ_VERBS → allow；`edit_file`/`write_file` 命中 WRITE_VERBS → confirm。同时显式携带 `ToolAnnotations`（read/list 为 `readOnlyHint: true`），不依赖命名巧合
- 确认门展示：edit/write 在 `prepare` 阶段生成 `display.explanation`（`修改 <文件名>：N 处编辑` 摘要），复用 `gateToolCall` 既有机制
- 新增 capability roles：`file-read`（approval mode = readOnly）、`file-edit`（默认 runtimePolicy）
- 资源互斥：`resources` 返回 `file:<canonical>` key（与 `build-tools.ts` 中 MCP 工具的 file hint key 同前缀），read 工具 read mode、edit/write 工具 write mode——并行工具调度天然按文件互斥
- 路径准入与 opaque shell 互斥：准入时捕获路径归属和 canonical target，持锁后、读盘前复验；containment 或目标变化即 fail-closed。所有文件工具同时持有 `shell:opaque-side-effects` read lock，未知/破坏性 shell 持 write lock，不允许 shell 在文件工具的复验与执行之间并行改指 symlink

### 5.5 System prompt 纪律

新增「# 文件工具」节：行号前缀非文件内容、编辑前必读、old_string 逐字复制且须唯一、多处修改用 edits 数组一次提交、新建/重写用 write_file；并声明与 shell 分工——**读改文件优先文件工具，不要用 cat/sed/echo 重定向**（那会失去差异预览与状态跟踪）。

## 6. 组装与默认开关

- `buildFileToolset(settings, registry, ctx) → { readTools, editTools }`，tracker 内聚在工具集内（每 session 一个）
- `AgentSessionOptions.fileTools?: SessionFileToolsSettings`（`workdir` 必填，`maxFileBytes`/`maxOutputChars` 可选）
- `ConversationEngineOptions.fileToolsEnabled?: boolean`（默认 true）；workdir 取 `bash?.workdir ?? process.cwd()`——无 shell 的会话同样可用文件工具

## 7. Non-goals（本期不做）

- shell 编辑命令的语义拦截（intercept）——现有 confirm 门已兜底，列为 future
- `grep` 工具——bash 已覆盖搜索场景
- 跨子 agent 的 canonical tool `_meta` envelope（grok-build 式 taxonomy 全量）——future
- hashline 锚点编辑、编辑方言切换
- 图片/PDF 读取——走既有附件栈（Protocol 1.4），文件工具保持纯文本
- 非 UTF-8 编码转换（GBK 等）——检测到疑似乱码只警告不转换

## 8. 决策记录

| 决策 | 理由 |
|---|---|
| string-replace 而非 patch DSL | 多 provider 下最普适；patch/grammar 是模型协同设计路线，roll 不训模型 |
| edits 数组统一形态（无单编辑糖） | schema 单一形态对弱模型 structured output 更稳，避免 anyOf 兼容性问题 |
| 内容 hash 而非 mtime 判 stale | mtime 在编辑器 touch/同步盘场景误报；内容才是模型心智模型的对象 |
| 归一化只做 1:1 折叠 | 保证 normalized→original 映射精确，替换永不污染非目标字节 |
| 归一化命中必须唯一 | 容错不能引入新的歧义；多命中一律走诊断让模型决策 |
| 内建工具而非 MCP 子 agent | 反馈回路依赖 session 级状态连续（tracker、上下文管理）；跨进程会切断状态 |
| read/list 的 workdir 外路径走确认门 | 与 bash 通道 auditResolvedPath 的静默放行收敛语义对齐；绝对路径能力保留，仅收敛零确认面 |
