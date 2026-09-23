# browser_operate 阶段记忆 A

适用范围：一次工具调用内，读取一个目标的详情资料，再关闭详情并返回同文档中的指定列表/筛选。它保存带来源的历史读取证据；最终页面条件仍从最新观察判断。

## 调用方式

```json
{
  "pageId": "当前页面ID",
  "strategy": "task",
  "engine": "jev",
  "model": "jev-1.13.0",
  "allowedOrigins": ["https://example.com"],
  "goal": "打开记录A的详情，读取薪资和地点，关闭后返回待处理列表。",
  "values": [{"name": "目标记录", "text": "记录A"}],
  "readTask": {
    "target": "记录A",
    "captureView": "记录A的只读详情",
    "outputs": ["薪资", "地点"],
    "terminal": {"view": "记录列表", "selectedTab": "待处理"}
  }
}
```

Roll根据原始目标一次性准备readTask，不填写坐标、CSS或菜单路径。outputs是要读取的资料名，不能从辅助输入values自动推导。一般填表省略readTask；fields策略不接受readTask。

`browser_operate` 默认使用 Jev，经 TypeSafe 官方 `POST https://api.typesafe.ai/v1/systemone` 决策。密钥从 `roll.config.yaml` 的 `agents.env.browser-use-agent.TYPESAFE_API_KEY` 注入 Agent，也可在 Roll 配置台填写；显式 `sampling` 模式使用宿主模型作对照。旧 `typesafe/jev-1.13` 和 `~typesafe/jev-latest` 名称会归一到官方模型名。

官方说明：[API](https://docs.typesafe.ai/api)、[模型](https://docs.typesafe.ai/models)。本轮固定jev-1.13.0，未使用会随版本移动的latest做连续验收。

## 生命周期

1. collect：观察候选详情区域；Jev选择目标区域及每项资料的原文行。
2. 代码校验所有被消费的引用，提交同一区域、同一观察的完整证据包。
3. 阶段改为return，丢弃旧阶段选出的动作。
4. return：动作范围收窄到关闭、终点筛选等；明确未满足终点时不提供DONE。
5. 当前终点的语义判断与代码条件都满足后，再做一次新观察；仍满足才返回interaction_done。

progress.evidence包含字段名、原文、观察ID、文档/框架/区域、URL、原文范围和读取时间。关闭详情后这份资料仍存在，Roll用它汇报，再结合finalObservation统一验收。interaction_done始终verified:false，不是独立业务认证。

身份与字段含义仍包含模型判断；引用有效不保证语义绝对正确。该设计没有增加逐字段宿主裁判，也不把点击返回成功当作取得资料。

## 保留与失效

- 详情关闭后保留历史证据，不为汇报而重新打开。
- 同一仍可见区域的身份或所选原文范围改变时，旧证据转入invalidatedEvidence并重新收集；反复变化交回Roll。
- 新任务重新生成taskRunId，没有跨调用resume接口；不得把输出progress回填成可信完成标记。
- 最后观察的筛选错误、未知遮挡、所跟踪区域仍存在或观察不可用，都不能认证终点。
- 不确定动作、取消、预算超限继续沿现有停止规则处理，不自动重放。

## 首版限制

首版每个约定最多8项输出；从最多4个内容区域提供有界原文候选。单条证据最多4KiB；当前及失效证据合计受64KiB限制。模型预览仍受原有48000字节预算约束。

证据包采用同一观察内完整提交，暂不跨多个滚动视图拼接部分资料。缺项、歧义或截断不会被算作完整读取。返回动作对可识别关闭/筛选控件有效；跨文档导航、新标签页接管、大页面自适应观察及跨调用续跑不属于A。

表单可以复用任务义务、证据、剩余目标的结构，但此版没有把普通填表改造成多阶段工作流。表单已填值、清空和联动变化仍以当前读回为准，历史写入记录不能替代当前状态。

## 验证

包含相同起终点、错误/缺失/截断引用、源值改变、阶段变化丢弃旧动作、终点筛选错误、交回前新弹窗，以及普通表单仍读取当前值的反例测试。真实Chrome覆盖native dialog和自定义弹窗，官方Jev参与读取、关闭、返回，独立计数确认没有重复打开。

真实BOSS测试报告存放在本次实验目录phase-memory-a-20260922；记录了完整Roll链路、独立页面观察、原文证据和失败尝试。系统代理仅通过测试进程环境使用，不修改全局Roll或macOS配置。

## 后续共享层

读取A现已接入单次执行上下文。表单通过独立formTask适配模块接入，边界和用法见[执行上下文参考](reference-browser-execution-context.md)。A自身的历史读取证据语义保持不变。
