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
VALIDATE_GENERATE="$SCRIPT_DIR/validate-generate.mjs"
VALIDATE_SEND="$SCRIPT_DIR/validate-send.mjs"
CHECK_AGENT_HEALTH="$SCRIPT_DIR/check-agent-health.mjs"
DETECT_EXPIRED="$SCRIPT_DIR/detect-expired-banner.mjs"
PARSE_PAGE_META="$SCRIPT_DIR/parse-page-meta.mjs"

AGENT="${ROLL_AGENT:-browser-use-agent}"
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
RESULTS_FILE="${TMPDIR:-/tmp}/roll-zhipin-unread-reply-$(date +%Y%m%d-%H%M%S).jsonl"
WORK_DIR=""

usage() {
  cat <<'EOF'
Usage: reply-unread-safely.sh [options]

Processes BOSS unread chats one-at-a-time (limit=1 per read) via roll + browser-use-agent.
Implements team skip rules, exchange-wechat, and rate limits.

Options:
  --agent NAME           MCP agent (default: browser-use-agent)
  --limit N              Max candidates to handle this run (default: all unread)
  --dry-run              Evaluate skip rules; do not generate/send/exchange
  --no-unread-filter     Skip clicking the "未读" tab
  --no-exchange-wechat   Do not call zhipin_exchange_wechat after send
  --min-gap SEC          Min seconds between successful sends (default: 0, no wait)
  --max-gap SEC          Max seconds between successful sends (default: 0)
  --batch-size N         Sends per batch before long pause (default: 4)
  --batch-pause SEC      Pause after each batch (default: 0, disabled)
  --results-file PATH    JSONL log path
  --keep-workdir         Do not delete temp workdir (debug)
  -h, --help

Exit codes: 0 ok | 1 usage | 2 captcha | 3 consecutive failures
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
    --limit) need_arg "$1" "${2:-}"; LIMIT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-unread-filter) CLICK_UNREAD_FILTER=0; shift ;;
    --no-exchange-wechat) EXCHANGE_WECHAT=0; shift ;;
    --min-gap) need_arg "$1" "${2:-}"; MIN_GAP="$2"; shift 2 ;;
    --max-gap) need_arg "$1" "${2:-}"; MAX_GAP="$2"; shift 2 ;;
    --batch-size) need_arg "$1" "${2:-}"; BATCH_SIZE="$2"; shift 2 ;;
    --batch-pause) need_arg "$1" "${2:-}"; BATCH_PAUSE="$2"; shift 2 ;;
    --results-file) need_arg "$1" "${2:-}"; RESULTS_FILE="$2"; shift 2 ;;
    --keep-workdir) KEEP_WORKDIR=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if ! command -v roll >/dev/null 2>&1; then
  echo "error: roll CLI not found in PATH" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: node required" >&2
  exit 1
fi

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

roll_json_file() {
  local tool="$1"
  local file="$2"
  roll run "$AGENT" "$tool" --input-file "$file" --json 2>&1 || true
}

roll_no_input() {
  roll run "$AGENT" "$1" --json 2>&1 || true
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

random_gap() {
  if [[ "$MAX_GAP" -le "$MIN_GAP" ]]; then
    echo "$MIN_GAP"
  else
    echo $((MIN_GAP + RANDOM % (MAX_GAP - MIN_GAP + 1)))
  fi
}

log() { echo "[reply-unread] $*" >&2; }

append_result() {
  append_result_json "$1"
}

ensure_agent_healthy() {
  local health
  health=$(roll agent health "$AGENT" --json 2>&1) || health=""
  if printf '%s' "$health" | node "$CHECK_AGENT_HEALTH" 2>/dev/null; then
    return 0
  fi
  log "starting agent $AGENT..."
  roll agent start "$AGENT" >&2 || true
  sleep 2
}

# Return to chat list only (no 未读 click).
ensure_chat_list() {
  roll_no_input zhipin_open_chat_page | extract_json_object >/dev/null || true
}

# Click 「未读」 at most once per script run while on the list view.
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
  ref=$(printf '%s' "$snap" | node "$FIND_UNREAD_REF" 2>/dev/null) || ref=""
  if [[ -n "$ref" ]]; then
    log "click 未读 filter $ref (once per run)"
    write_json "$WORK_DIR/click-unread.json" "{\"ref\":\"$ref\"}"
    roll_json_file click_ref "$WORK_DIR/click-unread.json" | extract_json_object >/dev/null || true
    UNREAD_FILTER_APPLIED=1
    sleep 1
  else
    log "warn: 未读 ref not found; relying on onlyUnread read_messages"
  fi
}

fetch_next_unread() {
  write_json "$WORK_DIR/read.json" '{"onlyUnread":true,"limit":1,"autoScroll":false}'
  local out
  out=$(roll_json_file zhipin_read_messages "$WORK_DIR/read.json")
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
  if ! printf '%s' "$open_out" | node "$VALIDATE_OPEN_CHAT" "$cid" 2>/dev/null; then
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"open_chat\"}"
    return 1
  fi

  # Snapshot + page URL for captcha / expired
  write_json "$WORK_DIR/snap-preflight.json" '{"interactiveOnly":false,"maxNodes":250}'
  local snap page_url page_title
  snap=$(roll_json_file browser_snapshot "$WORK_DIR/snap-preflight.json")
  local page_meta captcha_flag
  page_meta=$(printf '%s' "$snap" | node "$PARSE_PAGE_META" 2>/dev/null) || page_meta='{"url":"","title":"","captcha":false}'
  page_url=$(printf '%s' "$page_meta" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).url||'');" 2>/dev/null) || page_url=""
  page_title=$(printf '%s' "$page_meta" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).title||'');" 2>/dev/null) || page_title=""
  captcha_flag=$(printf '%s' "$page_meta" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).captcha?'1':'0');" 2>/dev/null) || captcha_flag="0"

  if [[ "$captcha_flag" == "1" ]]; then
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"preflight\",\"reason\":\"captcha\"}"
    log "STOP: captcha (url/title)"
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
  write_json "$WORK_DIR/info-raw.json" "$(printf '%s' "$info_out" | extract_json_object 2>/dev/null || echo '{}')"

  # 3. skip rules (file-based payload avoids shell quoting issues)
  local skip_result skip skip reason
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

  if [[ "$DRY_RUN" -eq 1 ]]; then
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":true,\"stage\":\"dry_run\",\"would\":\"reply+exchange\"}"
    log "dry-run would reply: $name"
    back_to_list
    return 0
  fi

  # 4. generate on current chat (no conversationId — avoids 3rd list click)
  write_json "$WORK_DIR/gp.json" '{"maxMessages":100}'
  log "zhipin_generate_reply_preview (current chat, no re-open)"
  local preview_out prepared_id
  preview_out=$(roll_json_file zhipin_generate_reply_preview "$WORK_DIR/gp.json")
  prepared_id=$(printf '%s' "$preview_out" | node "$VALIDATE_GENERATE" 2>/dev/null) || prepared_id=""

  if [[ -z "$prepared_id" ]]; then
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"preview\"}"
    back_to_list
    return 1
  fi

  # 5. sp.json → send
  write_json "$WORK_DIR/sp.json" "{\"preparedReplyId\":\"$prepared_id\"}"
  local send_out send_ok
  send_out=$(roll_json_file zhipin_send_prepared_reply "$WORK_DIR/sp.json")
  if printf '%s' "$send_out" | node "$VALIDATE_SEND" 2>/dev/null; then
    send_ok="1"
  else
    send_ok="0"
  fi

  if [[ "$send_ok" != "1" ]]; then
    append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":false,\"stage\":\"send\",\"preparedReplyId\":\"$prepared_id\"}"
    back_to_list
    return 1
  fi

  log "sent: $name"

  # 6. exchange wechat on current chat (empty input — no re-open)
  if [[ "$EXCHANGE_WECHAT" -eq 1 ]]; then
    write_json "$WORK_DIR/wx.json" '{}'
    log "zhipin_exchange_wechat (current chat)"
    roll_json_file zhipin_exchange_wechat "$WORK_DIR/wx.json" | extract_json_object >/dev/null || {
      log "warn: exchange_wechat failed for $name"
    }
  fi

  append_result "{\"ts\":\"$ts\",\"name\":\"$name\",\"conversationId\":\"$cid\",\"ok\":true,\"preparedReplyId\":\"$prepared_id\",\"exchangedWechat\":$([ "$EXCHANGE_WECHAT" -eq 1 ] && echo true || echo false)}"
  back_to_list
  return 10
}

back_to_list() {
  # Back to list only; do not re-click 未读 (avoids toggle/double-click; read uses onlyUnread).
  ensure_chat_list
}

main() {
  : >"$RESULTS_FILE"
  log "results -> $RESULTS_FILE"
  log "workdir -> $WORK_DIR"
  ensure_agent_healthy
  apply_unread_filter_if_needed

  local processed=0
  local consecutive_fail=0
  local batch_count=0
  local empty_reads=0

  while true; do
    if [[ -n "$LIMIT" && "$processed" -ge "$LIMIT" ]]; then
      log "reached --limit $LIMIT"
      break
    fi

    # Stay on list; zhipin_read_messages uses onlyUnread — no repeat 未读 click.
    ensure_chat_list
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
