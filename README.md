# 花卷 Agent (Roll)

[![License: FSL-1.1-ALv2](https://img.shields.io/badge/License-FSL--1.1--ALv2-blue.svg)](./LICENSE)
[![SDK License: MIT](https://img.shields.io/badge/SDK%20%26%20Protocol-MIT-green.svg)](./packages/sdk/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.6-339933.svg)](./package.json)

轻量级多模型 Agent 编排系统与终端工作台。支持多轮交互会话、自然语言工具路由、结构化管道执行与无人值守定时任务。

```bash
roll chat                                  # 启动交互式多轮 Agent 终端工作台
roll ask "汇总当前目录测试失败原因"          # 自然语言路由并自动提取工具参数
roll run ops-agent check_health --json     # 直接调用指定 MCP 工具并输出 JSON
```

## 设计思想

Roll 不把所有工具与重度依赖塞进一个臃肿的单体 Agent，而是围绕 **“统一编排中枢 + 可插拔专业子 Agent + 多形态入口”** 构建：

```text
       chat (多轮工作台) · ask / run (命令管道) · schedule (定时值守) · Desktop / Web UI
                               │
                               ▼
         ────────────── 编排中枢 (Roll) ──────────────
         统一模型基座 · 长会话记忆压缩 · 权限与并发控制
                  │                         ▲
                  │  MCP Tool Call          │  MCP Sampling
                  │  (SKILL.md + Schema)    │  (零密钥借用宿主模型)
                  ▼                         │
         ──────────── 可插拔专业子 Agent ─────────────
         浏览器自动化 · 领域业务工具 · Python / Go / Rust 服务
```

- **大脑集中，手脚解耦**：模型接入、会话记忆与安全审批由中枢统一管理；具体领域能力外置为独立的 [MCP](https://modelcontextprotocol.io/) 子 Agent 按需插拔，并可通过 **MCP Sampling** 反向借用宿主模型推理，子 Agent 无需重复配置密钥。
- **认知与执行分层**：以轻量的 [Agent Skills](https://agentskills.io/)（`SKILL.md`）声明“我是谁、何时调用”，以强 Schema 校验的 MCP Tool 保障参数提取与执行的确定性，避免海量工具塞满上下文。
- **同一内核，多种入口**：编排内核与交互界面分离——同一套子 Agent 与安全策略，既可用于终端交互协作（`chat`），也可用于脚本自动化管道（`ask` / `run --json`）、后台定时任务（`schedule`）及自定义桌面或 Web 客户端。

## 功能亮点

- **长对话压缩与原文回查**：接近上下文窗口阈值时自动生成摘要，并支持按需分块回查早期对话与工具输出；启动时自动加载项目目录下的 `AGENTS.md` / `CLAUDE.md` 约定。
- **多模型与订阅支持**：内置支持 Anthropic、OpenAI（含 API Key 与 ChatGPT 订阅账号登录）、Google Gemini、DeepSeek、Qwen、xAI，会话内可随时切换模型与推理强度。
- **可视化本地配置台**：运行 `roll ui` 即可在本地随机端口启动一次性 Web 控制台，完成模型表单/YAML 配置、ChatGPT 授权、定时任务与远程连接管理。
- **守护级定时调度**：内置跨重启持久化的定时任务账本与并发租约保护，支持一键安装 macOS / Windows 用户级常驻服务。

## 安装与升级

### npm 全局安装

环境要求：Node.js >= 22.6.0（源码开发需 Node.js >= 22.13.0）。

```bash
npm install --global @roll-agent/core
roll --help
roll doctor
```

> 免预装 Node.js 的跨平台独立发行包、pnpm / Volta 全局安装方式及升级恢复机制，详见 [安装和更新 Roll](./docs/how-to-install-roll.md)。

### 检查与执行更新

```bash
roll update --check    # 仅检查 Roll 本体与已注册 Agent 的可用更新
roll update            # 更新本体并刷新已注册 Agent 元数据
```

## 5 分钟快速开始

### 1. 初始化环境与模型配置

运行一站式交互向导（引导配置模型、网络、可选内建 Shell 工具与 Agent），或启动本地可视化 Web 配置台：

```bash
roll setup             # 一键交互式引导（完成后自动运行 roll doctor 自检）
roll config init       # 仅生成最小 roll.config.yaml 模板
roll ui                # 在 127.0.0.1 随机端口启动按需 Web 配置台（支持表单对比与 YAML 校验）
```

最小 `roll.config.yaml` 示例（`${VAR_NAME}` 为环境变量名占位符，切勿将密钥原文填入 `${}` 内）：

```yaml
llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers:
    anthropic:
      api-key: ${ANTHROPIC_API_KEY}
```

除 API Key 外，也可使用本机浏览器授权 ChatGPT 订阅账号（详见 [ChatGPT 订阅使用说明](./docs/how-to-use-chatgpt-subscription.md)）：

```bash
roll auth chatgpt login
```

### 2. 注册子 Agent

```bash
# 安装并注册已发布的 npm Agent 包
roll agent install @roll-agent/browser-use-agent

# 注册本地源码目录或 Git 仓库 Agent
roll agent add ./my-local-agent

# 注册远程 streamable-http MCP 服务
roll agent add --remote https://mcp.example.com/mcp --name docs-agent --description "文档检索服务"

# 查看已注册 Agent、工具契约与本地 Skills
roll agent list
roll agent tools browser-use-agent
roll skills list
```

若子 Agent 需要专属环境变量，可在 `roll.config.yaml` 的 `agents.env.<agent-name>` 下统一声明，由宿主在启动子进程时按需注入。

### 3. 运行与编排

```bash
# 交互式多轮会话（TTY 默认进入全屏 TUI；支持 /model、/resume、/compact、/status）
roll chat
roll chat "检查最近一次构建日志并定位报错模块"

# 两阶段自然语言路由（先选定 agent + tool，再严格按目标 inputSchema 提取参数）
roll ask "抓取 https://example.com 首页标题与正文摘要"

# 确定性调用（适合脚本编排与复杂 JSON 载荷）
roll run some-agent sync_records --input-json '{"dryRun":true,"batchSize":50}' --json
roll run some-agent sync_records --input-file ./payload.json

# 登记并管理无人值守定时任务（支持固定间隔或每日/每周日历规则）
roll schedule add "巡检仓库依赖安全告警并生成摘要" --name daily-audit --every 24h
roll schedule service install
```

## 生态扩展

### 开发子 Agent（`@roll-agent/sdk`，MIT 协议）

使用 TypeScript SDK 可快速定义具备 Zod Schema 校验与并行资源锁提示（`resourceHints`）的 MCP 子 Agent：

```typescript
import { defineAgent, defineTool } from "@roll-agent/sdk";
import { z } from "zod";

const writeReport = defineTool({
  name: "write_report",
  description: "将分析报告写入工作区文件",
  input: z.object({ path: z.string(), content: z.string() }),
  output: z.object({ written: z.boolean() }),
  annotations: { readOnlyHint: false, destructiveHint: true },
  resourceHints: [{ field: "path", kind: "file", mode: "write" }],
  execute: async ({ path, content }) => {
    // 执行实际文件写入逻辑
    return { written: Boolean(path && content) };
  },
});

const agent = defineAgent({ name: "report-agent", tools: [writeReport] });
agent.listen(); // 默认以 stdio MCP Server 启动；亦支持 streamable-http
```

Python、Go、Rust、Java 等任意语言实现的标准 MCP Server 均可直接接入，详见 [非 Node.js Agent 接入指南](./docs/how-to-integrate-non-node-agents.md)。

### 接入自定义桌面与 Web 客户端（MIT 协议）

Roll 支持以无头模式暴露版本化 JSON-RPC Runtime Protocol（`roll runtime serve --stdio`），供第三方 UI 宿主集成：

| 宿主形态 | 推荐依赖包（MIT） | 职责边界 |
| --- | --- | --- |
| 本地桌面 / Node 宿主 | `@roll-agent/client-node`、`@roll-agent/protocol` | Electron Main / Node 进程持有客户端连接，前端通过受控 IPC 交互 |
| 远程浏览器 Web 应用 | `@roll-agent/relay-client`、`@roll-agent/relay-protocol` | 配合本机 `roll companion` 与云端 Relay 安全转发会话与审批事件 |

## 文档导航

- **使用指南**
  - [安装和更新 Roll](./docs/how-to-install-roll.md)
  - [更新已注册的 Agent](./docs/how-to-update-registered-agents.md)
  - [使用本地 Web 配置台（`roll ui`）](./docs/how-to-use-roll-ui.md)
  - [使用 ChatGPT 订阅聊天](./docs/how-to-use-chatgpt-subscription.md)
  - [终端项目会话指南](./docs/how-to-use-chat-workspaces.md)
  - [上下文压缩与历史回查说明](./docs/how-to-context-compaction.md)
  - [使用 `roll schedule` 定时运行任务](./docs/how-to-schedule-tasks.md)
  - [Herdr 终端状态集成说明](./docs/how-to-use-herdr.md)
- **客户端与生态接入**
  - [非 Node.js Agent 接入指南](./docs/how-to-integrate-non-node-agents.md)
  - [创建第一个 Runtime UI 客户端](./docs/tutorial-runtime-ui-quickstart.md)
  - [使用 Electron、Tauri、Python 或 Next.js 接入](./docs/how-to-build-roll-runtime-ui.md)
  - [远程 Web App 接入指南](./docs/how-to-connect-remote-web-app.md)
  - [Runtime Protocol 架构与安全边界](./docs/runtime-protocol-architecture.md)
  - [Runtime Protocol v1 参考](./docs/runtime-protocol-v1-reference.md) · [`@roll-agent/client-node` 参考](./docs/client-node-reference.md) · [Relay Protocol 参考](./docs/companion-relay-v1-reference.md)
- **工程约定（贡献者与维护者）**
  - [仓库工程总则（AGENTS.md）](./AGENTS.md)
  - [架构与宿主集成](./docs/engineering/architecture.md) · [发布供应链约束](./docs/engineering/release.md)

## 仓库结构与源码开发

```
packages/
  core/                    CLI、配置、认证、多模型 Provider、Agent Registry、MCP 宿主与本地配置台
  runtime/                 ConversationEngine、ThreadStore、上下文压缩、工具桥接与 Scheduler 账本
  protocol/                版本化 Runtime Protocol 契约与 JSON Schema（MIT）
  client-node/             stdio Runtime Protocol Node.js 客户端（MIT）
  relay-protocol/          Browser、Cloud Relay 与 Local Companion 共享 Wire 契约（MIT）
  relay-client/            第三方 Web 应用使用的 Browser-safe Relay 客户端（MIT）
  companion/               本地 Companion 桥接、租约与交互管理能力
  sdk/                     MCP 子 Agent 开发 SDK：defineAgent() / defineTool()（MIT）
  browser/                 浏览器运行时抽象、上下文管理与页面探索原语
  reply-authority-client/  远程签名鉴权服务客户端
agents/
  browser-use/             基于 CDP / Playwright 的浏览器自动化子 Agent
  smart-reply/             领域结构化回复子 Agent
examples/                  Electron / Python Runtime 客户端与结构化输出示例
```

本地开发基于 Node.js 原生 Type Stripping 零编译运行（要求 Node.js >= 22.13.0，pnpm 版本见根 `package.json#packageManager`）：

```bash
pnpm install
pnpm dev -- --help       # 零编译直接运行 TypeScript CLI 入口
pnpm build               # 构建全部包与 Web 配置台静态产物
pnpm typecheck           # 全仓严格类型检查
pnpm lint                # ESLint 9 + neostandard 检查
pnpm test                # 运行内置 node:test 单元测试套件
```

## 许可协议（License）

本仓库采用**核心源码可用（Fair Source）+ 生态接入层宽松开源**的双层许可策略：

- **核心引擎、宿主与内置组件（[`FSL-1.1-ALv2`](./LICENSE)）**
  仓库根目录及 `@roll-agent/core`、`@roll-agent/runtime`、`@roll-agent/companion`、`@roll-agent/browser` 等核心与内置 Agent 包采用 **Functional Source License, Version 1.1, ALv2 Future License (`FSL-1.1-ALv2`)**：
  - 允许个人及企业**内部使用**、自托管部署、非商业教学研究，以及修改和再分发；
  - **禁止竞争性商业用途（Competing Use）**：不得将本软件包装为替代性的商业产品或对外提供托管服务（Managed Service / SaaS）；
  - **两年自动转开源**：每个发布版本自发布满 **2 年**之日起，自动转换为标准宽松开源协议 **Apache License 2.0**。
- **SDK 与协议客户端包（[`MIT`](./packages/sdk/LICENSE)）**
  `@roll-agent/sdk`、`@roll-agent/protocol`、`@roll-agent/client-node`、`@roll-agent/relay-protocol`、`@roll-agent/relay-client` 采用 **MIT License** 授权，方便第三方团队无顾虑地开发自定义 MCP 子 Agent 与客户端应用。
