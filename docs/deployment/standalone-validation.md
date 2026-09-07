# 独立发行本地验证记录

日期：2026-09-07。环境：macOS arm64，Node 24.18.0，pnpm 11.24.0（本次临时工具链，未替换全局安装）。这些结果对应本次工作区实现，不能代替合入后的六平台 CI 或线上验收。

| 验证 | 结果 |
| --- | --- |
| Core 单元/集成测试 | 1670 通过，3 跳过，0 失败 |
| 安装、更新、配置迁移、共享 Agent 生命周期 E2E | 32 通过 |
| POSIX 安装器、重复安装、恶意 PATH、损坏归档和互斥锁 | 5 通过；Windows 执行测试留给 CI |
| 六平台元数据、Core 转发模块身份、确定性归档 | 本地通过；Linux 服务器发布测试留给 CI |
| Core/UI typecheck、相关 ESLint、Prettier、ShellCheck、依赖 denylist | 通过 |
| macOS arm64 独立发行构建 | 通过 frozen lockfile 和依赖策略检查；约 104 MB 压缩包 |
| 脱离仓库加载 | 私有官方 Node/npm、CLI、Runtime 实际加载、SQLite、UI 文件和 ripgrep 均通过 |
| 原生 A→B 升级 | 通过；npm lifecycle、Agent 本体和 Node 子进程均使用 B 的私有解释器，用户数据保留 |
| 真实 npm registry 安装 | 在隔离 HOME、无系统 Node/npm 的 PATH 下成功安装官方 browser-use-agent；未启动 Agent，未配置业务凭据 |

原生升级使用本地 fixture registry 和测试版本 A=0.36.1、B=0.36.2。B 由同一构建改写版本元数据生成，用于验证安装与更新机制，不代表已经发布这些版本，也不证明未来版本的数据迁移兼容性。请求改写仅存在于测试入口，生产下载源仍固定为 `https://roll.duliday.com`。

该测试曾暴露 Runtime 反向引用 Core 在独立目录中无法解析的问题；已通过无链接的 ESM 转发模块修复，并重跑原始升级反例。转发模块保留原始 Core 模块身份，避免执行环境上下文出现两份实例。

## 尚未完成的线上步骤

- Linux、Windows 和其他 CPU 架构需在六平台原生 CI 上通过；未向 aliyun-server 上传源码运行测试。
- 当前仅只读检查了服务器：域名已有 Nginx/Next.js 网站，SSH 使用非默认端口，独立发行路由和部署用户尚未配置。
- GitHub 的独立发行 SSH secrets 尚未配置；`ROLL_DISTRIBUTION_ENABLED` 未启用。现有 npm 发布流程保留，分支 CI 不部署生产。
- 需在代码提交后运行 CI，准备受限发布用户与 Nginx 路由，再由正式 release 流程发布完整版本。真实在线 URL 安装及第二个正式版本升级尚未验收。

构建、CI 和服务器操作见 [独立发行部署说明](standalone-distribution.md)。

## Review 后补充验证

针对工作区 Review 的修复再次验证：Core 1676 项通过、3 项跳过；安装/更新/doctor/生命周期 E2E 34 项通过；本次发布门禁、端口、安装器和归档脚本测试 9 项通过、2 项平台跳过。Core typecheck、构建后的 CLI health、相关 lint/format 和 ShellCheck 通过。

- 真实子进程 SIGINT/SIGTERM 中断下载：旧版本不变，scratch 和锁被清理，退出码为 130/143；随后能重新取得锁。
- 预检子进程延迟处理 SIGTERM：父操作等待其关闭后才返回，避免过早释放资源。
- 锁所有权被替换时拒绝删除；owner.json 提供 PID 和创建时间用于诊断，不据此自动打破锁。
- Core 版本不变时发布门禁不访问下载服务器；新版本缺失时构建，已存在完整版本时跳过，查询失败或不完整时拒绝猜测。
- 非法 SSH 端口在读取 publication、凭据或发起 SSH 前退出。
- npm/standalone 版本查询失败均报告跳过；doctor 在全局参数前置时仍可输出损坏安装的诊断。

Linux finalize 的重复 staging 清理已补回归断言，但其实际执行仍需 Linux CI。Nginx 缓存配置已改为 expires，避免遮蔽继承的安全头；本次没有修改线上 Nginx 或部署任何版本。
