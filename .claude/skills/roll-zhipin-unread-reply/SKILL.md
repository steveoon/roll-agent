---
name: roll-zhipin-unread-reply
description: >-
  Safely batch-replies to unread BOSS Zhipin chats via roll CLI and browser-use-agent using
  reply-unread-safely.sh or reply-unread-safely.ps1 (team skip rules, limit=1 reads, rate limits).
  Use when replying to all unread messages, continuing unread replies, clicking 未读 filter, or
  automating zhipin chat workflow. Never use ad-hoc roll loops or built-in browser_ tools for Zhipin.
---

# Roll Zhipin Unread Reply

## CRITICAL

- **NEVER** use Cursor `browser_` / IDE browser MCP for BOSS. **ALWAYS** `roll run browser-use-agent …`.
- **NEVER** hand-write tight `for` loops over `roll run`. Use the bundled script only:
  - macOS/Linux: `scripts/reply-unread-safely.sh`
  - Windows PowerShell: `scripts/reply-unread-safely.ps1`
- **NEVER** reuse `c.json` / `gp.json` / `sp.json` across candidates (script uses a fresh temp dir per run).

Team business rules: [references/business-rules.md](references/business-rules.md)

## Run the script (default path)

**macOS / Linux / WSL / Git Bash**

```bash
.claude/skills/roll-zhipin-unread-reply/scripts/reply-unread-safely.sh --dry-run
.claude/skills/roll-zhipin-unread-reply/scripts/reply-unread-safely.sh --limit 3
```

**Windows (pure PowerShell — no bash)**

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\.claude\skills\roll-zhipin-unread-reply\scripts\reply-unread-safely.ps1 -DryRun -Limit 3
# bash-style flags also work: --dry-run --limit 3
```

| Bash flag | PowerShell | Purpose |
| --- | --- | --- |
| `--dry-run` | `-DryRun` | Open chat + skip rules only |
| `--limit N` | `-Limit N` | Cap candidates this run |
| `--no-unread-filter` | `-NoUnreadFilter` | Skip clicking 「未读」 |
| `--no-exchange-wechat` | `-NoExchangeWechat` | Skip exchange-wechat |
| `--min-gap` / `--max-gap` | `-MinGap` / `-MaxGap` | Delay between sends (default **0** = immediate next) |
| `--batch-size` / `--batch-pause` | `-BatchSize` / `-BatchPause` | Burst control (default pause **0** = off) |
| `--keep-workdir` | `-KeepWorkDir` | Keep temp JSON files after run |

Requires: `roll` + `node` on PATH; `browser-use-agent` healthy; Reply Authority env (`roll skills get browser-use-agent --include-references`).

### Script layout

| File | Role |
| --- | --- |
| `reply-unread-safely.sh` | macOS / Linux / WSL entry |
| `reply-unread-safely.ps1` | Windows PowerShell entry |
| `evaluate-skip-rules.mjs` | Team skip rules |
| `build-skip-input.mjs` | Build skip payload from files (safe quoting) |
| `extract-roll-json.mjs` | Parse last JSON from `roll` stdout |
| `append-jsonl.mjs` | Append one JSONL result line |
| `roll-json-extract.mjs` | Shared last-JSON extractor |
| `find-unread-ref.mjs` | Locate 未读 tab ref (regex fallback) |
| `parse-read-candidate.mjs` | Parse `zhipin_read_messages` output |
| `validate-*.mjs` / `check-agent-health.mjs` | Roll output validators |
| `detect-expired-banner.mjs` / `parse-page-meta.mjs` | Page guards |

Quick test (no roll):

```bash
node scripts/evaluate-skip-rules.test.mjs
node scripts/roll-helpers.test.mjs
```

### Windows PowerShell pitfalls (addressed in repo)

| Issue | Script fix |
| --- | --- |
| PS 5.1 reads `.ps1` as system ANSI without UTF-8 BOM | **No Chinese literals in `.ps1`** — UTF-8 strings live in `.mjs` helpers |
| `Invoke-NodeStdin` given inline JS instead of file path | All logic in `*.mjs`; first arg is always a path |
| `require()` inside `.mjs` / temp `.js` confusion | Helpers use ESM only (`import` from `roll-json-extract.mjs`) |
| `Out-String` re-encodes roll output as ANSI | `Invoke-RollCapture` joins stream lines; no `Out-String` |
| `ProcessStartInfo` on `roll.ps1` | **Not used** — invoke `roll` via PowerShell `& roll` |
| Huge `browser_snapshot` JSON fails `JSON.parse` | `find-unread-ref.mjs` uses `extract-roll-json` + regex fallback |
| Temp workdir deleted on exit | `-KeepWorkDir` / `--keep-workdir` keeps files for debugging |

## Per-candidate workflow (implemented in script)

```text
read_messages(limit=1, onlyUnread) → one candidate (read-only, no list click)
→ c.json + zhipin_open_chat(conversationId)     ← only list-row click
→ info.json {maxMessages} + get_candidate_info  ← current chat
→ evaluate-skip-rules.mjs → skip? → back to list
→ gp.json {maxMessages} + generate_reply_preview
→ sp.json + send_prepared_reply
→ wx.json {} + exchange_wechat (current chat)
→ back to list → repeat
```

**未读 tab:** clicked **once** at run start (`apply_unread_filter_if_needed`). Loop and `back_to_list` only call `zhipin_open_chat_page` — they do **not** click 未读 again.

**List row (候选人):** clicked **once per candidate** via `zhipin_open_chat` only. `zhipin_get_candidate_info`, `zhipin_generate_reply_preview`, and `zhipin_exchange_wechat` run on the **current chat** (no `conversationId` in input) so they do not call `openChat` again. `zhipin_read_messages` only reads DOM; it does not click rows.

Note: `zhipin_open_chat` may still **retry one list click** internally if the right panel does not sync (browser-use-agent behavior).

All `roll run` inputs use **`--input-file`** (PowerShell-safe; macOS/Linux compatible).

## Skip rules (script-enforced)

Skipped candidates are logged in JSONL with `"stage":"skip"` and `"reason":…`:

| reason | Rule |
| --- | --- |
| `wechat_already_exchanged` | `[微信号:…]`, `请求交换微信已发送`, `wechat-exchange` messages |
| `candidate_wechat_provided` | `微信号：` + id |
| `candidate_wechat_added` | `我加您了`, `已经加了`, … |
| `student` / `student_*` | Age ≤25 + 26–29年 experience; 应届/在校/毕业生 keywords |
| `age_brand_*` | 成都你六姐 18–45; 北京必胜客/Pizza 18–50 |
| `declined` | 不考虑了, 不合适, … |
| `position_expired` | 沟通职位已到期 banner |

Logic: `scripts/evaluate-skip-rules.mjs`

## CAPTCHA — stop immediately

Script exits **2** when:

- URL contains `/web/passport/zp/verify.html`
- Title contains `安全验证`
- Snapshot text matches verification keywords
- **2** consecutive empty unread reads

Tell the user to complete verification manually; do not retry immediately.

## Agent checklist

1. `roll agent health browser-use-agent --json` → `roll agent start browser-use-agent` if needed.
2. `--dry-run` first unless user explicitly ordered send now.
3. Run script; read JSONL path from stderr (`results -> …`).
4. Summarize: sent / skipped (by reason) / failed / captcha stop.
5. For tool schemas and BOSS nuances: `roll skills get browser-use-agent --include-references --json`.
6. For generic roll CLI: `roll-core` skill.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done or no unread |
| 1 | Missing `roll`/`node` or bad args |
| 2 | Captcha — user action required |
| 3 | Consecutive failures |

## References

- [references/business-rules.md](references/business-rules.md) — team workflow source
- [references/safety.md](references/safety.md) — rate limits and incident notes
