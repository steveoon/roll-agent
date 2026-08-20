# 让第三方 Web App 使用用户电脑上的 Roll

本指南面向普通第三方 Web 开发者。应用只需要两处接入：后端把当前登录用户兑换成短期
Relay Session，前端使用 Browser-safe 的 `@roll-agent/relay-client`。应用不启动 Runtime、
不解析 Relay frame，也不接触设备凭据或本机路径。

> 当前状态：生产 Relay 已部署于 `sponge-mcp.duliday.com`，实现本仓库的
> [`roll-cloud-relay-openapi.yaml`](./contracts/roll-cloud-relay-openapi.yaml) 合同
> （2026-08 实测：redeem 返回合同错误体，`/v1/companion` WSS 握手 101）。
> Companion 默认指向该官方 host；开发调试可用 `ROLL_COMPANION_RELAY_HOST`
> 环境变量覆盖，仅 loopback 覆盖允许降级 `ws://`/`http://`，非法覆盖值 fail-closed。

## 1. 应用后端：签发 Browser Session

第三方的 Relay server credential 只能保存在后端。以下示例省略了具体 Web 框架，但保留了
必须的认证和缓存边界：

```ts
export async function createRollSession(request: Request): Promise<Response> {
  const user = await requireCurrentUser(request);
  const credential = process.env.ROLL_RELAY_SERVER_CREDENTIAL;
  // 官方 Relay 域名尚未确定；发布前它会成为固定值，在此之前由你自行注入。
  const relayHost = process.env.ROLL_RELAY_HOST;
  if (credential === undefined || relayHost === undefined) {
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

这个接口应挂在应用自己的同源地址，例如 `/api/roll/session`。请求体不能接受
`deviceId`、`workspaceId`、`cwd`、Relay URL 或 allowed methods；Tenant 和唯一 Workspace
都由 Relay 根据 server credential 与当前 `subject` 决定。P0 的每个 server credential 还在
Relay 管理面预注册唯一 Browser Origin：后端不能在请求中覆盖它，WebSocket 握手的 `Origin`
必须与 ticket 内绑定值完全一致。

## 2. 浏览器：使用 Relay Client

```bash
pnpm add @roll-agent/relay-client
```

```ts
import { createRelayClient } from "@roll-agent/relay-client";

const client = createRelayClient({
  async getSession({ signal }) {
    const response = await fetch("/api/roll/session", {
      method: "POST",
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) {
      throw new Error(`Unable to create Roll session (${response.status})`);
    }
    return response.json() as Promise<unknown>;
  },
});

client.subscribeConnection((state) => {
  renderConnectionState(state);
});

await client.connect();

const { items } = await client.listThreads();
const thread = items[0] === undefined
  ? await client.createThread()
  : await client.openThread(items[0].id);

thread.subscribe((view) => {
  renderChat(view);
});

await thread.send("请总结这个项目当前的状态");
```

UI 从 `thread.subscribe()` 得到 Snapshot、流式 assistant 文本、Turn 状态以及待处理
Interaction。Approval 和 User Input 都通过同一个方法回应：

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

应用不需要实现 request correlation、mutation ID、ACK、sequence 去重或 gap 恢复；这些由
客户端完成。同一页面仍存活时，已经发送但尚未确认结果的 mutation 可能返回
`OUTCOME_UNKNOWN`。已知 Thread 应主动调用 `thread.refresh()`；若 `createThread()` 的结果未知
且没有 Thread ID，则调用 `listThreads()` 并按应用自己的业务关联重新收敛。只有实际连接
断开时才依赖自动重连，任何情况都不要自行生成第二个 mutation。
完整页面刷新后旧 Promise 已不存在；新客户端不会猜测或重投刷新前的 mutation，而是重新
打开 Thread 并从 Snapshot 收敛。Relay 还必须向新 Browser Session 重投未完成的
`interaction.request`；Snapshot 本身不能恢复可响应的 `interactionId`。

## 3. 用户电脑：一次性安装和绑定

正式用户旅程应由官方签名安装器或企业软件分发完成：

1. 安装版本匹配的 Node、Roll 与 per-user Companion 服务。
2. 用管理员或产品发放的一次性 code，在受保护的安装流程中调用
   `roll companion enroll --code-stdin --workspace <absolute-path>`。
3. 调用 `roll companion service install`，以后在当前用户登录时自动启动。

服务化部署前提（launchd / 计划任务环境不继承用户 shell 的环境变量）：

- LLM API key 需以字面值写入 `roll.config.yaml`，不要依赖 `${ENV_VAR}` 引用。
- 建议 Node ≥22.13，使 `node:sqlite` 无需 `--experimental-sqlite` 旗标。

开发和受控 OEM 环境也可以直接使用 CLI，但 pairing code 必须由受保护的上游进程写入
stdin，不能放进命令行参数、配置或日志：

```bash
provisioning-command-that-prints-only-the-code \
  | roll companion enroll --code-stdin --workspace /absolute/project/path
roll companion service install
roll companion status --json
```

绑定后，日常用户只打开第三方 Web App 并聊天。Companion 自动连接内置的官方 Relay
（`sponge-mcp.duliday.com`），
管理 `roll runtime serve --stdio`，并固定使用本机已绑定的 Workspace；用户不需要理解
Companion、Runtime、Wire 或 cwd。IT/开发人员可用 `roll companion doctor --json` 和
`roll companion logs --follow` 做诊断。

## 4. 上线前检查

- 第三方后端从未向 Browser 暴露 Relay server credential。
- Browser Session ticket 为 60 秒、单次消费，并绑定 App、Origin、subject 与 Workspace。
- Companion 只建立出站 WSS，本机控制面只使用 Unix Socket 或 Windows Named Pipe。
- 云端无法设置 cwd；Workspace 只能在本机 enrollment 或 `workspace set` 时改变。
- Relay 在 Companion/Runtime 离线时拒绝新的 `turn.start`，不进行离线排队。
- Runtime 的 `auto/confirm/deny` 是唯一审批事实源；`deny` 无法由 Web 越过。
- 错误 Origin、过期/重复 ticket、错误 Workspace、Wire 1.0 和错误方向消息都 fail closed。

Relay 实现者还应同时使用
[`@roll-agent/relay-protocol/control`](../packages/relay-protocol/src/control.ts) 的 Schema、方向
allowlist 和 fixtures 做 conformance。普通 Web App 不需要直接安装该协议包。
