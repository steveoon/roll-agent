# 非 Node.js 子 Agent 接入指南

本指南面向使用 Python、Java、Go、Rust 等非 Node.js / TypeScript 技术栈开发子 Agent 的团队，说明如何将子 Agent 接入 `Roll（@roll-agent/core）`。

常见的接入方式有三种：

- **本地 `stdio` Agent（`on-demand`）**：由 `roll chat`、`roll schedule`、`roll run` 或 `roll ask` 按需拉起本地子进程。
- **外部常驻 `streamable-http` Agent（`external-managed`）**：Agent 作为独立服务常驻运行，Roll 通过 MCP Streamable HTTP 连接。
- **Roll 托管 `streamable-http` Agent（`core-managed`）**：通过 `package.json#rollAgent` 声明启动命令与本地端口，由 `roll agent start` / `stop` 托管常驻进程。

## 先选接入模式

| 场景 | 推荐传输 | 推荐配置方式 | 进程归属（`ownership`） |
| --- | --- | --- | --- |
| 工具型 Agent、启动开销低、无需跨会话维持长连接 | `stdio` | `SKILL.md metadata` + `roll agent add ./path` | `on-demand` |
| 已有独立部署的常驻服务（FastAPI / Spring Boot / Go 等） | `streamable-http` | `roll agent add --remote <endpoint>` 或 `SKILL.md metadata` | `external-managed` |
| 本地长会话 / 浏览器自动化服务，希望由 `roll agent start/stop` 统一启停 | `streamable-http` | `package.json#rollAgent` + `roll agent add ./path` | `core-managed` |

让任意语言的程序被 Roll 调用**不需要**引入 Node SDK，只需满足两个条件：

1. 程序实现了标准 MCP Server（`stdio` 或 `streamable-http`）。
2. 提供了一份符合规范的 `SKILL.md`（纯 `--remote` 注册时由 Roll 自动生成最简本地清单）。

## 不同入口的调用与连接机制

已注册的非 Node.js 子 Agent 可在以下所有入口中使用，但连接生命周期和元数据读取方式有所不同：

- **`roll chat`**：进入对话后通过 MCP `listTools()` 直接读取子 Agent 的实时工具列表与 `inputSchema` 注入模型上下文。对于 `stdio` Agent，**同一聊天会话期间首次连接后会保持并复用该子进程连接**，退出会话时才关闭——因此在本地修改了 `stdio` Agent 的代码或工具 Schema 后，需退出当前 `roll chat` 并重新进入会话（如 `roll chat --last`）才会加载新代码。
- **`roll schedule`**：每轮定时运行相当于独立执行一轮无人值守 `roll chat`。`on-demand` 的 `stdio` 子进程在该轮运行期间按需拉起，本轮结束即释放；`core-managed` 与 `external-managed` 的 HTTP 服务则直接通过配置的 endpoint 连接。
- **`roll run` / `roll ask`**：单次命令执行时拉起 `stdio` 子进程，调用完成后立即关闭。其中 `roll ask` 分两阶段执行：**前置路由阶段**主要读取注册时保存的 `SKILL.md`（`name`、`description` 与正文说明）来挑选目标 Agent 和工具，选定后再建立 MCP 连接校验 `inputSchema` 并执行工具。

## 共享要求

无论采用哪种接入模式，都请遵守以下约束：

- `SKILL.md` 必须存在，YAML frontmatter 至少包含 `name` 和 `description`。
- `SKILL.md` 正文应清晰说明各工具的用途与适用场景（供 `roll ask` 前置路由及技能检索参考）。
- **`stdout` 仅用于输出 MCP 协议报文**；所有业务日志、调试输出一律写入 `stderr`。
- **`stdout` 必须是 UTF-8 字节流**。Roll 按 UTF-8 解码子进程输出；Windows 上非 Node.js 运行时默认常采用系统区域编码（如中文环境下的 CP936/GBK），直接输出会导致中文工具结果乱码：
  - **Python**：Roll 启动 `stdio` 子进程时会自动注入 `PYTHONUTF8=1` 与 `PYTHONIOENCODING=utf-8`（可在 `agents.env` 中覆盖），通常无需额外配置；自行托管的 HTTP 服务进程需自行确保 UTF-8 编码。
  - **其他运行时（Java / Go / Rust / .NET）**：请在程序启动参数或代码中显式指定 UTF-8 输出（例如 Java 传入 `-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8`），不要依赖系统默认编码。

## 方案 A：本地 `stdio` Agent

这是非 Node.js 子 Agent 最轻量的本地接入方式。

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

- `roll-command` 按空白字符直接拆分为可执行文件与参数，**不经过 shell 解释**（不支持管道、重定向或环境变量展开）；若启动逻辑复杂，建议编写包装脚本并将 `roll-command` 指向该脚本。
- 单条工具返回结果可能超过 10 MiB 时，可在 `metadata` 中声明 `roll-max-buffer-size`（字节数，正整数，例如 `roll-max-buffer-size: "33554432"`）调高 `stdio` 读缓冲上限；未声明时沿用 MCP SDK 默认的 10 MiB，超限会断开连接。该字段仅对 `stdio` 生效。

### 注册与调用

```bash
roll agent add ./python-agent

# 单次声明式调用与自然语言路由
roll run python-demo-agent hello --name 张三
roll ask "让 python-demo-agent 打个招呼"

# 在交互式多轮对话中使用（模型自动发现并调用工具）
roll chat
```

注册后，该 Agent 同样可在 `roll schedule` 定时任务中由模型自动调用（注意：定时服务环境的 `PATH` 较精简，若 `python3` 等命令位于 Homebrew 或虚拟环境目录，请在 `roll.config.yaml` 的 `scheduler.env.PATH` 中显式补齐）。

### 适用场景

- 进程启动快、无重型初始化开销。
- 不需要跨会话长期持有浏览器实例或连接池。

## 方案 B：远程 / 常驻 `streamable-http` Agent

如果 Agent 本身已是常驻服务，或单次启动成本较高，推荐使用 MCP `streamable-http`。

### 方式 B1：直接注册远程 endpoint

```bash
roll agent add \
  --remote http://127.0.0.1:8100/mcp \
  --name python-http-agent \
  --description "Python HTTP MCP Agent"
```

适用场景：服务已经独立运行在线，无需在本地维护 Agent 目录。

注意：

- 该命令会在 Roll 数据目录下自动生成一份最简本地技能清单，仅包含你传入的 `name` 和 `description`，不含各工具的详细文字说明。
- `roll chat` 和 `roll schedule` 会直接连接 MCP 服务拉取实时工具列表，不受影响；但若希望 `roll ask` 的前置路由能结合详细文档更精准地挑选工具，推荐使用下面的方式 B2。

### 方式 B2：本地目录 + `SKILL.md` 指向远程 endpoint

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

- `search_docs` - 检索知识库文档
- `create_ticket` - 创建工单
```

注册：

```bash
roll agent add ./python-http-agent
```

这样做的好处：

- `roll ask` 前置路由可以读取完整的 `SKILL.md` 正文说明。
- 后续调整描述或工具说明文档后，直接执行 `roll update` 即可同步元数据。

## 可选：使用 `package.json#rollAgent` 声明运行时契约

如果你的非 Node.js 项目希望显式声明进程托管模式（尤其是让 Roll 通过 `roll agent start` / `stop` 托管本地常驻 HTTP 服务），可以在项目根目录放置一个最小的 `package.json` 并配置 `rollAgent` 字段。

### 1. `on-demand` + `stdio` 示例

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
      "args": ["agent.py"],
      "maxBufferSize": 33554432
    }
  }
}
```

### 2. `core-managed` + `streamable-http` 示例（由 Roll 托管本地常驻进程）

需要同时声明 `start.command`（及可选 `args`）与本地监听的 `endpoint.path` + `endpoint.port`：

```json
{
  "name": "python-managed-http-agent",
  "private": true,
  "rollAgent": {
    "runtime": {
      "ownership": "core-managed",
      "transport": "streamable-http"
    },
    "start": {
      "command": "python3",
      "args": ["server.py", "--port", "8100"]
    },
    "endpoint": {
      "path": "/mcp",
      "port": 8100
    }
  }
}
```

注册后可通过 `roll agent start python-managed-http-agent`、`roll agent stop python-managed-http-agent` 和 `roll agent health` 管理其生命周期。

### 3. `external-managed` + `streamable-http` 示例（外部自行托管进程）

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

### 优先级与跳过前端依赖安装

- `package.json#rollAgent` 的优先级高于 `SKILL.md metadata`；若两处同时声明了传输配置且彼此不一致，注册时 Roll 会直接报错阻止。
- 当目录下存在 `package.json` 时，`roll agent add ./path` 默认会依次根据 `package.json#packageManager` 字段及锁文件（`pnpm-lock.yaml`、`package-lock.json` / `npm-shrinkwrap.json`、`yarn.lock`、`bun.lock` / `bun.lockb`）自动识别包管理器安装依赖，均未命中时回退执行 `pnpm install`。
- 对于仅为提供 `rollAgent` 清单而放置 `package.json` 的纯 Python / Java / Go / Rust 项目，无需执行前端包管理器安装，可在注册时通过 `ROLL_SKIP_INSTALL=1` 跳过该步骤：

```bash
ROLL_SKIP_INSTALL=1 roll agent add ./python-managed-http-agent
```

## 常见误区

### 1. 直接对纯非 Node.js 仓库执行 `roll agent install`

`roll agent install <pkg>` 面向发布到 npm 仓库的软件包。如果希望为非 Node.js 子 Agent 提供团队内便捷分发，建议选择以下方式之一：

- 将服务部署为常驻 HTTP 端点，使用 `roll agent add --remote <endpoint>` 接入；
- 通过 Git 仓库分发，使用 `roll agent add <git-url>` 克隆并注册；
- 若确需走 npm 分发链路，编写一个轻量的 npm 包装包来拉起对应语言的可执行文件或运行时。

### 2. 将普通日志输出到 `stdout`

在 `stdio` 模式下，任何非 MCP JSON-RPC 的标准输出都会破坏协议帧解析导致连接中断。请务必将所有日志重定向到 `stderr`。

## 更新与运维

- **`stdio` Agent 更新代码后**：`roll run` / `roll ask` 下次执行即生效；正在进行的 `roll chat` 会话因复用了子进程连接，需退出会话后重进才生效。
- **`streamable-http` Agent 更新代码后**：`core-managed` 执行 `roll agent stop <name>` 与 `roll agent start <name>` 重启；`external-managed` 在外部托管系统中重启服务进程（若工具 Schema 变化，重进 `roll chat` 会话以刷新工具定义）。
- **修改了 `SKILL.md` 描述、正文或运行时配置后**：执行 `roll update` 刷新注册表元数据。完整更新策略参见 [已注册子 Agent 更新指南](./how-to-update-registered-agents.md)。

## 快速排错

### `roll run` / `roll chat` 能正常调用，但 `roll ask` 选不到正确工具

优先检查 `SKILL.md` 正文是否写清楚了工具名称与职责说明。`roll ask` 的前置路由阶段主要依据注册表中的 `SKILL.md` 文本选工具，而不是先连接所有子 Agent 拉取实时 Schema。

### `stdio` Agent 启动失败

优先检查：

- `roll-command`（或 `rollAgent.start.command`）在当前环境（或 `scheduler.env.PATH`）下是否可直接执行；
- 启动命令是否误用了管道、重定向、`~` 或环境变量展开等 shell 语法；
- 子进程启动时是否向 `stdout` 打印了横幅或日志污染了 MCP 协议流。

### HTTP Agent 已启动，但 Roll 仍报连接失败

优先检查：

- 服务端实现是否为标准 MCP `streamable-http` 协议；
- `roll-endpoint`、`--remote` 或 `endpoint.path` 是否包含了正确的路由后缀（如 `/mcp`）；
- 服务重启后监听地址或端口是否发生了变化。

## 小结

接入非 Node.js 子 Agent 时，可按如下原则快速选型：

- **轻量本地工具**：优先选 `stdio` + `SKILL.md metadata`；
- **独立部署的外部常驻服务**：优先选 `external-managed` `streamable-http`（配合本地 `SKILL.md` 可获得最佳 `roll ask` 路由效果）；
- **需由 Roll 统一启停的本地常驻服务**：选 `package.json#rollAgent`（`core-managed` + `streamable-http`），注册时配合 `ROLL_SKIP_INSTALL=1` 跳过前端依赖安装。
