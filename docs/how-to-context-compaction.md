# 长对话压缩与历史回查

默认 `summarize` 模式把较早对话压缩成一份任务摘要，保留近期原文与当前用户输入。
摘要帮助继续任务，可能遗漏旧细节；精确值仍以原始消息、工具记录和实际检查为准。

## 自动与手动压缩

自动压缩检查最终 SDK 请求，包括 system、工具定义、provider options、消息与输出预留。
默认 75% 是触发阈值，不能据此认定整个窗口已满。最新兼容请求的实测 input usage 用于校准，
与累计计费 token 分开；模型、工具、提示或其他请求形状变化会使旧校准失效。

每次维护只有一次有界摘要请求，输入为旧摘要和实际拟移除的完整历史。保留当前用户输入、
近期对话及最近的完整工具步骤，不拆分 tool-call/result，不截断未送入摘要的来源。
默认摘要期限为 120 秒，整轮已有 deadline 和 maxSteps 不重置。

摘要非空且有界、最终模型投影实际缩小、事务/CAS 提交成功后才报告压缩成功。
摘要失败、取消或无缩减时保持原上下文；请求还能通过硬预算则继续，否则明确结束本轮。
已接受输入与已完成工具结果保留，内部续跑不会自动重放工具副作用。

`/compact` 可显式触发一次尝试；无可压缩内容时可以无操作。
既有显式 `strategy: truncate` 配置继续兼容：只裁剪完整旧轮次/步骤并保留历史定位，
不额外调用摘要模型。它不会作为摘要失败后的自动降级。

## 按需回查

模型可调用免审批的只读 `roll__transcript`。checkpoint 提供原始记录范围和历史定位。
普通分页使用 `checkpointId`、`kind`、`afterSequence`、`limit`。
长记录可以使用：

```json
{"checkpointId":"<checkpoint UUID>","kind":"message","sequence":12,"offset":0,"maxChars":4000}
```

结果含 `text`、`nextOffset` 和 `totalChars`。继续读取同一记录直到所需内容出现；
`nextOffset` 为空表示本条结束。更早片段按 `previousCheckpointId` 回查。
分块前先完成脱敏，二进制数据、凭据、内部 provider/raw 字段不会因分块而绕过保护。
旧工具记录若已被既有 retention 清理，回查会说明不可用，不能恢复已删除的数据。

历史回查不控制普通工具权限：没有额外的语义事实覆盖、receipt、notes 或 ready 阶段。
原有工具审批规则继续适用。

## 旧会话

数据库升级到 v11；V1/V2 checkpoint、旧语义账本和旧协议事件仍可读取。
打开旧会话复用最长 8,000 字符的 checkpoint 提示，不加载全部旧账本，也不额外调用模型转换。
首次压缩仍走普通摘要路径：旧提示作为 previous summary，与拟移除的近期原文一起生成 V3 摘要。
旧表、checkpoint、账本和恢复备注保留；仅对将移出近期原文且尚未归档的旧摘要片段，在成功提交时补存为 `legacy_snapshot`。

回查旧结构化信息时，沿 `previousCheckpointId` 找到 V1/V2 checkpoint，使用 `kind: "legacy_context"`。
`sequence: 0` 是旧 checkpoint 与对应恢复备注，后续序号是该 checkpoint 代际的账本条目；支持相同的分页与分块参数。
旧来源因 retention 缺失不阻断会话加载或压缩，只在读取该记录时报告不可用，不能据此判断未授权或未执行。
未知高版本数据库仍拒绝打开；已知损坏 checkpoint 的回退和事务失败回滚沿用原有规则。
V3 摘要最长 24,000 字符，工具错误长文本不会再复制到 checkpoint 提示中。

新 Runtime 快照的 `contextRecovery` 为 `null`；1.6/1.3 旧事件仍可解析与重放，协议版本不回退。
