# 会话内模型选择

状态：本地实现；未提交、未发布。2026-11-09 根据用户反馈收缩范围。

## 需求与职责

第三方 App 可以为当前已打开的会话选择配置中的 provider/model，或恢复跟随配置默认值。选择只在当前 Runtime 会话生命周期内有效；detach、关闭、Runtime 重启均丢弃。是否记住选择、记多久、重新打开后是否恢复，由 App 决定。App 需要恢复时，先打开会话，再读取最新候选与 revision，显式调用选择接口。

Core 解析配置、凭证、Provider 与模型参数；Runtime 管理执行与会话隔离；Protocol/client-node 提供有界、类型化接口。接口不接收完整配置或凭证，不写 roll.config，不新增会话数据库字段或迁移，也不改变历史 model 标签。此分支 schema 12 仅属于先前的 workspace 归属功能。

CLI 与 scheduler 继续使用原 ConversationEngine。CLI 的模型候选包含现有订阅账号目录；其临时切换、显式设默认、Fast 和思考等级交互不变。它们不继承第三方 App 的内存选择。

## 执行与隔离

已有 ConversationEngine.switchModel 同步更新该 Engine 全部 Session 与共享 AgentHost Sampling。单独调用 AgentSession.switchModel 无法隔离共享 MCP Sampling。只有多会话协议宿主使用 ThreadModelEngine 适配器：每个已打开会话独立拥有一个原 ConversationEngine 和 CoreAgentHost/MCP manager，模型切换仍复用已有 switchModel，不替换活跃 Session、工具、后台进程或历史。

这意味着每个已打开会话拥有独立 MCP 连接，stdio Agent 可能有独立子进程；detach 关闭对应资源，关闭失败继续保留占用。宿主应 detach 不再需要执行的会话。只读历史浏览不创建这些资源。CLI/scheduler 的资源创建方式不变。

拒绝替代方案：仅给 engine.switchModel 加 threadId 会遗漏 Sampling；在共享连接上修改 Sampling 会串用模型；以全局互斥串行所有会话会损害原有多会话并发。修改 MCP 请求协议以携带会话上下文需要 Agent 配合，不属于本轮接口扩展。

## 接口

三个可选 Protocol 1.6 方法，旧宿主可能返回 method-not-found 或 CAPABILITY_UNAVAILABLE；版本相同不保证实现该扩展。

- runtime.models.list({})：configRevision、defaultModel、items。候选来自配置中的 provider/model 加有效默认值，不包含密钥、端点、providerOptions。不可用项带有限枚举原因。
- thread.model.get({threadId})：读取已打开会话的 revision、selection、configRevision、status、active。不会自动打开未打开的会话；未打开或已关闭返回不可用。
- thread.model.set({requestId, threadId, expectedRevision, configRevision, selection})：仅为已打开且可写的会话选择显式 provider/model 或 mode: default，返回状态。不会隐式打开或恢复会话；detach 后首次到达的旧请求返回不可用，不创建宿主或重新取得占用。

revision 是进程内、不透明 UUID，每次选择/重载及重新打开都产生新值，避免 detach/reopen 后旧请求误命中新实例。configRevision 标识已加载配置快照。requestId 使用既有幂等缓存；重复请求返回原始应答，查询当前状态必须使用 get。客户端遇到超时应先查状态，不得把旧应答当作当前模型。

status 为 applied / pending / failed；active 为真实已建立的模型、推理种类与上下文窗口，未建立时为 null。applied 的 active 必须非空。failed 仅公开 model-unavailable / prepare-failed / apply-failed / config-changed / settlement-failed，不公开底层错误或凭证。

## 并发与恢复

已有轮次、审批、用户输入、压缩和终态投影继续使用旧模型。忙碌时接受选择为 pending；只有安全结算后应用，新轮次在应用前被阻止。其他会话独立执行。异步准备完成时再次检查 revision、配置快照、所有权和关闭状态；取消或过期结果不能提交。

默认配置重载仍使用原 ModelConfigController 门禁。内存中显式选择保留并重新验证；跟随者应用新默认值。移除的显式候选进入 failed，不静默回退，用户可选择可用模型或跟随默认恢复。投影未成功结算不能通过换模型绕过。

打开与配置重载并发时，重载等待打开过程和当前模型准备完成；打开过程也会等待替代被取消准备的新任务，不能把 pending 会话作为已就绪返回。初始模型未变化时直接采用子 Engine 已完成的初始化，不再重复准备和切换。关闭时先启动子 Engine 清理以取消宿主初始化，再等待打开任务收敛。

跟随默认值的会话若准备或应用失败，全局重载也报告 failed，修复配置后可重载恢复。显式候选移除等局部失败只阻止相应会话，不使其他正常会话不可用。Core 创建子 Engine 时，模型相关可选参数全部取自当前模型选择，不能继承启动配置中已被删除的 Provider 参数。

数据库中的历史 model 标签不是当前生效模型或保存的选择偏好；打开期间重载也不改写它。App 展示当前模型应读取 thread.model.get 的 active/status，不能以历史列表的 model 标签代替。

推理类型以会话 active.reasoning 为准；既有握手含义不扩展为所有模型的能力。文本订阅仍需显式 opt-in；切换到文本模型后可重新申请订阅。没有新增选择通知，客户端可查询 get 直到终态。

## 验证

覆盖真实 Provider 请求、MCP Sampling、配置/数据库不写入、并发与过期准备、失败恢复、关闭取消、detach/reopen 和进程重启/CLI 不继承。以隔离 HOME、配置、历史和 localhost 服务执行，保留先前 workspace/P2 回归。具体结果记录在本轮 review 报告。
