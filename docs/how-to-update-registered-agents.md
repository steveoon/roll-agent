# How To Update Registered Agents

本指南说明在 Roll 里更新一个已注册子 Agent 时，什么时候只需要重启进程，什么时候可以用 `roll update`，什么时候仍然建议 `remove + add`。

## 适用范围

假设你已经注册过一个子 Agent，并且遇到了以下任一情况：

- tool 逻辑更新了
- tool schema 更新了
- `SKILL.md` 的名称、描述、body、transport、endpoint 变了
- 你发现 `roll run` / `roll ask` 还是打到了旧逻辑
- `roll update` 提示本地配置 schema 需要迁移

## Step 1. 先判断变更发生在哪一层

更新子 Agent 时，实际会涉及三层状态：

| 层 | 典型内容 | 是否影响调用 |
| --- | --- | --- |
| 注册表层 | agent 名称、描述、SKILL body、transport、endpoint | 会 |
| 磁盘代码层 | 本地源码、git pull 后的代码、npm 安装产物 | 会 |
| 运行进程层 | 正在运行的 HTTP Agent 内存态 | 会 |

最常见的误区是：**注册表更新了，不代表正在运行的 HTTP Agent 进程也更新了。**

## Step 2. 如果只是 tool 逻辑或 tool schema 更新

### `stdio` Agent

直接重新执行命令即可，不需要 `remove + add`。

原因：

- `roll run` / `roll ask` 会重新连接 Agent
- `stdio` Agent 通常是按调用启动的新进程
- 新进程会直接加载最新代码

### `streamable-http` Agent

需要**重启 Agent 服务进程**，通常不需要 `remove + add`。

原因：

- `roll run` / `roll ask` 调用前会读取 live `tools/list`
- 但 HTTP Agent 是常驻进程
- 如果服务没有重启，内存里仍然是旧 schema / 旧逻辑

结论：

- `stdio`：重新执行即可
- `http`：重启服务进程

## Step 3. 如果 Agent 来源是 `git` / `installed-package` / `local-path`

这三类来源都可以优先尝试：

```bash
roll update
```

`roll update` 当前会做这些事：

- `git` 来源：`git pull` + 安装依赖 + 刷新 `SKILL.md` / manifest
- `installed-package` 来源：重新安装 npm 包 + 刷新 `SKILL.md` / manifest
- `local-path` 来源：不拉代码，但会重新解析本地 `SKILL.md` / manifest 并刷新注册表

但要注意：

- 如果这个 Agent 是 **正在运行中的 `core-managed` HTTP Agent**，`roll update` 会自动重启并重新探活
- 如果这个 Agent 是 **external-managed HTTP 服务**，`roll update` 只会刷新 metadata / 连通性，不会替你接管外部进程
- 如果 `roll update` 同时提示本地 `roll.config.yaml` 需要迁移，先执行：

```bash
roll config migrate
```

然后再继续验证命令行为是否符合预期

## Step 4. 出现这些情况时，必须 `remove + add`

以下变更属于“注册表层变化”，需要重新注册：

- `SKILL.md` 中的 `name` 变了
- Agent 的来源变了
  - 例如从本地 path 改成 npm 包
  - 或从本地 path 改成远程 endpoint

以下变更现在通常可以直接用 `roll update` 刷新，不必 `remove + add`：

- `description` 变了
- `SKILL.md` body 变了，且你希望 `ask` 的路由语义更新
- legacy `roll-command` / `roll-endpoint` 变了，但 Agent 名称没变且来源没变
- `package.json#rollAgent` 的 runtime metadata 变了，但 Agent 名称没变且来源没变

这时建议显式执行：

```bash
roll agent remove <agent-name>
roll agent add <path-or-git-url>
```

或：

```bash
roll agent remove <agent-name>
roll agent install <package>
```

或：

```bash
roll agent remove <agent-name>
roll agent add --remote <endpoint> --name <name> --description "<description>"
```

## Step 5. `local-path` Agent 现在也可以用 `roll update`

当前 `roll update` **会刷新** `local-path` Agent 的本地 metadata。

如果你是这样注册的：

```bash
roll agent add ./agents/my-agent
```

那么：

- 只改 tool 逻辑 / schema：
  - `stdio` Agent 直接重跑
  - `core-managed http` Agent 可先用 `roll update`
  - `external-managed http` Agent 仍需重启外部服务
- 改 metadata / manifest：
  - 可优先尝试 `roll update`
- 改 Agent 名称或来源：
  - 需要 `remove + add`

## Step 6. 更新后如何确认是否真的生效

建议至少做下面几步：

```bash
roll agent info <agent-name>
roll agent health
roll run <agent> <tool> ...
```

如果是 HTTP Agent，额外确认：

- 服务进程是否已重启
- `roll run` 读到的 live `tools/list` 是否已经反映新 schema

## 快速判断表

| 场景 | 是否需要重启进程 | 是否需要 `roll update` | 是否需要 `remove + add` |
| --- | --- | --- | --- |
| `stdio` Agent 只改 tool 逻辑 | 否 | 否 | 否 |
| `http` Agent 只改 tool 逻辑 | 是 | 否 | 否 |
| `git` Agent 更新代码 | `core-managed` 会自动重启，`external-managed` 仍需外部重启 | 建议 | 否 |
| `installed-package` Agent 更新包 | `core-managed` 会自动重启，`external-managed` 仍需外部重启 | 建议 | 否 |
| `local-path` Agent 更新代码 / metadata | `core-managed` 会自动重启，`external-managed` 仍需外部重启 | 建议 | 否 |
| `SKILL.md` name 改了 | 视 transport 而定 | 不够 | 是 |
| 想刷新本地 path 注册信息 | 视 transport 而定 | 适用 | 否 |

## 预期结果

按这个流程处理后，你应该可以区分：

- 什么时候问题是“注册表没刷新”
- 什么时候问题是“磁盘代码没更新”
- 什么时候问题只是“HTTP Agent 进程没重启，内存里还是旧逻辑”
