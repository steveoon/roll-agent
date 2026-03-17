# How To Register And Run An Agent With Roll

本指南用于“我已经有一个 Agent，如何用 `roll` 注册并调用它”。

## 目标

将 Agent 注册到 roll，并通过 `run` / `ask` 使用。

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

## 步骤 2：检查注册结果

```bash
roll agent list
roll agent info my-agent-name
roll agent health
```

预期结果：

- `list` 能看到该 agent
- `info` 可查看传输方式和详情
- `health` 不报连接错误（或能给出明确不可达原因）

## 步骤 3：声明式调用

```bash
roll run my-agent-name tool_name --key value
```

## 步骤 4：自然语言调用（可选）

```bash
roll ask "帮我执行 xxx 任务"
```

## 常见问题

### 报 `SKILL.md not found`

你传入的目录不是 Agent 根目录，或文件名不正确。  
请确认路径下存在 `SKILL.md`。

### 报 `API key 未设置`

配置中 `${...}` 是环境变量名占位符，不是 key 本身。  
例如：`api-key: ${OPENAI_API_KEY}`，并确保 shell 中已 `export OPENAI_API_KEY=...`。

### 为什么日志不要 `console.log`？

stdio MCP 协议会占用 stdout。日志建议用 `ctx.logger`（stderr）。

### 远程服务也需要 `SKILL.md` 吗？

如果你用 `roll agent add --remote ...`，`roll-core` 会在本地生成一个 manifest 目录用于注册，不要求你额外手工创建本地源码目录。
