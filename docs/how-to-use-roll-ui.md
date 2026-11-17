# 使用 `roll ui` 配置 Roll

`roll ui` 是 Roll CLI（`@roll-agent/core`）按需启动的本地 Web 配置台：它直接读写 `roll.config.yaml` 并管理本机配套服务，不依赖也不挂载到任何子 Agent。

## 启动

```bash
roll ui
```

默认行为：

1. 按 `--config` 指定路径 → 从当前目录向上逐级查找 `roll.config.yaml` / `roll.config.yml` → 查找 `~/roll.config.yaml` / `~/roll.config.yml` 的顺序定位现有配置；若均不存在，则默认以 `~/roll.config.yaml` 作为目标文件。
2. 仅在 `127.0.0.1` 的随机端口启动临时 HTTP 服务。
3. 生成随机路径和一次性认证 token，并尝试在默认浏览器自动打开。
4. 当前终端收到 `Ctrl+C` / `SIGTERM` 后立即关闭服务。

不自动打开浏览器时：

```bash
roll ui --no-open
```

显式指定配置文件时：

```bash
roll ui --config ./roll.config.yaml
```

## 核心功能分区

### 配置表单与 YAML 编辑

左侧导航的 `ROLL CORE` 与 `SUBAGENT ENV` 分区分别展示 Roll 全局配置模块和已注册子 Agent 的环境变量（根据 Agent 的 `references/env.yaml` 生成），支持通过顶部搜索框（`⌘/Ctrl + K`）按用途、配置名或 key 快速定位字段，也可在右上角切换至 `YAML` 模式直接编辑原始配置文本。

### ChatGPT 订阅授权

在 `llm` 或 `runtime` 配置模块顶部集成了 ChatGPT 订阅账号面板。点击 **Continue with ChatGPT** 可在系统浏览器中完成 OpenAI OAuth 登录授权，支持查看多账号连接状态、刷新或退出账号，并直接选择订阅账号与可用模型。选定模型后需通过「审阅并保存」写入 `runtime` 配置，才会对后续 `roll chat` 和定时任务生效（仅选择账号不会切换模型服务；OAuth 凭证仅由本机后端保存，不返回前端）。

### 定时任务管理

左侧导航提供「定时任务管理」分区，对应 `roll schedule` 的三个核心层级：

- **服务卡片**：展示开机自启服务的安装 / daemon 运行状态、数据目录、下次唤醒时间与固化二进制是否过期，可直接安装、重启（有任务正在执行时会拒绝并说明原因；`--force` 仅在 CLI 提供）与卸载（需确认）。
- **任务列表**：展示每个任务的执行间隔、下次运行时间、上次错误与运行中标记，可逐个暂停或恢复（恢复时会按当前配置重新授权）。
- **最近运行**：跨任务合并展示最近运行记录，包含状态、尝试次数、耗时与可展开的失败原因；排队中的记录可直接取消，运行中的记录提供「终止并取消」（等价于 `roll schedule cancel --kill`，需确认；`--abandon` 仅在 CLI 提供）。

面板顶部会对需要处理的异常状态给出醒目提示（如存在 active 任务但未安装服务、上次安装或更新未完成、二进制过期、daemon 未运行等）。新建、编辑和删除任务仍通过 CLI（`roll schedule add / remove`）完成；面板数据采用手动刷新，不做后台轮询。该面板通过 `/api/schedule/*` 路由通信，鉴权与 CSRF 约束与其余 API 一致；若 controller 初始化失败，该分区会自动隐藏并在终端 `stderr` 输出警告。

### Companion 远程连接管理

在支持 Companion 的平台（macOS / Windows）上，左侧导航提供「Companion 管理」分区（对应 `roll companion`），可在页面中填入配对码与工作区绝对路径完成设备绑定（enroll）或解绑、调整默认工作区目录、安装或卸载后台服务、执行启动 / 停止 / 重启 / 启用 / 禁用等生命周期操作，以及运行健康检查（doctor）与查看实时日志。

## 保存与生效

保存配置前，右侧审阅面板会展示：

- Zod schema 校验结果；
- 相对磁盘当前文件的字段差异；
- 保存后需要立即重启服务、下次命令生效或人工迁移的项目。

| 运行时所有权 | 配置保存后的处理 |
| --- | --- |
| `core-managed` 且保存前正在运行 | 用户确认后由 Roll 停止、重启并检查就绪状态 |
| `core-managed` 且保存前已停止 | 保持停止，不擅自启动 |
| `on-demand` | 下次调用该 Agent 时自动读取新配置 |
| `external-managed` | 只给出人工重启提示，不操作外部进程 |
| `agents.data-dir` 等迁移型变更 | 只给出人工步骤，不自动搬迁数据 |

配置写回采用 revision 乐观并发控制：若文件在预览与保存之间被外部程序修改，保存请求会被拒绝。修改已存在的配置文件时会先创建备份，再通过临时文件、`fsync` 与原子替换提交写入，同时完整保留原有注释、字段顺序、引号风格和 `${ENV_VAR}` 占位引用；新建配置文件不产生备份。

自动重启 `core-managed` Agent 时不会仅凭 PID 发送信号。Roll 在启动托管进程时会将操作系统进程启动身份写入 runtime sidecar，停止前同时核对 `PID + processStartToken + startedAt`；一旦身份缺失、来自旧版 sidecar 或发生不匹配，一律拒绝发送信号并转为人工处理提示（Linux 核对 boot ID 与 `/proc` starttime，macOS 核对固定 locale 的进程启动时间与 boot time，Windows 核对进程启动时间 ticks）。

## 安全边界与限制

### 安全边界

- 服务仅绑定 IPv4 loopback（`127.0.0.1`），不监听局域网或公网地址，不支持 `0.0.0.0`、常驻守护或远程控制台暴露。
- 随机路径和一次性引导 token 仅保存在内存中；token 置于 URL fragment 内，不会随首个页面请求发往服务器，且兑换一次即失效。
- 认证完成后使用随机名称、随机 `Path`、`HttpOnly`、`SameSite=Strict` 的会话 cookie，所有写请求均强制校验 CSRF token。
- 服务端严格校验 `Host`、`Origin`、Fetch Metadata、CSP、请求体大小与请求超时，不启用 CORS。
- 已声明为 secret 的字段以及未在 `references/env.yaml` 中声明的 Agent 环境变量均按敏感值脱敏处理，UI 接口不返回原始明文。
- Agent 停止、重启与 runtime 元数据清理均校验完整进程身份，避免在 PID 被其他进程复用时误杀无关进程。

### 不覆盖的场景

- YAML 语法本身损坏无法解析时，配置台不会把无法可靠脱敏的原文发往浏览器，请先使用本地编辑器修复语法。
- 若需用全新模板覆盖已损坏的配置文件，请在终端运行独立的 `roll config init` 恢复入口（经人工确认后写入完整校验模板并保留原文件备份；Web UI 不开放此覆盖能力）。
- 当 YAML 语法合法但 Zod schema 校验未通过时，配置台会进入 `REPAIR MODE`，允许在安全脱敏的前提下修正配置并保存。
- Chrome 启动参数等进程级配置不支持热更新，界面会明确标注重启或下次启动后生效。
- 子 Agent 内部自行读取、但未在 `references/env.yaml` 中声明的环境变量不会自动出现在表单中。
- 旧版不含 `processStartToken` 的 runtime sidecar 会触发 fail-closed 保护：需先用系统工具核实并手动停止对应 PID，再运行 `roll doctor --fix` 清理残留元数据。
- 纯用户态零依赖实现仍存在极小的“复核启动身份 → 按 PID 发信号”系统调用时间窗竞态；若要彻底消除，需依赖操作系统级的 `pidfd`、稳定的 Windows 进程句柄或带认证的进程控制通道。

## 附：配置字段扩展维护约定（面向贡献者）

### 配置来源与复用关系

```text
rollConfigSchema ───────────┐
                            ├─> 配置目录 ─> React 表单
Agent references/env.yaml ──┘

roll config set/setup/migrate/init ─┐
roll ui 表单/YAML 编辑 ──────────────┼─> ConfigApplicationService ─> YAML AST 写回
其他内部配置写入 ────────────────────┘
```

| 配置类型 | 主数据源 | 新增普通字段时需要修改 |
| --- | --- | --- |
| Roll 全局配置 | `packages/core/src/config/schema.ts` 的 `rollConfigSchema` | 修改 Zod schema；key codec、默认值和 Web 字段树会自动派生 |
| 子 Agent 环境变量 | Agent 的 `references/env.yaml` | 增加 env 声明及 `type`、`secret`、`configurable` 等元数据；已注册 Agent 需通过更新或重新注册刷新声明快照 |
| CLI / Web 的校验与写回 | `validateConfigText()` + `ConfigApplicationService` | 通常无需为同一字段分别实现两套写回逻辑 |

表单目录和 YAML key codec 都通过 schema 递归生成，`DEFAULT_CONFIG` 也由最小 seed 经过 `rollConfigSchema.parse()` 生成。因此，带默认值或可选的普通字段不需要再维护一份 Web/CLI 字段清单；新增没有 schema 默认值的根级必填段时，仍需补 `DEFAULT_CONFIG_SEED`。

CLI 与 Web UI 共用 key 编码、Zod 校验、乐观并发检查和无损写回能力，但读取视图各有侧重：`roll config get` 和运行时走 `loadConfig()`，读取合并默认值、解析环境变量并展开路径后的 effective config；Web UI 走 `ConfigApplicationService`，读取未展开路径、未解析环境变量且已脱敏的 persisted config。

### 需要显式维护的语义 overlay

以下规则表达的是安全、生效或迁移语义，无法仅靠 Zod 结构自动推断，新增具有对应语义的字段时需同步维护：

| 语义 | 维护位置 | 何时需要修改 |
| --- | --- | --- |
| secret 判定 | `config/secret-policy.ts` 的 `isRollConfigSecretPath()` | 新字段包含 token、密码、认证 URL 等敏感值 |
| Web 表单只读 | `config/edit-policy.ts` 的 `isRollConfigReadOnlyPath()` | 字段改动需要人工迁移数据（如 `scheduler.data-dir`），表单只展示当前值并引导走 CLI；YAML 编辑与 CLI 不受限，由生效提示兜底 |
| 生效方式 / effect | `config/application-service.ts` 的 `describeActivation()` | 保存后需要重启 Agent、重启 scheduler service、新会话或人工迁移 |
| `~/` 路径展开 | `config/loader.ts` 的 `expandPaths()` | 新字段在 effective config 中应展开用户目录 |
| breaking migration | `config/migration.ts` 的迁移规则 | 删除、重命名或改变已有字段语义 |
| 友好说明 | `config/guidance.ts` | 新增或重命名配置叶子时必须补标题、用途、默认行为和 YAML 示例；Web UI 与 `roll config explain` 共用，完整性由 catalog 测试守护 |
| CLI curated surface | `config-setup.ts`、`config init` 模板、`doctor` | 希望进入交互向导、初始化模板或专项诊断；通用 `config get/set` 不需要字段清单 |

简言之，“无需维护两套”适用于字段结构、key 编码、校验和通用写回，而安全脱敏、进程生效、配置迁移及交互向导仍需显式声明。
