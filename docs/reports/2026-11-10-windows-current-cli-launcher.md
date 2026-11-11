# Windows 嵌套 Roll CLI 启动修复与验收

基线：`1ab21b98`；分支：`codex/windows-current-cli-launcher`。本次修复归属 Core，附 Core patch Changeset。没有修改 Runtime、Protocol 或 Desktop 产品源码，也没有推送、合并或正式发布。

## 实现

- `current-cli-shim.ts` 继续使用当前 Node、当前 CLI 入口和已有 execArgv 过滤/相对 preload 固定逻辑。Windows 所需文件统一写入原来的私有临时目录，环境恢复、退出清理与非 LIFO dispose 保持原有接口。
- `current-cli-windows.ts` 只对确认等价的规范盘符/UNC 路径转换命名空间。相对路径、点/空组件、尾部点或空格、DOS 设备名及其他命名空间不转换；可执行文件达到 MAX_PATH、固定参数含 Shell 特殊字符或 Unicode 时使用原生桥。
- CMD 源码保持 ASCII，避免改变用户代码页。桥接数据是固定启动参数的 Base64 JSON，未保存环境变量或用户调用参数。PowerShell 5.1 仅托管原生调用，不读取 `$args` 作为转发依据；从 `GetCommandLineW` 中取唯一边界后的原始命令行后缀，保留调用方已经完成的 Shell 解析。
- `CreateProcessW` 显式指定应用程序，规范普通长路径仅在语义等价时补充命名空间，已有命名空间原样保留。固定参数按 Windows native argv 规则引用，NUL 被拒绝。
- 通过受限 HANDLE_LIST 只继承复制的 stdin/stdout/stderr，不经过 PowerShell 文本管道。保留工作目录、调用环境中的 PATH/自定义值和子进程退出码。已有控制台保留 Ctrl+C；无控制台时不新建控制台。没有新增 Job Object、脱离进程组、父进程监控或进程树清理逻辑。
- CI 的现有 Windows shell job 增加两个回归文件。无新 npm 依赖、原生二进制分发或 Runtime/Protocol 契约变化。

路径语义依据：[Windows namespaces](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)、[长路径限制](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)、[PowerShell -File 规则](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)。仅凭去除前缀不能保证长路径可启动。

## 执行验证

| 检查 | 结果 |
| --- | --- |
| 工作区 `pnpm typecheck`、`pnpm lint` | 通过；最后的测试脚本调整另经 targeted ESLint / Prettier 检查 |
| Core 全量单测 | 2224 通过 / 9 跳过；包含 Windows 专用用例在 macOS 上的预期跳过 |
| Core E2E | 116 通过 / 0 失败 |
| `pnpm test:scripts` | 55 通过 / 10 跳过 / 0 失败 |
| Core build、隔离 HOME 的发布态 `agent health` | 通过；空注册表输出“暂无已注册 Agent” |
| 控制字符检查与变更格式检查 | 通过 |
| Windows ARM64 三个 CLI 测试文件 | 14 通过 / 2 个 POSIX 用例跳过 |
| Windows x64 三个 CLI 测试文件 | 14 通过 / 2 个 POSIX 用例跳过 |
| 扩展的环境/参数/标准流用例 | ARM64、x64 均 7 通过；PATH 和含中文/引号/百分号的自定义值保持一致 |

原生测试实际复制 Node 到超过 260 字符的位置，覆盖普通长路径及 namespaced 长路径；另外创建尾部点和空格的实际目录。x64 测试从真实 UNC 共享执行，还覆盖 UNC 命名空间大小写。参数包括首尾空字符串、空格、Unicode、嵌套引号、引号前反斜杠、尾部反斜杠、固定参数中的 `%PATH%`、Shell 元字符及类似 PowerShell 选项的字符串。stdin、stdout、stderr 各比较完整 64 KiB、包含全部 256 种字节的原始内容；退出码 7、真实 Ctrl+C 后退出码 130 均核对。

生命周期单测创建自己的隐藏控制台，向该控制台发送真实 Ctrl+C，不向用户终端发送信号。另一个用例按 wrapper PID 执行 taskkill，验证 Node 和孙进程结束、无关哨兵存活。

## 真实打包 Desktop

使用既有生产 ASAR/Main/preload/renderer 和私有官方 Node/Runtime，复制成独立开发测试包，只覆盖 Core 的两个构建 JS 文件。没有替换 renderer、注入 IPC 后门、改动安全 fuse 或修改旧安装包。开发覆盖包均标为 `LOCAL-DEVELOPMENT-CORE-SHIM-FIX-NOT-PUBLISHED`。

`scripts/validate-packaged-current-cli.mjs` 使用隔离 HOME/userData/config/history、系统 PATH、受控 loopback 模型。实际工具调用 `roll agent list --json`，解析空注册表后才输出验收标志；受控模型检查真实工具结果，严格核对两次请求。它也检查私有 shim 被实际解析，避免只验证 `--version` 或生成的脚本文本。

| 平台/路径 | 实际调用 | 生产界面停止 | 关闭正在执行的应用 |
| --- | --- | --- | --- |
| Windows ARM64，普通目录 | 通过 | 通过，随后关闭通过 | 中文目录下另测 |
| Windows x64，普通目录 | 通过 | 通过，随后关闭通过 | 通过 |
| Windows ARM64，中文目录 | 通过，原生桥实际存在 | 通过 | 通过 |
| Windows x64，中文目录 | 通过，原生桥实际存在 | 通过 | 通过 |
| macOS Apple Silicon，生产打包 App | Bash 工具嵌套调用通过 | 本次未重复整套 macOS UI 取消测试 | 正常完成后退出通过 |

中文目录让真实打包入口使用原生桥；不是用测试替身模拟该分支。生命周期用例经生产输入框和发送动作创建会话，让嵌套 `roll chat` 进入受控模型等待，再点击生产“停止”或关闭窗口。停止只结束已准入 PowerShell 工具子树，宿主 Runtime/应用继续存活；随后正常关闭应用，之前记录的 13 个应用及后代进程全部退出，独立哨兵存活。没有复制 Desktop 的 Job 生命周期管理。

Windows x64 是真实 x64 Electron/Node 二进制，PE machine 已核对为 `0x8664`，运行在 Windows 11 ARM64 的 x64 兼容层；ARM64 为 `0xaa64`。本次没有 Intel/AMD 实机或独立 x64 Windows OS 的结果。

prlctl 的 SYSTEM 隔离环境未发现 PowerShell 7。测试在私有目录解压官方 PowerShell 7.6.9 ARM64 便携包，并对照官方 `hashes.sha256` 验证 SHA-256：`2157fb002178e606c2a5532c56647118d90d029742f04d4900a71e3b478c2363`。只在测试子进程中指定私有 ProgramFiles 查找根，未改变系统安装、用户 PATH 或 Core 桥接器使用的内置 PowerShell 5.1。测试环境保留 PATHEXT/ComSpec；审批精确覆盖只存在于隔离 fixture 配置。

## 对照与独立发现

同一生产打包模板换回官方 Core 1.6.1 的旧 shim，在普通安装深度下仍出现真实嵌套 Roll 失败；修复后的普通路径和原生路径均通过。对照脚本输出 `BASELINE_OLD_CORE_NESTED_ROLL_FAILURE_CONFIRMED`。

额外将完整 Windows 包放到 Node 路径长度 267 的目录，发现进入 Core 前的 Desktop profile helper 启动失败。换回旧 Core 后仍同样失败，模型请求数为 0，输出 `BASELINE_DESKTOP_DEEP_PREFLIGHT_LIMITATION_CONFIRMED`。Owning source 是 Desktop 的 `src/main.ts` helperCommand 接线与 `src/profile-discovery.ts:156` 的直接 spawn；这项前置问题不在本次 Core 修复中解决。不能把 Core 的长可执行路径验收扩大成“整个 Desktop 任意深目录安装已通过”。

测试开发中纠正了路径大小写比较、x64 映像退出后的临时目录清理重试，以及关闭窗口时 CDP 执行上下文销毁的预期竞态。停止验收按实际工具根划定边界，保留宿主 Runtime 自己的 conhost；最终关闭仍检查全部后代退出。没有通过忽略进程或放宽实际参数/字节断言获得通过。

## 影响与自检

仓库为 `roll-agent`，工作目录是 nano-agent 当前 checkout。GitNexus 增量索引最初遗漏函数，全量刷新后恢复；`installCurrentCliShim → createChatCliScope → Chat/server/runtime serve` 的共同调用范围已核对，预编辑风险 HIGH 已报告。新增适配器只有一个直接 Core 调用方。scope=all 分析没有 partial/truncated 标记；图谱未列出受影响 process 不作为没有行为影响的证明。进程内的 C# 原生行为以实际 Windows 测试为依据。

自检覆盖：路径不等价时保留原名；CMD 固定文本不嵌入 Unicode；动态用户参数不参与 PowerShell 代码求值；只传标准句柄；辅助句柄全部关闭；当前 Node/入口/execArgv 固定；退出与取消保持既有所有权；POSIX 分支与公共接口保持一致。Runtime/Protocol 与 Desktop 源码 diff 为空。

同一提交的增量索引曾使 compare/main 报告 469 条流程 / CRITICAL，同时 context 查不到实际存在的 `installCurrentCliShim`。保持源码不变全量重建后，CLI 与 MCP 的 compare/main 均为 11 文件、87 符号、0 条列出流程 / low。该不一致属于本次工具证据的局限；不将任一风险评级直接当作产品行为结论。

## 本地证据与产物

证据目录：`Roll-Desktop-Test/2026-11-10-cli-shim-fix/`，其中 `evidence/` 保存最终日志、实际工具结果和操作前进程树；`selected-cases.json`、`baseline-comparison.json`、`verified-windows-binaries.json`、`build-info.json` 保存对应关系与哈希。旧用户安装、配置、历史和原有交付包保留。

两个覆盖文件的 SHA-256：

```text
current-cli-shim.js    c151a63c10e7329f6cb308fd7d01679fca6a6cb4d538d2e76cbd7ac112c36341
current-cli-windows.js 8743d5f9c9d92ee78253978856070bebfae5ec065b2d56a15f1b1625f612216a
```

Windows ASAR 为 `ff1333af913a3d560e0cc011b5b7320c7ce8236d13a2598f441b9c26b20a5cfc`；macOS ASAR 为 `23103d1a8d846729c8789fe32b96f2cc3cd6ab3bf4eb2a9a0619de4d5f843fc2`，均与模板相同。macOS 开发副本重新 ad-hoc 签名且 strict/deep 校验通过；不是公证或正式发布。

复跑打包验收：

```sh
node scripts/validate-packaged-current-cli.mjs '<packaged executable>' '<new isolated root>' normal
node scripts/validate-packaged-current-cli.mjs '<Windows packaged executable>' '<new isolated root>' cancel
node scripts/validate-packaged-current-cli.mjs '<Windows packaged executable>' '<new isolated root>' close
```

缺少系统 PowerShell 7 的测试环境可只为该子进程指定 `ROLL_VALIDATION_PWSH_ROOT`，指向包含 `PowerShell/7/pwsh.exe` 的私有根。fixture 不安装工具或修改持久环境。

## 审查跟进修订（2026-11-11）

上述打包验收与覆盖文件 SHA-256 对应 `82dc0d02` 快照。代码审查后在同一分支追加了最小防御补丁（不改变发布架构或公开契约）：`current-cli-shim.ts` 为临时目录删除补充 Windows 短重试与 best-effort 异常兜底（防止瞬态句柄锁中断上游清理链）并过滤空白 `SystemRoot` 回退；`current-cli-windows.ts` 在 `DOS_DEVICE` 中补入 `CONIN$` / `CONOUT$`；`scripts/validate-packaged-current-cli.mjs` 为进程树深度计算增加防环保护；`docs/windows-compatibility.md` 记录了中文/超长路径下 `Add-Type` 的编译开销与企业 `ConstrainedLanguage` 边界。
