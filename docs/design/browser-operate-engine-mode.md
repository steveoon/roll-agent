# browser_operate 操作模式

## 目标与边界

`browser_operate` 使用同一套页面观察、阶段记忆、动作校验、CDP 执行与最终观察。模式只决定每一步由哪个决策服务回答：标准模式使用 Roll MCP Sampling；快速模式使用 TypeSafe 官方 Jev。任务目标、可写字段、提交授权和最终验收仍由调用方 Roll 管理，不在浏览器执行循环中增加逐字段宿主检查。

## 配置与生效

```yaml
browser:
  operate:
    engine: sampling # 默认；改为 jev 才开启快速模式
agents:
  env:
    browser-use-agent:
      TYPESAFE_API_KEY: ${TYPESAFE_API_KEY} # 仅 jev 需要
```

配置台“浏览器 → 浏览器任务操作 → 操作模式”提供“标准（Roll 模型）”和“快速（TypeSafe Jev）”；TypeSafe 密钥在 browser-use-agent 的 Agent 环境变量中填写。保存浏览器配置后，运行中的 core-managed browser-use-agent 需要重启以接收新模式；已停止的 Agent 下次启动生效。配置中的模式由 Roll 注入为 `BROWSER_OPERATE_ENGINE`，不接受同名 Agent 环境变量覆盖。

若 Agent 由外部进程管理，Roll 无法重启或注入其进程环境；外部管理方需同步设置 `BROWSER_OPERATE_ENGINE` 和快速模式密钥。

| 生效模式 | 有效 TypeSafe key | browser_operate 行为 |
| --- | --- | --- |
| 未配置或 `sampling` | 任意 | 使用 Roll MCP Sampling；不调用 TypeSafe |
| `jev` | 有 | 使用 TypeSafe Jev |
| `jev` | 无或空白 | 操作页面前返回 `configuration_error`；不自动回退 |

密钥的可用性指 Agent 进程实际收到非空密钥；密钥无效或服务不可用会在调用 TypeSafe 时返回错误，不能在离线配置校验中预知。标准模式还需要当前 MCP 客户端提供 Sampling 能力。

## 兼容性与安全

工具的旧 `engine` 入参暂时保留为可选字段，用于识别旧调用方。省略时按配置运行；传入时必须与配置一致，否则在浏览器动作前返回 `invalid_input`。它不再是引擎切换入口。旧的 `engine: "jev"` 调用方应先把 Roll 配置切换为快速模式，随后可移除工具参数。`model` 仍只在快速模式下选择 Jev 模型。

变更不改变 `browser_operate` 的动作策略、origin/iframe 检查、禁止控件匹配、写入后读回或一次委派内的阶段记忆。引擎切换只改变决策请求目的地；快速模式会把观察状态发送给 TypeSafe，标准模式把它交给 Roll 配置的模型服务。
