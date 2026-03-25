# How To Register And Run An Agent With Roll

本指南用于“我已经有一个 Agent，如何用 `roll` 注册并调用它”。

## 目标

将 Agent 注册到 roll，并通过 `run` / `ask` 使用。

本指南也覆盖最近 commander 的几个关键变化：

- `ask` 现在是“先路由，再按目标 tool schema 提参”
- `run` 支持 `--input-json` / `--input-file`
- 对开放对象/复杂 payload，`ask` 会提示改用显式输入
- 业务 Agent 的私有运行配置应显式走 `agents.env.<agent-name>`

## 假设

- `roll` 命令可用
- 你已经准备好以下三种交付形态之一：
1. 本地 Agent 目录（开发态）
2. 已发布的已编译 npm 包
3. 已部署的远程 `streamable-http` MCP 服务

## 步骤 1：选择一种注册方式

```bash
# 本地目录
roll agent add /absolute/path/to/my-agent

# 已编译 npm 包
roll agent install @roll-agent/my-agent

# 远程 MCP 服务
roll agent add --remote https://example.com/mcp --name my-agent --description "My remote agent"
```

说明：

- 本地目录也支持相对路径，例如 `./agents/my-agent`
- `roll agent install` 适合终端用户安装编译后的 Agent 应用
- `--remote` 适合你把 Agent 部署在自己的服务器上
- 不要对本地源码目录使用 `roll agent install`；源码目录 / Git 仓库都应使用 `roll agent add`
- `.tgz` 安装包也必须是可外部分发的编译产物；如果包里仍包含 `workspace:*` 依赖或只适合 monorepo 开发态，`install` 不会工作

## 步骤 2：检查注册结果

```bash
roll agent list
roll agent info my-agent-name
roll agent health
roll doctor
```

预期结果：

- `list` 能看到该 agent
- `info` 可查看传输方式和详情
- `health` 不报连接错误（或能给出明确不可达原因）
- `doctor` 可检查配置迁移状态以及已注册 Agent 的 env readiness

如果该 Agent 在 `SKILL.md` 中通过 `metadata.roll-env-file` 声明了机器可读 env 契约：

- `roll agent info my-agent-name` 会展示每个 env 当前来自 `agents.env`、当前 shell、默认值还是完全缺失
- `roll doctor` 会报告缺失的 required env，或提示“目前只依赖 shell 环境，建议持久化到 `agents.env`”

## 步骤 3：声明式调用

```bash
roll run my-agent-name tool_name --key value

# 复杂对象输入可直接传 JSON
roll run my-agent-name tool_name --input-json '{"payload":{"foo":"bar"}}'

# 或从文件读取
roll run my-agent-name tool_name --input-file ./payload.json
```

说明：

- `--key value` 适合简单字符串、数字、布尔参数
- `--input-json` / `--input-file` 适合开放对象、嵌套对象、批量 payload
- 如果同时提供显式 JSON 和 `--key value`，后者会覆盖同名字段

## 步骤 4：自然语言调用（可选）

```bash
roll ask "帮我执行 xxx 任务"
```

`roll ask` 更适合“自然语言可可靠映射到 tool 参数”的任务。如果某个必填字段是开放对象（例如任意 JSON config、`z.record()`、批量同步 payload），`roll-core` 会提示改用 `roll run --input-json` / `--input-file` 或由上层编排器显式提供参数，而不是让 LLM 猜测这类结构。

## 常见问题

### 报 `SKILL.md not found`

你传入的目录不是 Agent 根目录，或文件名不正确。  
请确认路径下存在 `SKILL.md`。

### 对本地路径执行 `roll agent install` 报错

这是用法不匹配：

- 本地源码目录 / Git 仓库，请使用 `roll agent add`
- 已编译 npm 包 / `.tgz` 安装包，请使用 `roll agent install`

### 报 `API key 未设置`

配置中 `${...}` 是环境变量名占位符，不是 key 本身。  
例如：`api-key: ${OPENAI_API_KEY}`，并确保 shell 中已 `export OPENAI_API_KEY=...`。

如果这是某个业务 Agent 自己需要的环境变量，优先写在：

```yaml
agents:
  env:
    my-agent-name:
      SOME_API_KEY: ${SOME_API_KEY}
```

不要默认假设它会继承 `roll-core` 的 `llm.*` 配置。

### 为什么日志不要 `console.log`？

stdio MCP 协议会占用 stdout。日志建议用 `ctx.logger`（stderr）。

### 什么时候应该让用户用 `roll run --input-json`？

当你的 tool 输入包含：

- 任意键值对对象（如 `z.record()`）
- 深层嵌套 JSON
- 批量导入 payload

这类参数通常不适合 `roll ask` 从自然语言中自动提取，应该通过 `roll run --input-json` 或 `--input-file` 显式提供。

### 远程服务也需要 `SKILL.md` 吗？

如果你用 `roll agent add --remote ...`，`roll-core` 会在本地生成一个 manifest 目录用于注册，不要求你额外手工创建本地源码目录。
