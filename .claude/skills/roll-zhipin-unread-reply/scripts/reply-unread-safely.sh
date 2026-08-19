#!/usr/bin/env bash
# BOSS Zhipin unread reply — team business rules + safe rate limits.
# See ../SKILL.md and ../references/business-rules.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_RULES_JS="$SCRIPT_DIR/evaluate-skip-rules.mjs"
EXTRACT_ROLL_JSON="$SCRIPT_DIR/extract-roll-json.mjs"
BUILD_SKIP_INPUT="$SCRIPT_DIR/build-skip-input.mjs"
APPEND_JSONL="$SCRIPT_DIR/append-jsonl.mjs"
FIND_UNREAD_REF="$SCRIPT_DIR/find-unread-ref.mjs"
PARSE_READ_CANDIDATE="$SCRIPT_DIR/parse-read-candidate.mjs"
VALIDATE_OPEN_CHAT="$SCRIPT_DIR/validate-open-chat.mjs"
FORMAT_OPEN_CHAT_FAILURE="$SCRIPT_DIR/format-open-chat-failure.mjs"
VALIDATE_GENERATE="$SCRIPT_DIR/validate-generate.mjs"
PARSE_GENERATE_PREVIEW="$SCRIPT_DIR/parse-generate-preview.mjs"
FORMAT_PREVIEW_FAILURE="$SCRIPT_DIR/format-preview-failure.mjs"
BUILD_SEND_PAYLOAD="$SCRIPT_DIR/build-send-payload.mjs"
APPLY_SEND_BUNDLE="$SCRIPT_DIR/apply-send-bundle.mjs"
COMPOSE_RESULT_INPUT="$SCRIPT_DIR/compose-result-input.mjs"
FORMAT_CANDIDATE_RESULT="$SCRIPT_DIR/format-candidate-result.mjs"
PARSE_SEND_RESULT="$SCRIPT_DIR/parse-send-result.mjs"
VALIDATE_SEND="$SCRIPT_DIR/validate-send.mjs"
CHECK_AGENT_HEALTH="$SCRIPT_DIR/check-agent-health.mjs"
VALIDATE_BROWSER_SELECTION="$SCRIPT_DIR/validate-browser-selection.mjs"
DETECT_EXPIRED="$SCRIPT_DIR/detect-expired-banner.mjs"
PARSE_PAGE_META="$SCRIPT_DIR/parse-page-meta.mjs"
DETECT_ACCESS_STOP="$SCRIPT_DIR/detect-access-stop.mjs"
FIND_RESUME_REF="$SCRIPT_DIR/find-resume-ref.mjs"
PARSE_RESUME_CAPTURE="$SCRIPT_DIR/parse-resume-capture.mjs"
APPLY_SCREEN_DECISIONS="$SCRIPT_DIR/apply-screen-decisions.mjs"

AGENT="${ROLL_AGENT:-browser-use-agent}"
BROWSER_INSTANCE="${ROLL_BROWSER_INSTANCE:-}"
LIMIT=""
DRY_RUN=0
CLICK_UNREAD_FILTER=1
EXCHANGE_WECHAT=1
MIN_GAP=0
MAX_GAP=0
BATCH_SIZE=4
BATCH_PAUSE=0
MAX_CONSECUTIVE_FAILURES=2
MAX_EMPTY_READS=2
KEEP_WORKDIR=0
NO_JUDGE=0
SCREEN_ONLY=0
DECISIONS_FILE=""
SCREEN_MANIFEST_FILE=""
RESULTS_FILE="${TMPDIR:-/tmp}/roll-zhipin-unread-reply-$(date +%Y%m%d-%H%M%S).jsonl"
WORK_DIR=""

usage() {
  cat <<'EOF'
Usage: reply-unread-safely.sh [options]

Processes BOSS unread chats one-at-a-time (limit=1 per read) via roll + browser-use-agent.
Implements team skip rules, exchange-wechat, and rate limits.

Options:
  --agent NAME           MCP agent (default: browser-use-agent)
  --browser-instance ID  browser.instances id passed to every browser-use tool
  --limit N              Max candidates to handle this run (default: all unread)
  --dry-run              Evaluate skip rules; do not generate/send/exchange
  --no-unread-filter     Skip clicking the "未读" tab
  --no-exchange-wechat   Do not call zhipin_exchange_wechat after send
  --no-judge             BREAK-GLASS: send recommended dual draft without learning feedback
  --min-gap SEC          Min seconds between successful sends (default: 0, no wait)
  --max-gap SEC          Max seconds between successful sends (default: 0)
  --batch-size N         Sends per batch before long pause (default: 4)
  --batch-pause SEC      Pause after each batch (default: 0, disabled)
  --results-file PATH    JSONL log path
  --screen-only          Resume-screening phase: open chat + skip rules + capture
                         resume screenshot into a manifest; never generate/send/exchange
  --screen-manifest PATH Manifest output for --screen-only / input for --decisions
  --decisions FILE       Act phase: agent-written JSON/JSONL of
                         {conversationId, fit, reason}; requires --screen-manifest
  --keep-workdir         Do not delete temp workdir (debug)
  -h, --help

Exit codes: 0 ok | 1 usage | 2 captcha/access_restricted | 3 consecutive failures
EOF
}

need_arg() {
  if [[ $# -lt 2 || -z "${2:-}" || "${2:0:1}" == "-" ]]; then
    echo "error: $1 requires a value" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) need_arg "$1" "${2:-}"; AGENT="$2"; shift 2 ;;
    --browser-instance) need_arg "$1" "${2:-}"; BROWSER_INSTANCE="$2"; shift 2 ;;
    --limit) need_arg "$1" "${2:-}"; LIMIT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-unread-filter) CLICK_UNREAD_FILTER=0; shift ;;
    --no-exchange-wechat) EXCHANGE_WECHAT=0; shift ;;
    --no-judge) NO_JUDGE=1; shift ;;
    --min-gap) need_arg "$1" "${2:-}"; MIN_GAP="$2"; shift 2 ;;
    --max-gap) need_arg "$1" "${2:-}"; MAX_GAP="$2"; shift 2 ;;
    --batch-size) need_arg "$1" "${2:-}"; BATCH_SIZE="$2"; shift 2 ;;
    --batch-pause) need_arg "$1" "${2:-}"; BATCH_PAUSE="$2"; shift 2 ;;
    --results-file) need_arg "$1" "${2:-}"; RESULTS_FILE="$2"; shift 2 ;;
    --keep-workdir) KEEP_WORKDIR=1; shift ;;
    --screen-only) SCREEN_ONLY=1; shift ;;
    --screen-manifest) need_arg "$1" "${2:-}"; SCREEN_MANIFEST_FILE="$2"; shift 2 ;;
    --decisions) need_arg "$1" "${2:-}"; DECISIONS_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

roll_cli() {
  if [[ -n "${ROLL_CURRENT_CLI:-}" && -x "$ROLL_CURRENT_CLI" ]]; then
    "$ROLL_CURRENT_CLI" "$@"
    return
  fi
  roll "$@"
}

if [[ -z "${ROLL_CURRENT_CLI:-}" || ! -x "$ROLL_CURRENT_CLI" ]] && ! command -v roll >/dev/null 2>&1; then
  echo "error: roll CLI not found in PATH" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: node required" >&2
  exit 1
fi

for helper in \
  "$SKIP_RULES_JS" "$EXTRACT_ROLL_JSON" "$BUILD_SKIP_INPUT" "$APPEND_JSONL" \
  "$FIND_UNREAD_REF" "$PARSE_READ_CANDIDATE" "$VALIDATE_OPEN_CHAT" "$FORMAT_OPEN_CHAT_FAILURE" \
  "$PARSE_GENERATE_PREVIEW" "$FORMAT_PREVIEW_FAILURE" "$BUILD_SEND_PAYLOAD" "$APPLY_SEND_BUNDLE" \
  "$COMPOSE_RESULT_INPUT" "$FORMAT_CANDIDATE_RESULT" "$PARSE_SEND_RESULT" "$VALIDATE_SEND" \
  "$CHECK_AGENT_HEALTH" "$VALIDATE_BROWSER_SELECTION" "$DETECT_EXPIRED" "$PARSE_PAGE_META" \
  "$DETECT_ACCESS_STOP" "$FIND_RESUME_REF" "$PARSE_RESUME_CAPTURE" "$APPLY_SCREEN_DECISIONS"; do
  if [[ ! -f "$helper" ]]; then
    echo "error: missing helper script: $helper" >&2
    exit 1
  fi
done

export REPLY_AGENT="$AGENT"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/roll-zhipin-reply.XXXXXX")"
UNREAD_FILTER_APPLIED=0
cleanup() {
  if [[ "$KEEP_WORKDIR" -eq 1 ]]; then
    log "kept workdir for debugging: $WORK_DIR"
    return 0
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

capture_roll_stdout() {
  local stderr_file
  stderr_file="$(mktemp "$WORK_DIR/roll-stderr.XXXXXX")"
  local stdout=""
  local exit_code=0

  if stdout=$(roll_cli "$@" 2>"$stderr_file"); then
    exit_code=0
  else
    exit_code=$?
  fi

  if [[ "$exit_code" -ne 0 && -s "$stderr_file" ]]; then
    cat "$stderr_file" >&2
  fi
  rm -f -- "$stderr_file"

  printf '%s' "$stdout"
  return "$exit_code"
}

roll_json_file() {
  local tool="$1"
  local file="$2"
  local inject_browser="${3:-1}"
  if [[ -n "$BROWSER_INSTANCE" && "$inject_browser" == "1" ]]; then
    node -e '
      const fs = require("node:fs");
      const filePath = process.argv[1];
      const browserInstance = process.argv[2];
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      payload.browserInstance = browserInstance;
      fs.writeFileSync(filePath, JSON.stringify(payload));
    ' "$file" "$BROWSER_INSTANCE"
  fi
  capture_roll_stdout run "$AGENT" "$tool" --input-file "$file" --json || true
}

roll_no_input() {
  local file="$WORK_DIR/input-$1.json"
  write_json "$file" '{}'
  roll_json_file "$1" "$file"
}

extract_json_object() {
  node "$EXTRACT_ROLL_JSON" 2>/dev/null
}

append_result_json() {
  printf '%s' "$1" | node "$APPEND_JSONL" "$RESULTS_FILE"
}

write_json() {
  local path="$1"
  local content="$2"
  printf '%s' "$content" >"$path"
}

write_text() {
  local path="$1"
  local content="$2"
  printf '%s' "$content" >"$path"
}

random_gap() {
  if [[ "$MAX_GAP" -le "$MIN_GAP" ]]; then
    echo "$MIN_GAP"
  else
    echo $((MIN_GAP + RANDOM % (MAX_GAP - MIN_GAP + 1)))
  fi
}

append_result() {
  append_result_json "$1"
}

stop_if_risk_page() {
  local out="$1"
  local stage="${2:-tool}"
  local name="${3:-}"
  local cid="${4:-}"
  local detected stop_flag reason ts
  detected=$(printf '%s' "$out" | node "$DETECT_ACCESS_STOP" 2>/dev/null) || detected='{"stop":false}'
  stop_flag=$(printf '%s' "$detected" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).stop?'1':'0');" 2>/dev/null) || stop_flag="0"
  if [[ "$stop_flag" != "1" ]]; then
    return 0
  fi
  reason=$(printf '%s' "$detected" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).reason||'access_restricted');" 2>/dev/null) || reason="access_restricted"
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"$stage\",\"reason\":\"$reason\"}"
  log "STOP: $reason ($stage) — do not reload or retry"
  exit 2
}

format_send_result_line() {
  local mode="$1"
  local line_ts="$2"
  local line_name="$3"
  local line_cid="$4"
  local line_prepared_id="$5"
  local line_send_result="$6"
  local exchanged_flag="${7:-0}"
  write_json "$WORK_DIR/send-result.json" "$line_send_result"
  node "$COMPOSE_RESULT_INPUT" "$WORK_DIR/send-bundle.json" "$WORK_DIR/send-result.json" \
    | node "$FORMAT_CANDIDATE_RESULT" "$mode" "$line_ts" "$line_name" "$line_cid" "$line_prepared_id" "$exchanged_flag"
}

feedback_notice_from_result() {
  node -e '
    let row = {};
    try { row = JSON.parse(require("node:fs").readFileSync(0, "utf8")); } catch { process.exit(0); }
    if (row.feedbackQueued === true) {
      console.log(`feedback queued for retry: ${row.name} (${row.feedbackStatus})`);
    } else if (row.feedbackGap === true) {
      const source = row.decisionSource || "unknown";
      const status = row.feedbackStatus || "missing";
      const reason = row.fallbackReason || row.feedbackError || "feedback_not_closed";
      console.log(`WARN: feedback gap: ${row.name}; source=${source}; status=${status}; reason=${reason}`);
    } else if (row.learningSkipped === true) {
      const source = row.decisionSource || "unknown";
      const reason = row.fallbackReason || row.decisionReason || "learning_not_expected";
      console.log(`learning feedback skipped: ${row.name}; source=${source}; reason=${reason}`);
    }
  '
}

log() { echo "[reply-unread] $*" >&2; }

ensure_agent_healthy() {
  local health
  health=$(capture_roll_stdout agent health --json) || health=""
  if printf '%s' "$health" | node "$CHECK_AGENT_HEALTH" 2>/dev/null; then
    return 0
  fi
  log "starting agent $AGENT..."
  roll_cli agent start "$AGENT" >&2 || true
  sleep 2
}

ensure_browser_instance_selection() {
  local status
  status=$(roll_no_input browser_status)
  if ! printf '%s' "$status" | ROLL_BROWSER_INSTANCE="$BROWSER_INSTANCE" node "$VALIDATE_BROWSER_SELECTION" >&2; then
    exit 1
  fi
  if [[ -n "$BROWSER_INSTANCE" ]]; then
    log "browserInstance -> $BROWSER_INSTANCE"
  fi
}

# Return to chat list only (no 未读 click).
ensure_chat_list() {
  local out
  out=$(roll_no_input zhipin_open_chat_page)
  stop_if_risk_page "$out" "open_chat_page"
}

# Apply 「未读」 once per current SPA document; force reload invalidates this state.
apply_unread_filter_if_needed() {
  if [[ "$CLICK_UNREAD_FILTER" -ne 1 ]]; then
    return 0
  fi
  if [[ "$UNREAD_FILTER_APPLIED" -eq 1 ]]; then
    log "未读 filter already active, skip click"
    return 0
  fi
  ensure_chat_list
  write_json "$WORK_DIR/snapshot.json" '{"interactiveOnly":true,"maxNodes":500}'
  local snap ref
  snap=$(roll_json_file browser_snapshot "$WORK_DIR/snapshot.json")
  stop_if_risk_page "$snap" "unread_filter"
  ref=$(printf '%s' "$snap" | node "$FIND_UNREAD_REF" 2>/dev/null) || ref=""
  if [[ -n "$ref" ]]; then
    log "click 未读 filter $ref (current SPA document)"
    write_json "$WORK_DIR/click-unread.json" "{\"ref\":\"$ref\"}"
    roll_json_file click_ref "$WORK_DIR/click-unread.json" | extract_json_object >/dev/null || true
    UNREAD_FILTER_APPLIED=1
    sleep 1
  else
    log "warn: 未读 ref not found; relying on onlyUnread read_messages"
  fi
}

invalidate_unread_filter_after_reload() {
  if [[ "$CLICK_UNREAD_FILTER" -eq 1 ]]; then
    UNREAD_FILTER_APPLIED=0
    log "unread filter state invalidated after force reload"
  fi
}

ensure_unread_list_ready() {
  # Preserve the steady-state page-drift guard even when the unread filter is already active.
  ensure_chat_list
  if [[ "$CLICK_UNREAD_FILTER" -eq 1 ]]; then
    apply_unread_filter_if_needed
  fi
}

fetch_next_unread() {
  write_json "$WORK_DIR/read.json" '{"onlyUnread":true,"limit":1,"autoScroll":false}'
  local out
  out=$(roll_json_file zhipin_read_messages "$WORK_DIR/read.json")
  stop_if_risk_page "$out" "read_messages"
  printf '%s' "$out" | node "$PARSE_READ_CANDIDATE" 2>/dev/null || true
}

evaluate_skip() {
  local payload_file="$1"
  node "$SKIP_RULES_JS" <"$payload_file"
}

check_page_blockers() {
  local snap="$1"
  printf '%s' "$snap" | node "$DETECT_EXPIRED" 2>/dev/null || echo "ok"
}

append_manifest() {
  local manifest="$1"
  local line="$2"
  printf '%s' "$line" | node "$APPEND_JSONL" "$manifest"
}

# Screening phase: click right-panel 「在线简历」, capture the canvas resume image,
# close the dialog, and append a manifest row for the agent to review.
capture_resume_screening() {
  local cid="$1"
  local name="$2"
  local ts="$3"
  local manifest="$SCREEN_MANIFEST_FILE"

  write_json "$WORK_DIR/snap-resume.json" '{"interactiveOnly":true,"maxNodes":300}'
  local snap ref
  snap=$(roll_json_file browser_snapshot "$WORK_DIR/snap-resume.json")
  stop_if_risk_page "$snap" "resume_snapshot" "$name" "$cid"
  ref=$(printf '%s' "$snap" | node "$FIND_RESUME_REF" 2>/dev/null) || ref=""
  if [[ -z "$ref" ]]; then
    log "screen $name: 在线简历 entry not found"
    append_manifest "$manifest" "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"screen\",\"status\":\"resume_entry_missing\"}"
    return 0
  fi

  log "screen $name: click 在线简历 $ref"
  write_json "$WORK_DIR/click-resume.json" "{\"ref\":\"$ref\"}"
  roll_json_file click_ref "$WORK_DIR/click-resume.json" | extract_json_object >/dev/null || true
  sleep 1

  local diag diag_json ready
  write_json "$WORK_DIR/diag.json" '{"phase":"resume-canvas","watchMs":3000}'
  diag=$(roll_json_file zhipin_diagnose_browser_state "$WORK_DIR/diag.json")
  stop_if_risk_page "$diag" "resume_canvas" "$name" "$cid"
  diag_json=$(printf '%s' "$diag" | extract_json_object 2>/dev/null) || diag_json='{}'
  ready=$(printf '%s' "$diag_json" | node -e 'let j={};try{j=JSON.parse(require("fs").readFileSync(0,"utf8"));}catch{};process.stdout.write(j.resumeCanvas?.canvasReady===true?"1":"0");' 2>/dev/null) || ready="0"
  if [[ "$ready" != "1" ]]; then
    log "screen $name: resume canvas not ready"
    append_manifest "$manifest" "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"screen\",\"status\":\"resume_canvas_not_ready\"}"
    roll_no_input zhipin_close_resume >/dev/null || true
    return 0
  fi

  local cap_out cap_meta image_path
  write_json "$WORK_DIR/cap.json" '{}'
  cap_out=$(roll_json_file zhipin_capture_resume "$WORK_DIR/cap.json")
  stop_if_risk_page "$cap_out" "resume_capture" "$name" "$cid"
  cap_meta=$(printf '%s' "$cap_out" | node "$PARSE_RESUME_CAPTURE" 2>/dev/null) || cap_meta=""
  image_path=$(printf '%s' "$cap_meta" | node -e 'let j={};try{j=JSON.parse(require("fs").readFileSync(0,"utf8"));}catch{};process.stdout.write(j.imagePath||"");' 2>/dev/null) || image_path=""
  roll_no_input zhipin_close_resume >/dev/null || true

  if [[ -z "$image_path" || ! -f "$image_path" ]]; then
    log "screen $name: resume capture produced no image"
    append_manifest "$manifest" "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"screen\",\"status\":\"resume_capture_failed\"}"
    return 0
  fi

  log "screen $name: resume captured -> $image_path"
  append_manifest "$manifest" "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":true,\"stage\":\"screen\",\"status\":\"screened\",\"resumeImagePath\":\"$image_path\"}"
  return 0
}

# Act phase: apply agent resume decisions to a screen manifest; reply only to fit
# candidates, log resume_mismatch skips for the rest.
run_act_phase() {
  if [[ -z "$SCREEN_MANIFEST_FILE" || ! -f "$SCREEN_MANIFEST_FILE" ]]; then
    log "error: --decisions requires --screen-manifest pointing at a --screen-only manifest"
    exit 1
  fi
  local suitable_tsv unsuitable_jsonl summary
  suitable_tsv="$WORK_DIR/suitable.tsv"
  unsuitable_jsonl="$WORK_DIR/unsuitable.jsonl"
  summary=$(node "$APPLY_SCREEN_DECISIONS" "$SCREEN_MANIFEST_FILE" "$DECISIONS_FILE" "$suitable_tsv" "$unsuitable_jsonl") || {
    log "error: failed to merge decisions: $summary"
    exit 1
  }
  log "act phase: $summary"
  if [[ -s "$unsuitable_jsonl" ]]; then
    while IFS= read -r line; do
      append_result "$line"
    done <"$unsuitable_jsonl"
  fi
  if [[ ! -s "$suitable_tsv" ]]; then
    log "no suitable candidates; done"
    return 0
  fi

  local processed=0
  local consecutive_fail=0
  local batch_count=0
  while IFS=$'\t' read -r cid name image_path; do
    [[ -z "$cid" ]] && continue
    if [[ -n "$LIMIT" && "$processed" -ge "$LIMIT" ]]; then
      log "reached --limit $LIMIT"
      break
    fi
    log "act [$((processed + 1))] $name ($cid)"
    set +e
    process_one "$cid" "$name" ""
    local rc=$?
    set -e
    if [[ "$rc" -eq 2 ]]; then
      exit 2
    fi
    processed=$((processed + 1))
    if [[ "$rc" -eq 1 ]]; then
      consecutive_fail=$((consecutive_fail + 1))
      if [[ "$consecutive_fail" -ge "$MAX_CONSECUTIVE_FAILURES" ]]; then
        log "STOP: $MAX_CONSECUTIVE_FAILURES consecutive failures"
        exit 3
      fi
    elif [[ "$rc" -eq 10 ]]; then
      consecutive_fail=0
      batch_count=$((batch_count + 1))
      if [[ "$batch_count" -ge "$BATCH_SIZE" ]]; then
        if [[ "$BATCH_PAUSE" -gt 0 ]]; then
          log "batch pause ${BATCH_PAUSE}s"
          sleep "$BATCH_PAUSE"
        fi
        batch_count=0
      else
        local gap
        gap=$(random_gap)
        if [[ "$gap" -gt 0 ]]; then
          log "sleep ${gap}s"
          sleep "$gap"
        fi
      fi
    else
      consecutive_fail=0
    fi
  done <"$suitable_tsv"
  log "act phase done; handled=$processed"
}

process_one() {
  local cid="$1"
  local name="$2"
  local preview="$3"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # 1. c.json → open_chat (only list-row click in this pipeline)
  write_json "$WORK_DIR/c.json" "{\"conversationId\":\"$cid\"}"
  log "zhipin_open_chat $name (list click)"
  local open_out
  open_out=$(roll_json_file zhipin_open_chat "$WORK_DIR/c.json")
  stop_if_risk_page "$open_out" "open_chat" "$name" "$cid"
  if ! printf '%s' "$open_out" | node "$VALIDATE_OPEN_CHAT" "$cid" 2>/dev/null; then
    local initial_open_path reload_path retry_open_path reload_out failure_line
    initial_open_path="$WORK_DIR/open-chat-initial.out"
    reload_path="$WORK_DIR/open-chat-reload.out"
    retry_open_path="$WORK_DIR/open-chat-retry.out"
    write_text "$initial_open_path" "$open_out"

    log "warn: open_chat failed for $name; force-reloading chat page and retrying once"
    write_json "$WORK_DIR/reload-chat.json" "{\"forceReload\":true,\"expectedConversationId\":\"$cid\"}"
    reload_out=$(roll_json_file zhipin_open_chat_page "$WORK_DIR/reload-chat.json")
    write_text "$reload_path" "$reload_out"
    stop_if_risk_page "$reload_out" "open_chat_page" "$name" "$cid"
    invalidate_unread_filter_after_reload

    log "retry zhipin_open_chat $name after force reload"
    open_out=$(roll_json_file zhipin_open_chat "$WORK_DIR/c.json")
    write_text "$retry_open_path" "$open_out"
    stop_if_risk_page "$open_out" "open_chat" "$name" "$cid"
    if ! printf '%s' "$open_out" | node "$VALIDATE_OPEN_CHAT" "$cid" 2>/dev/null; then
      failure_line=$(node "$FORMAT_OPEN_CHAT_FAILURE" \
        "$ts" "$name" "$cid" "$initial_open_path" "$reload_path" "$retry_open_path" 2>/dev/null) \
        || failure_line=""
      if [[ -n "$failure_line" ]]; then
        append_result "$failure_line"
      else
        append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"open_chat\",\"recoveryAttempted\":true}"
      fi
      return 1
    fi
    log "open_chat recovered after force reload: $name"
  fi

  # Snapshot + page URL for captcha / expired
  write_json "$WORK_DIR/snap-preflight.json" '{"interactiveOnly":false,"maxNodes":250}'
  local snap page_url page_title
  snap=$(roll_json_file browser_snapshot "$WORK_DIR/snap-preflight.json")
  local page_meta captcha_flag blocked_flag
  page_meta=$(printf '%s' "$snap" | node "$PARSE_PAGE_META" 2>/dev/null) || page_meta='{"url":"","title":"","captcha":false,"blocked":false}'
  page_url=$(printf '%s' "$page_meta" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).url||'');" 2>/dev/null) || page_url=""
  page_title=$(printf '%s' "$page_meta" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).title||'');" 2>/dev/null) || page_title=""
  captcha_flag=$(printf '%s' "$page_meta" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).captcha?'1':'0');" 2>/dev/null) || captcha_flag="0"
  blocked_flag=$(printf '%s' "$page_meta" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).blocked?'1':'0');" 2>/dev/null) || blocked_flag="0"

  if [[ "$captcha_flag" == "1" ]]; then
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"preflight\",\"reason\":\"captcha\"}"
    log "STOP: captcha (url/title)"
    exit 2
  fi
  if [[ "$blocked_flag" == "1" ]]; then
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"preflight\",\"reason\":\"access_restricted\"}"
    log "STOP: access_restricted (url/title)"
    exit 2
  fi

  local blocker
  blocker=$(check_page_blockers "$snap")
  if [[ "$blocker" == "expired" ]]; then
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"preflight\",\"reason\":\"position_expired\"}"
    log "skip $name: position expired"
    back_to_list
    return 0
  fi
  # 2. get_candidate_info on current chat (do NOT pass conversationId — avoids 2nd list click)
  write_json "$WORK_DIR/info.json" '{"maxMessages":100}'
  log "zhipin_get_candidate_info (current chat, no re-open)"
  local info_out
  info_out=$(roll_json_file zhipin_get_candidate_info "$WORK_DIR/info.json")
  stop_if_risk_page "$info_out" "get_candidate_info" "$name" "$cid"
  write_json "$WORK_DIR/info-raw.json" "$(printf '%s' "$info_out" | extract_json_object 2>/dev/null || echo '{}')"

  # 3. skip rules (file-based payload avoids shell quoting issues)
  local skip_result skip stop_flag reason
  printf '%s' "$preview" >"$WORK_DIR/preview.txt"
  node "$BUILD_SKIP_INPUT" \
    "$WORK_DIR/info-raw.json" \
    "$WORK_DIR/preview.txt" \
    "$page_url" \
    "$page_title" \
    "$WORK_DIR/skip-input.json"
  skip_result=$(evaluate_skip "$WORK_DIR/skip-input.json")
  skip=$(printf '%s' "$skip_result" | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(j.skip?'1':'0');")
  stop_flag=$(printf '%s' "$skip_result" | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(j.stop?'1':'0');" 2>/dev/null) || stop_flag="0"
  if [[ "$stop_flag" == "1" ]]; then
    reason=$(printf '%s' "$skip_result" | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(j.reason||'captcha');" 2>/dev/null) || reason="captcha"
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"preflight\",\"reason\":\"$reason\"}"
    exit 2
  fi
  if [[ "$skip" == "1" ]]; then
    reason=$(printf '%s' "$skip_result" | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(j.reason||'skip');")
    append_result "$(node -e 'const j=JSON.parse(process.argv[1]); console.log(JSON.stringify({ts:process.argv[2],name:process.argv[3],conversationId:process.argv[4],ok:false,stage:"skip",reason:j.reason||"skip"}));' "$skip_result" "$ts" "$name" "$cid")"
    log "skip $name: $reason"
    back_to_list
    return 0
  fi

  if [[ "$SCREEN_ONLY" -eq 1 ]]; then
    capture_resume_screening "$cid" "$name" "$ts"
    back_to_list
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":true,\"stage\":\"dry_run\",\"would\":\"reply+exchange\"}"
    log "dry-run would reply: $name"
    back_to_list
    return 0
  fi

  # 4. generate on current chat (no conversationId — avoids 3rd list click)
  write_json "$WORK_DIR/gp.json" '{"maxMessages":100}'
  log "zhipin_generate_reply_preview (current chat, no re-open)"
  local preview_out preview_meta prepared_id has_dual send_bundle failure_line
  preview_out=$(roll_json_file zhipin_generate_reply_preview "$WORK_DIR/gp.json")
  stop_if_risk_page "$preview_out" "preview" "$name" "$cid"
  preview_meta=$(printf '%s' "$preview_out" | node "$PARSE_GENERATE_PREVIEW" 2>/dev/null) || preview_meta=""
  prepared_id=$(printf '%s' "$preview_meta" | node -e 'let j={};try{j=JSON.parse(require("fs").readFileSync(0,"utf8"));}catch{};process.stdout.write(j.preparedReplyId||"");' 2>/dev/null) || prepared_id=""
  has_dual=$(printf '%s' "$preview_meta" | node -e 'let j={};try{j=JSON.parse(require("fs").readFileSync(0,"utf8"));}catch{};process.stdout.write(j.hasDualDraft?"1":"0");' 2>/dev/null) || has_dual="0"

  if [[ -z "$prepared_id" ]]; then
    failure_line=$(printf '%s' "$preview_meta" | \
      node "$FORMAT_PREVIEW_FAILURE" "$ts" "$name" "$cid" 2>/dev/null) || failure_line=""
    if [[ -n "$failure_line" ]]; then
      append_result "$failure_line"
    else
      append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"preview\"}"
    fi
    back_to_list
    return 1
  fi

  if [[ "$has_dual" == "1" && "$NO_JUDGE" -eq 1 ]]; then
    log "BREAK-GLASS: --no-judge -> send recommended option; learning is skipped but a terminal outcome is recorded"
  fi

  if ! send_bundle=$(node "$BUILD_SEND_PAYLOAD" "$prepared_id" "$has_dual" "$NO_JUDGE"); then
    log "send payload validation failed; message was not sent"
    send_bundle=""
  fi
  write_json "$WORK_DIR/send-bundle.json" "$send_bundle"
  if [[ -z "$send_bundle" ]] || ! printf '%s' "$send_bundle" | node "$APPLY_SEND_BUNDLE" "$WORK_DIR/sp.json" 2>/dev/null; then
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"send_build\",\"preparedReplyId\":\"$prepared_id\",\"hasDualDraft\":$([ "$has_dual" == "1" ] && echo true || echo false)}"
    back_to_list
    return 1
  fi

  # 5. sp.json → send
  local send_out send_result send_ok
  send_out=$(roll_json_file zhipin_send_prepared_reply "$WORK_DIR/sp.json")
  stop_if_risk_page "$send_out" "send" "$name" "$cid"
  send_result=$(printf '%s' "$send_out" | node "$PARSE_SEND_RESULT" 2>/dev/null) || send_result='{"ok":false}'
  if printf '%s' "$send_result" | node -e 'let j={};try{j=JSON.parse(require("fs").readFileSync(0,"utf8"));}catch{};process.exit(j.ok?0:1);' 2>/dev/null; then
    send_ok="1"
  else
    send_ok="0"
  fi

  if [[ "$send_ok" != "1" ]]; then
    local result_line
    result_line=$(format_send_result_line send_failed "$ts" "$name" "$cid" "$prepared_id" "$send_result" 0) || result_line=""
    if [[ -n "$result_line" ]]; then
      append_result "$result_line"
    else
      append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"send\",\"preparedReplyId\":\"$prepared_id\"}"
    fi
    back_to_list
    return 1
  fi

  log "sent: $name"

  # 6. exchange wechat on current chat (empty input — no re-open)
  if [[ "$EXCHANGE_WECHAT" -eq 1 ]]; then
    write_json "$WORK_DIR/wx.json" '{}'
    log "zhipin_exchange_wechat (current chat)"
    local wx_out
    wx_out=$(roll_json_file zhipin_exchange_wechat "$WORK_DIR/wx.json")
    stop_if_risk_page "$wx_out" "exchange_wechat" "$name" "$cid"
    printf '%s' "$wx_out" | extract_json_object >/dev/null || {
      log "warn: exchange_wechat failed for $name"
    }
  fi

  local success_line
  success_line=$(format_send_result_line sent "$ts" "$name" "$cid" "$prepared_id" "$send_result" "$EXCHANGE_WECHAT") || success_line=""
  if [[ -n "$success_line" ]]; then
    local feedback_notice
    feedback_notice=$(printf '%s' "$success_line" | feedback_notice_from_result) || feedback_notice=""
    if [[ -n "$feedback_notice" ]]; then
      log "$feedback_notice"
    fi
    append_result "$success_line"
  else
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":true,\"preparedReplyId\":\"$prepared_id\",\"exchangedWechat\":$([ "$EXCHANGE_WECHAT" -eq 1 ] && echo true || echo false)}"
  fi
  back_to_list
  return 10
}

back_to_list() {
  ensure_unread_list_ready
}

main() {
  : >"$RESULTS_FILE"
  log "results -> $RESULTS_FILE"
  log "workdir -> $WORK_DIR"
  ensure_agent_healthy
  ensure_browser_instance_selection

  if [[ -n "$DECISIONS_FILE" ]]; then
    # Act phase works on already-read (no longer unread) candidates: never filter 未读.
    # Screening usually leaves the 未读 filter applied, which hides already-read
    # candidates from open_chat — force-reload once to drop it back to 全部.
    CLICK_UNREAD_FILTER=0
    log "act phase: force reload to drop 未读 filter"
    write_json "$WORK_DIR/reload-act.json" '{"forceReload":true}'
    local act_reload
    act_reload=$(roll_json_file zhipin_open_chat_page "$WORK_DIR/reload-act.json")
    stop_if_risk_page "$act_reload" "act_reload"
    ensure_chat_list
    run_act_phase
    return 0
  fi

  ensure_unread_list_ready

  if [[ "$SCREEN_ONLY" -eq 1 ]]; then
    if [[ -z "$SCREEN_MANIFEST_FILE" ]]; then
      SCREEN_MANIFEST_FILE="${RESULTS_FILE%.jsonl}-screen-manifest.jsonl"
    fi
    : >"$SCREEN_MANIFEST_FILE"
    log "screen manifest -> $SCREEN_MANIFEST_FILE"
  fi

  local processed=0
  local consecutive_fail=0
  local batch_count=0
  local empty_reads=0

  while true; do
    if [[ -n "$LIMIT" && "$processed" -ge "$LIMIT" ]]; then
      log "reached --limit $LIMIT"
      break
    fi

    # A force reload rebuilds the SPA and invalidates the previously clicked 未读 filter.
    ensure_unread_list_ready
    local next
    next=$(fetch_next_unread)
    if [[ -z "$next" ]]; then
      empty_reads=$((empty_reads + 1))
      if [[ "$empty_reads" -ge "$MAX_EMPTY_READS" ]]; then
        log "no unread (empty reads: $empty_reads)"
        break
      fi
      sleep 2
      continue
    fi
    empty_reads=0

    local cid name preview
    cid=$(printf '%s' "$next" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).conversationId)")
    name=$(printf '%s' "$next" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).name)")
    preview=$(printf '%s' "$next" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).preview||'')")

    log "[$((processed + 1))] $name ($cid)"
    set +e
    process_one "$cid" "$name" "$preview"
    local rc=$?
    set -e

    if [[ "$rc" -eq 2 ]]; then
      exit 2
    fi

    processed=$((processed + 1))

    if [[ "$rc" -eq 1 ]]; then
      consecutive_fail=$((consecutive_fail + 1))
      if [[ "$consecutive_fail" -ge "$MAX_CONSECUTIVE_FAILURES" ]]; then
        log "STOP: $MAX_CONSECUTIVE_FAILURES consecutive failures"
        exit 3
      fi
    elif [[ "$rc" -eq 10 ]]; then
      consecutive_fail=0
      batch_count=$((batch_count + 1))
      if [[ "$batch_count" -ge "$BATCH_SIZE" ]]; then
        if [[ "$BATCH_PAUSE" -gt 0 ]]; then
          log "batch pause ${BATCH_PAUSE}s"
          sleep "$BATCH_PAUSE"
        fi
        batch_count=0
      else
        local gap
        gap=$(random_gap)
        if [[ "$gap" -gt 0 ]]; then
          log "sleep ${gap}s"
          sleep "$gap"
        fi
      fi
    else
      consecutive_fail=0
    fi
  done

  log "done; handled=$processed; see $RESULTS_FILE"
}

main "$@"
