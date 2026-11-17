# 更新已注册的子 Agent

本指南说明在 Roll 中更新已注册子 Agent 时，不同变更分别影响哪一层状态，以及何时重跑命令或重进会话即可生效、何时应执行 `roll update`、何时必须 `remove + add` 重新注册。

## 适用范围

假设你已经注册过一个子 Agent，并遇到以下任一情况：

- 修改了 tool 实现逻辑或 tool schema
- 更新了 `SKILL.md` 的名称、描述、正文或 `package.json#rollAgent` 元数据
- 修改代码后发现 `roll run`、`roll ask` 或 `roll chat` 仍执行旧逻辑
- `roll update` 提示本地配置文件 schema 需要迁移

## Step 1. 判断变更发生在哪一层

子 Agent 的行为由以下三层状态共同决定：

| 层级 | 典型内容 | 是否影响调用 |
| --- | --- | --- |
| 注册表层 | Agent 名称、描述、`SKILL.md` 正文、transport、endpoint、启动元数据 | 会 |
| 磁盘代码层 | 本地源码、`git pull` 后的代码、npm 包安装产物 | 会 |
| 运行进程层 | 常驻 HTTP Agent 服务进程，或当前 `roll chat` 会话持有的 `stdio` 子进程 | 会 |

排查更新未生效时，最常见的误区是**只更新了磁盘代码或注册表，却仍在复用旧的运行进程**。

## Step 2. 仅改代码或 Tool Schema 时的生效方式

如果 Agent 的名称、来源及注册表启动元数据均未改变，仅修改了内部代码逻辑或 tool schema，无需 `remove + add`，按传输方式与调用入口处理即可：

### `stdio` Agent

- **单次命令（`roll run` / `roll ask`）**：直接重新执行命令即可生效。单次命令每次都会拉起新的 `stdio` 子进程，执行完毕后退出，因此会自动加载磁盘上的最新代码与 schema。
- **交互式会话（`roll chat`）**：在同一个 `roll chat` 会话期间，宿主会保持并复用已建立的 `stdio` 子进程连接，不会在每轮对话重拉进程。**修改代码或 tool schema 后，需要退出当前 `roll chat` 会话并重新进入**，才会启动新子进程使改动生效。

### `streamable-http` Agent

需要**重启该 HTTP Agent 服务进程**。虽然 `roll run` / `roll ask` 调用前会实时请求 `tools/list`，但 HTTP Agent 是独立常驻进程，不重启服务则内存中仍是旧代码和旧 schema：

- 若为 Roll 托管（`core-managed`）的 HTTP Agent，可直接运行 `roll update` 自动完成重启与探活。
- 若为外部自管（`external-managed`）的 HTTP 服务，需由你手动重启外部服务进程。
- 若当前正处于 `roll chat` 会话中且更新了 tool schema，重启 HTTP 服务后同样建议重新进入 `roll chat` 会话以刷新工具列表。

## Step 3. 使用 `roll update` 刷新注册表与重启托管服务

无论子 Agent 来自 `git`、`installed-package` 还是 `local-path`（例如通过 `roll agent add ./agents/my-agent` 注册的本地目录），都可以优先使用 `roll update` 同步更新：

```bash
roll update
```

`roll update` 会按注册来源分别执行：

- **`git` 来源**：执行 `git pull` 拉取最新代码、安装依赖，并重新解析 `SKILL.md` / manifest 刷新注册表。
- **`installed-package` 来源**：拉取并重新安装 npm 包，同步刷新 `SKILL.md` / manifest。
- **`local-path` 来源**：不改动本地源码，但会重新解析本地目录中的 `SKILL.md` 与 `package.json#rollAgent`（manifest）并刷新注册表快照。

只要 Agent 的**名称和注册来源没有改变**，以下注册表层变更都可以直接通过 `roll update` 刷新，无需 `remove + add`：

- `SKILL.md` 的 `description` 或正文更新（例如希望同步更新 `roll ask` 的路由语义）
- `package.json#rollAgent` 的运行时元数据更新，或旧版 `roll-command` / `roll-endpoint` 字段更新

执行 `roll update` 时还需注意以下行为边界：

- 对于**正在运行的 `core-managed` HTTP Agent**，`roll update` 会自动停止旧进程、启动新进程并重新探活。
- 对于 **`external-managed` HTTP 服务**，`roll update` 只刷新注册表元数据并检查连通性，不会接管或重启外部进程。
- 若 `roll update` 提示本地 `roll.config.yaml` 需要迁移，请先执行配置迁移再继续验证：

```bash
roll config migrate
```

## Step 4. 必须 `remove + add` 的场景

只有当 Agent 的核心标识或注册来源发生变化时，才必须先移除再重新注册：

- `SKILL.md` 中的 Agent `name` 变了
- Agent 的注册来源类型变了（例如从本地路径改为 npm 包，或从本地路径改为远程 `--remote` endpoint）

此时按新的来源方式显式重新注册：

```bash
# 本地路径或 Git 仓库
roll agent remove <agent-name>
roll agent add <path-or-git-url>

# npm 包
roll agent remove <agent-name>
roll agent install <package>

# 远程 HTTP Endpoint
roll agent remove <agent-name>
roll agent add --remote <endpoint> --name <name> --description "<description>"
```

## Step 5. 验证更新生效

更新完成后，可通过以下命令确认注册信息、连通性与实际调用结果：

```bash
roll agent info <agent-name>
roll agent health
roll run <agent-name> <tool-name> ...
```

若目标为 HTTP Agent，请额外确认服务进程确已重启，且 `roll run` 获取到的实时 `tools/list` 已反映最新 schema；若在 `roll chat` 中验证，请确保已退出旧会话并重新进入。

## 快速判断表

| 变更场景 | 是否需要重启进程 / 重进会话 | 是否需要 `roll update` | 是否需要 `remove + add` |
| --- | --- | --- | --- |
| `stdio` Agent 仅改代码或 tool schema | `roll run` / `roll ask` 无需操作；`roll chat` 需退出并重进会话 | 否 | 否 |
| `streamable-http` Agent 仅改代码或 tool schema | 需重启 HTTP 服务进程（若在 `roll chat` 中改了 schema 也需重进会话） | 否（`core-managed` 可借 `roll update` 重启） | 否 |
| `git` / `installed-package` Agent 拉取新版本 | `core-managed` 自动重启；`external-managed` 需手动重启外部服务；已打开的 `roll chat` 需重进 | 建议 | 否 |
| `local-path` Agent 修改代码或刷新本地 `SKILL.md` / manifest | 同上（`stdio` 在 `roll chat` 中需重进，`external-managed` HTTP 需手动重启） | 改代码无需，刷新元数据建议执行 | 否 |
| `SKILL.md` 中的 `name` 改变，或 Agent 来源类型改变 | 重注册后旧 `roll chat` 会话需重进，`external-managed` HTTP 需确保目标服务就绪 | 不够 | **是** |
