# @roll-agent/browser-use-agent

## 0.25.2

### Patch Changes

- Updated dependencies [[`90abbe5`](https://github.com/steveoon/roll-agent/commit/90abbe5dce3928202d62ece03a68661254d7c947)]:
  - @roll-agent/sdk@0.5.1

## 0.25.1

### Patch Changes

- [#215](https://github.com/steveoon/roll-agent/pull/215) [`87dcfb6`](https://github.com/steveoon/roll-agent/commit/87dcfb66ffa2ee594a4bbec6f8e6873f11ae3b87) Thanks [@steveoon](https://github.com/steveoon)! - 命中 BOSS 403/验证码/安全检查页时，常规 `zhipin_*` 抛 `zhipin_access_restricted` 并硬停止，避免被 catch 成「请重试」后继续打接口

- [#213](https://github.com/steveoon/roll-agent/pull/213) [`6841eb5`](https://github.com/steveoon/roll-agent/commit/6841eb5b30694b36cb97863507aa9e0f61f00366) Thanks [@steveoon](https://github.com/steveoon)! - `zhipin_capture_resume` 的 `outputPath` 在 input schema 层强制绝对路径，与工具描述对齐；相对路径不再相对进程 cwd 写盘

## 0.25.0

### Minor Changes

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`8549330`](https://github.com/steveoon/roll-agent/commit/85493304ac978f99889029f725e8f35ddf6a3301) Thanks [@steveoon](https://github.com/steveoon)! - chat 端到端图像链路：工具截图可直接被多模态模型识别
  - SDK：工具结果新增 `mcpImages` 约定字段（导出 `ToolResultImage` 类型），`executeToolForMcp` 将其摘出为 MCP 标准 image content block，base64 不再混入文本 JSON 载荷
  - runtime：tool result 中的 file part（图像）改走独立预算（`MAX_TOOL_MODEL_FILE_CHARS`，12M 字符），不再被 60k 文本预算截断——图像 token 成本按分辨率计算而非字符数
  - runtime：新增 `relocateToolImagesToUserMessages` 幂等消息变换，经 `streamText` 的 `prepareStep` 在每步请求前把 tool 消息中的图像搬运到紧随的 user 消息——dashscope 等 provider 对 tool 角色消息中的图按纯文本计入 input length，仅 user 消息中的图走视觉通道
  - browser-use-agent：`zhipin_capture_resume` 返回值携带 `mcpImages`，chat 模式下模型可直接看到简历截图（实测 qwen3.7-plus / grok-4.5 / gpt-5.5 皆可识别并继续调用工具）

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`8037453`](https://github.com/steveoon/roll-agent/commit/803745358aea19aa4ac77eec4ccf153c485ec7fc) Thanks [@steveoon](https://github.com/steveoon)! - 移除 `zhipin_locate_resume_canvas` 工具，其探测能力并入 `zhipin_diagnose_browser_state` 的新 `resume-canvas` phase
  - `zhipin_capture_resume` 自包含全部前置检查与定位，locate 在标准链路（open → capture → close）中从无必要调用
  - 需要低成本排障时改用 `zhipin_diagnose_browser_state({ phase: "resume-canvas" })`：只读返回 `resumeCanvas` 段（弹窗可见性、iframe/canvas 就绪状态、截图坐标与 canvas 尺寸），不滚动、不截图

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`cbe4b0d`](https://github.com/steveoon/roll-agent/commit/cbe4b0d6e5da685148931c02796c5d50ad49f916) Thanks [@steveoon](https://github.com/steveoon)! - feat: 简历详情弹窗全链路 native CDP 化，新增 zhipin_capture_resume 长图截取工具
  - `@roll-agent/browser`：`NativeCdpController` 新增 `Page.captureScreenshot` allowlist 与 `captureScreenshot()` 方法（支持 clip/scale）
  - `zhipin_open_resume` / `zhipin_locate_resume_canvas` / `zhipin_close_resume` 摆脱 Playwright attach，全部改走 native CDP（isolated world + Input dispatch），修复 attach 掉线与页面异常刷新问题
  - 新增 `zhipin_capture_resume`：滚动分段 + 浏览器内离屏 canvas 拼接，输出完整简历 PNG 长图（实测 7448px 全量）；适配 smooth-scrolling 滚动容器、canvas 视口窗口重绘机制与 getImageData 读取防御（drawImage 指纹确认）；canvas 空白（DOM 文本渲染版式）时回退弹窗区域截图（captureMode: dom-screenshot）
  - 编排器读取 `imagePath` 用自身多模态能力理解简历内容（方案 B：工具只产图，不做内容理解）

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`4f958ed`](https://github.com/steveoon/roll-agent/commit/4f958ed6e85bed7904c8a76efcbd2b885d0f1ac0) Thanks [@steveoon](https://github.com/steveoon)! - zhipin_capture_resume 全程 visual 反馈，消除滚动截图期间的无提示等待
  - 复用 NativeVisualActivitySession：开始显示「正在读取简历」胶囊 + 视口光晕，滚动拼接中按实测位移显示百分比进度（总量来自 stitch init 新返回的 maxScrollTotal），完成/失败分别以 success/error 主题收尾
  - 首轮滚动位移尚未实测时不显示「0%」，有真实位移后才出现百分比
  - dom-screenshot / viewport-clip 路径在 Page.captureScreenshot 前主动 clear overlay 并等待淡出，确保反馈层不会进入简历截图
  - `captureResumeCanvas` 新增可选 `onProgress` 回调（导出 `NativeResumeStitchProgress` 类型），既有调用方不受影响

### Patch Changes

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`5218a94`](https://github.com/steveoon/roll-agent/commit/5218a94269afc3a94fdbf341a7533c9fcd86c652) Thanks [@steveoon](https://github.com/steveoon)! - 简历工具链 code review 修复（8 项）
  - `zhipin_locate_resume_canvas` 改用轻量几何探测 `readResumeCanvasGeometry()`，不再跑完整滚动拼接（实测 ~20s → 0.5s），恢复 5s canvas 等待与结构化错误返回，`canvasInfo` 语义回归 canvas 缓冲区尺寸
  - `zhipin_capture_resume` / `zhipin_open_resume` 补 catch：CDP 中途异常不再泄漏为 raw MCP 错误，visual 反馈以 error 态收尾而非永久残留「正在读取」胶囊
  - `zhipin_capture_resume` 的弹窗等待预算 3s → 12s，与 `zhipin_open_resume` 对齐，消除慢网下的过早失败
  - 关闭按钮搜索限定在可见 dialog 容器作用域内（`.close-btn` 等通用选择器不再可能命中主文档无关元素）
  - 弹窗关闭判定加入 iframe 可见性（站点隐藏而非卸载弹窗时不再误报"未关闭"）
  - Escape 兜底按键补 `windowsVirtualKeyCode: 27`（此前合成事件 keyCode 为 0，legacy 键盘监听收不到）
  - 打招呼/打开卡片两个点击表达式去重为共享 builder，消除 DOM 变更时的双份维护漂移
  - runtime：relocate 的工具图像只保留最近 2 条消息的图，更早的替换为占位文本，长会话不再每轮重发全部历史图（用户自发的图像消息不受影响）

- [#211](https://github.com/steveoon/roll-agent/pull/211) [`79def06`](https://github.com/steveoon/roll-agent/commit/79def06ed0e0190f16652e8282b6e0f7bc39124e) Thanks [@steveoon](https://github.com/steveoon)! - SKILL.md 同步简历工具链现状：`zhipin_open_resume` / `zhipin_locate_resume_canvas` / `zhipin_close_resume` 标注更正为 native CDP（不再是"Playwright-backed 未迁移项"），收录新工具 `zhipin_capture_resume`（滚动拼接长图 + MCP image content + captureMode 三态 + 进度反馈），新增「查看简历」典型链路与两条编排硬规则（简历正文只能走图像通道；capture 需在 resumeReady 后调用）

- Updated dependencies [[`8549330`](https://github.com/steveoon/roll-agent/commit/85493304ac978f99889029f725e8f35ddf6a3301), [`cbe4b0d`](https://github.com/steveoon/roll-agent/commit/cbe4b0d6e5da685148931c02796c5d50ad49f916)]:
  - @roll-agent/sdk@0.5.0
  - @roll-agent/browser@0.10.0

## 0.24.1

### Patch Changes

- Updated dependencies [[`692b351`](https://github.com/steveoon/roll-agent/commit/692b351d91dad93909971cff8c1bcf641db562a5)]:
  - @roll-agent/sdk@0.4.0

## 0.24.0

### Minor Changes

- [#152](https://github.com/steveoon/roll-agent/pull/152) [`63cba26`](https://github.com/steveoon/roll-agent/commit/63cba264d29978662461cd6c3be3dec7af333318) Thanks [@steveoon](https://github.com/steveoon)! - Preserve redacted request/phase/latency diagnostics when `zhipin_generate_reply_preview` fails (including `clientTimeoutMs` for the Roll transport budget), raise the shared Reply Authority client timeout default from 30s to 60s so it stays above the RFC complete-request deadline, and declare `REPLY_AUTHORITY_TIMEOUT_MS` in browser-use env diagnostics.

### Patch Changes

- Updated dependencies [[`63cba26`](https://github.com/steveoon/roll-agent/commit/63cba264d29978662461cd6c3be3dec7af333318)]:
  - @roll-agent/reply-authority-client@0.7.0

## 0.23.0

### Minor Changes

- [#150](https://github.com/steveoon/roll-agent/pull/150) [`6515fc2`](https://github.com/steveoon/roll-agent/commit/6515fc24aaddfb866a60b0ed3275d814467cc989) Thanks [@steveoon](https://github.com/steveoon)! - Enforce dual-draft judging at the prepared-reply send boundary for both roll chat and the unread-reply skill, enrich Judge decisions with bounded redacted context and concrete reasons, preserve preview-degraded groups as non-learning terminal outcomes, replace cross-service raw errors with stable safe reason codes, honor the service feedback deadline, persist feedback in a retryable SQLite outbox before posting it to Reply Authority, and sync browser-use SKILL/workflow docs for the new send-owned Judge and not_learned feedback path.

### Patch Changes

- Updated dependencies [[`6515fc2`](https://github.com/steveoon/roll-agent/commit/6515fc24aaddfb866a60b0ed3275d814467cc989)]:
  - @roll-agent/reply-authority-client@0.6.0

## 0.22.2

### Patch Changes

- [#146](https://github.com/steveoon/roll-agent/pull/146) [`d5cfdd0`](https://github.com/steveoon/roll-agent/commit/d5cfdd051110b58d4ab46ea0656ceb6316f9b3bf) Thanks [@steveoon](https://github.com/steveoon)! - Add the on-demand `roll ui` local configuration console with schema-derived forms, safe YAML editing, secret redaction, revision checks, and runtime activation planning.

  Expose typed Agent environment metadata so both the CLI and configuration UI can reuse the same declarations.

  Agent env declarations now fail closed: omitting `secret` is equivalent to `secret: true`, so authors must mark non-sensitive fields explicitly with `secret: false`.

  Harden managed Agent activation with OS process-start identities so stale or legacy PID metadata fails closed instead of signaling a reused PID.

## 0.22.1

### Patch Changes

- [#142](https://github.com/steveoon/roll-agent/pull/142) [`308af83`](https://github.com/steveoon/roll-agent/commit/308af83f74274598d527959a3cdea728b9b75892) Thanks [@steveoon](https://github.com/steveoon)! - Keep managed CDP pages active when browser windows are occluded. Wait for the BOSS chat list after force reloads, restore the unread filter before subsequent batch reads, and include page visibility plus selected-chat diagnostics when synchronization times out.

- Updated dependencies [[`308af83`](https://github.com/steveoon/roll-agent/commit/308af83f74274598d527959a3cdea728b9b75892)]:
  - @roll-agent/browser@0.9.1

## 0.22.0

### Minor Changes

- [#136](https://github.com/steveoon/roll-agent/pull/136) [`8e592b3`](https://github.com/steveoon/roll-agent/commit/8e592b3d24716b9bcb624eb29fddf3c1040a451a) Thanks [@steveoon](https://github.com/steveoon)! - 同一 `browserInstance` 的页面操作工具在服务端互斥串行，修复 chat 模式并行 tool call 在同一浏览器实例上互相踩踏的竞态。

  **browser-use-agent**：新增 per-browserInstance 互斥队列（`browser-instance-lock.ts`），经 `withBrowserInstanceInput` 接入——同实例页面操作排队依次执行，不同实例保持并行。严格 page-free 的 `browser_status`、`list_pages`、`attach_browser_session` 不进锁，保证实例被长操作占用时仍有读状态排障出口；`zhipin_diagnose_browser_state` 当前也保留为不进锁的诊断入口，但不再声明为纯只读，调用涉及 native focus/input 的 phase 时仍应避免和页面操作并发（`browser_stop`、`zhipin_judge_prepared_reply` 本就绕过实例包装，不受影响）。发生争用时输出排队等待日志。

  **@roll-agent/sdk**：`AgentContext` 新增可选 `signal: AbortSignal`（per-request），`registerTool` 将 MCP 请求的取消信号透传给工具。排队等待期间客户端已超时/取消的请求，出队时会被直接丢弃并返回 `cancelled_while_queued`（含 `browserInstance` 与 `queuedMs` details），保证"客户端已放弃的请求不再落地执行"，避免超时重试导致 `say_hello`/`exchange_wechat` 这类副作用操作重复执行的幽灵操作风险。

  对遵守 one worker → one browserInstance 编排规范的 orchestrator 零行为变化：同实例顺序调用永远无锁争用。SKILL.md 已同步说明排队语义与"超时重试前先用读工具验证"的指引。

### Patch Changes

- Updated dependencies [[`8e592b3`](https://github.com/steveoon/roll-agent/commit/8e592b3d24716b9bcb624eb29fddf3c1040a451a)]:
  - @roll-agent/sdk@0.3.0

## 0.21.1

### Patch Changes

- Updated dependencies []:
  - @roll-agent/sdk@0.2.1

## 0.21.0

### Minor Changes

- [#122](https://github.com/steveoon/roll-agent/pull/122) [`05b75c1`](https://github.com/steveoon/roll-agent/commit/05b75c15786501f665e76c77d7ee0ffbd711fafd) Thanks [@steveoon](https://github.com/steveoon)! - Upgrade the BOSS recommend candidate filter tool to model the region selector and all visible filter panel fields through the native CDP workflow.

  The browser-use skill now documents the recommend filter as a target-state contract, including region-to-district filtering, patch versus replace behavior, multi-select clearing, and stale candidate refs after filtering. The Roll core skill template now also reminds orchestrators that array inputs in state-setting tools are not automatically append operations.

## 0.20.0

### Minor Changes

- [#118](https://github.com/steveoon/roll-agent/pull/118) [`becaaeb`](https://github.com/steveoon/roll-agent/commit/becaaeb479a65a96b93d62cc8b2326ea9aaa000e) Thanks [@steveoon](https://github.com/steveoon)! - Adapt Reply Authority dual-draft `replyVariants` feedback loop.
  - `@roll-agent/reply-authority-client` adds `replyVariants`, reply feedback body/response/rubric schemas, `fetchReplyFeedbackRubric()`, and `postReplyFeedback()`.
  - `@roll-agent/browser-use-agent` stores dual-draft prepared replies behind neutral `option_1` / `option_2`, adds `zhipin_judge_prepared_reply`, supports `variantDecision` in `zhipin_send_prepared_reply`, and posts `/reply-feedback` after successful sends.
  - `@roll-agent/browser-use-agent` also renders neutral dual-draft options side-by-side in the in-page reply preview so operators can compare the two safe alternatives before sending.
  - `@roll-agent/browser-use-agent` normalizes Zhipin profile experience tokens: graduation labels such as `25年应届生` become `应届生`, graduation years such as `06年毕业` are excluded from work experience, implausible bare year values are dropped, and bare year labels strip leading zeros; Reply Authority `422` / `504` / `5xx` preview failures are classified as rejection, timeout, or server errors.
  - `@roll-agent/smart-reply-agent` re-exports the new protocol schemas/types and documents that the primary browser send loop should use `browser-use`.
  - Roll/OpenClaw orchestration docs now describe prepared artifacts, neutral variant choices, optional judge/decision stages, and confirmation retries without exposing signed envelopes.

### Patch Changes

- Updated dependencies [[`becaaeb`](https://github.com/steveoon/roll-agent/commit/becaaeb479a65a96b93d62cc8b2326ea9aaa000e)]:
  - @roll-agent/reply-authority-client@0.5.0

## 0.19.0

### Minor Changes

- [#116](https://github.com/steveoon/roll-agent/pull/116) [`a806ae7`](https://github.com/steveoon/roll-agent/commit/a806ae756b61f38912d0ce3dc4764dd3b9dfb8ba) Thanks [@steveoon](https://github.com/steveoon)! - 支持沟通职位新命名规范 `xxx-xxx-xxx[品牌ID]` 的品牌识别。
  - `resolvePreferredBrandId()`：从沟通职位末尾的 `[品牌ID]` 尾缀（兼容全角括号 `【】`/`［］` 与内部空白）提取 Duliday 品牌 ID
  - `resolvePreferredBrand()`：检测到品牌 ID 尾缀时不再取第一段作为品牌名，避免向服务端发送错误的 explicit 品牌信号（新格式第一段是岗位描述而非品牌名）
  - 协议新增可选字段 `preferredBrandId`，随 generate-reply / prepare-reply-context 请求发送，与 Reply Authority 服务端的 `duliday_id` 直查对齐；`zhipin_get_candidate_info` 输出同步暴露该字段（与 `preferredBrand` 互斥）
  - 老命名 `品牌名-xxx`（无 ID 尾缀）走原有名称解析链路，行为不变
  - 清理 location signal 本地 LLM 解析残留：地点证据提取已收编 Reply Authority 服务端，`job-signals.ts` 仅保留纯函数信号解析

### Patch Changes

- Updated dependencies [[`a806ae7`](https://github.com/steveoon/roll-agent/commit/a806ae756b61f38912d0ce3dc4764dd3b9dfb8ba)]:
  - @roll-agent/reply-authority-client@0.4.0

## 0.18.0

### Minor Changes

- [#114](https://github.com/steveoon/roll-agent/pull/114) [`d40bc83`](https://github.com/steveoon/roll-agent/commit/d40bc835be0defdfa0068623534c7831c16c5ee6) Thanks [@steveoon](https://github.com/steveoon)! - Default Zhipin reply generation to Reply Authority server-side planning, consume server
  location-resolution stream events, and add a prepare-reply-context client API for speculative
  context preheating. Zhipin reply previews now surface timing details from stream phase latency
  events so prepared-context hits are visible in the browser feedback layer.

  `ReplyAuthorityRequestError` now exposes the HTTP `statusCode`, and `zhipin_get_candidate_info`
  backs off prepare attempts for 10 minutes after persistent failures (tenant prepare disabled or
  missing client env) instead of re-issuing doomed requests on every call. Its `locationSignals`
  output field is deprecated and always empty now that extraction lives server-side.

  `zhipin_generate_reply_preview` now consumes `gate.completed` events: when a server-side
  fact/quality gate rewrote the final reply, the browser completion label appends
  「终稿经安全门调整」 and the tool output includes `gateRewritten: true`, explaining why the
  final reply may differ from the streamed draft.

### Patch Changes

- Updated dependencies [[`d40bc83`](https://github.com/steveoon/roll-agent/commit/d40bc835be0defdfa0068623534c7831c16c5ee6)]:
  - @roll-agent/reply-authority-client@0.3.0

## 0.17.0

### Minor Changes

- [#112](https://github.com/steveoon/roll-agent/pull/112) [`1fe17c6`](https://github.com/steveoon/roll-agent/commit/1fe17c6f0fb342c5487d4e1e797e0e37c9392530) Thanks [@steveoon](https://github.com/steveoon)! - 新增候选人地点信号（`locationSignals`）管道，供 Reply Authority 生成更贴近门店/区域的回复（Issue [#111](https://github.com/steveoon/roll-agent/issues/111)）。
  - `@roll-agent/reply-authority-client`：新增 `CandidateLocationSignalSchema`，`GenerateReplyToolInput` 支持可选 `locationSignals`。
  - `@roll-agent/browser-use-agent`：`job-signals` 通过 LLM 明确区分地点咨询与非地点咨询，地点咨询时抽取原文地点证据，非地点咨询时返回空信号；LLM 失败时仅返回资料城市/区域弱信号；`zhipin_get_candidate_info` 与 `zhipin_generate_reply_preview` 透传 `locationSignals`，并在浏览器内展示地点分析/生成进度。
  - `@roll-agent/smart-reply-agent`：re-export 地点信号 schema，保持与 Reply Authority 契约一致。

### Patch Changes

- Updated dependencies [[`1fe17c6`](https://github.com/steveoon/roll-agent/commit/1fe17c6f0fb342c5487d4e1e797e0e37c9392530)]:
  - @roll-agent/reply-authority-client@0.2.0

## 0.16.2

### Patch Changes

- [#109](https://github.com/steveoon/roll-agent/pull/109) [`4e4f1f9`](https://github.com/steveoon/roll-agent/commit/4e4f1f93a7462600b46d4e2dfb281d266829710f) Thanks [@steveoon](https://github.com/steveoon)! - 修复 macOS 上批量回复 BOSS 直聘未读消息时，发送瞬间弹出系统「关于本机」窗口的问题。
  - 根因：`native-page.ts` 的 `selectAllFocusedText()` 在发送回复前用合成键盘事件 `Cmd+A`（带 Command/Ctrl 修饰键）清空输入框，该事件在网页未消费时会泄漏到 macOS 系统快捷键层，触发系统窗口。
  - 修复：全选改用页面内 JS `Selection` API（contenteditable 走 `range.selectNodeContents`，input/textarea 走 `el.select()`），不再发送任何带修饰键的合成键盘事件；删除仍用无修饰 `Backspace`，「清空再输入」的语义不变。
  - 全选走现有 `evaluateJson` → `Runtime.evaluate`，不引入 `Runtime.enable`，无新增自动化指纹面。

## 0.16.1

### Patch Changes

- [#107](https://github.com/steveoon/roll-agent/pull/107) [`4929389`](https://github.com/steveoon/roll-agent/commit/49293899bc7409d570c9f9a20544f822bf4b8f63) Thanks [@steveoon](https://github.com/steveoon)! - 修复智能回复 `message_sent` 埋点丢失未读上下文导致 dashboard 回复率/被回复人恒为 0 的问题。
  - `zhipin_generate_reply_preview` 在读取聊天详情后派生 `unreadCountBeforeReply`：优先取真实红点（`nav.unreadCount > 0`），否则当预览上下文里最新有效人类消息来自候选人时保守推断为 1，再否则为 0；该值随预备回复一并保存。
  - `zhipin_send_prepared_reply` 将保存的 `unreadCountBeforeReply` 透传给 `sendSignedZhipinReply()`；发送阶段如重新 `openChat()` 拿到更大的真实未读数，用 `Math.max()` 保留更可信数值。
  - 不新增任何外部 MCP tool 参数，不改变 `zhipin_generate_reply_preview` / `zhipin_send_prepared_reply` / `zhipin_send_reply` 的公开输入输出契约；`message_sent` 继续以 `unreadCountBeforeReply > 0` 生成 `wasUnreadBeforeReply=true`。
  - 仅修复未来埋点，历史数据不自动回填。

## 0.16.0

### Minor Changes

- [#105](https://github.com/steveoon/roll-agent/pull/105) [`45563de`](https://github.com/steveoon/roll-agent/commit/45563de4523c50592b3b8a074676146b1d2a9eae) Thanks [@steveoon](https://github.com/steveoon)! - 新增 native CDP `Page.reload` 恢复能力，用于长跑 BOSS tab 的周期性恢复。
  - `@roll-agent/browser`：`NativeCdpController` 新增 `reload({ url?, ignoreCache?, timeoutMs? })`，并将 `Page.reload` 加入 native CDP 方法 allowlist；走现有 `preflightAction`（actionPolicy / domainAllowlist）边界，不触发 Playwright attach。
  - `@roll-agent/browser-use-agent`：
    - 新增通用 tool `browser_reload_active_tab`，对当前 tracked native page 执行 reload，采用 document 身份哨兵检测换页完成（规避同 URL 下 readyState 假阳性）。
    - `zhipin_open_chat_page` 新增 `forceReload` 入参与 `usedReload` / `reloadSkippedReason` 输出；仅在当前确为可恢复的 BOSS 沟通页时 reload，否则返回结构化 `not_chat_page`，并支持 `browserActionApproval` 回环。
    - reload 后所有 `@eN` / `candidateRef` / `jobRef` 失效，须重新 snapshot / 读列表（SKILL.md 与 references/zhipin-workflows.md 已补充能力边界）。

### Patch Changes

- Updated dependencies [[`45563de`](https://github.com/steveoon/roll-agent/commit/45563de4523c50592b3b8a074676146b1d2a9eae)]:
  - @roll-agent/browser@0.9.0

## 0.15.0

### Minor Changes

- [#102](https://github.com/steveoon/roll-agent/pull/102) [`ba1c045`](https://github.com/steveoon/roll-agent/commit/ba1c045008316a33e6f482efcedeaa6991fda3ea) Thanks [@steveoon](https://github.com/steveoon)! - Add per-instance browser profile colors for managed multi-browser runtimes.

- [#102](https://github.com/steveoon/roll-agent/pull/102) [`ba1c045`](https://github.com/steveoon/roll-agent/commit/ba1c045008316a33e6f482efcedeaa6991fda3ea) Thanks [@steveoon](https://github.com/steveoon)! - Add instance-level browser stop commands that close managed browser runtimes without stopping browser-use-agent.

### Patch Changes

- Updated dependencies [[`ba1c045`](https://github.com/steveoon/roll-agent/commit/ba1c045008316a33e6f482efcedeaa6991fda3ea), [`ba1c045`](https://github.com/steveoon/roll-agent/commit/ba1c045008316a33e6f482efcedeaa6991fda3ea)]:
  - @roll-agent/browser@0.8.0

## 0.14.0

### Minor Changes

- [#100](https://github.com/steveoon/roll-agent/pull/100) [`fd4917d`](https://github.com/steveoon/roll-agent/commit/fd4917d6720fd76a4b8a4f1e466ca3fa6d7ecc26) Thanks [@steveoon](https://github.com/steveoon)! - Add managed multi-browser instance support with per-instance runtime config, status reporting, profile labeling, and adaptive visible window tiling for browser-use workflows.

### Patch Changes

- Updated dependencies [[`fd4917d`](https://github.com/steveoon/roll-agent/commit/fd4917d6720fd76a4b8a4f1e466ca3fa6d7ecc26)]:
  - @roll-agent/browser@0.7.0

## 0.13.0

### Minor Changes

- [#98](https://github.com/steveoon/roll-agent/pull/98) [`1431557`](https://github.com/steveoon/roll-agent/commit/14315578effb9f8f2f035b5225b9f4904ffd7fe7) Thanks [@steveoon](https://github.com/steveoon)! - Add browser foreground policy control for native CDP interactions.

  Browser security config now supports `foregroundPolicy` with a default of `when-minimized`, so native browser actions only call `Page.bringToFront` when the target Chrome window is minimized. `browser-use-agent` applies the policy across generic ref actions and Zhipin native tools, and browser diagnostics now report the effective policy.

### Patch Changes

- Updated dependencies [[`1431557`](https://github.com/steveoon/roll-agent/commit/14315578effb9f8f2f035b5225b9f4904ffd7fe7)]:
  - @roll-agent/browser@0.6.0

## 0.12.1

### Patch Changes

- [#96](https://github.com/steveoon/roll-agent/pull/96) [`db6d46b`](https://github.com/steveoon/roll-agent/commit/db6d46b3ea482650024b307e1593406846286dce) Thanks [@steveoon](https://github.com/steveoon)! - Keep the browser visual activity viewport frame safe by clearing stale full-page overlay styles before rendering a low-opacity edge glow, preventing the page from appearing inset while preserving visual progress feedback.

## 0.12.0

### Minor Changes

- [#94](https://github.com/steveoon/roll-agent/pull/94) [`2013aea`](https://github.com/steveoon/roll-agent/commit/2013aeada6d7269826133ed0e6c1e765d06a70b7) Thanks [@steveoon](https://github.com/steveoon)! - Add generic browser Accessibility snapshots and stable `@eN` element refs.
  - Add AX snapshot schemas, `Accessibility.getFullAXTree` support, and `@eN` ref generation in `@roll-agent/browser`.
  - Add backendNodeId-first element ref actions with role/name/nth fallback for stale refs, including recursive same-target iframe refs that carry `frameId`.
  - Promote non-semantic DOM-action controls inside same-target iframes, such as visible `div`/`span` buttons with `cursor:pointer` or button-like class hints.
  - Promote composite dropdown option rows by reading visible descendant text in dropdown/menu/select contexts.
  - Expose `browser_snapshot`, `click_ref`, and `type_ref` in `browser-use-agent`, capped by `security.maxSnapshotNodes` and gated by browser action policy.

### Patch Changes

- Updated dependencies [[`2013aea`](https://github.com/steveoon/roll-agent/commit/2013aeada6d7269826133ed0e6c1e765d06a70b7)]:
  - @roll-agent/browser@0.5.0

## 0.11.0

### Minor Changes

- [#91](https://github.com/steveoon/roll-agent/pull/91) [`e84cba2`](https://github.com/steveoon/roll-agent/commit/e84cba281b5f5a999577175db296a48e843eeff9) Thanks [@steveoon](https://github.com/steveoon)! - Add browser security policy and browser-use tool confirmation policy.
  - Add env-driven browser hard boundaries for domain allowlists, action policy decisions, and output caps.
  - Add browser-use tool-level policy with one-time approval tokens for confirm-gated tools.
  - Gate `zhipin_send_prepared_reply` with non-consuming prepared reply inspection and approval retry support.
  - Add structured tool errors in the SDK and expose them through `roll run --json`.
  - Surface browser security and tool policy summaries in `browser_status` and `roll doctor`.

- [#91](https://github.com/steveoon/roll-agent/pull/91) [`7ba7324`](https://github.com/steveoon/roll-agent/commit/7ba73245068d1340424ff5e27438201c560c4a2b) Thanks [@steveoon](https://github.com/steveoon)! - Add Reply Authority shared client, browser-use streaming reply preview, and prepared reply sending.

  Browser-use now streams Reply Authority progress into an in-page preview panel, stores signed replies
  behind opaque `preparedReplyId` values, and sends via `zhipin_send_prepared_reply` without exposing
  signed envelopes to callers. Sending reuses the currently selected chat when it already matches the
  prepared reply target, while still reopening and validating stale targets as a fallback. The preview
  panel also shows a lightweight loading spinner during generation.

  Smart-reply now reuses the shared Reply Authority client for the existing non-streaming
  `generate_reply` flow. The shared Reply Authority schema now accepts `modelConfig.reasoning`, so
  orchestrators can explicitly request reasoning/thinking mode for smart replies. Browser-use exposes
  the same choice as a narrow `reasoning` option on `zhipin_generate_reply_preview`, while preserving
  opaque prepared reply artifacts instead of passing signed envelopes through orchestrators.

### Patch Changes

- Updated dependencies [[`e84cba2`](https://github.com/steveoon/roll-agent/commit/e84cba281b5f5a999577175db296a48e843eeff9), [`7ba7324`](https://github.com/steveoon/roll-agent/commit/7ba73245068d1340424ff5e27438201c560c4a2b)]:
  - @roll-agent/browser@0.4.0
  - @roll-agent/sdk@0.2.0
  - @roll-agent/reply-authority-client@0.1.2

## 0.10.0

### Minor Changes

- [#89](https://github.com/steveoon/roll-agent/pull/89) [`a600efb`](https://github.com/steveoon/roll-agent/commit/a600efb3f3db513801fac22555e7abbc4342e936) Thanks [@steveoon](https://github.com/steveoon)! - Add Reply Authority shared client, browser-use streaming reply preview, and prepared reply sending.

  Browser-use now streams Reply Authority progress into an in-page preview panel, stores signed replies
  behind opaque `preparedReplyId` values, and sends via `zhipin_send_prepared_reply` without exposing
  signed envelopes to callers. Sending reuses the currently selected chat when it already matches the
  prepared reply target, while still reopening and validating stale targets as a fallback. The preview
  panel also shows a lightweight loading spinner during generation.

  Smart-reply now reuses the shared Reply Authority client for the existing non-streaming
  `generate_reply` flow. Roll/OpenClaw orchestration docs were updated to describe opaque prepared
  reply artifacts instead of passing signed envelopes through orchestrators.

### Patch Changes

- Updated dependencies [[`a600efb`](https://github.com/steveoon/roll-agent/commit/a600efb3f3db513801fac22555e7abbc4342e936)]:
  - @roll-agent/reply-authority-client@0.1.1

## 0.9.1

### Patch Changes

- [#82](https://github.com/steveoon/roll-agent/pull/82) [`bff87f0`](https://github.com/steveoon/roll-agent/commit/bff87f022ef0411f5e97397f13d59d163ea0a2fe) Thanks [@steveoon](https://github.com/steveoon)! - Add orchestrator-focused runtime improvements across Roll and browser-use.

  Core now serves registered agent skill documents through `roll skills list|get|path`, including an opt-in `roll skills get <agent> --include-references` mode that returns referenced local `references/*` documents. `roll run` also supports `--batch-json`, `--batch-file`, and `--batch-stdin` for multiple explicit tool calls in one CLI process; `--bail` stops on first failure. `roll doctor` adds `--fix-plan` and safe `--fix` handling for config migration, missing agent data directories, and orphan core-managed runtime metadata. `roll agent health` also surfaces runtime sidecar issues (version mismatch, orphan sidecar, PID mismatch) before probing the endpoint.

  The browser-use agent now emits and accepts BOSS recommend-list `candidateRef` handles so orchestrators can pass stable tool-facing references to `zhipin_say_hello` and `zhipin_open_resume` instead of relying only on raw DOM indices.

- [#82](https://github.com/steveoon/roll-agent/pull/82) [`2003604`](https://github.com/steveoon/roll-agent/commit/20036040a3a29cabc9022d6a34d092f4f908d4a7) Thanks [@steveoon](https://github.com/steveoon)! - Add native CDP page navigation support and move `navigate_active_tab` onto the native CDP path. The tool now avoids Playwright attach, reuses native platform tabs, opens non-platform URLs in a native page, and blocks direct BOSS `/web/chat/*` backend navigation in favor of semantic BOSS navigation tools.

- [#82](https://github.com/steveoon/roll-agent/pull/82) [`b17c360`](https://github.com/steveoon/roll-agent/commit/b17c3602400572c04a7a3aa8db9808de332feb89) Thanks [@steveoon](https://github.com/steveoon)! - Improve BOSS recommend-page orchestration with `zhipin_list_recommend_jobs`, `jobRef` based job selection, optional force-click behavior, and shorter batched greeting delays.

- Updated dependencies [[`2003604`](https://github.com/steveoon/roll-agent/commit/20036040a3a29cabc9022d6a34d092f4f908d4a7)]:
  - @roll-agent/browser@0.3.1

## 0.9.0

### Minor Changes

- [#78](https://github.com/steveoon/roll-agent/pull/78) [`225d8cc`](https://github.com/steveoon/roll-agent/commit/225d8ccc416ef21f607278c20ca9b4706615b265) Thanks [@steveoon](https://github.com/steveoon)! - Add Zhipin recruitment event tracking for message, contact, and WeChat exchange flows with environment-driven Open API configuration.

## 0.8.0

### Minor Changes

- [#73](https://github.com/steveoon/roll-agent/pull/73) [`9ee8d5e`](https://github.com/steveoon/roll-agent/commit/9ee8d5e87c88f78ff033a4ed714e1e388bc73a09) Thanks [@steveoon](https://github.com/steveoon)! - Add BOSS recommend job selection support and expose scroll boundary state for dynamic lists.

  The BOSS native CDP workflow can now select the active recommend-page job by stable
  `jobValue`, `jobName`, or current dropdown `index`, and `zhipin_scroll_view` reports
  top/bottom boundary fields so orchestrators can reason about virtual list position.

## 0.7.7

### Patch Changes

- [#71](https://github.com/steveoon/roll-agent/pull/71) [`203e573`](https://github.com/steveoon/roll-agent/commit/203e5739477f6ad59180d8bfc9eec59ff3318d30) Thanks [@steveoon](https://github.com/steveoon)! - Slow down native CDP mouse movement previews and make click pulses more visible.

## 0.7.6

### Patch Changes

- [#69](https://github.com/steveoon/roll-agent/pull/69) [`2da5f7f`](https://github.com/steveoon/roll-agent/commit/2da5f7f3a1c0bf3a473260c22297ff0e9d2acbcd) Thanks [@steveoon](https://github.com/steveoon)! - Add native CDP primitives and migrate the BOSS Zhipin main workflow to the native backend.

  `@roll-agent/browser` now exposes native CDP controller utilities for page inspection,
  DOM evaluation, mouse input, keyboard input, text insertion, and native locators without
  requiring a Playwright page attach.

  `browser-use-agent` now routes the BOSS Zhipin chat, reply sending, WeChat exchange,
  recommend-list reading, filtering, scrolling, and greet flows through the native backend.
  The remaining resume popup tools stay Playwright-backed and share their DOM contract through
  `resume-dom-contract.ts`.

  `roll ask` preflight validation now catches array `minItems` constraints before dispatching
  tool calls, so underspecified semantic requests can return `needs_input` instead of reaching
  MCP tool validation.

- Updated dependencies [[`2da5f7f`](https://github.com/steveoon/roll-agent/commit/2da5f7f3a1c0bf3a473260c22297ff0e9d2acbcd)]:
  - @roll-agent/browser@0.3.0

## 0.7.5

### Patch Changes

- [#67](https://github.com/steveoon/roll-agent/pull/67) [`4d11426`](https://github.com/steveoon/roll-agent/commit/4d11426060071f4c1dfceaa5019f4a397d332677) Thanks [@steveoon](https://github.com/steveoon)! - Fix `roll run` JSON object input handling and add browser-use diagnostics for BOSS page attach state.

  `roll run` now accepts a third positional JSON object as explicit tool input while keeping
  `--input-json` as the recommended orchestration-safe form. `browser-use-agent` also adds
  `zhipin_diagnose_browser_state` for inspecting BOSS native page selection, attach state, page
  readiness, and automation fingerprint exposure.

## 0.7.4

### Patch Changes

- Updated dependencies [[`256d676`](https://github.com/steveoon/roll-agent/commit/256d6765dfb451e7aca57121e304bfba54e56752)]:
  - @roll-agent/sdk@0.1.6

## 0.7.3

### Patch Changes

- [#63](https://github.com/steveoon/roll-agent/pull/63) [`e0f5a51`](https://github.com/steveoon/roll-agent/commit/e0f5a51b5e63e1503d906f4124a7209010688c92) Thanks [@steveoon](https://github.com/steveoon)! - feat(browser-use): add dynamic list scrolling, recommend filter tool, and harden exchange-wechat
  - 新增 `zhipin_scroll_view(surface, direction?, steps?, distance?, settleMs?)`，支持 `chat-list` / `chat-history` / `recommend-list` 三个内部滚动容器；不传 `direction` 时使用该 surface 的默认方向
  - `zhipin_read_messages` 新增 `autoScroll` / `maxScrolls` 参数，默认按 `conversationId` 自动向下滚动左侧消息列表并合并去重
  - `zhipin_get_candidate_list` 新增 `autoScroll` / `maxScrolls` 参数和 `scrollStats.stopReason` 返回字段（`target-count` / `boundary` / `no-new-items` / `max-steps`），默认按 `candidateId` / `data-geek` 滚动去重
  - 抽出通用动态列表滚动器 `pages/shared/dynamic-list-scroller.ts` 和 `pages/zhipin/list-surfaces.ts`，由上述工具复用
  - 新增 `zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)`，在「推荐牛人」页打开筛选面板，只设置年龄、性别、活跃度[单选] 三个维度并提交；未传的维度会重置为「不限」（年龄默认 `16-不限`），不会触碰岗位、学历、薪资、求职状态等其他筛选项
  - `zhipin_exchange_wechat` 可靠性加固：调用前用 `getSelectedChatTarget` / `getActiveChatPanel` 校验左侧选中会话与右侧聊天面板的候选人一致；「换微信」按钮 selector 限定在右侧 `.conversation-operate` 操作区，文本匹配从 `includes("换微信")` 改为严格等于，避免误匹配顶部筛选栏的「已交换微信」；移除全量 `span` 文本 fallback；marker 属性提取为常量并在 `finally` 中清理，避免跨调用残留
  - SKILL.md 更新推荐列表链路为 4 步，并补充动态列表滚动规则与 `index` 不可跨调用稳定的说明

## 0.7.2

### Patch Changes

- [#61](https://github.com/steveoon/roll-agent/pull/61) [`d4df6ee`](https://github.com/steveoon/roll-agent/commit/d4df6eebd70ee11be8d5c727777c5dd177b455af) Thanks [@steveoon](https://github.com/steveoon)! - feat(browser-use): add semantic navigation tools, visual activity system, and stable conversation IDs
  - 新增 `navigate_active_tab`、`zhipin_open_chat_page`、`zhipin_open_recommend_page` 三个语义导航 tool，替代硬编码 URL 跳转
  - 引入 visual activity session 系统：cursor 生命周期与 activity tone 独立管理，支持从 theme key 派生色调
  - `browser_status` tool 重构视觉反馈输出，cursor 显示与活动状态解耦
  - BOSS 聊天工作流（read-messages、send-reply、open-chat、exchange-wechat 等）引入稳定 conversation ID，确保跨调用会话一致性

## 0.7.1

### Patch Changes

- [#58](https://github.com/steveoon/roll-agent/pull/58) [`8a0dd50`](https://github.com/steveoon/roll-agent/commit/8a0dd50253cd452b3651950e69aa2d6a1b1ce20a) Thanks [@steveoon](https://github.com/steveoon)! - feat(browser-use): replace brand whitelist with hyphen-format preferredBrand extraction
  - `zhipin_get_candidate_info` 现在通过连字符类分隔符（`-` / `－` / `—` / `–`）从 `communicationPosition` 提取 `preferredBrand`，不再依赖硬编码白名单
  - 提取结果作为可选字段透传给 `generate_reply`，供 smart-reply-agent 做品牌锁定
  - 新增 `resolvePreferredBrand()` / `resolveExpectedSignals()` 纯函数，`resolveConversationSignals()` 统一出口
  - 移除 `BRAND_ALIAS_TO_NAME` 白名单和空格兼容分隔符逻辑

## 0.7.0

### Minor Changes

- [#54](https://github.com/steveoon/roll-agent/pull/54) [`edded04`](https://github.com/steveoon/roll-agent/commit/edded043c69b9e83af25b3f6e6dbb49c22332b08) Thanks [@steveoon](https://github.com/steveoon)! - feat: external-agent friendly discoverability, drift detection and error context

  面向 orchestrator / 外部 agent 的一轮可用性优化，覆盖最常踩的 4 个坑：
  - **Tool discoverability**
    - core 新增 `roll agent tools <agent-name>` 命令（含 `--json`），代理 MCP `tools/list`，输出每个 tool 的 name / description / inputSchema
    - `roll run` / `roll ask` 调到不存在的 tool 时，输出 Levenshtein + token overlap 融合评分的 "Did you mean: ..." 候选 + 指向 `roll agent tools` 的提示
  - **Unified preflight output**
    - core 新增 `packages/core/src/tool-runtime/preflight.ts` 模块，一次性聚合缺失字段（递归展开父对象 → 叶子字段）
    - 错误输出分 A（输入缺失）/ B（运行条件缺失）双 section，不再按 zod 首错截断
    - `roll ask` 的 `needs_input` 响应新增 `runtimeIssues` 字段
  - **Config drift detection**
    - browser-use 新增 `diagnostic_status` 诊断能力（经 `browser_status.effectiveEnvSources` 暴露），smart-reply 新增 `diagnostic_status` tool；两者返回声明过的 env key 的 `{present, fingerprint}`（SHA256 前 8 位，不泄漏 value）
    - core 的 `roll doctor` / `roll agent info` 调用诊断 tool，对比 yaml 声明与 agent 运行态指纹，展示 `✓ from yaml (stable)` / `⚠ differs from yaml (ephemeral)` / `⚠ from shell (ephemeral)` / `✗ missing` 等六态
  - **Fail-fast on preload + error context**
    - browser-use 启动期 preload Reply Authority 公钥失败时写入 `replyAuthorityKeysLoaded=false`，`browser_status` 输出该字段，`zhipin_send_reply` 在验签前就前置拒绝并返回结构化错误
    - smart-reply 的 Reply Authority 调用统一走 `ReplyAuthorityRequestError`（携带 `meta: {url, timeoutMs, requestId}` + `Error.cause` 链 + `x-request-id` 透传）

## 0.6.0

### Minor Changes

- [#52](https://github.com/steveoon/roll-agent/pull/52) [`a73f10a`](https://github.com/steveoon/roll-agent/commit/a73f10ae62a591a4e8c66aef8336b211af0db68e) Thanks [@steveoon](https://github.com/steveoon)! - feat: add recruiter binding resolution and v2 envelope verification
  - smart-reply agent now accepts direct `recruiterBinding` or proxy `recruiterUsername`, resolving recruiter bindings before calling Reply Authority Service when needed
  - browser-use agent now expects v2 signed envelopes and validates recruiter binding before sending replies

## 0.5.0

### Minor Changes

- [#47](https://github.com/steveoon/roll-agent/pull/47) [`289dc16`](https://github.com/steveoon/roll-agent/commit/289dc1660ec2d1c2973e024454a3192cef6f812e) Thanks [@steveoon](https://github.com/steveoon)! - feat(smart-reply): generate_reply 全切 Reply Authority Service 云端签发

  smart-reply-agent 不再本地执行回复管线，改为向 Reply Authority Service 转发请求。
  输入新增必填 target（platform/tenantId/conversationId/candidateId），
  输出新增 signedEnvelope 和 envelopeExp。
  环境变量：REPLY_AUTHORITY_URL + REPLY_AUTHORITY_BEARER_TOKEN。

  feat(browser-use): zhipin_send_reply 实现本地 Ed25519 信封验签

  输入从 message 改为 signedEnvelope，发送前执行完整验证链路：
  Ed25519 签名校验 → iss/aud/platform 校验 → exp/iat 时间戳校验 →
  jti 防重放 → conversationId/candidateId 目标绑定校验。
  zhipin_read_messages 和 zhipin_get_candidate_info 输出补充 conversationId/candidateId。

  fix(core): agent-start 未注入 agents.env 到 core-managed 进程

  roll agent start 启动 core-managed agent 时未传递 agents.env 配置的环境变量，
  改为通过 getAgentEnv() 查找并注入。

  fix(core): config set 错误转换 SCREAMING_SNAKE_CASE 键名

  camelToKebab 对全大写+下划线格式的环境变量名（如 REPLY_AUTHORITY_KEYS_URL）
  逐字符插入连字符，现跳过此类键名。

## 0.4.2

### Patch Changes

- [#43](https://github.com/steveoon/roll-agent/pull/43) [`a8cafd5`](https://github.com/steveoon/roll-agent/commit/a8cafd5eef20b104931614d14be280d2d84c343c) Thanks [@steveoon](https://github.com/steveoon)! - fix(browser-use): 推荐列表工具消除合成点击 isTrusted: false 风控风险

  zhipin_say_hello 和 zhipin_open_resume 的点击操作从 evaluate() 内合成 MouseEvent 改为 Playwright locator.click()，生成 isTrusted: true 事件，降低 Boss 直聘动作级反自动化检测风险。
  - 新增 recommend-list.ts 公共 helper，统一推荐列表的 frame 定位、列表等待、卡片信息只读提取
  - zhipin_say_hello: 移除 dispatchEvent(mousedown/mouseup/click) + btn.click()，改为 locator.scrollIntoViewIfNeeded() → hover() → humanDelay() → click()
  - zhipin_open_resume: 移除 evaluate 内 item.click()，改为 locator 定位 clickSurface → hover() → randomDelay() → click()
  - 保留原有时序随机化逻辑（humanDelay、performRandomScroll）
  - zhipin_get_username: 修复 lazy attach 后因 hasContext 前置检查导致的"未找到已跟踪页面"回归，改为 getPage() 自动发现并绑定页面
  - zhipin_send_reply: 发送按钮点击从 evaluate 内 btn.click() 改为 Playwright locator.click()，data-roll-send-btn 清理移入 finally 防残留
  - chat-navigation: clickMessageEntry() 和 clickChatItem() 从 evaluate 内 DOM click 改为临时 marker + Playwright locator.click()，新增 clearTemporaryMarker/clickMarkedElement 共用 helper

## 0.4.1

### Patch Changes

- [#43](https://github.com/steveoon/roll-agent/pull/43) [`a8cafd5`](https://github.com/steveoon/roll-agent/commit/a8cafd5eef20b104931614d14be280d2d84c343c) Thanks [@steveoon](https://github.com/steveoon)! - fix(browser-use): 推荐列表工具消除合成点击 isTrusted: false 风控风险

  zhipin_say_hello 和 zhipin_open_resume 的点击操作从 evaluate() 内合成 MouseEvent 改为 Playwright locator.click()，生成 isTrusted: true 事件，降低 Boss 直聘动作级反自动化检测风险。
  - 新增 recommend-list.ts 公共 helper，统一推荐列表的 frame 定位、列表等待、卡片信息只读提取
  - zhipin_say_hello: 移除 dispatchEvent(mousedown/mouseup/click) + btn.click()，改为 locator.scrollIntoViewIfNeeded() → hover() → humanDelay() → click()
  - zhipin_open_resume: 移除 evaluate 内 item.click()，改为 locator 定位 clickSurface → hover() → randomDelay() → click()
  - 保留原有时序随机化逻辑（humanDelay、performRandomScroll）

## 0.4.0

### Minor Changes

- [#41](https://github.com/steveoon/roll-agent/pull/41) [`1e317e0`](https://github.com/steveoon/roll-agent/commit/1e317e0807bdbbbc241e9f40632c7797fab1773c) Thanks [@steveoon](https://github.com/steveoon)! - feat(browser): lazy Playwright attach + 原生 CDP 页面管理

  解决 Boss 直聘反自动化检测问题。根因：Playwright 在登录前持续 attach 整个浏览器 + newPage/goto 开页被 Boss 风控识别为自动化行为。

  **@roll-agent/browser 改动：**
  - BrowserRuntime 启动后不再立即 connectOverCDP()，改为首次 getBrowser() 时 lazy attach
  - 新增 NativeCdpPageClient，通过原生 CDP HTTP 接口（/json/list、/json/new、/json/activate）管理页面，全程不触发 Playwright
  - ContextManager 支持双轨状态：登录前 nativeSelection + 登录后 Playwright Page，attach 时启发式匹配回之前选中的 tab
  - 新增 profile 装饰（名称/颜色/clean exit 标记），Chrome 启动参数对齐 OpenClaw
  - DI 模式支持测试注入 spawn/connectOverCDP/fetch

  **@roll-agent/browser-use-agent 改动：**
  - open_platform / list_pages / select_page 全部切到原生 CDP 路径，登录前零 Playwright attach
  - 新增 attach_browser_session 调试工具，显式触发 connectOverCDP
  - 聊天页进入策略重构为四级 fallback：已是聊天页 → 复用已有聊天 tab → UI 点击消息按钮 → goto 兜底（软失败）
  - 所有 zhipin\_\* 工具内联的 page.goto 已清除，统一到 chat-navigation 辅助函数

### Patch Changes

- Updated dependencies [[`1e317e0`](https://github.com/steveoon/roll-agent/commit/1e317e0807bdbbbc241e9f40632c7797fab1773c)]:
  - @roll-agent/browser@0.2.0

## 0.3.2

### Patch Changes

- [#33](https://github.com/steveoon/roll-agent/pull/33) [`5661430`](https://github.com/steveoon/roll-agent/commit/5661430138b6e86d6025d209702271ad3d3cd793) Thanks [@steveoon](https://github.com/steveoon)! - build: bundle published packages into single JS files via esbuild

  Replace multi-file tsc output with esbuild single-file bundles to eliminate
  internal file structure from dist/. Build pipeline is now
  tsc --emitDeclarationOnly → esbuild bundle → terser minification.
  .d.ts files preserved as-is for TypeScript consumers.

- Updated dependencies [[`5661430`](https://github.com/steveoon/roll-agent/commit/5661430138b6e86d6025d209702271ad3d3cd793)]:
  - @roll-agent/sdk@0.1.5
  - @roll-agent/browser@0.1.5

## 0.3.1

### Patch Changes

- [#26](https://github.com/steveoon/roll-agent/pull/26) [`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c) Thanks [@steveoon](https://github.com/steveoon)! - build: add terser minification and remove source maps from published packages
  - Add shared `scripts/obfuscate.mjs` for post-tsc minification (compress + mangle with `keep_classnames`)
  - Disable `sourceMap` and `declarationMap` in root `tsconfig.build.json`
  - Add `scripts/verify-published-packages.mjs` for tarball-level publish verification
  - `.d.ts` files remain intact for TypeScript consumers

- Updated dependencies [[`fd6f899`](https://github.com/steveoon/roll-agent/commit/fd6f89959e12be71469977d22ec525d02dad5e9c)]:
  - @roll-agent/sdk@0.1.4
  - @roll-agent/browser@0.1.4

## 0.3.0

### Minor Changes

- [#21](https://github.com/steveoon/roll-agent/pull/21) [`a6747b8`](https://github.com/steveoon/roll-agent/commit/a6747b8a1f3995246817054d36de120dd921e84e) Thanks [@steveoon](https://github.com/steveoon)! - refactor(browser-use): zhipin_get_username 升级为语义定位优先 + CSS 兜底的混合定位
  - 四策略证据收集：P1 语义角色（getByRole）+ P2 ARIA snapshot + P3 叶子文本 + P4 CSS 兜底
  - 纯函数打分择优，支持位置权重（xRatio）和跨策略交叉确认
  - 输出 schema 增量扩展：新增 usedStrategy/source 字段，保留 usedSelector 兼容
  - 抽取 platform-page.ts 复用平台页面查找逻辑
  - zhipin_get_username 现在仅复用当前 runtime 已跟踪的 BOSS直聘页面，不再对未跟踪页面做隐式扫描或副作用恢复；首次使用需先 open_platform，或通过 list_pages + select_page 恢复跟踪
  - 修复 username 长度判断 off-by-one（< 改回 <=）

### Patch Changes

- Updated dependencies [[`6e92776`](https://github.com/steveoon/roll-agent/commit/6e9277676a9c9a654906f5d75f998de7033765ac)]:
  - @roll-agent/sdk@0.1.3
  - @roll-agent/browser@0.1.3

## 0.2.2

### Patch Changes

- [#13](https://github.com/steveoon/roll-agent/pull/13) [`55e3417`](https://github.com/steveoon/roll-agent/commit/55e34178bcd18063ecc63b5fd7dc456d79e6baed) Thanks [@steveoon](https://github.com/steveoon)! - Fix the published `@roll-agent/browser` npm manifest to export `dist` files instead of `src` files, and republish `@roll-agent/browser-use-agent` against the fixed browser package.

- Updated dependencies [[`55e3417`](https://github.com/steveoon/roll-agent/commit/55e34178bcd18063ecc63b5fd7dc456d79e6baed)]:
  - @roll-agent/browser@0.1.2

## 0.2.1

### Patch Changes

- [#10](https://github.com/steveoon/roll-agent/pull/10) [`0d86a7c`](https://github.com/steveoon/roll-agent/commit/0d86a7cafc515be6d240377fdf21894ea072c4f3) Thanks [@steveoon](https://github.com/steveoon)! - Make browser-use-agent default to system Chrome without downloading Playwright Chromium during install.

## 0.2.0

### Minor Changes

- [#5](https://github.com/steveoon/roll-agent/pull/5) [`4b55128`](https://github.com/steveoon/roll-agent/commit/4b551281215d1848ca87c5da86866e3831189b3e) Thanks [@steveoon](https://github.com/steveoon)! - Agent runtime management v1 and browser-use tools migration

  **@roll-agent/core**
  - Three-layer agent model: source / transport / runtime ownership
  - Store schema v2 with backward-compatible migration
  - package.json#rollAgent manifest support for agent discovery
  - PID-based process management for core-managed agents
  - CLI lifecycle commands: install/start/stop/health/update/remove
  - Argument extractor and extraction schema improvements
  - LLM router tool description fix

  **@roll-agent/browser-use-agent**
  - Migrate all 11 zhipin tools from ai-sdk-computer-use
  - Add chat-navigation helper with ensureChatOpen for single-shot mode
  - Anti-detection: randomDelay, humanDelay, scroll patterns
  - Fix DOM selectors for exchange-wechat, say-hello, get-candidate-list
  - Add navigate_active_tab tool
  - Publish as @roll-agent/browser-use-agent with rollAgent manifest

  **@roll-agent/browser**
  - Add page listing, selection, and navigation APIs to context-manager

  **@roll-agent/sdk**
  - HTTP transport shutdown order fix

### Patch Changes

- Updated dependencies [[`4b55128`](https://github.com/steveoon/roll-agent/commit/4b551281215d1848ca87c5da86866e3831189b3e)]:
  - @roll-agent/browser@0.1.1
  - @roll-agent/sdk@0.1.2
