---
name: browser-use-agent
description: 浏览器操控 Agent。控制浏览器操作招聘平台：读取消息、打开聊天、发送签名回复、换微信、滚动动态列表、查看推荐列表、筛选候选人、打招呼、查看简历；也提供通用 AX snapshot、@eN element ref 点击/输入，以及 BOSS直聘 native CDP / Playwright attach 风控诊断。
metadata:
  roll-env-file: references/env.yaml
---

# Browser Use Agent

浏览器自动化执行层。BOSS 直聘主链路优先走 native CDP backend；未迁移的低优先级简历弹窗工具仍使用 Playwright-backed 页面 attach。

## 使用前提

- 先启动 `browser-use-agent` HTTP 常驻服务；浏览器 session 跨调用持久。
- 通过 Roll 调用本 Agent 时，先用 `roll skills get browser-use-agent --include-references --json` 读取当前说明和 `references/*`，再用 `roll agent tools browser-use-agent --json` 读取真实 schema。
- 完整 `inputSchema` 以 `roll agent tools browser-use-agent --json` 为准。
- 多账号/多 profile 场景下，Roll 会从 `browser.instances` 注入 `BROWSER_INSTANCES_JSON`；所有 browser-use tool 都支持可选 `browserInstance` 输入，用于选择目标 `profile/userDataDir + cdpPort + sessionsDir`。未传时按 `browser.defaultInstance`，再按单实例自动选择；多实例且无默认值时会返回 `needs_input`。
- 多个 `managed-cdp` 实例首次启动时会自动把 Chrome profile 展示名设为实例 ID，并按声明顺序分配 profile 颜色和自适应平铺窗口：2–3 个实例横向并列并撑满桌面可用高度；4 个实例 2×2 铺满屏幕；5 个及以上按「最多 4 列、每行撑满宽度」均衡排列（5→3+2、6→3+3、8→4+4、10→4+3+3）。macOS 使用只读 `system_profiler SPDisplaysDataType` 探测逻辑分辨率；Windows 使用只读 PowerShell/.NET `PrimaryScreen.WorkingArea` 探测扣除任务栏后的工作区；探测不到时回退默认工作区；也可通过 `ROLL_BROWSER_WORK_AREA=x,y,width,height` 覆盖。需要固定展示时在实例上配置 `profile-name` / `profile-color` / `window-bounds`。
- 浏览器实例采用 **lazy start**：agent 启动不会立刻拉起全部 Chrome，首次访问某个 `browserInstance` 时才启动对应 profile/CDP runtime。
- 实例级关闭使用 `roll browser stop <browserInstance...>` 或 `roll browser stop --all`；它只关闭当前 `browser-use-agent` 托管的浏览器 runtime，不停止 agent 服务进程，也不删除 `userDataDir` / `sessionsDir` 数据。停止整个服务仍使用 `roll agent stop browser-use-agent`。
- `browser_status` 是无副作用诊断工具；它不会为了查询状态而启动尚未启动的 Chrome。需要启动某个实例时，调用带 `browserInstance` 的业务工具，例如 `open_platform({ browserInstance, platform:"zhipin" })`。
- `browser_status.primaryInstanceId` 表示顶层 `running/headless/mode/security` 所采用的 primary bundle；多实例详情请看 `instances[]`。
- `REPLY_AUTHORITY_URL` / `REPLY_AUTHORITY_BEARER_TOKEN` 是生成智能回复预览的必填环境变量；`REPLY_AUTHORITY_KEYS_URL` 是发送预备回复前验签的必填环境变量。`roll doctor` 会通过 `references/env.yaml` 和 `browser_status.effectiveEnvSources` 检查它们是否声明并在运行态生效。
- `BROWSER_SECURITY_JSON` 可选配置浏览器硬安全策略；`browser_status.security` 会返回实际加载后的 `domainAllowlist`、`maxPageContentBytes`、`maxSnapshotNodes`、`actionPolicy` 和 `foregroundPolicy`。`foregroundPolicy` 默认 `when-minimized`，普通后台窗口不抢桌面焦点；仅需要旧行为时才显式设为 `always`。
- `BROWSER_USE_POLICY_JSON` 可选配置 browser-use 工具级业务策略；日常推荐只把 `zhipin_send_prepared_reply` 配为 `confirm`。
- 长任务前或状态异常时先跑 `roll doctor --fix-plan --json`；仅对配置迁移、`agents.dataDir`、孤儿 runtime 元数据这类安全项才使用 `roll doctor --fix --json`。
- 页内反馈默认开启：
  - `BROWSER_VISUAL_CURSOR`：native CDP 点击/拖拽/滚动前显示同源虚拟鼠标轨迹和点击波纹；简历弹窗等 Playwright-backed 工具仍使用旧虚拟指针。
  - `BROWSER_VISUAL_ACTIVITY`：读取、识别、提取等操作显示状态胶囊和区域高亮。
- 需要关闭反馈时，将对应环境变量设为 `false`。

## 多 Boss 账号 / 多 Profile 托管模式

目标：让 orchestrator 同时托管多个 BOSS 招聘账号时，每个账号固定绑定一个独立 Chrome profile、CDP port、session 目录和招聘事件归因 ID。

声明模型：

```text
browserInstance
  -> userDataDir/profile
  -> cdpPort 或 cdpUrl
  -> sessionsDir
  -> trackingAgentId
```

配置示例：

```yaml
browser:
  default-instance: boss-a
  instances:
    boss-a:
      platform: zhipin
      mode: managed-cdp
      cdp-port: 9222
      user-data-dir: ~/.roll-agent/browser/profiles/boss-a
      sessions-dir: ~/.roll-agent/browser/sessions/boss-a
      profile-color: "#2563EB"
      # window-bounds 可选；省略时按实例数量自动平铺
      tracking-agent-id: zhipin-boss-a
    boss-b:
      platform: zhipin
      mode: managed-cdp
      cdp-port: 9223
      user-data-dir: ~/.roll-agent/browser/profiles/boss-b
      sessions-dir: ~/.roll-agent/browser/sessions/boss-b
      profile-color: "#DC2626"
      tracking-agent-id: zhipin-boss-b
```

orchestrator 规则：

1. 多账号托管时，把 `browserInstance` 当作账号路由键；同一个任务线程中的每一次 browser-use tool call 都必须传同一个 `browserInstance`。
2. 不要把 `boss-a` 产生的 `pageId`、`@eN`、`@cN`、`@jN`、`preparedReplyId` 或当前页面状态传给 `boss-b`。
3. `browserInstance` 只标识浏览器/profile；业务归因使用该实例的 `trackingAgentId`，缺失时才 fallback 到 `RECRUITMENT_EVENTS_DEFAULT_AGENT_ID`，仍缺失则跳过招聘事件上报并 warn。
4. `platform` 与实例配置不一致时会返回 `platform_mismatch`。例如 `browserInstance:"boss-a"` 声明为 `zhipin`，就不要调用 `yupao_*` 工具或 `open_platform({ platform:"yupao" })`。
5. 多实例没有 `browser.defaultInstance` 时，任何未显式传 `browserInstance` 的业务调用都会返回 `needs_input`。并行托管建议显式传，不依赖 default。
6. `browser_status()` 可先用于读取声明态/运行态；真正启动某个账号 profile 使用 `open_platform({ browserInstance, platform:"zhipin" })`。
7. 每个账号首次托管时，需要人工在对应 Chrome 窗口完成 BOSS 登录；之后 session 跟随对应 `userDataDir` 和 `sessionsDir`。
8. Chrome 原生 tab group 只通过扩展 API 暴露，browser-use 不注入扩展；用 profile 名称和窗口并排布局作为稳定识别方式。

浏览器生命周期命令：

| 目的 | 命令 | 行为 |
| --- | --- | --- |
| 关闭一个或多个实例窗口/runtime | `roll browser stop boss-a boss-b` | 只关闭指定 browser runtime；`browser-use-agent` 保持运行；`userDataDir` / `sessionsDir` 保留，后续调用会 lazy start。 |
| 关闭全部已启动实例 | `roll browser stop --all` | 关闭当前 agent 托管的所有已启动 browser runtime；不停止服务进程，不删除数据。 |
| 停止整个服务进程 | `roll agent stop browser-use-agent` | 停止 `browser-use-agent`；后续 tool 调用不可用，直到重新 `roll agent start browser-use-agent`。 |
| 清理 profile/session 数据 | `roll browser clear-data [browserInstance] --yes` | 删除声明的 `userDataDir` / `sessionsDir`；先用无 `--yes` dry-run 确认范围，运行中的实例需先 stop，除非显式使用 force。 |

规则：

1. 人类或上层编排器做生命周期控制时优先使用 `roll browser stop`；`browser_stop` tool 主要服务 MCP/agent 内部集成。
2. 只想重启某个浏览器窗口或释放 runtime 时，不要用 `roll agent stop browser-use-agent`。
3. `remote-cdp` / `existing-session` 实例关闭时只断开 Roll 侧连接；不会关闭外部浏览器进程。
4. 不扫描系统 Chrome 进程，也不按端口或目录强杀未由当前 agent 托管的浏览器。

启动/检查流程：

```text
roll doctor --json
  -> roll agent health --json  # parse browser-use-agent entry
  -> roll run browser-use-agent browser_status --json
  -> roll run browser-use-agent open_platform --input-json '{"browserInstance":"boss-a","platform":"zhipin"}' --json
  -> 人工确认 boss-a 窗口登录
  -> roll run browser-use-agent zhipin_get_username --input-json '{"browserInstance":"boss-a"}' --json
  -> roll browser stop boss-a  # 只关闭 boss-a 浏览器 runtime；agent 保持运行
```

多账号批量示例：

```json
[
  {
    "agent": "browser-use-agent",
    "tool": "open_platform",
    "input": { "browserInstance": "boss-a", "platform": "zhipin" },
    "label": "boss-a-open"
  },
  {
    "agent": "browser-use-agent",
    "tool": "open_platform",
    "input": { "browserInstance": "boss-b", "platform": "zhipin" },
    "label": "boss-b-open"
  }
]
```

Boss 聊天托管模板：

```text
对每个 browserInstance 独立执行:
zhipin_read_messages({ browserInstance, onlyUnread:true, limit:N })
  -> zhipin_generate_reply_preview({ browserInstance, conversationId })
  -> zhipin_send_prepared_reply({ browserInstance, preparedReplyId })
  -> zhipin_read_messages({ browserInstance, onlyUnread:true, limit:N })  # 验证
```

## 通用 Tools

| Tool | 用途 |
| --- | --- |
| `browser_status()` | 查询浏览器 runtime、session、Reply Authority 公钥预加载状态、视觉反馈开关、安全策略和 env 指纹。 |
| `browser_stop(browserInstance? / browserInstances? / all?)` | 关闭一个、多个或全部已启动 browser runtime；不停止 `browser-use-agent` 服务进程，未启动实例返回 `not_running`。 |
| `open_platform(platform)` | 通过 native CDP 打开并聚焦招聘平台主页；登录前不触发 Playwright attach。 |
| `list_pages(platform?)` | 通过 native CDP 列出浏览器页面和 `pageId`。 |
| `select_page(platform, pageId)` | 将指定页面绑定为平台活跃页；登录前优先走 native target 激活。 |
| `navigate_active_tab(url)` | 通过 native CDP 打开/导航页面；不触发 Playwright attach，不支持直接跳转 BOSS `/web/chat/*` 后台路径。 |
| `browser_reload_active_tab(ignoreCache?, browserActionApproval?)` | 对当前 tracked native page 执行 CDP `Page.reload`，清空页面内 DOM 与 SPA 状态后等待文档换页；不触发 Playwright attach，走现有 actionPolicy / domainAllowlist 边界。reload 后所有 `@eN` / `candidateRef` 失效，必须重新 snapshot / 读列表。 |
| `browser_snapshot(pageId?, maxDepth?, maxNodes?, interactiveOnly?)` | 读取当前或指定页面的 Accessibility Tree；默认只返回可交互节点，并为可交互节点生成 `@eN`；也会补充有限的非语义 DOM 可操作短文本，例如 `span` 渲染的 tab/filter 标签，并递归内联同 target iframe 中的可操作 AX 节点。 |
| `click_ref(ref, pageId?, browserActionApproval?)` | 点击 `browser_snapshot` 返回的 `@eN`；优先用 `backendNodeId`，失效时用 `role/name/nth` fallback；iframe 子节点会携带并复用 `frameId`。 |
| `type_ref(ref, text, clear?, pageId?, browserActionApproval?)` | 向 `browser_snapshot` 返回的 `@eN` 输入文本；`clear:true` 会先清空当前控件；iframe 子节点会携带并复用 `frameId`。 |

## 通用页面操作编排

这组三个通用工具用于“没有专用业务 tool 的可访问控件操作”，不是 BOSS 专用工具的替代品。

工具选择优先级：

| 场景 | 首选 | 兜底 |
| --- | --- | --- |
| BOSS 已建模业务链路，例如读消息、打开聊天、换微信、打招呼、筛选候选人 | `zhipin_*` 专用 tool | 只有专用 tool 缺失或无法覆盖新按钮时，才使用 `browser_snapshot` + `click_ref` / `type_ref` |
| 通用网页上点击语义明确的按钮、链接、输入框 | `browser_snapshot` 找 `role/name`，再用 `click_ref` / `type_ref` | 操作后重新 `browser_snapshot` 或用业务 read tool 验证 |
| 页面、tab、平台选择 | `list_pages` + `select_page` 或平台专用 opener | 不要直接猜内部 URL |
| 风控或底层行为诊断 | `zhipin_diagnose_browser_state` | 正常业务路径不要默认诊断 |

两阶段流程：

```text
观察阶段:
list_pages/select_page  # 仅多页面或目标页不明确时
  -> browser_snapshot(interactiveOnly=true)
  -> orchestrator 按 role/name/disabled 选择 @eN

动作阶段:
click_ref(@eN) 或 type_ref(@eN, text, clear?)
  -> 若 actionPolicy=confirm，原样带回 browserActionApproval 重试
  -> 重新 browser_snapshot 或调用业务 read tool 验证页面状态
```

关键规则：

1. `@eN` 只来自最近一次 `browser_snapshot`，只能用于同一 `pageId` 的后续 `click_ref` / `type_ref`。
2. `@eN` 不等同于 BOSS 推荐页的 `@cN` / `@jN`；`@cN`、`@jN` 只服务对应 `zhipin_*` 工具。
3. 不要自行构造 `@eN`；只能传 `browser_snapshot.snapshot.refs[].ref`。
4. 选择目标时优先匹配 `role + name`，并排除 `disabled:true` 的节点；若目标是非语义短文本控件，使用 `role:"clickable"` / `role:"focusable"` / `role:"editable"`、可见文案和 `properties.domActionable:true` 判断。
5. 如果 `refs[]` 或 `nodes[]` 中出现 `frameId`，说明该 ref 来自 iframe 子 frame；orchestrator 只需要继续传 `ref` 和必要的 `pageId`，不要手工传或改写 `frameId`。
6. `snapshot.truncated:true` 表示节点达到 `maxNodes` 上限；先缩小 `maxDepth`、指定 `pageId` 或切到更明确页面后再决策。
7. 页面导航、刷新、弹窗出现、列表重排、筛选变化后，先重新 `browser_snapshot`，不要复用旧 `@eN`。
8. `browser_snapshot` 是 AX 语义快照，不是完整 HTML、截图或网络状态；需要业务数据时仍应使用对应 read tool。
9. 当前 iframe 支持是同 target / 同 CDP session 内递归内联；递归受 `maxNodes`、frame 去重和 CDP frame 可解析性限制。跨 target / OOPIF iframe 需要 Native CDP session multiplexing，当前不承诺覆盖。

通用页面操作细节见 `references/generic-browser-refs.md`。

## 调试 Tools

| Tool | 触发点 |
| --- | --- |
| `attach_browser_session()` | 只在调试时显式执行一次 `connectOverCDP()`，用于验证“仅 attach”是否触发风控。 |
| `zhipin_diagnose_browser_state(phase?, targetPageId?, watchMs?, networkEventLimit?)` | 分阶段定位 BOSS 页面在 native CDP、Playwright attach、evaluate、storage/cookie 读取时的回退/风控触发点。 |
| `zhipin_scroll_view(surface, direction?, steps?, distance?, settleMs?)` | native CDP 滚动或检查 `chat-list`、`chat-history`、`recommend-list` 内部动态列表；`steps=0` 只返回 `atTop` / `atBottom` / `canScrollUp` / `canScrollDown` / `position`。 |

诊断细节见 `references/zhipin-diagnostics.md`。正常业务路径不要默认调用 `zhipin_diagnose_browser_state()`。

常见诊断 phase 关键词：`native`、`native-watch`、`native-ws-connect`、`native-page-bring-front`、`native-evaluate-url-no-runtime-enable`、`native-dom-read-no-runtime-enable`、`native-input-move-no-runtime-enable`、`native-runtime-enable`、`browser-attach`、`page-attach`、`network-watch`、`page-evaluate`、`detector-fingerprint`、`storage-summary`。

## BOSS直聘聊天 Tools

| Tool | Backend | 说明 |
| --- | --- | --- |
| `zhipin_read_messages(limit?, onlyUnread?, sortBy?, autoScroll?, maxScrolls?)` | native CDP | 读取消息列表；默认 `autoScroll=true`，按 `conversationId` 去重。 |
| `zhipin_open_chat_page(forceReload?, browserActionApproval?)` | native CDP | 点击左侧导航切回「沟通」；`forceReload:true` 时只对当前沟通页执行 `Page.reload` 做长跑恢复，返回 `usedReload`；若实时页面已不是沟通页，会跳过 reload 并返回 `reloadSkippedReason`。 |
| `zhipin_open_chat(conversationId?, candidateName?, index?, preferUnread?)` | native CDP | 打开目标聊天；匹配优先级为 `conversationId` > `candidateName` > `index`。 |
| `zhipin_get_candidate_info(conversationId?, candidateName?, index?, maxMessages?)` | native CDP | 提取候选人资料、聊天记录、`conversationId`、`candidateId` 和页面职位信号。 |
| `zhipin_generate_reply_preview(conversationId?, candidateName?, index?, maxMessages?, reasoning?)` | native CDP | 读取聊天上下文，调用 Reply Authority SSE 流式生成回复，并在浏览器内展示阶段与临时草稿；可用 `reasoning` 控制是否请求 thinking/reasoning；返回 `preparedReplyId`，不返回 `signedEnvelope`。 |
| `zhipin_send_prepared_reply(preparedReplyId, toolActionApproval?, browserActionApproval?)` | native CDP | 发送 `zhipin_generate_reply_preview` 生成的预备回复；内部取回并验签 envelope；若 `BROWSER_USE_POLICY_JSON.tools.zhipin_send_prepared_reply.policy="confirm"`，首次调用返回 `needs_confirmation`，确认后带 `toolActionApproval` 重试；若同时启用 `BROWSER_SECURITY_JSON.actionPolicy="confirm"`，还需按返回的 `browserActionApproval` 再次重试。 |
| `zhipin_exchange_wechat(conversationId?, candidateName?, index?)` | native CDP | 点击「换微信」和确认弹窗，优先按 `conversationId` 定位聊天。 |
| `zhipin_get_username()` | native CDP | 读取当前登录招聘者用户名；用于 `recruiterUsername` / `recruiterBinding` 链路。 |

失败策略：native backend 不可用时返回 `success:false`，不自动 fallback 到 Playwright。

## BOSS直聘推荐 Tools

| Tool | Backend | 说明 |
| --- | --- | --- |
| `zhipin_open_recommend_page()` | native CDP | 点击左侧导航切到「推荐牛人」。 |
| `zhipin_list_recommend_jobs()` | native CDP | 只读推荐页顶部招聘岗位下拉；返回 `jobs[].jobRef` / `jobs[].value` / `current` / `canSwitch`，不切换岗位。 |
| `zhipin_select_recommend_job(jobRef?, jobValue?, jobName?, index?, searchKeyword?, useSearch?, forceClick?)` | native CDP | 切换推荐页顶部招聘岗位筛选；优先传 `jobRef`，其次 `jobValue`，再次 `jobName`，`index` 只作当前下拉快照兜底；`forceClick:true` 时目标已选中也会点击一次岗位项。 |
| `zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)` | native CDP | 只设置年龄、性别、活跃度；未传维度重置为 `不限`，年龄默认 `16-不限`；若返回 `status:"requires_vip"`，表示当前账号无法使用该筛选。 |
| `zhipin_get_candidate_list(maxResults?, autoScroll?, maxScrolls?)` | native CDP | 读取推荐候选人卡片；默认滚动并按 `candidateId` / `data-geek` 去重，返回 `candidateRef`。 |
| `zhipin_say_hello(indices?, candidateRefs?)` | native CDP | 批量点击「打招呼」；优先传 `candidateRefs`，`indices` 只作当前 DOM 快照兜底。 |
| `zhipin_open_resume(index?, candidateRef?)` | Playwright-backed | 打开简历弹窗；优先传 `candidateRef`，低优先级未迁移项。 |
| `zhipin_locate_resume_canvas()` | Playwright-backed | 定位 `#recommendFrame -> iframe[src*="c-resume"] -> canvas#resume, div#resume canvas`。 |
| `zhipin_close_resume()` | Playwright-backed | 关闭简历弹窗；selector 契约见 `src/pages/zhipin/resume-dom-contract.ts`。 |

推荐链路和动态列表细节见 `references/zhipin-workflows.md`。

## 鱼泡 Tools

| Tool | 说明 |
| --- | --- |
| `yupao_read_messages(limit?)` | 读取鱼泡未读消息列表。 |
| `yupao_send_reply(conversationId, message)` | 向鱼泡指定对话发送回复。 |

## 编排硬规则

1. `conversationId` / `candidateId` 是聊天稳定主键；`index` 只表示当前 DOM 快照。
2. `zhipin_read_messages` 返回了 `conversationId` / `candidateId` 后，后续 related tool 必须复用这些真实输出。
3. 调 `zhipin_open_chat`、`zhipin_get_candidate_info`、`zhipin_exchange_wechat` 时优先传 `conversationId`。
4. 生成聊天回复优先调用 `zhipin_generate_reply_preview(conversationId)`；它会打开目标聊天、在浏览器内展示 Reply Authority SSE 的阶段、工具执行状态和临时草稿，不需要先额外调用 `zhipin_open_chat`。
5. `draft.delta` 只能展示，不能发送；真正可发送内容只来自 Reply Authority `final` 事件生成的内部签名结果。
6. 发送回复只能调用 `zhipin_send_prepared_reply(preparedReplyId, toolActionApproval?, browserActionApproval?)`；主输入只能使用 `preparedReplyId`，确认重试时可原样带回 `needs_confirmation` 返回的 approval；不要构造裸文本发送路径，也不要保存或传递 `signedEnvelope`。
7. `zhipin_send_prepared_reply` 会校验 envelope 的 `conversationId + candidateId + recruiterBinding`，当前页面目标或招聘者不一致时拒绝。
8. 需要更强推理时，可给 `zhipin_generate_reply_preview` 传 `reasoning:{enabled:true, effort:"low"|"medium"|"high", scope:"reply"|"all"}`；不传则沿用 Reply Authority Service 默认策略。
9. `preferredBrand` 只来自 `zhipin_get_candidate_info` 对 `communicationPosition` 的连字符格式解析；不要用通用岗位名或候选人公司名伪造。
10. 推荐页岗位筛选优先调用 `zhipin_list_recommend_jobs()`；若返回 `canSwitch:false`，说明当前账号/页面没有可切换目标，不要继续盲试岗位名。
11. `jobRef` 来自 `zhipin_list_recommend_jobs` 输出，格式如 `@j1`；选择岗位时优先传 `zhipin_select_recommend_job({ jobRef })`。
12. `jobRef` 只对最近一次岗位下拉快照有意义；筛选、搜索、刷新或页面重开后先重新调用 `zhipin_list_recommend_jobs`。
13. 推荐页岗位筛选的稳定主键是 `zhipin_list_recommend_jobs` / `zhipin_select_recommend_job` 返回的 `value`；已知 `value` 时传 `jobValue`。
14. 推荐岗位只知道标题时传 `jobName`；`index` 只表示当前岗位下拉快照，不要在搜索、筛选、刷新或跨步骤后复用。
15. `zhipin_select_recommend_job` 返回 `status:"selected"` 或 `status:"already_selected"` 都表示目标岗位已生效。
16. `zhipin_select_recommend_job` 返回 `status:"not_found"` 时不要盲目重试；先调用 `zhipin_list_recommend_jobs`，再选择最接近岗位的 `jobRef` 或 `value`。
17. 只有明确需要重新点击已选中岗位项时才传 `forceClick:true`；默认不要传，避免无意义重复点击。
18. `zhipin_filter_recommend_candidates` 返回 `status:"requires_vip"` 时不要反复尝试绕过筛选 UI；当前账号没有权限使用该筛选，改为直接读取当前推荐列表或调整业务策略。
19. 聊天消息列表不产生 `candidateRef`；聊天回复链路使用 `conversationId` / `candidateId`，推荐候选人链路才使用 `candidateRef`。
20. 推荐候选人列表的 `candidateRef` 来自 `zhipin_get_candidate_list` 输出，格式如 `@c1`；后续 `zhipin_say_hello` / `zhipin_open_resume` 优先传它。
21. `candidateRef` 只对最近一次推荐列表快照有意义；筛选、搜索、滚动加载、刷新或页面重开后先重新调用 `zhipin_get_candidate_list`。
22. 不要自行构造 `jobRef` / `candidateRef`；只能传本 Agent 刚返回的 ref。
23. 调 `zhipin_say_hello` 前，先从 `zhipin_get_candidate_list` 结果中过滤 `buttonText:"打招呼"` 的候选人；`buttonText` 为空通常表示已经打过招呼。
24. 如果业务有年龄、资格或岗位匹配约束，必须先按 `age` / `expectedPosition` / `tags` 等列表字段过滤；不要把刚读到的全部 `candidateRefs` 盲目提交。
25. `zhipin_say_hello({ candidateRefs })` 支持同一快照内连续提交多个 ref；若返回“候选人引用已过期”，说明 BOSS 列表已重排，重新执行 `zhipin_get_candidate_list` 后只重试剩余目标。
26. 高频连续 tool call 可用 `roll run --batch-stdin --json` 批量提交，但每项仍要显式声明 `agent` / `tool` / `input`，不要假设 batch 自动传递上一步输出。
27. 不要用 `navigate_active_tab` 直接跳转 `https://www.zhipin.com/web/chat/*`；聊天页用 `zhipin_open_chat_page()`，推荐页用 `zhipin_open_recommend_page()`。
28. BOSS 已有专用工具能表达业务意图时，不要为了“看见按钮”而绕开专用工具改用 `click_ref` / `type_ref`。
29. 对 BOSS 未建模按钮，例如新出现的“交换电话”，可以先用 `browser_snapshot` 找到对应 `@eN`，再 `click_ref`；弹窗确认类二次动作必须重新 snapshot 后再点击。
30. 长跑同一 BOSS tab 出现「选中态丢失 / 列表错乱 / 依赖当前选中聊天的工具失败」时，做 periodic recovery 的边界：
    - 优先 `zhipin_open_chat_page({ forceReload: true })`（或通用 `browser_reload_active_tab`）：等价手动 F5，清空当前 document 的 DOM 与页面内 SPA 状态，保留 Chrome 窗口与 profile 登录态；reload 后所有 `@eN` / `candidateRef` 失效，必须重新 snapshot / 读列表。
    - 普通 `zhipin_open_chat_page()`（不带 forceReload）在已处于沟通页时只返回 `alreadyOnChat`，**不会**卸载 document，无法清状态。
    - `roll browser stop` 才能回收 renderer 进程内存，但会关闭浏览器窗口；reload 只清 document 级状态，**不保证** renderer 100% 把内存归还 OS，杀进程仍由 `roll browser stop` 负责。

## 典型链路

```text
聊天回复:
zhipin_read_messages
  -> zhipin_generate_reply_preview(conversationId)
  -> zhipin_send_prepared_reply(preparedReplyId)

推荐候选人:
zhipin_open_recommend_page
  -> zhipin_list_recommend_jobs()
  -> zhipin_select_recommend_job(jobRef | jobValue | jobName)  # 可选；canSwitch=false 时跳过
  -> zhipin_filter_recommend_candidates(...)  # 可选；requires_vip 时跳过筛选
  -> zhipin_get_candidate_list(maxResults?, autoScroll=true)
  -> 按 buttonText/年龄/业务资格过滤
  -> zhipin_say_hello(candidateRefs)
```

## 参考资料

- `references/zhipin-diagnostics.md`：BOSS native CDP / attach 诊断阶段、推进顺序和返回字段。
- `references/zhipin-workflows.md`：聊天主键、动态列表、`preferredBrand`、Reply Authority 编排细节。
- `references/generic-browser-refs.md`：通用 AX snapshot、`@eN` ref、点击/输入闭环和边界条件。
- `references/env.yaml`：运行所需环境变量声明。
