# ADR 0001：远程 Web 接入由官方 Companion 承担本机信任边界

- 状态：Accepted
- 日期：2026-08-06
- 决策范围：Roll Runtime、Companion、Relay Wire、Browser SDK 与 Cloud Relay 的责任边界

## 背景

Roll Runtime Protocol 是受信本地协议。`roll runtime serve --stdio` 不认证网络连接，
也不管理设备身份、租户、Relay 重连或本机 Workspace 映射，因此不能直接暴露给浏览器或
Cloud Relay。

远程 Web 产品需要一条最小但完整的链路：

```text
第三方 Web App
├─ Browser: @roll-agent/relay-client
└─ Backend: POST /api/roll/session
                 │
                 ▼
Cloud Relay（独立仓库）
                 │ authenticated WSS
                 ▼
roll companion（本机 per-user 服务）
                 │ stdio
                 ▼
roll runtime serve --stdio
```

## 决策

1. Roll 官方交付 `roll companion` CLI 与常驻本机服务。P0 不发布稳定的
   `@roll-agent/companion-host` SDK。
2. `@roll-agent/companion` 继续是低层 Bridge、Lease 与 Interaction 基础包；普通第三方
   Web 开发者不直接依赖它。
3. 普通 Web App 只安装 `@roll-agent/relay-client`。它负责 Wire correlation、恢复、ACK、
   gap 与 Chat/Interaction reducer，但不暴露 raw frame。
4. Relay Wire 1.1 继续作为 Chat 数据面。Browser session bootstrap 使用独立 Control 1.0
   合同，不把账号、租户或 WebSocket 生命周期塞入数据面 union。
5. Cloud Relay 服务、账号/租户数据库与设备 enrollment 属于独立
   `roll-cloud-relay` 仓库。本仓库只维护共享 Schema、fixtures、客户端与 conformance。
6. `roll chat --server` 保持兼容；Companion 只启动正式入口
   `roll runtime serve --stdio`。

## P0 固定拓扑

- 一个受信官方 Relay profile；终端用户不能输入任意 Relay URL。
- 一个设备、一个 Workspace、一个 controller。
- Runtime Protocol 1.3，Relay Wire 1.1，Browser Control 1.0。
- 只支持文本 Chat、Approval 与 User Input。
- Companion 只建立出站 WSS，不监听 TCP。CLI 控制使用权限受限的 Unix Socket 或 Windows
  Named Pipe。
- 云端不能指定或修改 cwd。`enroll`/`workspace set` 必须在本机 canonicalize 并验证目录。

## 安全不变量

### 身份与凭据

- 第三方后端用自己的 server credential 兑换 60 秒、单次消费的 Browser ticket。P0 每个
  credential 在 Relay 管理面只对应一个注册 Browser Origin，请求体不能覆盖它。
- Browser ticket 绑定 App、该注册 Origin、subject 与唯一 Workspace；消费时必须严格校验
  WebSocket `Origin` header。
- Ticket/Origin 校验失败必须拒绝 HTTP WebSocket upgrade，不能先建立未认证 WebSocket 再发送
  `session.error`；成功连接的第一帧仍唯一是 `session.ready`。
- Device credential 只进入 macOS Keychain 或 Windows 当前用户保护存储；YAML 只保存
  credential reference。
- Pairing code 只从 stdin 或安装器受保护通道读取，不进入 argv、日志或配置。
- Relay 必须保留尚未终止的 `interaction.request`，并在 Browser session 更换后重投；Wire
  1.1 Snapshot 没有可用于响应的 `interactionId`，Browser 不能从 `approvalId` 猜测它。

### 请求授权

Companion 在请求缓存与 Runtime dispatch 之前授权每个 `runtime.request`。P0 只允许绑定
Workspace 的以下方法：

```text
thread.list
thread.create
thread.open
thread.snapshot
thread.capabilities
turn.start
turn.cancel
operation.get
interaction.candidate
```

拒绝统一投影为 `REMOTE_REQUEST_DENIED`，不向远端泄漏本机原因。
`interaction.candidate` 还必须通过 responder policy。

### Approval 权威

Runtime 的 `runtime.approval` 是唯一审批事实源：

- `auto` 自动执行；
- `confirm` 由已认证 Web controller approve/reject；
- `deny` 不产生可由 Web 越过的 Interaction。

Companion 只验证 Workspace、request policy 与 responder，不增加隐式风险分类或本机二次
确认。

## 责任边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| roll-agent monorepo | Companion 服务、relay-client、Wire/Control Schema、Runtime supervision、conformance | Cloud Relay 生产服务、租户数据库、第三方业务 UI |
| roll-cloud-relay | enrollment、Browser session、Companion/Browser WSS、身份与 Workspace 路由、限流和运维 | 本机路径、Tool 最终授权、Runtime 生命周期 |
| 第三方后端 | 把当前登录用户兑换为短期 Relay session | Device credential、本机路径、向 Browser 下发 Relay 管理密钥 |
| 第三方前端 | Chat、Approval、User Input UI | raw frame、ACK/gap、启动 Runtime/Companion |
| Companion | Workspace、Runtime、远程请求 allowlist、设备凭据和最终本机边界 | 入站公网服务、端口映射、云端指定 cwd |

## P0 明确不做

- 稳定 Host SDK、Relay Admin SDK、React UI 包；
- 多设备、多 Workspace、observer/controller 转移；
- 任意自托管 Relay profile、E2EE、HA；
- 远程 File Picker、Authentication 或本机二次审批；
- Cloud Relay 服务实现与第三方账号系统。

## 发布与验收

正式 GA 需要 macOS universal 签名/notarize 安装包和 Windows x64 Authenticode MSI，均注册
per-user 服务并携带版本匹配的 Node 与 Roll。没有签名凭据或目标 OS runner 时，可以验证
构建输入、服务描述与 unsigned staging artifact，但不能宣称安装器验收完成。

`@roll-agent/relay-client` 是新增 npm 包。第一次正式发布前，npm scope 管理员必须预创建包并
为 `.github/workflows/release.yml` 配置 Trusted Publisher；仓库不会回退到长期 npm token。

Cloud Relay 当前实现尚未更新。本 ADR 和
[`roll-cloud-relay-openapi.yaml`](../contracts/roll-cloud-relay-openapi.yaml) 是待其消费的合同，
不是对线上能力的描述。
