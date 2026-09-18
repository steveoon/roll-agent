# 让第三方 App 展示 Subagent 的结构化结果

这份指南面向已有 App 的开发者：让 Subagent 返回业务数据，经 Roll Runtime 传到客户端，再用 App 自己的组件展示。

本文以候选人列表为例。同一份数据可以在 Web 中显示为表格，在 Electron 中显示为卡片；Roll 不要求两端使用相同的组件或框架。

## 开始前

确认你已经有可连接的 Runtime、已注册的 Subagent，以及能打开会话的客户端。远程 Web 还需要完成现有的 [Companion / Relay 接入](companion-relay-v1-reference.md)。

| 接入方式 | 所需能力 | 客户端 |
| --- | --- | --- |
| 本地 Node / Electron | Runtime Protocol **1.5**，`initialize.features` 包含 `app-output` | `@roll-agent/client-node` |
| 远程 Web | Runtime Protocol **1.5** + Relay Wire **1.2** + 本机工具授权 | `@roll-agent/relay-client` |

这里的协议版本与 npm 包版本是两套编号。使用未发布分支时，需要配套的本地候选包；不要假定 npm 上的旧包已经包含这些接口。

你只需要按顺序完成四件事：

1. **工具端**：声明输出契约并返回数据。
2. **连接端**：选择本地或远程接入，远程接入增加本机授权。
3. **App 端**：按 operation 读取结果，交给自己的渲染器。
4. **验证**：检查新执行、历史恢复和拒绝状态。

## 1. 为工具声明结构化输出

如果 Subagent 已经声明了输出契约，可以直接跳到第 2 步。

下面是一个最小的 Node Subagent。`output` 定义数据形状，`appOutput` 标识这份业务契约，`execute()` 返回普通对象。

```ts
import { defineAgent, defineTool } from "@roll-agent/sdk";
import { z } from "zod";

const listCandidates = defineTool({
  name: "list_candidates",
  description: "返回用于 UI 联调的合成候选人数据",
  input: z.object({}),
  output: z.object({
    candidates: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        score: z.number().min(0).max(1),
        skills: z.array(z.string()),
      }),
    ),
  }),
  appOutput: {
    schemaId: "example.candidates",
    schemaVersion: 1,
    remoteReadable: true,
  },
  annotations: { readOnlyHint: true },
  execute: async () => ({
    candidates: [
      {
        id: "demo-1",
        name: "李明（演示）",
        score: 0.9,
        skills: ["TypeScript", "Node.js"],
      },
    ],
  }),
});

await defineAgent({
  name: "structured-output-demo",
  tools: [listCandidates],
}).listen();
```

**检查结果：**工具通过 MCP `tools/list` 暴露 `outputSchema` 和 `_meta["roll/appOutput"]`；成功调用时，业务对象出现在 `structuredContent` 中。这些包装由 SDK 完成，工具作者无需手动构造。

注意两点：

- `remoteReadable` 默认是 `false`。设为 `true` 只表示工具愿意分享，远程读取仍需要第 2 步的本机授权。
- 输出必须是完整的 JSON 对象。不要为了展示效果修改字段类型，也不要把组件代码放进返回值。

非 Node Subagent 可以实现同一 MCP 约定，见 [MCP 输出参考](app-output-reference.md#非-node-subagent-的-mcp-约定)。

## 2. 选择连接方式

### 本地 Node / Electron

沿用现有的 `RollNodeClient` 连接。在协商结果中检查 `app-output`，再按 operation ID 读取：

```ts
if (!client.getInitializationResult().features.some((feature) => feature === "app-output")) {
  throw new Error("当前 Runtime 不支持结构化结果，请先升级");
}

const response = await client.getOperationResult({ threadId, operationId });
```

`threadId` 来自当前会话；`operationId` 来自完成事件的 `operationId` 或 snapshot 中的 `operation.id`。不要把 `toolCallId` 当作 `operationId`。

Electron 应由主进程使用 Node Client，再通过明确的 IPC 方法把结果交给 renderer。完整连接方式见 [Node Client 参考](client-node-reference.md)。

### 远程 Web

先在本机 `~/.roll-agent/companion/config.yaml` 的**已有配置中追加**下面的允许列表，保留原有设备身份、工作区和凭据引用：

```yaml
remoteAppOutputs:
  - agentName: structured-output-demo
    toolName: list_candidates
```

授权按 Agent 和工具名称精确匹配。工具声明、本机允许列表、当前认证 Workspace 三者必须同时允许。

然后让 App 后端把客户端支持的协议版本转交给 Relay：

```ts
import { createRelayClient } from "@roll-agent/relay-client";

const client = createRelayClient({
  getSession: async ({ signal, supportedRelayProtocolVersions }) => {
    const response = await fetch("/api/roll/session", {
      method: "POST",
      credentials: "include",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ supportedRelayProtocolVersions }),
    });
    if (!response.ok) throw new Error("无法创建 Relay 会话");
    return response.json(); // { connectUrl, expiresAt }
  },
});

await client.connect();
const thread = await client.openThread(threadId);
const capabilities = await thread.capabilities();
const response = await thread.getResult(operationId);
```

应用后端的 `/api/roll/session` 需要：

1. 校验 App 自己的登录身份。
2. 从服务端绑定记录查出 `workspaceId`，不接受浏览器自行指定。
3. 向 Relay 的 `POST /v1/browser-sessions` 发送 `{ workspaceId, supportedRelayProtocolVersions }`。
4. 将 `{ connectUrl, expiresAt }` 返回浏览器，不返回 Relay 应用密钥。

**检查结果：**Relay 会话协商到 Wire 1.2，`thread.getResult()` 能读到结果。未传版本列表会保留旧版 1.1 行为，无法启用新通道。`capabilities` 用于检查当前工具的有效输出能力，数据读取本身仍会再次校验授权。

可运行的后端示例见 [演示服务器](../examples/structured-output/server.mjs)。它使用演示登录方式；接入业务 App 时复用自己的认证和用户绑定记录。

## 3. 按结果身份选择 App 自己的组件

先理解结果从哪里来：

```text
工具执行 → Runtime 校验、保存 → 完成事件 / snapshot 提供结果描述
                                        ↓
                            App 按 operationId 查询完整结果
                                        ↓
                              校验数据 → 自定义组件
```

完成事件和 snapshot 的 `appOutput` **只有状态和契约身份，没有业务正文**。收到描述后，再使用上一步的查询方法。

建议让渲染入口按下面的顺序处理：

| 收到什么 | App 应做什么 |
| --- | --- |
| `response.result === null` | 显示结果不存在或已被移除 |
| `output.status !== "available"` | 清除旧正文，展示对应状态；不要因此重新执行工具 |
| 来源、schema 和版本都匹配 | 再校验 `output.data`，交给已注册的业务组件 |
| 契约不认识或版本不支持 | 显示有界 JSON 预览或 `fallbackText` |
| 某个组件渲染失败 | 只回退当前结果卡片，保持聊天和其他结果可用 |

本例的组件匹配条件是：

```ts
result.agentName === "structured-output-demo" &&
result.toolName === "list_candidates" &&
result.output.status === "available" &&
result.output.schemaId === "example.candidates" &&
result.output.schemaVersion === 1
```

匹配成功后，候选人数据位于 `result.output.data.candidates`。App 可以用 React、原生 DOM 或其他框架展示，但仍要验证组件实际读取的字段，不能仅凭 schema 名字信任数据。

完整的“读取 → 校验 → 表格渲染 → 回退”实现见 [Web 示例](../examples/structured-output/web.ts)。组件随 App 自身发布，Runtime 不会下载或执行 Subagent 提供的组件代码。

## 4. 验证新执行、历史恢复和授权

先在配置好的联调环境检查：

- **新执行**：产生新的 operation，App 能读取并展示结果。
- **历史恢复**：刷新页面或重新连接，重新获取 snapshot 和结果后仍能展示。
- **撤销授权**：从本机允许列表移除工具，再读取时返回 `denied`；App 清除旧正文。
- **未知契约 / 不可用结果**：显示回退内容或状态，不自动重跑工具。

不要长期缓存已完成结果来代替新的授权检查。结果缓存至少按 Workspace、thread、operation 隔离；断线时清除可见旧数据，重新连接后重新读取。

如果要使用仓库提供的隔离测试，在 Roll 仓库根目录执行：

```sh
# 使用相邻的 roll-cloud-relay 仓库；也支持现有 worktree 的相邻 relay 目录。
pnpm test:structured-output

# 保持隔离服务运行，以便查看演示页面。
pnpm test:structured-output --serve
```

Relay 不在相邻目录时，显式传入路径：

```sh
ROLL_TEST_RELAY_REPO=/absolute/path/to/roll-cloud-relay \
  pnpm test:structured-output
```

测试需要已准备好的配套协议包和 Relay 依赖。它使用临时配置、实际 SDK/Runtime 子进程和真实 Relay 服务端代码，不修改用户原有的 Companion 配对。

自动测试输出 `passed: true` 表示通过；`--serve` 还会打印页面地址和演示登录信息。测试数据固定，因此**新执行与历史读取可能显示相同内容**；两者区别在会话、operation 和是否发生了工具执行。

本地浏览器联调使用明确的回环 WS 适配。它验证数据链路和 UI，不替代线上 WSS/TLS、正式依赖安装或真实大模型验收。完整运行步骤见 [示例 README](../examples/structured-output/README.md)。

## 排查与进一步阅读

- Companion 显示配置问题或 Runtime 离线：[后台运行环境诊断](how-to-diagnose-companion-environment.md)。

- 结果不可用、容量限制、MCP 返回格式：[结构化结果参考](app-output-reference.md)。
- 本地 RPC、事件与版本兼容：[Runtime Protocol 参考](runtime-protocol-v1-reference.md)。
- 远程会话与协议边界：[Companion / Relay 参考](companion-relay-v1-reference.md)。
- 发布前还需要完成哪些验证：[验证记录](structured-output-validation.md#release-gates-still-open)。
