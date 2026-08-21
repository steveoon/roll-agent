# Runtime Protocol 1.4 对齐修复 设计

来源：2026-08-21 对 `openclaw-roll-core-skill-template` 文档 review 的延伸调查（`docs/runtime-protocol-v1-reference.md` 仍标 1.3 为最新）。调查发现问题不止文档：一个运行时 bug、一个 packaging 遗漏、一个示例启动即失败，以及六份文档集体停在 1.3。

## 背景

Runtime Protocol 1.4 于 2026-08-12 落地（PR #211 / issue #177，`packages/protocol/CHANGELOG.md:18-21`）：在 1.3 之上新增 attachments 子系统 —— `attachment.stage|chunk|commit|release` 四方法、八个 `ATTACHMENT_*` 错误码、四个 `limits` 字段、`UiMessage` 的 `attachment` part、`turn.start.input.attachments`。1.4 对 1.3 是严格超集：1.3 注册表、方法 schema、事件 envelope、错误注册表全部按引用复用（`packages/protocol/src/index.ts:2003-2010`），没有任何 1.3 可见形状被收窄。

1.4 落地时以下几处没有跟上，且没有任何测试失败：

## 问题清单与证据

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P0-1 | `projectRuntimeServerRequestCancelParams` 只有 `"1.3" \|\| "1.2"` 与 `"1.1"` 分支，1.4 落到 `runtimeProtocolSchemaUnavailable` 抛错 | `packages/protocol/src/index.ts:2877-2895`；实跑：1.1/1.2/1.3 ✅，1.4 ❌ `does not support server request cancellation` | 1.4 会话上 `runtime.serverRequest.cancel` **永不送达**：待处理 `approval.request` / `userInput.request` 到期、被取消或 capability 撤销后，服务端本地已结算，客户端毫不知情 |
| P0-1b | 调用方 `sendCancellation` 用裸 `catch {}` 吞掉投影异常（注释假定「transport 已断」） | `packages/runtime/src/server/runtime-client-request-coordinator.ts:606-620` | 上述 bug 完全不可见；`onDiagnostic` 钩子存在（`:53`）却没被用上 |
| P0-1c | `projectRuntimeServerRequestParams` 同样缺 1.4 分支 | `index.ts:2854-2875`；生产不可达（coordinator 直接用 registry parse，`coordinator.ts:247-254`），仅测试调用 | 潜伏问题，与 P0-1 同根 |
| P1-2 | `packages/protocol/package.json` exports 缺 `./schema/1.4`（`exports` 与 `publishConfig.exports` 两处） | 构建脚本按 `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS` 全量生成（`scripts/generate-schema.mjs:342-370`），`dist/schema/roll-runtime-protocol-v1.4.schema.json` 存在且进 tarball；从 `packages/client-node` 实测 `import.meta.resolve("@roll-agent/protocol/schema/1.4")` → `ERR_PACKAGE_PATH_NOT_EXPORTED` | 1.0–1.3 都能钉 schema 版本，唯独当前版本钉不了 |
| P1-3 | `fixtures/` 只有 `v1` / `v1.2` / `v1.3`，没有 `v1.4` | `ls packages/protocol/fixtures` | 1.4 无跨语言 golden fixture，JSON Schema 产物对 attachment 形状零覆盖 |
| P1-4 | Electron 示例对最新 runtime **启动即失败** | `client-node` 默认 `maxFrameBytes = RUNTIME_V13_MIN_CLIENT_FRAME_BYTES`（`packages/client-node/src/index.ts:75`）→ 过滤器保留 1.4（`:624-629`）→ runtime 取客户端列表第一个可解析版本（`runtime-service.ts:572-578`）= 1.4 → `examples/electron-runtime-client/main.ts:276-279` `isElectronRuntimeProtocolVersion("1.4")` 为 false → `shutdown()` + throw | 示例自 1.4 落地起无法连接默认 runtime。根因：`supported-protocols.ts:3-7` 手写 `["1.3","1.2","1.1"] as const satisfies readonly RuntimeProtocolVersion[]` —— `satisfies` 只检查「⊆」不检查「覆盖」，联合类型扩宽时零报错，是假的安全感 |
| P2-5 | 六份文档把 1.3 写成最新 | `docs/runtime-protocol-v1-reference.md:7`（55 行含 1.3，0 行含 1.4）；`docs/client-node-reference.md:9`；`docs/runtime-protocol-architecture.md:53`；`packages/protocol/README.md:89-96`；`packages/client-node/README.md:77`；6 处可复制的版本列表字面量全部以 `"1.3"` 开头 | 两个已发布 npm 包的 README 用 GitHub 绝对链接指向参考文档（`npm pack --dry-run` 证实 README 随包分发）。手写非 Node 客户端的嵌入方照抄 `["1.3","1.2","1.1","1.0"]` 即永久钉死 1.3：**不报错**，但 `features` 永远不含 `attachments`、附件方法不可发现、快照中非文本 part 被静默剥离（`index.ts:2684-2692`） |
| P2-6 | 参考文档 7 处明确写错（不是缺列） | L15/L79-81 把 17 MiB 帧下限限定为 1.3；L147/L149 把 capability 握手限定为 1.3/1.2（1.4 同样要求 ACK 后才投递 Interaction）；L229/L342 `runtime.events.resume` 只在 1.3；L239-244 `turn.start` 仅 `{ text }`；L259/L263 `eventCursor` 只存在于 1.3；L647-650 幂等方法「七个」实为十一个（`runtime-service.ts:699-1106`） | 照文档写的 1.4 客户端会收不到审批（不做 ACK）、误判 resume 不可用、配置错误的帧预算 |
| P3-7 | 测试只覆盖 1.2 / 1.1 / 「1.0 应抛错」 | `packages/protocol/src/index.test.ts:1285-1294` | 正是 P0-1 溜过去的原因：缺一条「凡 `serverRequests` 为 true 的版本都必须投影成功」的全版本断言 |
| P3-8 | 无 docs-sync 测试 | 全仓库 `*.test.ts` 无一读取 `docs/*.md`；文档冻结于 2026-08-05（f509946），1.4 于 2026-08-12 落地（38bb3c6），无任何失败 | 文档漂移没有任何自动信号 |

校准：Node 嵌入方结构性免疫 —— `RollNodeClient` 从 `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS` 运行时派生广告列表，白捡 1.4。`examples/python-runtime-client` 明确是「v1.1 smoke client」（其 README 标题如此），钉 `["1.1","1.0"]` 是刻意的，**不在本次范围**。

## 已确认的决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 投影函数分支依据 | **按 `RUNTIME_PROTOCOL_CAPABILITIES` 派生 wire 形状**，不再写版本字面量链：`serverRequests=false` → 无 Server Request；`serverRequestCapabilityNegotiation=true` → `interaction` 形状（`interactionId`，1.2+）；否则 → `legacy` 形状（`serverRequestId` + `approvalId?`，1.1） | `RUNTIME_PROTOCOL_CAPABILITIES` 已是 `as const satisfies Readonly<Record<RuntimeProtocolVersion, …>>`（`index.ts:107-140`）：新增 1.5 时**漏表直接编译报错**，投影函数自动继承正确形状。复用既有的穷举表，零新增表、零新增公开 API（patch 级） |
| 不新增公开导出 | 派生 helper 与形状常量为模块私有 | 保持 `@roll-agent/protocol` 公开面不变；穷举性由 `satisfies` 在编译期保证，运行期由全版本矩阵测试保证 |
| coordinator `catch {}` | 拆成两段：投影失败 → `this.diagnose(...)` 并 `return`；仅 `responder.send` 失败才静默 | 投影失败是编程错误不是传输故障，应当可见；但 `sendCancellation` 被定时器回调调用，抛出会变成未捕获异常，所以走 `diagnose` 而不是 rethrow。生产未接 `onDiagnostic`（`runtime-server.ts:163`），行为零变化；测试可观测 |
| `./schema/1.4` export | `exports` 与 `publishConfig.exports` 同时补；加一条测试遍历 `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS` 断言两处映射齐全 | 与 fixture 一样，「按版本全量生成但手写清单漏项」是同一类 bug，用同一类测试堵 |
| `fixtures/v1.4` | 仅用 JSON Schema 可表达的约束构造 invalid fixture（`maxItems`、`pattern`），不用依赖 zod `.refine()` 的用例 | `generate-schema.mjs:348-365` 用 ajv 对全部 fixture 做 valid/invalid 双向断言；`z.toJSONSchema` 丢弃 refine，refine-only 的 invalid 会让构建失败 |
| Electron 示例 | 版本列表改为从 `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS` 按 `getRuntimeProtocolCapabilities(v).serverRequests` 过滤派生；类型改为 `Exclude<RuntimeProtocolVersion, "1.0">` | 示例的真实要求是「有 Server Request 控制路径」而不是某几个版本号；renderer 只消费事件（README 自述；`renderer.ts:481`），1.4 事件 envelope 与 1.3 同形，无需改 renderer |
| 文档范围 | 参考文档全量修订（版本表、3 处列表字面量、7 处明确错误、4 张表补 1.4 行/列、幂等清单）；其余 5 份只修「最新版本」声明与版本列表字面量 | 参考文档是两个 npm 包对外的 wire 契约；其余文档的逐句 1.3 措辞扫描作为后续任务 |
| docs-sync 测试 | `packages/protocol/src/docs-sync.test.ts`：① 三份文档的「最新版本」声明 = `RUNTIME_PROTOCOL_VERSION`；② 六份文档中任何 `["1.x", …]` 列表字面量，首元素不是 `1.1`/`1.0` 就必须是 `RUNTIME_PROTOCOL_VERSION`；③ 参考文档必须含全部 `RUNTIME_METHODS`、`RUNTIME_ERROR_CODES` 与 `runtimeLimitsV14Schema` 全部字段 | 把「文档陈旧」从靠人眼变成测试红灯；②是针对本次事故形态（可复制列表钉死旧版本）的 tripwire |
| Changeset | `@roll-agent/protocol: patch`、`@roll-agent/runtime: patch` | 修 bug + 补遗漏导出，无新公开 API；runtime 仅 coordinator 诊断路径变化 |

## 架构

### 修复点（`packages/protocol/src/index.ts`）

在 `getRuntimeProtocolCapabilities` 之后新增模块私有的形状派生：

```
RUNTIME_SERVER_REQUEST_WIRE_SHAPES = { interaction, legacy } as const
resolveRuntimeServerRequestWireShape(version) → "interaction" | "legacy" | null
```

`projectRuntimeServerRequestParams` / `projectRuntimeServerRequestCancelParams` 改为对 `shape` 分支，`null` 与 legacy+非 approval 仍走 `runtimeProtocolSchemaUnavailable`。外部签名、返回类型、错误消息全部不变。

### 控制流（已逐环读码证明 1.4 可达）

`runtime-protocol-adapter.ts:284` 协商结果写入 `this.protocolVersion` → `:681` 取出 → `:706` / `:793` 作为 `RuntimeClientRequestOptions.protocolVersion` → `coordinator.ts:241/294` 存入 interaction → `:606` 投影 → （修前）抛错 → `:620` 吞掉。

### 不变量（测试表达）

- 对每个 `v ∈ SUPPORTED_RUNTIME_PROTOCOL_VERSIONS`：`getRuntimeProtocolCapabilities(v).serverRequests` ⇒ cancel 投影成功且能被 `parseRuntimeServerRequestCancelParamsForVersion(v)` 原样解析；`"interactionId" in 结果` ⇔ `serverRequestCapabilityNegotiation`
- 对每个支持 Server Request 的 `v` 与其 registry 中每个 method：params 投影成功且能被 `parseRuntimeServerRequestParamsForVersion(v, method)` 原样解析
- coordinator 在 `protocolVersion: "1.4"` 下取消请求时，`responder` 收到 `runtime.serverRequest.cancel`，params 为 `{ interactionId, reason }`，且无 diagnostic
- 每个支持版本在 `package.json` 两处 exports 都有 `./schema/<v>` 映射
- 文档「最新版本」声明 = `RUNTIME_PROTOCOL_VERSION`；文档版本列表字面量不得以陈旧版本开头

## 范围外（明说）

- `examples/python-runtime-client`：刻意的 1.1 smoke client，保持
- 其余 5 份文档中逐句的「1.3/1.2」能力措辞扫描（如 `client-node-reference.md` 26 处）：本次只修「最新版本」声明与列表字面量，其余列为后续
- 1.3 客户端读取含附件 thread 时非文本 part 被静默剥离的行为本身：这是 1.4 设计决定（CHANGELOG 明示「自动降级为 text-only」），本次只在参考文档写明，不改行为
- `docs/runtime-protocol-v1-reference.md` 改名或拆分：标题保持「v1 参考」

## 验证策略

- 单元：`pnpm --filter @roll-agent/protocol test`（基线 35 pass）、`pnpm --filter @roll-agent/runtime test`
- 构建：`pnpm --filter @roll-agent/protocol build` —— 触发 `generate-schema.mjs` 对 `fixtures/v1.4` 的 ajv 双向校验
- 导出：从 `packages/client-node` 目录 `import.meta.resolve("@roll-agent/protocol/schema/1.4")` 必须解析到 `roll-runtime-protocol-v1.4.schema.json`
- 示例：`pnpm verify:example:electron`
- 全仓：`pnpm lint`、`pnpm typecheck`、`pnpm changeset status`、GitNexus `detect_changes()`
