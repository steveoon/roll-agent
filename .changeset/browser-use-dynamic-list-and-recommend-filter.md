---
"@roll-agent/browser-use-agent": patch
---

feat(browser-use): add dynamic list scrolling, recommend filter tool, and harden exchange-wechat

- 新增 `zhipin_scroll_view(surface, direction?, steps?, distance?, settleMs?)`，支持 `chat-list` / `chat-history` / `recommend-list` 三个内部滚动容器；不传 `direction` 时使用该 surface 的默认方向
- `zhipin_read_messages` 新增 `autoScroll` / `maxScrolls` 参数，默认按 `conversationId` 自动向下滚动左侧消息列表并合并去重
- `zhipin_get_candidate_list` 新增 `autoScroll` / `maxScrolls` 参数和 `scrollStats.stopReason` 返回字段（`target-count` / `boundary` / `no-new-items` / `max-steps`），默认按 `candidateId` / `data-geek` 滚动去重
- 抽出通用动态列表滚动器 `pages/shared/dynamic-list-scroller.ts` 和 `pages/zhipin/list-surfaces.ts`，由上述工具复用
- 新增 `zhipin_filter_recommend_candidates(ageMin?, ageMax?, gender?, activity?)`，在「推荐牛人」页打开筛选面板，只设置年龄、性别、活跃度[单选] 三个维度并提交；未传的维度会重置为「不限」（年龄默认 `16-不限`），不会触碰岗位、学历、薪资、求职状态等其他筛选项
- `zhipin_exchange_wechat` 可靠性加固：调用前用 `getSelectedChatTarget` / `getActiveChatPanel` 校验左侧选中会话与右侧聊天面板的候选人一致；「换微信」按钮 selector 限定在右侧 `.conversation-operate` 操作区，文本匹配从 `includes("换微信")` 改为严格等于，避免误匹配顶部筛选栏的「已交换微信」；移除全量 `span` 文本 fallback；marker 属性提取为常量并在 `finally` 中清理，避免跨调用残留
- SKILL.md 更新推荐列表链路为 4 步，并补充动态列表滚动规则与 `index` 不可跨调用稳定的说明
