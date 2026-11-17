# 安装和更新 Roll

Roll 提供独立发行包与 npm 两种安装渠道。两种渠道使用相同的 CLI 和 Agent 生态；独立发行包携带 Node/npm，用户无需预装 Node 或 pnpm。

## 独立安装

macOS / Linux：

```sh
curl -fsSL https://roll.duliday.com/install.sh | sh
```

安装脚本会提示当前终端的 PATH 生效命令，新打开的终端会自动使用用户级入口。也可以先下载并审阅脚本后再执行：

```sh
curl -fsS https://roll.duliday.com/install.sh -o install.sh
sh install.sh --version 2.1.0 --install-dir "$HOME/roll" --no-modify-path
```

上面的版本号为参数示例，实际请传入已发布的版本号。指定自定义安装目录时，CLI 入口位于该目录下的 `bin/roll`。

Windows PowerShell：

```powershell
irm https://roll.duliday.com/install.ps1 | iex
```

如需自定义参数，可先下载脚本，再传入 `-Version`、`-InstallDir`、`-NoModifyPath`。脚本仅配置当前用户环境，不要求管理员身份，也不会全局修改 PowerShell 执行策略。

Windows 安装脚本会先校验发行包，再使用包内自带的 Node 与单文件安装助手完成目录部署。它支持 Windows PowerShell 5.1，无需开启系统长路径策略或预装 Node/npm。首次安装、重复安装及后续更新共用同一套 Node ZIP 安全校验逻辑，PowerShell 仅负责处理短路径引导文件与用户 PATH（引导脚本不支持用 `-Version` 安装缺少引导助手的早期旧版 ZIP 包，也不会回退到存在长路径风险的解压方式）。

在已有安装上重复运行在线安装脚本时，脚本只更新 Roll 本体，保留现有配置文件、会话记录和已安装的 Agent 包；若此前使用了自定义目录，需继续传入原 `--install-dir` / `-InstallDir`（脚本不会自动扫描其他安装位置）。更新前会检查使用锁与后台服务状态，若存在活跃任务、正在调用的 Agent 或无法确认的进程身份，脚本会安全中止，按提示结束相关工作后重试即可。完成安装后，日常升级直接运行 `roll update`。

系统支持范围为 macOS 13.5+、Linux（kernel 4.18+ / glibc 2.28+）与 Windows 10 / Server 2016 及以上版本，支持 x64 与 arm64 架构；暂不提供 musl/Alpine 包。POSIX 环境需具备 `curl`、`tar` 与 SHA-256 校验工具，Windows 使用系统自带 PowerShell，全程无需本地编译。

## npm 安装

本机已安装兼容版本 Node/npm 的用户可继续通过 npm 全局安装：

```sh
npm install --global @roll-agent/core
```

独立安装与 npm 安装可以共存。运行 `roll doctor` 可查看当前生效的安装位置与执行环境，实际调用哪个实例由终端 `PATH` 顺序决定。独立版不会将内置的私有 Node/npm 写入用户全局 `PATH`。

若使用 pnpm 全局安装、Yarn Classic global 或 Volta 管理全局包，`roll update` 仅在能确认 npm 全局目标与当前运行实例一致时才会更新本体，否则会提示跳过。此时请继续使用原包管理器升级：

```sh
pnpm add --global @roll-agent/core@latest
yarn global add @roll-agent/core@latest
volta install @roll-agent/core@latest
```

按你的实际安装渠道执行对应命令后，可运行 `roll doctor` 确认 `PATH` 命中的实例。上述 Yarn 命令适用于 [Yarn Classic](https://classic.yarnpkg.com/lang/en/docs/cli/global/)，Volta 的工具安装与升级统一使用 [volta install](https://docs.volta.sh/reference/install)；Roll 不会自动迁移这些包管理器的全局目录。

## 安装 Agent 与更新

```sh
roll agent install @roll-agent/browser-use-agent
roll update --check
roll update
roll doctor
```

**更新来源与网络容错**：`roll update` 会分别检查 Roll 本体与已注册 Agent。独立版从官方发行清单拉取本体更新，npm 版更新经确认的全局包目录；从源码运行或无法确认安装目标时会自动跳过本体更新，仅处理 Agent。npm 类型的 Agent 使用配置的 npm registry，与本体发行服务器相互独立。若本体版本检查遇到网络异常，命令会跳过本体更新并继续处理 Agent，不会将未知状态误报为“已是最新版本”；单纯的版本检查失败不会导致整个命令报错退出，但下载、安装或 Agent 更新实际失败仍返回非零退出码。

**独立版内置 Node/npm 的生效条件**：独立版在执行普通 `node`、`npm`、`npx` 命令（包括 Agent 安装脚本、`stdio` / HTTP Agent 启动以及浏览器初始化）时会自动使用随包携带的运行环境；若配置了显式解释器路径（如 `/usr/local/bin/node`），则按原路径执行。需要注意，仅当 Agent 启动配置明确声明 `start.command: node` 并将 JS 入口文件路径放入 `start.args`（例如 `['node_modules/example-cli/bin/index.js']`，切勿把整条 shell 命令串当作入口）时，Roll 才会自动注入随包 Node，而不会猜测任意脚本文件的 shebang——直接启动 `.bin/xxx`、`tsx` 或自定义脚本仍沿用系统环境，可能依赖外部安装的 Node。Python、`pip`、虚拟环境、Docker 及原生编译工具同样由外部环境提供，Roll 负责管理这些 Agent 的进程生命周期，但不供应其语言运行时。

**安全预检与后台服务协调**：升级本体时，安装器会先完成新包下载、SHA-256 校验，并在隔离配置环境中执行启动预检，全部通过后才进入正式切换流程；若有 Agent 正在使用或存在状态不明的任务，维护流程会提前阻止切换。切换后旧版本目录予以保留，用户的配置文件、认证凭据、会话记录和 Agent 安装目录均不会被覆盖。后台服务方面：

- **macOS / Windows 定时任务（scheduler）服务**：通过新版本入口协调切换，若当前有活跃任务则延后重启。
- **Companion 服务**：为避免中断正在进行的远程会话，自动更新期间保留现有服务进程；待远程会话结束后手动执行 `roll companion service install` 即可切换到新版本。
- **Linux 后台进程**：Linux 当前以前台 daemon 方式运行，重启后使用新版本，暂未内置系统级常驻服务。

## 故障恢复

- **下载、校验或预检失败**：原有版本保持完好可用，排查网络或环境问题后重试即可。
- **同版本文件与发行包不一致**：安装器会拒绝覆盖并保留现场，可在新目录安装并排查原因，不会删除已有用户数据。
- **下载或预检阶段收到 `SIGINT` / `SIGTERM`**：安装器会先中止 I/O 并等待预检子进程退出，随后清理临时目录和锁文件，退出码分别为 `130` / `143`。
- **清理时遇到文件占用**：若失败回滚清理因文件占用受阻，安装器会打印保留的临时目录与锁路径。请先确认原安装进程已退出并解除文件占用，再清理明确标识的残留项，切勿清空用户配置或整个安装目录。
- **遗留 `.install-lock`**（例如遭遇 `SIGKILL`、断电等强制中断）：Node 更新器会在锁旁留下 `owner.json`（记录 PID、创建时间及所有权标识）辅助排查。由于操作系统可能复用 PID，仅凭记录无法断定原进程已退出，需人工确认无相关更新进程运行后再删除该锁。
- **本体已升级但个别 Agent 更新失败**：命令会报告部分成功并对失败的 Agent 执行回滚恢复，不会将用户数据库或其他已成功更新的组件一并回退。

服务器和 CI 配置见 [独立发行部署说明](deployment/standalone-distribution.md)。
