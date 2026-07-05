# How To Integrate Non-Node Agents With Roll

本指南面向使用 Python、Java、Go、Rust 等非 Node/TypeScript 技术栈开发子 Agent 的团队，说明如何把 Agent 接入 `roll-core`。

当前最推荐的两种接入方式是：

- **本地 `stdio` Agent**：由 `roll run` / `roll ask` 按需启动本地进程
- **远程 `streamable-http` Agent**：Agent 自己常驻运行，Roll 通过 MCP HTTP 连接

## 先选接入模式

| 场景 | 推荐模式 | 注册方式 | 生命周期 |
| --- | --- | --- | --- |
| 工具型 Agent、启动成本低、希望一次调用拉起一个进程 | `stdio` | `roll agent add ./path` | `on-demand` |
| 浏览器自动化、长会话、启动成本高、已有常驻服务 | `streamable-http` | `roll agent add --remote <endpoint>` 或 `roll agent add ./path` | `external-managed` |

如果你只是想让任意语言的 Agent 被 Roll 调用，**不需要**使用 Node SDK。真正的要求只有两个：

1. 你的程序实现了 MCP Server
2. 你提供了 `SKILL.md`

## 共享要求

无论使用哪种模式，都建议满足这些约束：

- `SKILL.md` 必须存在，frontmatter 至少包含 `name` 和 `description`
- `SKILL.md` body 要写清楚 tools 的用途；`roll ask` 路由会读取这些文字
- `stdout` 只输出 MCP 协议数据
- 日志一律写到 `stderr`
- tool 名称、参数名、描述尽量稳定；更新后 `stdio` Agent 直接重跑，HTTP Agent 需要重启服务
- **`stdout` 必须是 UTF-8 字节流**。Roll 按 UTF-8 解码子进程的 stdio；Windows 上非 Node
  运行时默认使用系统 locale 编码（中文系统为 CP936/GBK），中文 tool 结果会变成乱码。
  - Python：Roll 启动 `stdio` 子进程时会自动注入 `PYTHONUTF8=1` 与 `PYTHONIOENCODING=utf-8`
    （可在 agent env 里显式覆盖），通常无需额外处理；自行托管的 HTTP 服务进程需要自己保证
  - 其他运行时（Java/Go/Rust/.NET）：请在程序内显式以 UTF-8 写 stdout/stderr
    （如 Java 加 `-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8`），不要依赖系统默认编码

## 方案 A：本地 `stdio` Agent

这是非 Node Agent 最简单的本地接入方式。

### 目录结构

```text
python-agent/
  SKILL.md
  agent.py
```

### `SKILL.md`

```markdown
---
name: python-demo-agent
description: Python 示例 Agent
metadata:
  roll-transport: stdio
  roll-command: python3 agent.py
---

## Tools

- `hello` - 返回问候语
- `list_tasks` - 列出当前任务
```

说明：

- `roll-command` 会被直接按空白拆分，不经过 shell 解释
- 如果启动命令很复杂，建议写一个包装脚本，再把 `roll-command` 指向那个脚本
- 非 Node Agent 的 `local-path` 场景，当前**最简单**的做法仍然是用 `SKILL.md metadata`

### 注册与调用

```bash
roll agent add ./python-agent
roll run python-demo-agent hello --name 张三
roll ask "让 python-demo-agent 打个招呼"
```

### 什么时候适合

- 进程启动成本低
- 不需要长时间持有浏览器、数据库连接、会话状态
- 希望本地开发时直接改代码后重跑命令

## 方案 B：远程 `streamable-http` Agent

如果 Agent 本身已经是一个常驻服务，或者启动成本高，推荐走 HTTP MCP。

### 方式 B1：直接注册远程服务

```bash
roll agent add \
  --remote http://127.0.0.1:8100/mcp \
  --name python-http-agent \
  --description "Python HTTP MCP Agent"
```

这种方式最适合：

- 服务已经在线
- 你只想让 Roll 连上它
- 不需要额外维护一个本地 Agent 仓库

注意：

- 这种方式会生成一个最小本地 manifest
- `ask` 路由可用，但可用语料只有 `name`、`description` 和一个通用 body
- 如果你希望 `roll ask` 更准确地理解 tools，建议使用下面的 B2

### 方式 B2：本地仓库 + `SKILL.md` 指向远程 endpoint

```text
python-http-agent/
  SKILL.md
```

```markdown
---
name: python-http-agent
description: Python HTTP MCP Agent
metadata:
  roll-transport: streamable-http
  roll-endpoint: http://127.0.0.1:8100/mcp
---

## Tools

- `search_candidate` - 搜索候选人
- `send_reply` - 发送回复
```

注册：

```bash
roll agent add ./python-http-agent
```

这样做的好处是：

- `ask` 路由能看到完整 `SKILL.md` body
- 以后改描述、tool 说明时可以直接 `roll update`

### 什么时候适合

- Agent 需要维持浏览器、会话、缓存、长连接
- 进程启动慢，不适合每次调用拉起
- 你已经有 Python/FastAPI、Java/Spring Boot、Go/Fiber 等常驻服务

## 可选：在非 Node 仓库里使用 `package.json#rollAgent`

如果你的非 Node Agent 仓库愿意放一个最小 `package.json`，也可以使用 runtime manifest。

### `stdio` 示例

```json
{
  "name": "python-demo-agent-manifest",
  "private": true,
  "rollAgent": {
    "runtime": {
      "ownership": "on-demand",
      "transport": "stdio"
    },
    "start": {
      "command": "python3",
      "args": ["agent.py"]
    }
  }
}
```

### `external-managed streamable-http` 示例

```json
{
  "name": "python-http-agent-manifest",
  "private": true,
  "rollAgent": {
    "runtime": {
      "ownership": "external-managed",
      "transport": "streamable-http"
    },
    "endpoint": {
      "url": "http://127.0.0.1:8100/mcp"
    }
  }
}
```

注意两点：

- `package.json#rollAgent` 优先级高于 `SKILL.md metadata`
- 如果两边 runtime 信息冲突，Roll 会直接报错

对非 Node Agent 来说，这个做法是**可选高级用法**。如果你只是本地开发或手工部署服务，通常 `SKILL.md metadata` 更简单。

另一个现实差异是：

- `roll agent add ./path` 只要看到 `package.json`，当前就会尝试执行一次 `pnpm install`
- 对纯 Python/Java/Go 项目来说，这通常不是必须步骤
- 所以如果你只是想提供 runtime manifest，而不想引入 npm/pnpm 语义，继续使用 `SKILL.md metadata` 往往更省事

## 当前不推荐的路径

### 1. 直接把纯 Python/Java 项目当作 npm installable Agent

当前 `roll agent install` 的分发路径仍是 npm-centric。  
如果你想让非 Node Agent 走“一键安装”，更现实的方式通常是：

- 提供一个 Node/npm 包装层
- 或把 Agent 部署成远程服务，再用 `roll agent add --remote`

### 2. 让 MCP 协议日志写到 `stdout`

这会直接污染协议流，尤其是 `stdio` 模式下最容易出问题。日志必须走 `stderr`。

## 更新与运维

- `stdio` Agent 改了代码后，通常直接重跑即可
- `streamable-http` Agent 改了代码后，需要重启服务进程
- 如果改了 `SKILL.md` body、描述或 runtime metadata，可执行：

```bash
roll update
```

完整更新策略见：

- [How To Update Registered Agents](./how-to-update-registered-agents.md)

## 快速排错

### `roll run` 能连上，但 `roll ask` 选不到正确 tool

优先检查 `SKILL.md` body 是否写清楚了 tool 说明。`ask` 路由不会直接读取 live tool schema 作为主要语料。

### `stdio` Agent 启动失败

优先检查：

- `roll-command` 是否可在当前机器直接执行
- 命令是否依赖 shell 特性（如管道、重定向、变量展开）
- MCP 协议输出是否被普通日志污染

### HTTP Agent 已启动，但 Roll 仍报连接失败

优先检查：

- endpoint 是否真的是 MCP `streamable-http`
- `roll-endpoint` / `--remote` 是否带了正确的 `/mcp` 路径
- 服务重启后端口是否变化

## 预期结果

按本指南接入后，非 Node Agent 团队应该能明确区分：

- **本地工具型 Agent**：优先 `stdio`
- **常驻服务型 Agent**：优先 `streamable-http`
- **简单接入**：优先 `SKILL.md metadata`
- **更强 runtime 声明**：可选 `package.json#rollAgent`
