# 让第三方 Web App 使用用户电脑上的 Roll

本指南面向普通第三方 Web 开发者。接入工作仅涉及两处：应用后端将当前已登录用户兑换为短期
Relay Session，前端直接调用浏览器安全的 `@roll-agent/relay-client`。应用本身无需启动 Runtime、
无需解析底层 Relay 协议帧，也不会接触设备凭据或用户本机路径。

> 当前状态：官方生产 Relay 已部署于 `sponge-mcp.duliday.com`，实现了本仓库的
> [`roll-cloud-relay-openapi.yaml`](./contracts/roll-cloud-relay-openapi.yaml) 控制面契约。
> 本机 `roll companion` 默认连接该官方地址；本地开发联调时可通过 `ROLL_COMPANION_RELAY_HOST`
> 环境变量覆盖目标地址（仅限本机回环地址允许降级为 `ws://` / `http://`，其余非法覆盖值一律按 fail-closed 拒绝）。

## 1. 应用后端：签发 Browser Session

第三方应用的 Relay 服务端凭据（server credential）只能保存在后端。以下示例不绑定具体 Web 框架，展示了必需的鉴权与禁止缓存边界：

```ts
export async function createRollSession(request: Request): Promise<Response> {
  const user = await requireCurrentUser(request);
  const credential = process.env.ROLL_RELAY_SERVER_CREDENTIAL;
  const relayHost = process.env.ROLL_RELAY_HOST ?? "sponge-mcp.duliday.com";
  if (credential === undefined) {
    return Response.json({ error: "Roll Relay is not configured" }, { status: 503 });
  }

  const upstream = await fetch(`https://${relayHost}/v1/browser-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({ subject: user.id }),
    signal: request.signal,
  });

  const body: unknown = await upstream.json();
  return Response.json(body, {
    status: upstream.status,
    headers: { "cache-control": "no-store" },
  });
}
```

该接口应挂载在应用自身的同源路由（如 `/api/roll/session`）下。请求体严禁接受前端传入的
`deviceId`、`workspaceId`、`cwd`、Relay URL 或方法白名单；租户身份与唯一绑定的 Workspace
完全由 Relay 根据服务端凭据与当前用户的 `subject` 确定。此外，每个服务端凭据在 Relay 管理面都预先绑定了唯一允许的浏览器 `Origin`：应用后端无法在请求中覆盖该值，浏览器发起 WebSocket 握手时的 `Origin` 请求头必须与票据绑定的源完全一致。

## 2. 浏览器：使用 Relay Client

```bash
pnpm add @roll-agent/relay-client
```

```ts
import { createRelayClient } from "@roll-agent/relay-client";

const client = createRelayClient({
  async getSession({ signal, supportedRelayProtocolVersions }) {
    const response = await fetch("/api/roll/session", {
      method: "POST",
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) {
      throw new Error(`Unable to create Roll session (${response.status})`);
    }
    // supportedRelayProtocolVersions 默认为 ["1.2", "1.1"]；后端若对接支持版本协商的会话网关可按需透传。
    void supportedRelayProtocolVersions;
    return response.json() as Promise<unknown>;
  },
  // 当云端 Relay 与本机 Companion 均已升级支持 Wire 1.3 时，可显式声明：
  // relayProtocolVersions: ["1.3", "1.2", "1.1"],
});

client.subscribeConnection((state) => {
  renderConnectionState(state);
});

await client.connect();

const { items } = await client.listThreads();
const thread =
  items[0] === undefined ? await client.createThread() : await client.openThread(items[0].id);

thread.subscribe((view) => {
  // view 包含 snapshot、liveAssistantMessages、interactions、turn 与 contextRecovery（Wire 1.3 下更新，旧版本为 null）
  renderChat(view);
});

await thread.send("请总结这个项目当前的状态");
```

`createRelayClient()` 默认向 `getSession` 传入 `supportedRelayProtocolVersions: ["1.2", "1.1"]`，以兼容现有 Relay 服务的版本白名单；当部署的 Relay 服务与本机 Companion 均支持 Wire `1.3` 时，可通过 `relayProtocolVersions: ["1.3", "1.2", "1.1"]` 启用 `1.3`。

UI 通过 `thread.subscribe()` 接收 Snapshot、流式回复增量、Turn 状态、待处理交互以及 `view.contextRecovery`（Wire `1.3` 下随 Snapshot 和 `context.recovery.changed` 事件同步有界上下文恢复门禁状态，Wire `1.2/1.1` 下恒为 `null`）。审批（Approval）与用户输入（User Input）统一通过 `thread.respond()` 提交：

```ts
const pending = view.interactions.find((item) => item.status === "pending");
if (pending?.request.method === "approval.request") {
  await thread.respond(pending.request.interactionId, { decision: "approve" });
}

if (pending?.request.method === "userInput.request") {
  await thread.respond(pending.request.interactionId, {
    status: "submitted",
    values: [{ id: "region", value: "north" }],
  });
}
```

在协商到 Relay Wire `1.2` 或 `1.3` 时，客户端还提供会话能力查询与工具结构化输出（`appOutput`）的按需读取：

```ts
const { manifest } = await thread.capabilities();

// 当 OperationView 或 tool.completed 事件中的 appOutput.status === "available" 时按需拉取：
const { result } = await thread.getResult(operationId);
if (result?.output.status === "available") {
  renderStructuredAppOutput(result.output.schemaId, result.output.data, result.output.fallbackText);
}
```

只有工具本身声明 `remoteReadable: true` 且用户本机 Companion 已为对应的 `agentName + toolName` 配置 `remoteAppOutputs` 授权时，`thread.getResult()` 才会返回完整 `data`；未授权时返回 `{ status: "denied" }`，而在仅协商到 Wire `1.1` 的会话上调用该方法会直接以 `PROTOCOL_ERROR` 拒绝。

应用无需自行处理请求关联、幂等 `requestId`、序列确认（ACK）、去重或缺口（gap）恢复，这些逻辑均由客户端内置完成。若当前页面未刷新，但已发出的写操作因断线等原因无法确认执行结果，客户端会抛出错误码为 `OUTCOME_UNKNOWN` 的 `RelayClientError`。此时若已知 Thread ID，应调用 `thread.refresh()` 重新拉取快照；若 `createThread()` 结果未知且尚未拿到 Thread ID，则应调用 `listThreads()` 并结合业务标识收敛状态。仅在底层连接实际断开时依赖客户端自动重连，任何情况下都不要自动重发第二个写操作。

浏览器整页刷新后，原有的内存态 Promise 已销毁；新创建的客户端实例不会猜测或重放刷新前的写操作，而是重新打开 Thread 并基于最新 Snapshot 收敛界面。由于远程脱敏后的 Snapshot 不包含可直接响应的 `interactionId`，Cloud Relay 必须向新建的 Browser Session 重新投递尚未结算的 `interaction.request`。

## 3. 用户电脑：一次性安装和绑定

面向终端用户的正式交付应通过官方签名安装包或企业软件分发工具完成：

1. 安装版本匹配的 Node.js、Roll 与当前用户级（per-user）Companion 服务。
2. 使用管理员或产品后台签发的一次性配对码（pairing code），在受控安装流程中执行
   `roll companion enroll --code-stdin --workspace <absolute-path>`。
3. 执行 `roll companion service install`，使服务在当前系统用户登录后自动启动。

后台服务部署注意事项（`launchd` 或系统计划任务不会继承交互式终端的 Shell 环境变量）：

- 模型服务的 API Key 应直接写入 `roll.config.yaml`，避免依赖 `${ENV_VAR}` 环境变量占位符。
- 建议使用 Node.js `>=22.13.0`，以便内置 `node:sqlite` 无需额外传递 `--experimental-sqlite` 启动参数。

在本地开发或受控 OEM 环境中也可直接通过 CLI 完成配置，但一次性配对码必须由受信任的上游进程通过标准输入（stdin）传入，严禁出现在命令行参数、配置文件或日志中：

```bash
provisioning-command-that-prints-only-the-code \
  | roll companion enroll --code-stdin --workspace /absolute/project/path
roll companion service install
roll companion status --json
```

完成绑定后，终端用户日常只需打开第三方 Web App 即可直接对话。本机 Companion 会自动连接官方生产 Relay
（`sponge-mcp.duliday.com`），托管 `roll runtime serve --stdio` 子进程，并固定锁定已绑定的本机 Workspace；用户无需关心 Companion、Runtime、协议版本或工作目录。运维与开发人员可通过 `roll companion doctor --json` 和 `roll companion logs --follow` 排查运行状态。

## 4. 上线前检查

- 第三方应用后端绝不向浏览器暴露 Relay 服务端凭据（server credential）。
- Browser Session 票据有效期不超过 60 秒、仅限单次消费，并严格绑定所属应用、`Origin`、`subject` 与 Workspace。
- 本机 Companion 仅发起主动出站 WSS 连接；本机控制面仅监听 Unix Domain Socket 或 Windows Named Pipe。
- 云端与前端均无法指定或修改 `cwd`；工作目录只能在本机执行 `enroll` 或 `workspace set` 时变更。
- 当本机 Companion 或 Runtime 离线时，Relay 直接拒绝新的 `turn.start` 请求，不做离线消息排队。
- 本机 Runtime 配置的 `auto` / `confirm` / `deny` 审批策略是唯一事实源；Web 端只能响应 `confirm` 交互，无法绕过 `deny`。
- 凡遇到 `Origin` 不匹配、票据过期或重复使用、Workspace 不一致、降级到 Wire `1.0` 或消息传输方向非法的情况，均按 fail-closed 原则立即拒绝。

Cloud Relay 服务端实现者还应使用
[`@roll-agent/relay-protocol/control`](../packages/relay-protocol/src/control.ts) 导出的 Schema、方向白名单与测试夹具完成一致性校验；普通第三方 Web App 无需直接安装该协议包。
