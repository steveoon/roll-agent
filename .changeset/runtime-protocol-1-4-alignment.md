---
"@roll-agent/protocol": patch
"@roll-agent/runtime": patch
---

Runtime Protocol 1.4 对齐修复

- protocol：`projectRuntimeServerRequestCancelParams` / `projectRuntimeServerRequestParams` 改按 `RUNTIME_PROTOCOL_CAPABILITIES` 派生 wire 形状，修复 1.4 会话上 `runtime.serverRequest.cancel` 投影抛错、取消通知从未送达（待处理 `approval.request` / `userInput.request` 到期或取消后客户端得不到通知）；新增全版本矩阵回归测试
- protocol：补齐 `@roll-agent/protocol/schema/1.4` 子路径导出（产物已存在但未导出）；新增 `fixtures/v1.4/*` 跨语言 golden fixture；新增 docs-sync 测试把协议文档钉到 `RUNTIME_PROTOCOL_VERSION`
- runtime：`RuntimeClientRequestCoordinator` 取消通知投影失败时通过 `onDiagnostic` 上报而不再静默吞掉；补 1.4 取消通知回归测试
