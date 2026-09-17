# 结构化 App 结果参考

本页适用于 Runtime Protocol 1.5 和 Relay Wire 1.2。接入步骤见 [第三方 App 接入指南](how-to-consume-app-output.md)。协议版本与 npm 包版本相互独立。

## 查询接口与返回形状

| 接口 | 用途 |
| --- | --- |
| `operation.result.get({ threadId, operationId })` | Runtime 的只读结果 RPC |
| `client.getOperationResult({ threadId, operationId })` | Node Client 的类型化封装 |
| `thread.getResult(operationId)` | Relay Client 的类型化封装 |
| `thread.capabilities()` | Relay Client 查询当前会话工具能力 |

不存在的 operation 返回 `{ "result": null }`。有效结果的形状如下，示例中的 ID 为说明用占位值：

```json
{
  "result": {
    "threadId": "<thread UUID>",
    "operationId": "<operation UUID>",
    "agentName": "structured-output-demo",
    "toolName": "list_candidates",
    "createdAt": "2026-09-17T00:00:00.000Z",
    "output": {
      "status": "available",
      "schemaId": "example.candidates",
      "schemaVersion": 1,
      "remoteReadable": true,
      "data": { "candidates": [] },
      "fallbackText": "没有找到候选人"
    }
  }
}
```

完成事件使用 `operationId`，snapshot 的 operation 使用 `id`。两者关联同一执行结果；`toolCallId` 是另一种身份。

## 结果状态

| `output.status` | 含义 | 处理方式 |
| --- | --- | --- |
| `available` | 完整业务结果可读 | 校验契约及数据后渲染 |
| `not_provided` | 工具没有提供 App 结果，或属于旧历史记录 | 继续使用已有文本展示 |
| `invalid` | 输出不符合契约或不能无损表达为 JSON | 显示输出错误，检查工具实现 |
| `too_large` | 完整结果超过字节上限 | 显示超限，不把部分数据当完整结果 |
| `expired` | 结果正文已过期或被留存策略回收 | 清除缓存，显示过期 |
| `denied` | 远程授权条件不满足 | 清除缓存，检查工具声明与本机授权 |
| `rejected` | 凭据内容检查拒绝了整份结果 | 根据 `reason` / `field` 排查公开数据 |

只有 `available` 携带业务 `data`。`rejected` 的诊断示例：

```json
{
  "status": "rejected",
  "reason": "credential_field",
  "field": "apikey"
}
```

`reason` 为 `credential_field` 或 `credential_value`；`field` 可省略，提供时只表示归一化的凭据字段类别，不包含被拒值或完整业务路径。

协议不支持应作为能力错误处理，不伪装成 `not_provided` 或空业务列表。

## 输出声明与 MCP 约定

SDK 的 `appOutput` 字段：

| 字段 | 类型 / 默认值 | 含义 |
| --- | --- | --- |
| `schemaId` | 非空字符串，最长 256 字符 | 业务契约标识，由工具作者与 App 约定 |
| `schemaVersion` | 正整数 | 业务契约版本 |
| `remoteReadable` | boolean，默认 `false` | 工具是否允许结果进入远程读取通道，不代替宿主授权 |

`output` 是业务 schema 的单一来源。SDK 要求对象根 schema；不可表达的转换、静默剥字段或不支持的引用不会被降级成其他类型。

### 非 Node Subagent 的 MCP 约定

工具定义同时提供 `outputSchema` 和 Roll 元数据：

```json
{
  "name": "list_candidates",
  "inputSchema": { "type": "object", "properties": {} },
  "outputSchema": {
    "type": "object",
    "properties": {
      "candidates": { "type": "array", "items": { "type": "object" } }
    },
    "required": ["candidates"]
  },
  "_meta": {
    "roll/appOutput": {
      "schemaId": "example.candidates",
      "schemaVersion": 1,
      "remoteReadable": true
    }
  }
}
```

成功调用返回：

```json
{
  "content": [{ "type": "text", "text": "没有找到候选人" }],
  "structuredContent": { "candidates": [] }
}
```

App 读取的是经过 Runtime 校验的 `structuredContent`，无需解析文本块中的 JSON。

### 执行完成，但输出不可用

MCP 要求缺少合法结构化输出时使用错误返回。SDK 因此发送以下配对标记，保留“执行已经完成”的事实：

```json
{
  "isError": true,
  "_meta": {
    "roll/executionStatus": "completed",
    "roll/appOutputStatus": "invalid"
  },
  "content": [
    {
      "type": "text",
      "text": "Tool execution completed; application output unavailable. Do not repeat the operation."
    }
  ]
}
```

`roll/appOutputStatus` 也可以是 `too_large`。Runtime 和 CLI 只对**已声明输出契约且配对标记完整**的工具结果区分执行成功与输出失败，普通 MCP 错误仍是错误。

此时 `roll run --json` 返回 `ok: true`、`executionStatus: "completed"` 和 `appOutputStatus`；`roll ask` 和 batch run 在成功结果中附带 `appOutputStatus`。CLI 退出码为 0，原始 MCP 结果仍保留供诊断。调用方不应因为输出不可用而自动重试已完成的操作。

### 声明错误的隔离

错误的 Roll 输出声明会禁用该工具的 App 结果通道，并记录 `appOutputIssue: "invalid_contract"` 及发现告警；同一 Agent 的健康工具保持可用。MCP 本身不合法的消息或无法编译的 `outputSchema` 仍受 MCP 校验约束。

## 内容检查与容量

App 业务数据与取证摘要使用不同的处理规则。头像 URL、普通 `data` 字符串、分页游标、邀请编码和 SKU 可以作为业务数据保留；明确的凭据字段或凭据格式会使整份结果成为 `rejected`，不会静默改写 DTO。

内容检查是补充防护，不能代替工具作者对公开字段的选择。不要把输入凭据、内部 `_meta` 或原始内部状态混入业务数据。

| 限制 | 上限 |
| --- | --- |
| 单份完整结果 | 256 KiB，按 UTF-8 序列化后的字节数计 |
| 输出 schema | 32 KiB，仅自包含 schema 和本地 JSON Pointer 引用 |
| 每线程结果正文 | 16 MiB、2,000 份、30 天，任一条件触发回收 |

超限时整份省略，不返回被截断后仍标为有效的业务对象。

## 持久化、恢复与远程授权

- 执行记录和结果状态在同一事务中保存，提交后再发送结果描述。
- 描述符是事件发生时的事实；当前是否可读以结果查询为准。
- 读路径只比较到期时间，不执行留存 UPDATE；物理回收在写入和启动时进行。
- fork 保留原始过期时间；删除线程同步清理结果；旧记录不从 raw、display 或模型消息补造数据。
- 工具声明、本机精确允许列表、认证 Workspace 必须同时允许远程读取。本机配置每次读取时重新检查。
- Relay Client 只合并进行中的相同读取，不长期缓存正文；Relay 的 query 响应不进入重放缓冲。
- Wire 1.1 继续隐藏 `display` 和 App 结果描述；混合版本通过投影兼容。相同 mutation 可按既有幂等规则重放，query 或已换参数的请求不能借重连复用旧响应。
- 当前远程通道沿用 WSS，并信任 Relay 服务转发数据；不提供端到端加密。
