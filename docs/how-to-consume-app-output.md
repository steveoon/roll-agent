# 在第三方 App 中展示 Subagent 结构化结果

Roll 负责结果契约、执行关联、持久化和授权。App 根据受信的 Agent 来源、schemaId 和版本选择自己的组件。Runtime 与客户端 SDK 不加载 Agent 提供的 HTML、JavaScript 或组件代码。

## 工具作者：显式声明业务输出

```ts
import { z } from "zod";
import { defineTool } from "@roll-agent/sdk";

const listCandidates = defineTool({
  name: "list_candidates",
  description: "Return synthetic candidates",
  input: z.object({}),
  output: z.object({
    candidates: z.array(z.object({
      id: z.string(), name: z.string(), score: z.number(), skills: z.array(z.string()),
    })),
  }),
  appOutput: { schemaId: "example.candidates", schemaVersion: 1, remoteReadable: true },
  annotations: { readOnlyHint: true },
  execute: async () => ({ candidates: [] }),
});
```

`remoteReadable` 默认 false。声明它不等于取得远程授权；仍须本机允许该工具。未声明 `appOutput` 的工具保持原有输出路径。

`output` 是单一契约来源，必须能准确表达为 JSON Schema 对象；不能表示的转换或规则在注册阶段失败。仅支持自包含 schema 和本地 JSON Pointer 引用，不从网络解析 `$ref`。SDK 用 MCP `outputSchema` 和 `structuredContent` 承载结果。

非 Node Subagent 使用等价 MCP 定义：

```json
{
  "name": "list_candidates",
  "inputSchema": { "type": "object", "properties": {} },
  "outputSchema": { "type": "object", "properties": { "candidates": { "type": "array", "items": { "type": "object" } } }, "required": ["candidates"] },
  "_meta": { "roll/appOutput": { "schemaId": "example.candidates", "schemaVersion": 1, "remoteReadable": true } }
}
```

成功的工具结果把业务对象放在 `structuredContent`，`content` 保留文本回退。不要将输入凭据、原始内部状态或 `_meta` 放进业务 DTO。

如果工具已经完成操作，但输出验证失败，SDK 返回 `isError: true`，同时带 `_meta["roll/executionStatus"] = "completed"` 和 `_meta["roll/appOutputStatus"] = "invalid"`（或 `"too_large"`）。Runtime 仅对已声明契约且标记配对完整的结果区分“执行完成”和“App 输出不可用”。独立 MCP 实现应使用相同约定；普通 MCP 错误不被猜测为执行成功。输出错误不触发工具自动重试。

## 本地客户端

Runtime Protocol 1.5 的 `initialize.features` 包含 `app-output`。完成事件和 operation snapshot 中的 `appOutput` 是轻量描述，正文使用只读接口获取：

```ts
const response = await client.getOperationResult({ threadId, operationId });
if (response.result?.output.status === "available") {
  const { agentName, toolName, output } = response.result;
  // 先验证来源、schemaId、schemaVersion 和 data，再调用 App 自己注册的组件。
  renderRegisteredResult({ agentName, toolName, output });
}
```

等价 RPC 为 `operation.result.get({threadId, operationId})`，不存在 operation 时返回 `{result: null}`。不支持该协议时显示能力不支持，不把它表示为空业务数据。

状态含义：

| 状态 | UI 行为 |
| --- | --- |
| available | 使用受信组件，未知契约回退到有界 JSON 或文本 |
| not_provided | 工具没有提供结构化结果，继续显示已有文本 |
| invalid | 显示输出不符合契约，不自动重跑工具 |
| too_large | 显示完整结果超限，不展示被截断的业务对象 |
| expired | 显示历史结果已到期 |
| denied | 隐藏正文并清除对应缓存，显示无读取权限 |

组件错误应局限于单份结果。缓存按 Workspace/thread/operation 隔离；刷新和重连要重新读取。持久事件中的描述是发生当时的事实，当前是否可读以结果查询为准。

## 远程客户端与宿主授权

沿用现有应用后端认证、Workspace 绑定、设备配对和 WSS。首轮信任 Relay 服务转发数据；不提供端到端加密。

在本机 `~/.roll-agent/companion/config.yaml` 的现有配置中加入精确允许列表，保留已有身份、工作区和凭据引用字段：

```yaml
remoteAppOutputs:
  - agentName: structured-output-demo
    toolName: list_candidates
```

默认没有授权。工具的 `remoteReadable`、本机允许列表、当前认证 Workspace 必须同时允许；云端和浏览器不能写入此授权。本机配置每次读取时重新加载，移除条目后新查询立即拒绝；当前已显示的内容无法从用户记忆或外部副本中撤回，App 应在重连/刷新/拒绝时清除自己的缓存。

Web 需要 Relay Wire 1.2 和 Runtime Protocol 1.5。将客户端版本列表通过应用后端转交 Relay，Workspace 始终从服务端用户绑定记录读取：

```ts
const client = createRelayClient({
  getSession: async ({ signal, supportedRelayProtocolVersions }) => {
    const response = await fetch("/api/roll/session", {
      method: "POST", credentials: "include", signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ supportedRelayProtocolVersions }),
    });
    if (!response.ok) throw new Error("Session unavailable");
    return response.json();
  },
});
await client.connect();
const thread = await client.openThread(threadId);
const capabilities = await thread.capabilities();
const response = await thread.getResult(operationId);
```

应用后端向 `POST /v1/browser-sessions` 发送 `{workspaceId, supportedRelayProtocolVersions}`。未提供版本列表仍按旧客户端处理为 1.1。会话选择的版本签入 ticket，并由 `session.ready.relayProtocolVersion` 确认；正在使用的连接不切换版本。

新结果查询只合并进行中的相同读取，不缓存已完成正文；Relay 也不把查询响应写入重放缓冲。旧 Wire 1.1 继续隐藏 `display`，不传结构化结果。旧新客户端混用通过版本投影兼容，新能力需要整条链路支持。

## 容量和历史语义

完整结果最大 256 KiB，schema 最大 32 KiB；均按 UTF-8 字节计。超过上限整份省略，不修改字段类型或删掉部分行后冒充完整结果。每线程最多保留 16 MiB、2000 份结果、30 天，任一上限触发回收。

结果与执行记录同事务落库，提交后才发送完成事件。fork 保留原过期时间；删除线程删除对应结果。旧记录不从 raw、display 或模型消息中推断业务对象。事件 JSON 保持旧格式，新事件描述放在独立存储列，保证旧 Runtime 可以继续读取原有事件。

## 示例与验收

`examples/structured-output/` 提供合成候选人 Subagent、定制 Web 表格及演示后端。Electron 参考客户端提供同一契约的候选人卡片。两端组件相互独立。

跨仓隔离联调命令：

```sh
ROLL_TEST_RELAY_REPO=/absolute/path/to/updated/roll-cloud-relay \
  node --experimental-strip-types --experimental-sqlite scripts/test-structured-output-e2e.mjs
```

Relay 仓库需要已构建的新协议候选包或正式发布版本。脚本使用临时配置、真实 Runtime 与 SDK 子进程、实际 Relay WebSocket 服务和正式客户端状态机，不改变用户的 Companion 配对。

`--serve` 可保留隔离实例用于 GUI 验收。浏览器的回环 QA 适配仅用于本地 WS；不代替线上 WSS/TLS 和部署验证。正式版本包发布前，跨仓本地包验证与从 npm 全新安装的验证应分别记录。
