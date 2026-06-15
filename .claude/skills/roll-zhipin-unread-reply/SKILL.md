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
.claude/skills/roll-zhipin-unread-reply/scripts/reply-unread-safely.sh --browser-instance boss-a --limit 3
```

**Windows (pure PowerShell — no bash)**

```powershell
.\.claude\skills\roll-zhipin-unread-reply\scripts\reply-unread-safely.ps1 -DryRun -Limit 3
.\.claude\skills\roll-zhipin-unread-reply\scripts\reply-unread-safely.ps1 -BrowserInstance boss-a -Limit 3
# bash-style flags also work: --dry-run --limit 3
```

If local PowerShell policy blocks `.ps1` execution, use process-scoped bypass for that shell only:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
```

| Bash flag | PowerShell | Purpose |
| --- | --- | --- |
| `--browser-instance ID` | `-BrowserInstance` | Target `browser.instances` id for every browser-use tool call |
| `--dry-run` | `-DryRun` | Open chat + skip rules only |
| `--limit N` | `-Limit N` | Cap candidates this run |
| `--no-unread-filter` | `-NoUnreadFilter` | Skip clicking 「未读」 |
| `--no-exchange-wechat` | `-NoExchangeWechat` | Skip exchange-wechat |
| `--no-judge` | `-NoJudge` | Skip `zhipin_judge_prepared_reply`; dual-draft sends recommended option only |
| `--min-gap` / `--max-gap` | `-MinGap` / `-MaxGap` | Delay between sends (default **0** = immediate next) |
| `--batch-size` / `--batch-pause` | `-BatchSize` / `-BatchPause` | Burst control (default pause **0** = off) |
| `--keep-workdir` | `-KeepWorkDir` | Keep temp JSON files after run |

Requires: `roll` + `node` on PATH; `browser-use-agent` healthy; Reply Authority env (`roll skills get browser-use-agent --include-references`).

### Multi-profile mode

Use `--browser-instance <id>` / `-BrowserInstance <id>` whenever `roll.config.yaml` defines multiple `browser.instances`.

```text
script flag / ROLL_BROWSER_INSTANCE
  -> every browser-use input file gets browserInstance
  -> browser-use selects matching profile/CDP/session
```

- Run one script process per Boss account/profile.
- Do not run two script processes against the same `browserInstance`.
- If no flag is provided, browser-use falls back to `browser.default-instance` or single-instance mode.
- Browser runtimes are lazy-started by the first browser-use tool call. The script does not need to
  pre-open every configured instance.
- To close one profile after a run, use `roll browser stop <browserInstance>`; this keeps
  `browser-use-agent` alive and preserves `userDataDir` / `sessionsDir`.
- Do not use `roll agent stop browser-use-agent` for routine per-profile cleanup, especially while
  another `reply-unread-safely` process is running on a different `browserInstance`.

#### Parallel orchestration (multi-account)

Supported pattern: **one `reply-unread-safely` process per `browserInstance`**, started in parallel (e.g. boss-b + boss-c each with their own `--limit`).

| Operation class | Parallel-safe? | Notes |
| --- | --- | --- |
| Read-only (`zhipin_get_username`, `zhipin_read_messages`, `browser_status`) | Yes | Good smoke test before a batch run |
| Full script (open chat → generate → send) | Yes, **after pre-flight passes on every instance** | Each process must target a **different** `--browser-instance` |
| Two processes on the **same** `browserInstance` | No | Will fight over the same CDP tab/session |

If parallel scripts finish with `handled=0`, `no unread (empty reads: 2)`, or open the wrong candidate, **do not assume instance isolation is broken first** — check [Pre-flight checklist](#pre-flight-checklist) and [Session recovery](#session-recovery) below.

When parallel full-reply runs misbehave but sequential runs on the same instances succeed, stagger script start by a few seconds or finish pre-flight sequentially before launching both send loops.

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
| `parse-generate-preview.mjs` | Parse preview output (`preparedReplyId`, `hasDualDraft`) |
| `build-send-payload.mjs` | Build send bundle with optional `variantDecision` from judge |
| `apply-send-bundle.mjs` | Write validated `sp.json` from send bundle |
| `write-judge-input.mjs` | Safely write `judge.json` with `preparedReplyId` |
| `compose-result-input.mjs` | Merge bundle + send result for JSONL formatting |
| `format-candidate-result.mjs` | Build JSONL result line for sent / send_failed |
| `parse-send-result.mjs` | Parse send output (`ok`, `feedbackStatus`) |
| `validate-*.mjs` / `check-agent-health.mjs` | Roll output validators |
| `validate-browser-selection.mjs` | Fail fast when multi-instance config needs explicit `browserInstance` |
| `detect-expired-banner.mjs` / `parse-page-meta.mjs` | Page guards |

Quick test (no roll):

```bash
node scripts/evaluate-skip-rules.test.mjs
node scripts/roll-helpers.test.mjs
node scripts/pipeline-judge-send.test.mjs
```

### Windows PowerShell pitfalls (addressed in repo)

| Issue | Script fix |
| --- | --- |
| PS 5.1 native-command pipes can garble UTF-8 output | `.ps1` avoids non-ASCII runtime literals and forces console/pipeline UTF-8 where possible |
| `Get-Content` / `Set-Content` can re-encode JSON as ANSI | JSON input/results use `.NET` `ReadAllText` / `WriteAllText` with UTF-8 no BOM |
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
→ gp.json {maxMessages} + generate_reply_preview → preparedReplyId
→ [若 hasDualDraft 且未 --no-judge] judge.json + zhipin_judge_prepared_reply → variantDecision
→ build-send-payload.mjs → apply-send-bundle.mjs → sp.json
→ sp.json + send_prepared_reply
→ wx.json {} + exchange_wechat (current chat)
→ back to list → repeat
```

**未读 tab:** clicked **once** at run start (`apply_unread_filter_if_needed`). Loop and `back_to_list` only call `zhipin_open_chat_page` — they do **not** click 未读 again.

**List row (候选人):** clicked **once per candidate** via `zhipin_open_chat` only. `zhipin_get_candidate_info`, `zhipin_generate_reply_preview`, and `zhipin_exchange_wechat` run on the **current chat** (no `conversationId` in input) so they do not call `openChat` again. `zhipin_read_messages` only reads DOM; it does not click rows.

Note: `zhipin_open_chat` may still **retry one list click** internally if the right panel does not sync (browser-use-agent behavior).

All `roll run` inputs use **`--input-file`** (PowerShell-safe; macOS/Linux compatible).

### Operational guardrails

- `needs_confirmation`: scripts do **not** auto-retry with approval payloads today; see [references/safety.md](references/safety.md).
- Dual-draft previews default to `zhipin_judge_prepared_reply` before send so `variantDecision.reason` flows into `/reply-feedback`. Use `--no-judge` only when you explicitly want the recommended option without judge latency.
- Multi-instance selection is validated at startup through `browser_status`; when multiple instances exist without a configured default, the script exits before touching BOSS unless `--browser-instance` / `-BrowserInstance` is provided.
- Pre-flight is per `browserInstance`: check `browser_status`, `zhipin_get_username`, `zhipin_open_chat_page`, then one `zhipin_read_messages`.
- Recovery is per `browserInstance`: if the tab is logged out, on marketing home, or returns empty reads unexpectedly, recover that profile before running the script. If only one browser runtime is stale, prefer `roll browser stop <browserInstance>` then reopen that same instance; do not restart the whole agent.

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

1. Complete [references/safety.md](references/safety.md) pre-flight for every `--browser-instance` you will use.
2. `roll agent health --json` → `roll agent start browser-use-agent` only when the service is down; use `roll browser stop <browserInstance>` for stale browser runtime/page state.
3. `--dry-run` first unless user explicitly ordered send now.
4. Run script; read JSONL path from stderr (`results -> …`).
5. Summarize: sent / skipped (by reason) / failed / captcha stop.
6. For tool schemas and BOSS nuances: `roll skills get browser-use-agent --include-references --json`.
7. For generic roll CLI: `roll-core` skill.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done or no unread |
| 1 | Missing `roll`/`node` or bad args |
| 2 | Captcha — user action required |
| 3 | Consecutive failures |

## References

- [references/business-rules.md](references/business-rules.md) — team workflow source
- [references/safety.md](references/safety.md) — rate limits, `needs_confirmation` gaps, and incident notes
- `agents/browser-use/SKILL.md` — `open_platform` vs `zhipin_open_chat_page`, send policy, multi-instance tools
