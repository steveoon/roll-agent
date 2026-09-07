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

## 后续 CI 与服务器准备（2026-09-07）

上述表格记录最初的本机检查。后续六个平台的构建、安装器回归、原生 A→B 升级和产物汇总均已通过，见 [独立发行 CI](https://github.com/steveoon/roll-agent/actions/runs/34102293433)。Artifact Actions 已升级到固定 SHA 的 Node 24 版本；Node 20 弃用警告已消失。依赖布局优化后，本机 macOS arm64 发行包从 77,546 个文件降至 18,706 个文件，压缩大小从约 104.1 MiB 降至 64.7 MiB。

服务器准备已通过 `ssh aliyun-server` 完成：

- 新建 `/var/www/roll-distribution`，由专用 `roll-dist` 用户管理。`staging` 为 0700，`releases` 为 0755；未创建 stable 指针或发布任何发行版本。
- 既有 HTTPS server 新增 `/etc/nginx/snippets/roll-distribution.conf` include；原 Next.js 反向代理、证书和日志配置保留。原站点配置备份位于服务器 `/root/roll-distribution-backups/20260907-TB7ieS8X/roll-website.conf`。
- `nginx -t`、reload、网站首页和现有静态资源检查通过。使用专用账号 SFTP 上传的临时文本经真实 HTTPS 读取后内容一致；版本资源返回一年缓存头，并保留既有安全响应头。探针随后清理，重新请求返回 404。
- 部署公钥及其父目录由 root 管理，公钥带 `restrict` 限制；已验证专用账号可以写发行目录，但不能修改 Nginx 或公钥限制文件、不能读取 TLS 私钥，PTY 请求被拒绝。CI 不使用管理员密钥。
- 五项 `ROLL_DIST_SSH_*` secrets 已配置，host key 通过既有可信 SSH 连接核对；本地临时私钥已删除。`ROLL_DISTRIBUTION_ENABLED` 明确设为 `false`。
- 首个正式发行版尚未发布，`/install.sh`、`/install.ps1`、`/releases/stable/manifest.json` 当前预期返回 Nginx 404。

服务器只接收 Nginx 配置、运维引导脚本、公钥和临时文本探针；未上传 Roll 应用源码，也未在服务器运行源码构建或 Linux 测试。

## 尚未完成的线上步骤

- 合并功能 PR，创建或更新 Release PR；确认首发条件后开启部署开关，再通过正式 release 流程发布完整版本 A。
- 在无 Node/npm 环境从真实域名安装版本 A，安装并调用真实 npm Agent，核对私有解释器与所需外部依赖。
- 发布不同的正式版本 B，验证 `roll update`、数据保留、故障恢复及已配置后台服务的版本切换。CI 的合成版本和 fixture Agent 不能替代这项线上验收。

构建、CI 和服务器操作见 [独立发行部署说明](standalone-distribution.md)。

## Review 后补充验证

针对工作区 Review 的修复再次验证：Core 1676 项通过、3 项跳过；安装/更新/doctor/生命周期 E2E 34 项通过；本次发布门禁、端口、安装器和归档脚本测试 9 项通过、2 项平台跳过。Core typecheck、构建后的 CLI health、相关 lint/format 和 ShellCheck 通过。

- 真实子进程 SIGINT/SIGTERM 中断下载：旧版本不变，scratch 和锁被清理，退出码为 130/143；随后能重新取得锁。
- 预检子进程延迟处理 SIGTERM：父操作等待其关闭后才返回，避免过早释放资源。
- 锁所有权被替换时拒绝删除；owner.json 提供 PID 和创建时间用于诊断，不据此自动打破锁。
- Core 版本不变时发布门禁不访问下载服务器；新版本缺失时构建，已存在完整版本时跳过，查询失败或不完整时拒绝猜测。
- 非法 SSH 端口在读取 publication、凭据或发起 SSH 前退出。
- npm/standalone 版本查询失败均报告跳过；doctor 在全局参数前置时仍可输出损坏安装的诊断。

Linux finalize 的重复 staging 清理已补回归断言，并在后续 Linux 原生 CI 中通过。Nginx 缓存配置采用 expires，避免遮蔽继承的安全头；后续服务器准备的实际结果见上方记录，正式版本仍未部署。
