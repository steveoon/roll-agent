---
"@roll-agent/runtime": minor
"@roll-agent/core": minor
---

新增 `ShellProfile` 抽象并落地 Windows 原生 PowerShell 7 one-shot 支持。

- macOS/Linux 继续使用 POSIX profile，工具名保持 `roll__bash`，审批 key 保持 `roll.bash`，session exec 继续只在 POSIX 注册。
- Windows 只在检测到 `pwsh` 主版本 >= 7 时注册 `roll__powershell`，审批 key 为 `roll.powershell`；探测会把 PATH 与标准 Program Files 中完整限定的候选解析并缓存为绝对 `pwsh.exe`，拒绝 cwd/相对 PATH 候选。候选按顺序惰性检查，首个通过即停止，版本探测共享 5 秒总预算。未检测到或版本过低时跳过注册并提示安装 `Microsoft.PowerShell`。
- PowerShell 命令通过 `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand` 执行，`EncodedCommand` 使用 UTF-16LE base64，审批 UI、分类器和日志仍展示编码前明文命令；wrapper 显式设置 UTF-8 输出，并把 cmdlet 错误与 native `$LASTEXITCODE` 传播为真实退出码。
- Windows one-shot 不启用 detached 进程组，超时/中止使用 `SystemRoot\\System32\\taskkill.exe /PID <pid> /T /F` 清理进程树；`taskkill` 启动失败、非预期退出或超时会触发根进程强制终止兜底（退出码 128 视为目标进程已退出的正常竞速，不触发兜底），清理仍无法确认时会返回明确错误且不无限等待。PowerShell 命令本批全部分类为 `unknown`，默认过确认门；显式 `roll.powershell` approval override 仍优先。
- 过长的 PowerShell `EncodedCommand` 会在 spawn 前返回清晰错误，避免落到含糊的 Windows 命令行长度失败。
- 配置 canonical 字段从 `runtime.bash` 迁移为 `runtime.shell`，迁移器支持自动改名、camelCase/kebab-case 语义等值双写删除 legacy、冲突双写阻塞，段内等值别名会在迁移时去重为单一键；`roll config setup shell` 成为新命令，`roll config setup bash` 保留兼容 alias。所有 setup 入口会在读取业务输入前提示先完成已知 breaking migration，避免输入到最后一步才被丢弃。
- Windows 下 `roll config setup shell` 只引导 one-shot 开关，不再询问当前不会生效的安全命令自动放行和 session exec 选项。
- CI 新增 `windows-latest` shell smoke，覆盖 profile 选择、PowerShell one-shot、配置迁移和 engine 注册。
