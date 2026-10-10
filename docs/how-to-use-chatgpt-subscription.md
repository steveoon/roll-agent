# 使用 ChatGPT 订阅聊天（实验）

Roll 可以让本机 `roll chat` 和定时任务使用你授权的 ChatGPT 订阅。需在系统浏览器
完成 OpenAI 登录，并明确授权订阅用量；可用模型和额度由账号返回。

```bash
roll auth chatgpt login
roll auth chatgpt status --json
roll auth chatgpt models --json
roll chat --provider chatgpt --model <模型 slug>
roll chat "继续回答" --provider chatgpt --model <模型 slug> --last
```

多账号用 `--account <注册 ID>` 选择；新登录会保存独立注册，同邮箱的注册也
互相隔离。重新授权已有注册用 `roll auth chatgpt login --account <注册 ID>`。

在 `roll ui` 的 LLM 或 Runtime 页面点击 **Continue with ChatGPT**，浏览器
授权完成后选择账号、模型，通过配置预览和保存流程应用到下次聊天及定时任务。仅选择账号不会切换模型服务。前端只
接收账号状态，OAuth 凭证由本机后端保存。

```yaml
runtime:
  provider: chatgpt
  chatgpt-account-id: <注册 ID>
  model: <模型 slug>
```

CLI 参数优先于配置；未指定账号时使用认证服务当前账号。模型可以保存在配置
中，也可在交互启动时选择；非交互调用需指定或保存模型。聊天中的 `/model`
可切换订阅模型与已配置 API Key 模型。API Key 配置仍位于 `llm.providers`；
订阅选择无需加入该表。

订阅接入覆盖本地多轮历史、会话恢复、工具审批与执行、Sampling、上下文压缩和 scheduler。
Roll 的推理档位由各 Provider 适配：订阅通道把 `off` 映射成 `none`，`low/medium/high` 保持对应；聊天、Sampling 和压缩使用同一映射。同时按账号模型目录的 `supported_reasoning_levels` 校验能力。不支持关闭的模型会在推理前明确拒绝 `off`，提示改用 `low`；聊天切换失败保留当前档位，配置的聊天与压缩档位在初始化时一起检查，不自动改档位。

`runtime.provider/model/chatgptAccountId` 是聊天和定时任务共用的默认选择，`/model` 的“设为默认”和配置台保存都会影响后续任务。旧 `chat --server`、Runtime 服务和 Companion 暂不支持订阅，使用订阅默认值时会拒绝新请求；保存前会提示此边界。`roll ask` 独立使用 `llm.defaultProvider` 和 API Key，聊天切换到订阅不会阻断它。未支持入口和额度错误不会自动改走付费 API Key。

API Key 聊天启动不访问订阅模型目录；打开 `/model` 时才获取当前账号目录，网络失败不会阻断 API Key 聊天启动。

定时任务读取任务工作区配置，由本机 executor 使用相同账号认证与流式 Responses 适配器，自动读取最新 token。需预先保存模型，后台不会交互选择或打开授权页面。无人值守审批、任务时限和取消规则继续生效；需要人工批准的工具调用仍返回 `needs_confirmation`。这是本地定时执行，不发送不受订阅支持的 Responses `background` 参数。

```bash
roll schedule add "你的任务" --name "订阅任务" --every 30m
roll schedule run-now <任务 ID> --inline
```

订阅 Responses 使用真实流式请求、`store: false`、完整本地历史和带 namespace
的本地 function 工具。服务端错误、额度限制、缺少完成事件都会作为失败报告。
`maxOutputTokens`、`temperature` 和 `topP` 不受订阅通道支持，会产生不支持警告；Roll 的超时、取消和
压缩结果验证继续有效。

认证文件位于 `~/.roll-agent/auth/chatgpt/`，POSIX 目录 0700、文件 0600，原子
替换。同账号刷新通过跨进程锁串行化，并遵守服务端 `earliest_refresh_at`。

```bash
roll auth chatgpt refresh --account <注册 ID>
roll auth chatgpt logout --account <注册 ID>
```

刷新未到允许时间会提示时间；暂时网络失败保留凭证；到期前自动续期遇到暂时网络失败时继续使用最新且尚未到期的 token，不会使用失效或已撤销凭证。失效的续期凭证需要重新
登录。退出先尝试撤销远端 renewable session，再清除本地 token；远端撤销
未确认会明确提示，可在 [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage)
管理用量和断开授权。退出保留注册与 host ID，供下次重新授权使用。

接入协议依据 [OpenAI 注册流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、
[账号与续期](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、
[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) 和
[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。
