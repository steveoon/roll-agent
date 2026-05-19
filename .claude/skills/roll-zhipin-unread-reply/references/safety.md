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

1. Confirm `roll agent health browser-use-agent` is healthy.
2. Run `--dry-run` and confirm the candidate list.
3. Start with `--limit 3` on a risky account if unsure.
4. If exit code 2: complete verification in the browser; wait before re-running.
5. Review JSONL results; do not assume exit 0 means every row was sent (skipped rows have `ok:false`).

## Not covered yet

- Auto-retry for `needs_confirmation` / `browserActionApproval`
- Structured detection of expired jobs in tool output (still text match on snapshot)
- Resume from partial JSONL checkpoint
