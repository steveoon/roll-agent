# 使用 `roll ui` 配置 Roll

`roll ui` 是 `roll-core` 按需启动的本地配置台：它直接编辑 `roll.config.yaml`，不依赖也不挂载到任何子 Agent。

## 启动

```bash
roll ui
```

默认行为：

1. 按 `--config` → 从当前目录向上查找 `roll.config.yaml` / `roll.config.yml` → `~/roll.config.yaml` 的顺序确定目标文件。
2. 仅在 `127.0.0.1` 的随机端口启动临时 HTTP 服务。
3. 生成随机路径和一次性认证 token，并尝试在默认浏览器打开。
4. 当前终端收到 `Ctrl+C` / `SIGTERM` 后关闭服务。

不自动打开浏览器时：

```bash
roll ui --no-open
```

显式指定配置文件时：

```bash
roll ui --config ./roll.config.yaml
```

## 配置来源与复用关系

```text
rollConfigSchema ───────────┐
                            ├─> 配置目录 ─> React 表单
Agent references/env.yaml ──┘

roll config set/setup/migrate/init ─┐
roll ui 表单/YAML 编辑 ──────────────┼─> ConfigApplicationService ─> YAML AST 写回
其他内部配置写入 ────────────────────┘
```

| 配置类型 | 主数据源 | 新增普通字段时需要修改 |
|---|---|---|
| Roll 全局配置 | `packages/core/src/config/schema.ts` 的 `rollConfigSchema` | 修改 Zod schema；key codec、默认值和 Web 字段树会自动派生 |
| 子 Agent 环境变量 | Agent 的 `references/env.yaml` | 增加 env 声明及 `type`、`secret`、`configurable` 等元数据；已注册 Agent 需通过更新或重新注册刷新声明快照 |
| CLI / Web 的校验与写回 | `validateConfigText()` + `ConfigApplicationService` | 通常无需为同一字段分别实现两套写回逻辑 |

表单目录和 YAML key codec 都通过 schema 递归生成，`DEFAULT_CONFIG` 也由最小 seed 经过 `rollConfigSchema.parse()` 生成。因此，带默认值或可选的普通字段不需要再维护一份 Web/CLI 字段清单；新增没有 schema 默认值的根级必填段时，仍需补 `DEFAULT_CONFIG_SEED`。

CLI 与 Web UI 共用 key 编码、Zod 校验、乐观并发检查和无损写回能力，但不会强行共用同一种读取视图：`roll config get` 和运行时走 `loadConfig()`，读取合并默认值、解析环境变量并展开路径后的 effective config；Web UI 走 `ConfigApplicationService`，读取未展开、未解析环境变量且已脱敏的 persisted config。

### 需要显式维护的语义 overlay

这些规则表达的不是字段结构，无法只靠 Zod 自动推断；新增具有对应语义的配置时需要同步维护：

| 语义 | 维护位置 | 何时需要修改 |
|---|---|---|
| secret 判定 | `config/secret-policy.ts` 的 `isRollConfigSecretPath()` | 新字段包含 token、密码、认证 URL 等敏感值 |
| 生效方式 / effect | `config/application-service.ts` 的 `describeActivation()` | 保存后需要重启 Agent、新会话或人工迁移 |
| `~/` 路径展开 | `config/loader.ts` 的 `expandPaths()` | 新字段在 effective config 中应展开用户目录 |
| breaking migration | `config/migration.ts` 的迁移规则 | 删除、重命名或改变已有字段语义 |
| 友好说明 | `config/guidance.ts` | 新增或重命名配置叶子时必须补标题、用途、默认行为和 YAML 示例；Web UI 与 `roll config explain` 共用，完整性由 catalog 测试守护 |
| CLI curated surface | `config-setup.ts`、`config init` 模板、`doctor` | 希望进入交互向导、初始化模板或专项诊断；通用 `config get/set` 不需要字段清单 |

这意味着“无需维护两套”适用于字段结构、key 编码、校验和通用写回；不代表安全、生效、迁移或产品化向导语义能够自动猜测。

## 保存与生效

保存前配置台会展示：

- Zod 校验结果；
- 相对当前文件的差异；
- 需要立即重启、下次命令生效或人工处理的项目。

| 运行时所有权 | 配置保存后的处理 |
|---|---|
| `core-managed` 且保存前正在运行 | 用户确认后由 Roll 停止、重启并检查就绪状态 |
| `core-managed` 且保存前已停止 | 保持停止，不擅自启动 |
| `on-demand` | 下次调用该 Agent 时自动读取新配置 |
| `external-managed` | 只给出人工重启提示，不操作外部进程 |
| `agents.data-dir` 等迁移型变更 | 只给出人工步骤，不自动搬迁数据 |

写回采用 revision 乐观并发控制；文件在预览与保存之间被其他程序修改时，保存会被拒绝。修改已存在的文件时会先创建备份，并通过临时文件、`fsync`、原子替换完成提交，同时保留注释、字段顺序、引号和 `${ENV_VAR}` 引用。新建文件不产生备份。

自动重启不会只信任 PID。Roll 启动 core-managed Agent 时会把 OS 进程启动身份写入 runtime sidecar；停止前会同时核对 `PID + processStartToken + startedAt`，身份缺失、来自旧版 sidecar 或发生变化时一律拒绝发送信号，并转为人工处理。Linux 使用 boot ID 与 `/proc` starttime，macOS 使用固定 locale 的进程启动时间与 boot time，Windows 使用进程启动时间 ticks。

## 安全边界

- 服务不监听局域网地址，只绑定 IPv4 loopback。
- 随机路径和 token 都只在内存中存在；token 放在 URL fragment 中，不随首个页面请求发送到服务器，并且只能兑换一次。
- 认证完成后使用随机名称、随机 Path、`HttpOnly`、`SameSite=Strict` cookie；写请求还需 CSRF token。
- Host、Origin、Fetch Metadata、CSP、请求大小和请求超时都会校验；不启用 CORS。
- 已声明的 secret 及未声明的 Agent env 默认按 secret 处理，UI 不返回原始明文。
- Agent 停止、重启和 runtime 元数据清理按完整进程身份执行；PID 被其他进程复用时不会按 stale sidecar 自动终止它。
- 服务不是远程控制台，不支持 `0.0.0.0`、常驻守护或公网暴露。

## 不覆盖的场景

- YAML 语法本身已经损坏时，配置台不会把无法可靠脱敏的原文发到浏览器；请先在本地编辑器修复语法。
- `roll config init` 是独立恢复入口：用户在终端明确确认覆盖后，可以用经过完整校验的新模板替换损坏文件，并保留原始备份；该能力不开放给 Web UI。
- schema 校验失败但 YAML 仍可解析时，会进入 repair 模式，允许在安全脱敏后修改。
- Chrome 启动参数等进程级配置不能热更新；配置台会明确标注重启或下次启动后生效。
- Agent 自己维护、但未在 `references/env.yaml` 声明的内部参数不会自动进入表单。
- 旧版 runtime sidecar 不含 `processStartToken`，Roll 会 fail-closed；需要先用系统工具确认并手动停止对应 PID，再运行 `roll doctor --fix` 清理元数据。
- 零依赖实现仍存在极小的“再次读取启动身份 → 按 PID 发信号”系统调用竞态；若要彻底消除，需要 pidfd、稳定的 Windows process handle 或经过认证的进程控制通道。
