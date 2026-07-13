# Windows 兼容性评估与现状

> 基于 2026-07 的全库静态审计（chat 终端层 / 进程与路径层 / 编码与协议层三路并行核查）。
> CI 已覆盖 `windows-latest` PowerShell one-shot 与 session exec smoke；终端键盘矩阵和托管
> agent 生命周期仍需人工实测。

## 总体结论

代码底子好于预期：文件读写全部显式 UTF-8、路径全走 `path` API、CLI 懒加载使用 `file://` URL、
stdio 分帧两端剥 `\r`、包管理器调用已有完整 cmd.exe 适配（`package-manager.ts` 是全库唯一
带 `win32` 分支的模块）。风险集中在托管进程管理、非 Node 子进程编码、chat TUI 终端能力依赖、
用户手工编辑文件的编码陷阱四处。

## Windows 安装与配置指引

安装本身零特殊配置：官方 MSI 安装 Node ≥ 22.6.0，`npm i -g @roll-agent/core` 后
`roll` 命令经 npm `.cmd` shim 直接可用。以下是需要注意的使用习惯与已知限制。

### 必须注意

1. **Node 尽量装新**（22 LTS 起步）。Shift+Tab 等按键能否被识别取决于 libuv 的
   VT 输入直通支持（1.49+），越新的 Node 键盘兼容性越好。
2. **chat 模式用 Windows Terminal（或 VS Code 集成终端）**：
   - Windows Terminal：边框、emoji、CJK 宽度全部正常，TUI 完整可用
   - 传统 conhost（cmd/PowerShell 5.1 旧窗口）：可用，spinner 自动降级 ASCII，
     但 `⏵⏵`、`🧠` 等字形受字体限制可能显示为方块（字体问题，`chcp 65001` 无效）
   - Git Bash（MinTTY）：`isTTY` 为 false，chat **静默降级到 readline 基础模式**
     （无状态栏 / Auto Mode / slash 弹窗）；要 TUI 请换终端或 `winpty roll chat`
   - 非 chat 命令（`run`/`ask`/`agent`/`config`）在任何终端都正常
3. **手工编辑的文件存成 UTF-8**：`roll.config.yaml`、`SKILL.md` 用现代编辑器保存为
   UTF-8，不要用老记事本的「ANSI」或 UTF-16 另存（roll 强制按 UTF-8 解码）。
   带 BOM 的 `package.json` 已容忍，但仍建议无 BOM。

### 建议的配置习惯

- 配置路径 `~/` 与 `~\` 前缀均可展开（统一解析到 `USERPROFILE`），推荐 `~/.roll-agent`
  正斜杠风格；`${ENV_VAR}` 引用大小写敏感，需与系统变量名完全一致
- **Agent start 命令优先 `node` 直启**（`node dist/index.js`）。`npx`/`pnpm` 等
  `.cmd` 命令可以启动（cross-spawn），但 PID 记录的是 cmd.exe 包装层，
  `roll agent stop` 只能杀包装进程，真正的 agent 可能残留
- PowerShell 5.1 / cmd 里给 `roll run` 传 JSON 用 `--input-file`，不要用单引号
  `--input-json '{...}'`（cmd 不认单引号、PS 5.1 会剥引号）；PowerShell 7.3+ 单引号可用
- `roll chat` 内建 shell 工具使用 `runtime.shell` 配置：macOS/Linux 注册 `roll__bash`，
  Windows 原生只在检测到 PowerShell 7+ (`pwsh`) 时注册 `roll__powershell`；探测会覆盖 PATH 与
  标准 Program Files 安装路径，未安装时可运行 `winget install Microsoft.PowerShell`。设置
  `runtime.shell.session.enabled: true` 后，交互 REPL 与 `--server` 长驻模式还会注册
  `roll__exec_command`、`roll__exec_poll`、`roll__exec_list`；后台命令可跨聊天轮次继续运行。
  PowerShell 命令当前全部按 unknown 处理，默认逐条确认；显式
  `runtime.approval.overrides` 中的 `roll.powershell: auto` 或 `roll.exec_command: auto` 可覆盖对应
  工具。PowerShell wrapper 会把 cmdlet 错误和 native `$LASTEXITCODE` 传播为进程退出码，避免
  明显失败被展示为成功
- session exec 的用户 Esc 只中断当前轮创建或轮询过的会话；整轮 timeout 不终止后台进程，
  下一轮可先用 `roll__exec_list` 找回 session id，再用 `roll__exec_poll` 继续读取。显式取消、
  timeout 与正常退出会分别展示，不能只凭脚本最后一行判断成功。`exec_list` 是当前
  chat 进程内的有界近期集合，不是永久历史；`cleanup-failed` 会持续占用一个 session 名额，
  直到用 `roll__exec_poll` 读取并确认该终态结果
- pnpm 安装依赖遇路径过长报错时，开启系统长路径支持（`LongPathsEnabled=1`）

### 不需要做的事

- 不需要 `chcp 65001`：Node 对真实控制台走 `WriteConsoleW`，中文显示不依赖代码页
- Python stdio 子 Agent 不需要设编码：roll 自动注入 `PYTHONUTF8=1` +
  `PYTHONIOENCODING=utf-8`；唯一例外是自行托管的 external-managed HTTP 服务进程，
  需自行保证 UTF-8 输出
- 不需要开启系统区域设置的「Beta: 使用 UTF-8」（对其他工具有益，roll 不依赖）

### 已知限制与替代操作（chat 模式）

| 受影响功能 | 原因 | 替代 |
|---|---|---|
| Shift+Tab 切 Auto Mode | 按键翻译取决于终端 + Node 版本，未实测 | `/auto` 命令（等价） |
| Alt+. / Alt+, 调推理档 | 依赖 kitty 协议，Windows Terminal 不支持 | `/think`、`/effort` 命令 |
| Shift+Enter 换行 | 无 kitty 时与 Enter 不可区分（会直接发送） | 用 Ctrl+J 换行 |
| `roll agent stop` 优雅关闭 | Windows 无 SIGTERM，等于强杀（stop 时有提示） | 先 `roll browser stop` 关浏览器再停 agent |
| session exec 的 root 先退出、后代继续持有 stdio | root PID 已可能被系统复用，Roll 不会再用旧 PID 调 `taskkill /T`；会话保守标为 `cleanup-failed`，不伪报后代已清理 | 让脚本 root 等待自己启动的子进程结束；需保证这类后代必杀时需未来引入 Windows Job Object |
| session exec 跨 `roll chat` 进程重启恢复 | 会话仅存在于当前长驻进程，重启后不能重新附着旧 OS 进程 | 保持同一 chat 进程运行，或重新执行脚本 |

## 编码问题的成因模型

Windows 上的「UTF-8 乱码」是三个机制不同的问题，判断风险先分清边界：

1. **控制台显示边界（TTY 直写）**：Node 检测到 stdout 是真实控制台时，libuv 走 `WriteConsoleW`
   （UTF-8 → UTF-16），不经过代码页。中文正文在 `chcp 936` 下通常也能正确显示；显示异常的
   根源多为**字体字形覆盖**（`⏵`、`🗜`、braille 等在 legacy conhost 字体下缺字形），
   `chcp 65001` 救不了，只有 Windows Terminal 能解。
2. **管道/重定向字节边界**：stdout 被管道或重定向后是裸 UTF-8 字节，下游按 ANSI 代码页解读
   会乱码。反方向更危险：非 Node 子进程（Python 等）在 Windows 默认按 locale 编码
   （中文系统 CP936）写 stdout，父进程 MCP SDK 按 UTF-8 解码 → 中文 tool 结果 mojibake。
   Node↔Node 的 MCP stdio 两端都是 UTF-8，无此风险。
3. **文件解码边界**：所有 `readFileSync(..., "utf-8")` 强制按 UTF-8 解码。用户用记事本
   「ANSI」或 UTF-16 另存配置/SKILL.md 即产生乱码，代码层无法检测。

**关键澄清**：`已取消执行` / `策略拒绝执行` 这两个承担控制流的前缀
（`packages/runtime/src/tool-bridge/build-tools.ts` 生成、`agent-session.ts` 匹配）
从生成到匹配全程在同一 Node 进程内以 JS 字符串传递，**不存在编码转换风险**。

## Chat 模式 vs 非 Chat 模式

| 维度 | Chat（ink TUI） | 非 Chat（run/ask/agent/config） |
|---|---|---|
| 终端依赖 | raw mode + ANSI 光标控制 + kitty 探测 + Unicode 字形 | 纯追加流；日志 stderr、数据 stdout |
| 编码显示风险 | 高（边框/emoji/spinner 字形依赖终端字体） | 低（ora 自动降级 ASCII、chalk 自动降色） |
| 键盘 | Shift+Tab / Alt+. 依赖终端 VT 输入能力 | 无 |
| 最稳路径 | `roll chat --server`（纯 NDJSON）与 readline 回退 | `--json` 管道输出（stdout 纯净已验证） |

Chat 模式要点：

- 入口三重门控（`chat.ts`：`stdout.isTTY && stdin.isTTY && setRawMode`），Git Bash（MinTTY）
  下 isTTY 为 false 会**静默落到 readline 回退**——功能可用但 TUI 全部消失。
- **Shift+Tab 可用性是悬案**：ink 同时识别 backtab `\x1b[Z` 与 kitty `CSI 9;2u`，但输入序列
  能否到达 Node 取决于 libuv 版本（旧版自行翻译键盘事件，Shift+Tab 可能退化为裸 `\t`；
  libuv 1.49+ 支持 `ENABLE_VIRTUAL_TERMINAL_INPUT` 直通）。`/auto` 命令是设计好的兜底。
- **Alt+. 与 Shift+Enter 静态可证依赖 kitty 协议**（legacy 序列解析不出 meta / shift+回车）。
  Windows Terminal 不支持 kitty，探测（`CSI ? u` + 200ms 超时）会安全降级：不崩溃，
  但 Alt 调推理档静默失效、Shift+Enter 变成直接发送（Ctrl+J 换行仍可用）。
- kitty 探测、TTY 门控、ink 失败 try/catch 回退 readline，是现有仅有的跨平台保障，
  全库 chat 终端层无任何 `win32` 分支。

非 Chat 模式要点：

- **两条 spawn 路径命运不同**：`roll run`/`ask` 走 MCP SDK `StdioClientTransport`
  （内部 cross-spawn，`.cmd` 可解析）；`roll agent start`/托管自愈走 `process-manager.ts`
  （已于本轮同样切换 cross-spawn，见下表）。
- **`roll agent stop` 在 Windows 是强制终止**：`process.kill(pid, "SIGTERM")` 映射为
  `TerminateProcess`，子进程无法拦截、无法清理。依赖优雅关闭的 agent（browser-use 等）
  在 Windows 上得不到清理机会。另外 cross-spawn 对 `.cmd` 命令会经 cmd.exe 包装，
  记录的 PID 是包装进程，stop 只杀包装层——**Windows 托管 agent 应尽量用 `node` 直启**。
- `process.kill(pid, 0)` 探活对无权限进程可能抛 `EPERM` 被误判为已死（孤儿误清理，需实测）。

## 风险清单与修复状态

| 级别 | 问题 | 位置 | 状态 |
|---|---|---|---|
| 🔴 | 非 Node 子进程 stdout 按 locale 编码写、父进程按 UTF-8 解 → 中文乱码 | `client-manager.ts` `buildStdioChildEnv` | ✅ 已修复：注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`（可被显式 env 覆盖）；接入文档补编码章节 |
| 🔴 | `package.json` 带 UTF-8 BOM → `JSON.parse` 抛错，`roll agent add` 失败 | `discovery.ts` / `source.ts` / `process-manager.ts` | ✅ 已修复：统一经 strip-BOM 的 JSON 读取 helper |
| 🔴 | 托管 spawn 无 `.cmd` 解析（npx/pnpm 类 start 命令 ENOENT） | `process-manager.ts` | ✅ 已修复：切换 cross-spawn + `windowsHide` |
| 🔴 | SIGTERM = TerminateProcess，优雅停止语义失效 | `process-manager.ts` | ⚠️ 平台限制：stop 时在 win32 提示强制终止语义；agent 侧不应依赖退出钩子 |
| 🟠 | 两套 home 解析不一致（`HOME??USERPROFILE` vs `os.homedir()`），目录可能分裂 | `config/loader.ts` | ✅ 已修复：统一 `os.homedir()`，并支持 `~\` 前缀 |
| 🟠 | `agents.json` 非原子直写 + 解析失败静默清空 | `registry/store.ts` | ✅ 已修复：临时文件 + rename 原子写 |
| 🟠 | ink spinner 硬编码 braille 无降级 | `cli/chat/ink/spinner.ts` | ✅ 已修复：`is-unicode-supported` 降级 ASCII |
| 🟠 | 文档/skill 单引号 JSON 示例在 cmd/PowerShell 5.1 失败 | roll-core skill | ✅ 已修复：补 Windows 引用规范（推荐 `--input-file`） |
| 🟠 | `roll chat` 内建 shell 仅支持 POSIX，Windows 无原生命令执行 | runtime shell tool | ✅ 已修复：PowerShell 7+ 注册 one-shot 与 session exec；取消和清理走 `taskkill /T /F`；命令分类仍保守为 unknown |
| 🟠 | Shift+Tab / Alt+. / Shift+Enter 键盘链路 | chat TUI | 🔬 需实测（终端 × Node 版本矩阵） |
| 🟡 | `${env}` 替换大小写敏感（`Path` vs `PATH`） | `loader.ts` | 📋 待办（低优先级） |
| 🟡 | `unlinkSync` 删被占用 PID/日志文件抛 EPERM 无兜底 | `process-manager.ts` | 📋 待办 |
| 🟡 | `truncateMiddle` 按码点计宽，CJK 对齐错位 | `cli/utils/terminal.ts` | 📋 待办（显示层） |
| 🟡 | pnpm 深层 node_modules 可能触及 MAX_PATH 260 | 安装层 | 🔬 需实测（建议引导启用长路径） |

已验证安全（静态可证）：denial 前缀协议匹配同进程无编码边界；stdio NDJSON 两端剥 `\r`；
配置备份名 `YYYYMMDD-HHMMSS` 无冒号；懒加载 `file://` URL；yaml / gray-matter 容忍或剥离 BOM；
LLM HTTP 与 MCP JSON 全程 UTF-8；`--json` stdout 无 ANSI 混入；npm bin shim 标准可用。

## Windows 实测清单（按性价比排序）

1. 终端 × 键盘矩阵：Windows Terminal / conhost（cmd、PowerShell 5.1）/ Git Bash ×
   {Shift+Tab、Ctrl+J、Esc、退格、中文 IME}——重点确认 Shift+Tab 是否产出 `CSI Z`
2. Python stdio agent 中文往返（验证 `PYTHONUTF8` 注入效果）
3. 托管生命周期：start 黑框、日志句柄占用、stop 后资源残留
4. TUI 渲染：三种终端下边框/emoji/spinner 与 `displayWidth` 计算宽度的偏差
5. `windows-latest` 已覆盖 PowerShell one-shot、中文增量输出、session poll/退出、进程树取消、
   turn timeout 恢复与容量回收；下一步补终端 TUI 与托管 agent 生命周期 smoke
