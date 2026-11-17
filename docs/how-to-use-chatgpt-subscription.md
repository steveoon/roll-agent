# 使用 ChatGPT 订阅聊天（实验）

Roll 支持在本机 `roll chat` 和定时任务（`roll schedule`）中使用已授权的 ChatGPT 订阅。首次使用需在系统浏览器中完成 OpenAI 登录并明确授权订阅用量，可用模型列表与配额由账号动态返回。订阅通道完整覆盖本地多轮对话历史、会话恢复、工具审批与执行、MCP Sampling、上下文压缩及本地定时调度。

## 登录与多账号管理

通过 CLI 完成授权登录、查看状态与可用模型，并启动对话：

```bash
roll auth chatgpt login
roll auth chatgpt status --json
roll auth chatgpt models --json
roll chat --provider chatgpt --model <模型 slug>
roll chat "继续回答" --provider chatgpt --model <模型 slug> --last
```

多账号场景可通过 `--account <注册 ID>` 指定要使用的账号。每次执行新登录都会保存为独立的本地注册记录，即使使用同一邮箱登录也彼此隔离；如需重新授权已有注册记录，可执行 `roll auth chatgpt login --account <注册 ID>`。

你也可以在 `roll ui` 的 `llm` 或 `runtime` 页面点击 **Continue with ChatGPT**，在浏览器完成授权后选择账号与模型，并通过配置预览和保存流程将其应用到后续聊天与定时任务（注意：仅选择账号不会切换模型服务，需选定模型并保存配置；前端仅接收脱敏后的账号状态，OAuth 凭证由本机后端保存）：

```yaml
runtime:
  provider: chatgpt
  chatgpt-account-id: <注册 ID>
  model: <模型 slug>
```

CLI 参数优先级高于配置文件；未指定账号时默认使用认证服务的当前账号。模型既可预先写入配置，也可在交互式启动时按提示选择，但非交互调用必须显式传入或预先保存模型。对话过程中输入 `/model` 可在 ChatGPT 订阅模型与 `llm.providers` 中已配置 API Key 的模型之间随时切换，订阅配置本身无需写入 `llm.providers`。

## 推理强度档位（/effort）

Roll 的推理强度档位由各 Provider 分别适配：ChatGPT 订阅通道将 `off` 映射为 `none`，`low`、`medium`、`high`、`xhigh`、`max` 则保持原生对应，不会换算为固定 token 预算。Roll 会根据当前账号模型目录返回的 `supported_reasoning_levels` 校验模型能力，若目录未声明对应档位则不开放 `xhigh` / `max`；常规 API Key 模式仍使用原有的四档（`off` / `low` / `medium` / `high`），暂不接受 `xhigh` / `max`。

在全屏聊天中，可输入 `/effort` 查看当前模型支持的档位，或输入 `/effort xhigh`、`/effort max` 直接调整强度；切换快捷键仅在当前模型支持的档位之间移动。不支持关闭推理的模型会拒绝 `/think off`，报错后保留原状态，不会自动改写档位。使用 `/model` 切换模型时，若当前推理强度与目标模型不兼容，界面会先弹出档位选择器——取消选择则不切换模型，选定后一并应用新模型与新强度；将当前模型设为默认时也会同步保存当前聊天推理强度。`roll ui` 中的聊天与压缩推理档位下拉框同样按所选订阅模型动态筛选；若已保存的值不受所选模型支持，配置台会保留原值并提示调整，不做静默改写。

聊天、MCP Sampling 与上下文压缩共用同一套档位映射，但上下文压缩支持独立配置推理强度。在会话中执行 `/effort` 仅调整聊天与 Sampling 强度，不会联动修改已初始化的压缩强度。引擎初始化与模型切换时都会同时校验聊天和压缩档位，非交互任务若遇到模型不支持的档位会明确报错退出：

```yaml
runtime:
  provider: chatgpt
  model: <账号提供且支持 xhigh/max 的模型 slug>
  thinking-level: max
  compaction:
    thinking-level: low
```

默认推理强度为 `medium`。调高档位可能增加响应延迟和订阅额度消耗，并不保证所有任务效果更优；`max` 也不代表固定的推理 token 数量。

## Fast 模式

支持 Fast 的订阅模型可请求更快的生成速度。该模式默认关闭，开启后可能增加订阅额度消耗，实际生成速度由服务端决定。可通过 CLI 参数单次开启或覆盖配置中的默认开关：

```bash
roll chat --provider chatgpt --model <模型 slug> --fast
roll chat --no-fast # 本次覆盖配置中的 Fast 开关
```

使用 ChatGPT 订阅模型且全屏聊天输入区空闲时，按 **Ctrl+G** 可直接切换 Fast 开关，输入框内已有的草稿会保留；切换到其他提供商后，输入区、快捷键面板及 `/help` 不再提示 Ctrl+G，按键也不会改动 Fast 偏好。此外也可通过 `/fast on`、`/fast off` 或不带参数的 `/fast` 切换开关（基础 REPL 模式同样使用这些命令）。若 Ctrl+G 被操作系统、终端或终端复用器拦截，Roll 无法检测或接管该快捷键绑定，请改用 `/fast` 命令或自行调整冲突软件的快捷键设置；Roll 不注册系统全局快捷键，暂不支持自定义 Fast 快捷键。

开启 Fast 后，全屏聊天输入框呈紫色边框并在左侧显示 `⚡`（不支持 Unicode 的终端及旧版 Windows 控制台降级显示为 `>>`）。切换推理强度、切换模型、恢复会话或断线重连都会保留当前 Fast 偏好；切换到其他提供商时不会发送 Fast 参数。若需让后续聊天和定时任务默认开启，可在 `roll ui` 的 `runtime` 页面设置 **Fast 模式（ChatGPT）**，或在配置文件中写入：

```yaml
runtime:
  provider: chatgpt
  model: <支持 Fast 的模型 slug>
  fast-mode: true
```

Fast 模式同时作用于聊天、MCP Sampling 和上下文压缩，且不改变推理强度。Roll 根据当前账号模型目录中的 `service_tiers`（含 `priority`）或 `additional_speed_tiers`（含 `fast`）判断支持情况；未声明支持的模型会明确报错，可执行 `/fast off` 恢复普通请求，切换到不支持 Fast 的订阅模型后同样需先关闭 Fast 才能继续对话。开启时请求携带 `service_tier: "priority"`，关闭时省略该字段。输入框标识仅表示客户端的请求偏好——即使服务端响应返回的 `service_tier` 为 `default`，Roll 也不会据此自动关闭 Fast，也不将其视为加速生效或计费档位的确认依据。

## 定时任务与命令边界

`runtime.provider`、`runtime.model` 和 `runtime.chatgpt-account-id` 是 `roll chat` 与定时任务共用的默认配置，聊天中 `/model` 的“设为默认”与 `roll ui` 保存配置都会影响后续任务。各命令入口的支持边界与通道隔离规则如下：

- **暂不支持订阅的服务入口**：`roll runtime serve`（及旧兼容入口 `roll chat --server`）与 `roll companion` 暂不支持 ChatGPT 订阅；当默认配置指向订阅时，这些入口会拒绝新请求（`roll ui` 保存前也会提示该限制）。
- **与 API Key 命令互不串道**：`roll ask` 与 `roll run` 独立使用 `llm.default-provider` 和 `llm.providers` 中的 API Key 配置，将聊天切换为订阅不会阻断它们运行。即使订阅聊天配置了 `xhigh` / `max` 档位，`roll ask` / `roll run` 触发的 API Sampling 也会明确提示并回退使用默认的 `medium` 档位，不会将订阅高档位发往常规 API，也不会切换授权通道（若 API 聊天自身配置了不支持的档位仍会正常报错）。遇到不支持订阅的入口或订阅额度耗尽报错时，Roll 不会自动回退去消耗付费 API Key。
- **按需加载模型目录**：使用 API Key 启动 `roll chat` 时不会请求订阅模型目录；仅在打开 `/model` 选择器时才按需拉取当前订阅账号的模型目录，网络异常不会阻断 API Key 聊天启动。

定时任务（`roll schedule`）在执行时会读取任务所属工作区的配置，由本机 executor 复用相同的订阅账号认证与流式 Responses 适配器，并在每次运行时自动读取最新 token。由于后台执行无法弹出交互式模型列表或浏览器授权页，定时任务必须预先在配置中保存订阅模型。无人值守审批策略、任务超时与取消规则照常生效，需要人工批准的工具调用仍返回 `needs_confirmation`。调度完全由本机完成，不会发送订阅通道不支持的 Responses `background` 参数：

```bash
roll schedule add "你的任务" --name "订阅任务" --every 30m
roll schedule run-now <任务 ID> --inline
```

底层请求方面，订阅通道使用真实流式 Responses 请求，固定设置 `store: false`，每次携带完整的本地对话历史和带命名空间的本地 function 工具。服务端错误、配额限制或流式响应缺失完成事件都会作为失败明确报告。`maxOutputTokens`、`temperature` 和 `topP` 不受订阅通道支持（设置时会产生不支持警告），而 Roll 自身的超时控制、取消信号与上下文压缩结果校验继续生效。

## 凭证存储、续期与退出

认证凭证保存在 `~/.roll-agent/auth/chatgpt/` 目录下（POSIX 环境目录权限为 `0700`、文件权限为 `0600`），写入时采用原子替换。同一账号的 token 刷新通过跨进程锁串行化执行，并严格遵守服务端返回的 `earliest_refresh_at` 时间限制。

手动刷新凭证或退出指定账号：

```bash
roll auth chatgpt refresh --account <注册 ID>
roll auth chatgpt logout --account <注册 ID>
```

手动刷新时若尚未到达服务端允许的刷新时间，命令会提示具体可刷新时间。遇到暂时性网络故障时本地凭证会予以保留；到期前自动续期若遇暂时性网络失败，仍会继续使用当前尚未过期的最新 token，绝不会使用已过期或已撤销的凭证；一旦续期凭证本身失效，则需重新执行登录授权。

执行 `logout` 时会先尝试向远端撤销 renewable session，再清除本地 token；若远端撤销结果未能确认会给出明确提示，届时可在 [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage) 查看用量并手动断开授权。退出登录会保留本地注册记录与 host ID，以便下次重新授权时直接复用。

接入协议依据 [OpenAI 注册流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[账号与续期](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) 和 [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。
