# How To Update Registered Agents

本指南说明在 Roll 里更新一个已注册子 Agent 时，什么时候只需要重启进程，什么时候可以用 `roll update`，什么时候必须 `remove + add`。

## 适用范围

假设你已经注册过一个子 Agent，并且遇到了以下任一情况：

- tool 逻辑更新了
- tool schema 更新了
- `SKILL.md` 的名称、描述、body、transport、endpoint 变了
- 你发现 `roll run` / `roll ask` 还是打到了旧逻辑

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

## Step 3. 如果 Agent 来源是 `git` 或 `installed`

这两类来源可以优先尝试：

```bash
roll update
```

`roll update` 当前会做这些事：

- `git` 来源：`git pull` + 安装依赖 + 重新解析 `SKILL.md` 并刷新注册表
- `installed` 来源：重新安装 npm 包 + 重新解析 `SKILL.md` 并刷新注册表

但要注意：

- 如果这个 Agent 实际跑的是长驻 HTTP 服务，`roll update` **不会替你重启那个服务进程**
- 所以代码更新后，仍然要手动重启 HTTP Agent

## Step 4. 出现这些情况时，必须 `remove + add`

以下变更属于“注册表层变化”，需要重新注册：

- `SKILL.md` 中的 `name` 变了
- `description` 变了，且你希望注册表里的展示信息更新
- `SKILL.md` body 变了，且你希望 `ask` 的路由语义更新
- `roll-command` 变了
- `roll-endpoint` 变了
- transport 从 `stdio` 改成 `streamable-http`，或反过来
- Agent 的来源变了
  - 例如从本地 path 改成 npm 包
  - 或从本地 path 改成远程 endpoint

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

## Step 5. `local-path` Agent 要特别注意

当前 `roll update` **不会自动更新** `local-path` Agent。

如果你是这样注册的：

```bash
roll agent add ./agents/my-agent
```

那么：

- 只改 tool 逻辑 / schema：
  - `stdio` Agent 直接重跑
  - `http` Agent 重启服务
- 改注册信息：
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
| `git` Agent 更新代码 | 如果是 HTTP，则要 | 建议 | 否 |
| `installed` Agent 更新包 | 如果是 HTTP，则要 | 建议 | 否 |
| `local-path` Agent 更新代码 | 如果是 HTTP，则要 | 否 | 否 |
| `SKILL.md` name / endpoint / transport 改了 | 视 transport 而定 | 不够 | 是 |
| 想刷新本地 path 注册信息 | 视 transport 而定 | 不适用 | 是 |

## 预期结果

按这个流程处理后，你应该可以区分：

- 什么时候问题是“注册表没刷新”
- 什么时候问题是“磁盘代码没更新”
- 什么时候问题只是“HTTP Agent 进程没重启，内存里还是旧逻辑”
