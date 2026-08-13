# BOSS 直聘未读回复 — 业务规则（团队标准）

来源：团队 `zhipin-roll-workflow`。编排器与 `reply-unread-safely.sh` **必须**遵守；不得用 ad-hoc 循环绕过本脚本。

## 工具边界

**CRITICAL:** 禁止用内置 `browser_` / Cursor 浏览器 MCP 操作 BOSS。一律 `roll run browser-use-agent …`。

## 单条处理

- 每次只处理 **1** 个候选人：`zhipin_read_messages` 使用 `limit: 1`（且 `onlyUnread: true`），完成整条链路后再读下一条。
- 禁止手写 tight shell 循环；只允许调用本 skill 自带脚本（内含限速与状态恢复）。
- Windows 纯 PowerShell：使用 `scripts/reply-unread-safely.ps1`（不要用 `.sh`）。

## 每人严格顺序

每个候选人按序执行，不可跳步：

1. 写入 `c.json`（`conversationId`）→ `zhipin_open_chat`（**唯一**列表行点击）
2. 写入 `info.json`（仅 `maxMessages`）→ `zhipin_get_candidate_info`（当前会话，**勿**再传 `conversationId`）→ **Skip 检查**
3. 若跳过 → 回列表，不 generate/send
4. 写入 `gp.json`（仅 `maxMessages`）→ `zhipin_generate_reply_preview`（当前会话）
5. 写入 `sp.json` → `zhipin_send_prepared_reply`
6. `zhipin_exchange_wechat` 传 `{}`（当前会话；未触发 skip 时）
7. `zhipin_open_chat_page` → 回到列表（**不再**重复点「未读」；首轮已点一次，后续靠 `onlyUnread` 读列表）

## 输入文件

- 使用 `roll run … --input-file`（避免 PowerShell `--input-json` 引号问题）。
- **每个候选人重新写** `c.json` / `gp.json` / `sp.json`，禁止复用上一人的文件（错误 `conversationId` = 发错人）。

## Skip 检查（满足任一则跳过，不回复）

| 类别 | 条件 |
| --- | --- |
| 已换微信 | 历史含 `[微信号: …]`、`wechat-exchange`、`请求交换微信已发送` |
| 候选人已留微信 | `微信号：` + 字母数字 |
| 候选人已加 | `我加您了`、`我加了`、`加了您`、`已经加了`、`已添加`、`加你微信了` |
| 学生 | `age` ≤ 25 且 `experience` 含 `26年`/`27年`/`28年`/`29年`（届别=毕业年）；或含 `应届`、`在校`、`在读`、`大三`、`大四`、`NN年毕业生` |
| 超龄（品牌） | 成都你六姐：18–45；北京 Pizza / 必胜客：18–50（按 `preferredBrand` / 沟通岗位解析） |
| 明确拒绝 | `不考虑了`、`不合适`、`不感兴趣`、`算了`、`谢谢不用了` |

跳过记录写入 JSONL：`ok:false`, `reason:<skip_reason>`。

## 人机验证 / 风控页 — 立即停止

- URL 含 `/web/passport/zp/verify.html` 或其他验证/安全检查页
- 页面标题含 `安全验证`
- URL 为 BOSS 403 页（如 `/web/passport/zp/403.html?code=31`）或标题含 `访问受限`
- 任一 `zhipin_*` / snapshot 返回 `zhipin_access_restricted`（含列表轮询、`open_chat` 失败恢复；**不要** force reload）
- 连续空读列表（脚本默认 2 次）

停止后通知用户手动验证或等待页面标明的解封时间，**不要**刷新、**不要**换 tool 重试。

## 相关 tools

`zhipin_read_messages`, `zhipin_open_chat`, `zhipin_open_chat_page`, `zhipin_get_candidate_info`, `zhipin_generate_reply_preview`, `zhipin_send_prepared_reply`, `zhipin_exchange_wechat`, `zhipin_get_username`, `zhipin_scroll_view`, `browser_snapshot`, `click_ref`.
