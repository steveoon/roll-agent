# 安装和更新 Roll

Roll 提供独立发行包与 npm 两种安装渠道。两种渠道使用相同的 CLI 和 Agent 生态；独立发行包携带 Node/npm，用户无需预装 Node 或 pnpm。发行资产通过六个平台验证并上线后，以下 URL 才可用于安装。

## 独立安装

macOS / Linux：

```sh
curl -fsSL https://roll.duliday.com/install.sh | sh
```

安装脚本提示当前终端的 PATH 生效命令；新终端自动使用用户级入口。也可以先下载、阅读脚本，再执行。

```sh
curl -fsS https://roll.duliday.com/install.sh -o install.sh
sh install.sh --version 0.37.0 --install-dir "$HOME/roll" --no-modify-path
```

上面的版本号是参数示例，请使用已发布版本。自定义目录的入口位于该目录的 `bin/roll`。

Windows PowerShell：

```powershell
irm https://roll.duliday.com/install.ps1 | iex
```

如需参数，先下载脚本，再使用 `-Version`、`-InstallDir`、`-NoModifyPath`。脚本仅配置当前用户，不要求管理员身份，也不全局改变 PowerShell 执行策略。

Windows 安装脚本先校验发行包，再用包内 Node 和单文件安装助手处理完整目录。它支持 Windows PowerShell 5.1，不需要开启系统长路径策略或预装 Node/npm。安装、重复安装及更新都使用同一套 Node ZIP 安全校验；PowerShell 仅处理短路径引导文件及用户 PATH。

### Windows 0.38.0 的一次性过渡升级

修复版发布后，如果旧版安装或 `roll update` 报 `PathTooLongException`，重新运行上面的在线安装命令即可安装当前 stable。已有安装使用自定义位置时，必须继续传入原来的 `-InstallDir`；脚本不会自动查找其他安装位置。

脚本只更新 Roll 本体，保留配置、会话和 Agent 包。更新前检查使用锁和服务状态；有活动任务、Agent 使用中或身份无法确认时会停止，按提示结束相关工作后重试。以后正常使用 `roll update`。新版引导脚本不支持用 `-Version` 安装缺少引导助手的旧 ZIP；不会回退到存在长路径问题的解压方式。

失败清理若受文件占用阻碍，安装器会显示保留的临时目录与锁。先确认原安装进程已退出并解除占用，再处理该明确标识的残留；不要清空配置或整个安装目录。

支持 macOS 13.5+、Linux kernel 4.18+/glibc 2.28+、Windows 10/Server 2016 对应支持范围，架构为 x64/arm64。首版不提供 musl/Alpine 包。POSIX 需要 curl、tar、SHA-256 校验工具等系统工具；Windows 使用系统 PowerShell。无需本地编译 Roll。

## npm 安装

已有兼容 Node/npm 的用户可以继续执行：

```sh
npm install --global @roll-agent/core
```

两种安装可以共存。`roll doctor` 显示当前正在运行的安装位置与执行环境；PATH 决定 `roll` 指向哪份安装。Roll 不会把私有 Node/npm 加入用户全局 PATH。

使用 pnpm 全局安装、Yarn Classic global 或 Volta 时，`roll update` 只有在能证明 npm 的目标与当前安装一致时才更新本体；否则仅提示跳过。请继续通过原来的管理器更新：

```sh
pnpm add --global @roll-agent/core@latest
yarn global add @roll-agent/core@latest
volta install @roll-agent/core@latest
```

只执行与你的安装渠道对应的命令，再运行 `roll doctor` 确认 PATH 选中的实例。Yarn 命令适用于 [Yarn Classic](https://classic.yarnpkg.com/lang/en/docs/cli/global/)；Volta 的工具安装和升级使用 [volta install](https://docs.volta.sh/reference/install)。Roll 不会自动迁移这些管理器的全局安装目录。

## 安装 Agent 与更新

```sh
roll agent install @roll-agent/browser-use-agent
roll update --check
roll update
roll doctor
```

独立版从自己的发行清单检查和下载本体更新；npm 版更新经过确认的全局安装位置。源码或无法确认目标位置的安装跳过本体更新，继续处理 Agent。npm Agent 使用配置的 npm registry，与本体发行服务器分开。

独立版运行普通 `node`、`npm`、`npx` 命令时使用随包环境，包括 Agent 安装脚本、stdio/HTTP Agent 与浏览器 setup。显式解释器路径保持原意。Python、pip、虚拟环境、Docker 和原生编译工具由外部提供；Roll 可以管理这些 Agent 的进程，但不负责供应其语言环境。

该保证基于明确的启动命令，不会猜测任意文件的 shebang。直接启动 `.bin/xxx`、`tsx` 或自定义脚本时，命令和环境保持原样，可能仍需要外部 Node。希望使用私有 Node 的 Agent 应声明 `start.command: node`，并将真实 JS 入口放入 `start.args`，例如 `['node_modules/example-cli/bin/index.js']`；不要把 shell 命令串当作 JS 入口。

两种渠道的版本检查遇到网络失败时都跳过本体更新，继续处理 Agent，不会将未知状态显示为“已是最新版本”。单独的版本检查失败不使整个更新退出失败；实际下载、安装或 Agent 更新失败仍返回非零退出码。

升级先下载、校验并在隔离配置中预检，然后才进入现有维护流程。正在使用的 Agent 或状态不明的任务会阻止不安全的维护。旧版本目录保留；配置、凭据、会话和 Agent 安装目录不随发行包被覆盖。

macOS/Windows scheduler 服务会通过新版本入口协调更新，活跃任务会使重启延后。Companion 尚无原子的会话空闲确认机制，因此自动更新保留它的旧服务；远程会话结束后执行 `roll companion service install` 完成切换，避免中断远程使用。Linux 前台 daemon 使用启动时的版本，重启后使用新版本；本次不新增 Linux 系统服务。

## 故障恢复

- 下载、校验或预检失败：旧版本继续可用，排查网络后重试。
- 同一版本的文件与发行包不一致：安装器拒绝覆盖；保留现场，在新目录安装并诊断，不删除用户数据。
- 下载和预检阶段收到 SIGINT/SIGTERM：先中止 I/O 并等待预检子进程退出，再清理临时目录和锁，退出码分别为 130/143。
- 遗留 `.install-lock`（例如 SIGKILL、断电或其他阶段被强制终止）：Node 更新器会留下 `owner.json`，记录 PID、创建时间及所有权标识，供诊断。PID 可能被复用，记录不能证明进程已退出；先确认没有相关进程，再由用户处理该锁，不能自动假定它失效。
- 本体已升级而某个 Agent 失败：命令报告部分成功并执行该 Agent 的恢复流程，不把用户数据库和其他成功更新一起回退。

服务器和 CI 配置见 [独立发行部署说明](deployment/standalone-distribution.md)。
