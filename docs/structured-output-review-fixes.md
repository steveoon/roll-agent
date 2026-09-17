# 结构化输出审查修复记录

本轮独立核对 Fable 5 对 Roll `25048bf`、Relay `be6271c`、Electron `2168972` 的审查。

## 优先级与结论

| 优先级 | 问题 | 处理与证据 |
| --- | --- | --- |
| P1 | 新 Companion 的快照无法降级给旧 Web | 显式接受 Relay V12 快照后再投影到严格 V11；真实 WebSocket 的 thread.open、thread.snapshot 回归通过，未知额外字段仍拒绝 |
| P1 | 重连后同 ID mutation 被拒为离线 | 相同方法和参数的 mutation 可换 controller 重放；SHA-256 指纹防止换参数；query 不能借重连复用旧响应 |
| P1 | CLI 把已执行但输出无效当作执行失败 | run/ask 仅对已声明契约且有完整配对标记的结果返回执行成功和 appOutputStatus；实际 run 修复前 exit=1、修复后 exit=0，两次各自执行一次；ask 子进程也通过 |
| P2 | 业务 DTO 被取证脱敏启发式误伤 | 独立内容检查保留头像 URL、普通 data、分页 token、SKU、邀请 token；明确凭据返回 rejected + 安全诊断，与授权 denied 分离 |
| P2 | 描述符读取反复执行留存 UPDATE | 描述符、正文和 snapshot 读路径只比较到期时间；清理只在写入和启动执行；禁止 UPDATE 的 SQLite trigger 回归证明读取无写入 |
| P2 | 一个 App 输出声明错误中断整个工具列表 | 在 Roll 工具归一化阶段隔离错误，返回 appOutputIssue 并告警；真实 CLI 验证同 Agent 的健康工具仍可列出和调用 |

第六项不意味着任意不合法 MCP outputSchema 都被接受。MCP 自身的协议校验及 schema 编译规则仍然生效；本轮未通过绕过 MCP 校验来容忍整个服务的不合法协议响应。

## 兼容与安全边界

- 既有取证 redactor 保持原规则；新内容检查只用于 App DTO。它是补充防护，工具作者仍须定义适当的公开数据。
- rejected 诊断只包含静态原因和明确凭据字段类别，不返回被拒值或完整业务路径。
- rejected 加入尚未发布的 Runtime 1.5 / Relay 1.2 契约，同时更新 Relay 1.2 schema 指纹。已冻结的 Relay 1.0 / 1.1 schema 指纹未改动。
- CLI 不把普通 isError 或未声明工具的伪造标记提升为成功；原始 MCP 结果仍保留在结果字段中。
- 重连不允许将 query 改成 mutation，不允许同 mutation ID 换参数，也不将旧 query 绑定给新 controller。
- 到期结果在读时立即不可用，物理数据回收延迟到写入或启动，不延长可读期限。

## 验证

- Roll 全量测试：4190 通过，23 跳过，零失败；全仓类型检查、lint、构建通过。
- 新 CLI 子进程测试：run、ask 和健康工具隔离，共 3 项通过。
- Relay 真实 WebSocket 测试：72 项通过；类型检查、lint、构建通过。
- Electron：198 项通过；类型检查、构建通过。新增测试区分内容拒绝与授权拒绝。
- 跨仓实际 SDK/Runtime 子进程与 Relay WebSocket 联调通过；使用本地候选包，不代表正式 npm 依赖或线上 WSS 验收。
- 发布包审计通过。

## 其他处理与暂缓项

- 新增 `pnpm test:structured-output`；脚本识别普通仓库布局的相邻 roll-cloud-relay，也保留隔离 worktree 的相邻 relay 目录和显式环境变量路径。
- 没有提前修改消费者的未发布依赖版本或扩大冷却期豁免。发布后更新精确依赖、锁文件及对应 first-party 版本豁免，再部署兼容 Relay，最后升级 Companion/App。
- 未增加新 Companion 到旧 Relay 的自动协议回退；部署顺序仍需遵守。
- 结果卡片加载闪动和授权管理 CLI 不属于本轮高优先级修复。
- 当前消费仓库的正式依赖来源校验门禁仍保留；未绕过完整 Electron 发布校验。
