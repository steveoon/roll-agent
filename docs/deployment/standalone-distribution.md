# 独立发行包的构建和发布

Roll 的 npm 包和独立发行包来自同一 release commit。独立包携带 Node 24.18.0、对应 npm、Core 构建产物、生产依赖、UI 和平台 ripgrep；开发继续使用根 `packageManager` 指定的 pnpm。更新运行时时必须提升 Core 版本，不能覆盖既有发行资产。

## 构建与验证

使用 Node 24.18.0 和仓库指定 pnpm，在目标平台运行：

```sh
pnpm install --frozen-lockfile
pnpm --filter '@roll-agent/core...' run build
node --test 'scripts/distribution/*.test.mjs'
node scripts/distribution/build.mjs /tmp/roll-assets
```

构建阶段需要 Python 3（只用于确定性压缩）、平台解压工具和访问 Node 官方下载站及 npm registry。构建器在隔离工作区执行 `pnpm --config.inject-workspace-packages=true deploy --prod --frozen-lockfile`，保留仓库冷却期、依赖补丁和构建脚本限制；元数据缓存不足时允许访问 registry，不能去掉锁文件或供应链校验。禁止使用 legacy deploy（pnpm 11.24 的该分支会关闭 frozen 检查）。部署树再被复制为无符号链接的目录，所有包的发布入口采用 `publishConfig`。Runtime 反向引用 Core 的子路径通过 ESM 转发模块解析到唯一的 Core 文件，避免复制 Core 导致执行环境上下文分裂。构建烟雾测试实际加载 Runtime，不能只解析它的文件路径。

`node-checksums.json` 保存从 Node 官方 `SHASUMS256.txt` 核对的六个平台 SHA-256。下载不接受重定向，包内保留 Node/npm 许可证。更新该文件需要重新核对官方来源、Node 平台下限和六平台烟雾测试。

构建器在仓库外使用隔离 HOME 和受限 PATH 执行 Node、npm、CLI health、SQLite、UI 文件和 ripgrep 检查。CI 使用六个原生 runner，所有产物成功后才生成统一 manifest 和平台 TSV；Windows 压缩包不依赖符号链接权限。runner 标签参考 [GitHub 官方 runner 清单](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

这组烟雾测试不替代安装器、Agent lifecycle、升级维护锁和后台服务的集成测试。不能把 macOS 本机通过视为其余五个平台已经通过，也不能把纯静态 Nginx 检查视为线上安装成功。

## 首次配置服务器

在管理员会话中核对目标 HTTPS server，保留现有网站反向代理、证书和安全响应头。服务器主机名、SSH 别名、端口、用户名、真实目录及备份位置只记录在仓库之外的私有运维记录中，不写入公开文档、测试或 PR 正文。

由管理员选择专用发行根目录，并通过私有配置提供 `ROLL_DIST_ROOT`。它必须是规范的绝对路径，至少包含两级目录，路径组件只能含 ASCII 字母、数字、下划线、连字符和非前导点；不接受空格、相对路径、`.` / `..`、重复斜杠或符号链接路径。根目录内预先创建 `staging` 和 `releases`，并写入内容为 `roll-distribution-v1` 的 `.roll-distribution-root` 标记文件。专用非 root 用户只需该发行区域的写权限，不需要网站配置、证书或 sudo 权限。Nginx 用户需要读取发行文件及遍历目录的权限；staging 不应公开。服务器运行发布脚本只需 SSH/SFTP、POSIX shell 及 GNU coreutils/find/diff/awk。

`scripts/distribution/nginx.conf` 是模板，不能直接 include。先在有 Node 的管理员工作站从私有配置加载 `ROLL_DIST_ROOT`，然后生成仓库之外的配置文件：

```sh
node scripts/distribution/render-nginx.mjs /path/outside/checkout/distribution.conf
```

生成器拒绝不安全的根路径、仓库内输出（包括经目录链接指向仓库）和覆盖现有文件，并将输出权限设为 0600。管理员通过安全通道将文件安装到自行选择的 Nginx 配置位置，在既有 HTTPS server 中 include；先执行 `nginx -t`，通过后再 reload。具体安装与备份路径保存在私有运维记录中。CI 发布用户不执行 Nginx 管理命令。

在仓库 Actions secrets 配置：

| 名称 | 内容 |
| --- | --- |
| `ROLL_DIST_SSH_HOST` | 服务器 DNS 名或 IPv4 |
| `ROLL_DIST_SSH_USER` | 只能写发行目录的专用用户 |
| `ROLL_DIST_SSH_KEY` | 对应该用户的 SSH 私钥 |
| `ROLL_DIST_SSH_KNOWN_HOSTS` | 从可信运维渠道核对的服务器 host key 行 |
| `ROLL_DIST_SSH_PORT` | 可选 SSH 端口，默认 22；实际值保存在 Secret 中 |
| `ROLL_DIST_ROOT` | 必填；管理员预先创建并标记的规范发行根目录 |

配置就绪后，将仓库 Actions variable `ROLL_DISTRIBUTION_ENABLED` 设为 `true` 才会执行服务器发布。未启用时仍运行六平台构建验收，保留原有 npm 发布流程。`distribution.yml` 也支持手动运行，默认只验证；手动发布还需选择 `publish=true`。

不能在 CI 中用未验证的 `ssh-keyscan` 输出建立信任。服务器 SSH key 应关闭 agent/X11/端口转发和 PTY。首次部署需要运维人员完成目录权限和 Nginx 配置；仓库脚本不会自动修改现有线上服务器。

## 原子发布与失败处理

`release.yml` 在 npm OIDC 发布成功后先运行轻量门禁：只有本次 main 提交相对第一父提交改变了 Core 版本、且线上尚无该版本的完整六平台 manifest，才调用 `distribution.yml`。docs-only 或仅更新 Agent 的提交不重建 Core；成功发布后的工作流重试也不重复构建。线上查询发生非 404 错误或 manifest 不完整时门禁失败，避免把未知状态当作需要重建。失败版本仍可通过原提交重跑或手动工作流恢复。构建 job 没有 SSH credentials；assemble job 校验六个平台后上传完整 publication artifact；只有最后的 deploy step 读取 SSH secrets，且不安装依赖或执行构建。现有 GitHub Release job 保留。

CI 上传到唯一 `staging/<run-id>-<attempt>`。`finalize.sh` 在服务器取得互斥目录锁，拒绝链接、未知文件数量和非法路径，核对所有 SHA-256 及平台 TSV，再把完整目录移入 `releases/<version>`。最后原子替换 `releases/stable` 符号链接，脚本、manifest 和平台索引同时切换。过期 CI 运行不能降级 stable。

发布后的路径为：

```text
/install.sh
/install.ps1
/releases/stable/manifest.json
/releases/stable/<platform>.txt
/releases/<version>/roll-<version>-<platform>.tar.gz 或 .zip
```

安装脚本和 stable 路径通过 `expires -1` 设置 `Cache-Control: no-cache`；版本资产使用 `expires 1y` 设置一年缓存。location 不定义 `add_header`，因此继承 server 级的 HSTS 等安全响应头，参见 [Nginx headers 模块](https://nginx.org/en/docs/http/ngx_http_headers_module.html)。版本 URL 仍不可变，但不额外追加 `immutable` 指令以免破坏安全头继承。v1 使用 HTTPS 信任发行服务器并以清单 SHA-256 验证资产，没有额外客户端签名信任根，不能宣称可抵抗发行服务器失陷。

六平台构建失败不会移动 stable。相同版本再次上传必须逐文件相同，校验一致后删除本次重复 staging；失败 staging 保留供排查。不同 commit 或工具链产生不同资产应提升 Core 版本。失败 staging 目录保留供排查，不能把不完整 staging 指向 stable。只有确认没有发布进程后，运维才可以移除遗留 `.publish-lock`；CI 不自动打破未知锁，也不清理旧发行版本。

## 上线验收

先确认网站根路由行为不变、缺失 `/releases/...` 返回 404、脚本返回纯文本、TLS 和缓存头正确。然后在六个平台的无 Node/npm 环境从真实 HTTPS URL 安装版本 A，安装并调用真实 npm Agent。发布不同版本 B 后运行 `roll update`，核对 CLI、Agent 和已配置后台服务的实际解释器及版本。

记录每个平台的安装、升级和故障恢复结果。缺少 SSH secrets、服务器路由或第二个已发布版本时，应报告上线验收未完成，不能把生成工作流视为真实闭环已完成。
