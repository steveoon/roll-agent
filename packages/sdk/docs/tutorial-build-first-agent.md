# Build Your First Agent

本教程会带你从零创建一个可被 `roll` 调用的本地 Agent（stdio MCP Server）。
这是 SDK 当前支持的服务端形态；如果你要发布远程 `streamable-http` 服务，需要额外实现或部署服务端。

完成后你将得到：

- 一个 `echo-agent` 项目
- 一个可调用的 `echo` tool
- 可通过 `roll run` 成功执行
- 并理解什么时候该用 `roll ask`，什么时候该改用 `roll run --input-json`

## 前置条件

- Node.js >= 22.6.0
- 已全局安装 `@roll-agent/core`（命令 `roll` 可用）

## 步骤 1：初始化项目

```bash
mkdir -p ~/my-agents/echo-agent/src/tools
cd ~/my-agents/echo-agent
npm init -y
npm install @roll-agent/sdk zod
```

预期结果：项目目录下存在 `package.json`，并安装好依赖。

## 步骤 2：创建 echo tool

创建 `src/tools/echo.ts`：

```ts
import { z } from "zod";
import { defineTool } from "@roll-agent/sdk";

export const echoTool = defineTool({
  name: "echo",
  description: "回显输入文本",
  input: z.object({
    text: z.string().min(1),
  }),
  output: z.object({
    message: z.string(),
  }),
  execute: async ({ text }, ctx) => {
    ctx.logger.info("echo tool called");
    return { message: `echo: ${text}` };
  },
});
```

预期结果：tool 文件可保存成功，无 TypeScript 报错。

## 步骤 3：创建 agent 入口

创建 `src/index.ts`：

```ts
import { defineAgent } from "@roll-agent/sdk";
import { echoTool } from "./tools/echo.ts";

const agent = defineAgent({
  name: "echo-agent",
  tools: [echoTool],
});

agent.listen().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

预期结果：入口代码完成，agent 名称为 `echo-agent`。

## 步骤 4：创建 SKILL.md

在项目根目录创建 `SKILL.md`：

```md
---
name: echo-agent
description: 一个简单的回显 Agent
metadata:
  roll-transport: stdio
  roll-command: node --experimental-strip-types src/index.ts
---

## Tools

- `echo` - 回显输入
```

预期结果：`SKILL.md` 与 `src/index.ts` 同级。

## 步骤 5：注册并调用

```bash
roll agent add ~/my-agents/echo-agent
roll agent list
roll run echo-agent echo --text "hello"
```

预期结果：

- `roll agent list` 中能看到 `echo-agent`
- `roll run` 返回 JSON 文本，包含 `echo: hello`

如果后续你的 tool 需要开放对象或复杂 JSON 输入，也可以这样调用：

```bash
roll run my-agent some_tool --input-json '{"payload":{"foo":"bar"}}'
roll run my-agent some_tool --input-file ./payload.json
```

## 下一步

- 继续看任务指南：[Register and run an agent with roll](./how-to-register-agent-with-roll.md)
- 查 API 细节：[SDK API reference](./reference-api.md)
- 如果要面向终端用户分发，可把编译后的包发布后用 `roll agent install <package>` 安装
