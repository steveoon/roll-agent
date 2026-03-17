# @roll-agent/sdk

用于开发 Roll 子 Agent 的 TypeScript SDK。  
SDK 当前负责封装 MCP Server 的 `stdio` 运行时；远程 `streamable-http` 服务端能力仍由业务方自行实现或部署。

如果你的 tool 需要开放对象或复杂 JSON payload，建议同时考虑 `roll run --input-json` / `--input-file` 的调用体验；`roll ask` 更适合参数可以从自然语言可靠提取的 tool。

最近 `roll-core` 已经演进出一套更明确的调用模型：

- `ask` 采用“两阶段”：先选 tool，再按真实 `inputSchema` 提参
- tool 参数会经过统一的 `tool-runtime` preflight 校验
- 对开放对象/复杂 payload，commander 会要求显式输入，而不是让 LLM 猜

## 安装

```bash
npm install @roll-agent/sdk zod
```

## 文档导航（Diátaxis）

- Tutorial（新手跟做）: [Build your first agent](./docs/tutorial-build-first-agent.md)
- How-to（任务指南）: [Register and run an agent with roll](./docs/how-to-register-agent-with-roll.md)
- Reference（查阅手册）: [SDK API reference](./docs/reference-api.md)
- Explanation（设计说明）: [SDK design and architecture](./docs/explanation-design.md)

## 快速入口

如果你第一次接入，请先看 Tutorial：  
[Build your first agent](./docs/tutorial-build-first-agent.md)
