# Safety and rate limits

Team business rules (skip logic, single-item reads, tool sequence) live in
[business-rules.md](business-rules.md). This file covers rate limits only.

## Why this script exists

Ad-hoc shell loops that call `roll run` back-to-back for `zhipin_generate_reply_preview` +
`zhipin_send_prepared_reply` can send **6–10 messages in under 3 minutes** and trigger BOSS
人机验证.

## Defaults (tunable via flags)

- **0s** between successful sends (process next candidate immediately)
- **4** sends per batch, **0s** batch pause (disabled by default)

To reduce BOSS 人机验证 risk when sending many messages, use e.g.
`--min-gap 60 --max-gap 120 --batch-pause 480`.
- Stop entire run if snapshot text matches captcha keywords
- Skip (do not send) when 「沟通职位已到期」 appears in snapshot
- Stop after **2** consecutive preview/send failures

## Browser window looks smaller during automation

This is usually **not** Chrome resizing the OS window. `browser-use-agent` injects a page overlay
(`BROWSER_VISUAL_ACTIVITY`) that used to draw a full-page inset frame (`inset: 10px`), which made BOSS
look shrunk inside the window.

- Fixed in-repo: the inset page frame is disabled; only the status capsule + target highlight remain.
- Workaround on older installs: `BROWSER_VISUAL_ACTIVITY=false` in browser-use env.
- `bringToFront` per tool only focuses the tab; it does not change window size via CDP.

## Operator checklist

1. Confirm `roll agent health --json` reports `browser-use-agent` as healthy.
2. Run `--dry-run` and confirm the candidate list.
3. Start with `--limit 3` on a risky account if unsure.
4. If exit code 2: complete verification in the browser; wait before re-running.
5. Review JSONL results; do not assume exit 0 means every row was sent (skipped rows have `ok:false`).
6. If a single profile/page is stale, use `roll browser stop <browserInstance>` instead of restarting
   `browser-use-agent`.

## Multi-profile pre-flight

Complete per target `browserInstance` before `--dry-run` or a live script run. A passing MCP
health check alone is not enough.

1. `browser_status`: target instance has `cdp.versionReachable: true` and expected profile.
2. `zhipin_get_username`: returns the expected recruiter name, not generic placeholders like `我要招聘`.
3. `zhipin_open_chat_page`: returns `chatReady: true` and URL contains `/web/chat/`.
4. `zhipin_read_messages` with `onlyUnread: true`, `limit: 1`: returns a row when the user expects unread mail.
5. Keep `browser-use-agent` running across a batch; avoid `roll agent stop` / restart mid-test. To
   close a stale instance only, use `roll browser stop <browserInstance>`.

Safe smoke for two accounts:

```bash
for id in boss-b boss-c; do
  roll run browser-use-agent zhipin_get_username --input-json "{\"browserInstance\":\"$id\"}" --json
  roll run browser-use-agent zhipin_read_messages --input-json "{\"browserInstance\":\"$id\",\"onlyUnread\":true,\"limit\":1}" --json
done
```

## Session recovery

Use when pre-flight fails after an agent restart, Chrome relaunch, or `open_platform` landed on the
marketing home.

Symptoms: `zhipin_open_chat_page` -> `未找到沟通导航`; `zhipin_read_messages` -> 0 unread;
script -> `no unread (empty reads: 2)` / `handled=0`; username -> `我要招聘`.

Recovery per instance:

1. If the target runtime/page is stale but `browser-use-agent` is healthy, run
   `roll browser stop <id>`; do not stop other active profiles with `roll browser stop --all`.
2. `open_platform` with `{ "browserInstance": "<id>", "platform": "zhipin" }` if the tab is missing or on `about:blank`.
3. `browser_snapshot` (`interactiveOnly: true`) -> `click_ref` on 登录/注册; do not hard-code refs across runs.
4. `zhipin_get_username` again; expect the real recruiter name from the saved profile.
5. `zhipin_open_chat_page`; expect `chatReady: true` and `/web/chat/index`.
6. Re-run the `read_messages` smoke before starting `reply-unread-safely`.

Do not use `navigate_active_tab` to guess recruiter URLs; wrong paths can land on 404 and waste the tab.
Use `roll browser clear-data [browserInstance] --yes` only for an intentional profile/session reset,
after inspecting the dry-run plan without `--yes`.

## Send confirmation

If `BROWSER_USE_POLICY_JSON` sets `zhipin_send_prepared_reply` to `confirm`, or browser action policy
requires approval, `zhipin_send_prepared_reply` may return `needs_confirmation`.

- `reply-unread-safely.sh` / `.ps1` do not auto-retry with approval payloads today.
- Orchestrators must confirm with the user, then retry `zhipin_send_prepared_reply` with the same
  `preparedReplyId` plus the returned approval object.

## Dual-draft judge

When `zhipin_generate_reply_preview` returns `replyVariantSelection`, the script:

1. Calls `zhipin_judge_prepared_reply` (no `browserInstance` on this global tool).
2. Passes returned `variantDecision` (includes `reason`) into `zhipin_send_prepared_reply`.
3. Logs `hasDualDraft`, `chosenOption`, `judgeFallback`, and `feedbackStatus` in JSONL.

If judge fails (`fallback: true`), the script sends the recommended option without `variantDecision`
(same as legacy behavior; `feedbackStatus` is `skipped`).

Hard judge failures (`success: false`, e.g. expired/consumed `preparedReplyId`) abort at `send_build`
without calling `zhipin_send_prepared_reply`.

Pass `--no-judge` to skip the judge step and always send the recommended option.

## Not covered yet

- Auto-retry for `needs_confirmation` / `browserActionApproval`
- Structured detection of expired jobs in tool output (still text match on snapshot)
- Resume from partial JSONL checkpoint
