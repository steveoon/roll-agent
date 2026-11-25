#!/bin/bash
# CI-only transport: no dependency install/build with deployment credentials.
set -euo pipefail
VERSION=${1:?Core version required}
ARTIFACT_ID=${2:?Actions artifact ID required}
FINALIZER=${3:?release finalizer required}
TOOLS=$(dirname "$0")
[[ "$ARTIFACT_ID" =~ ^[0-9]+$ ]]
test -r "$FINALIZER"
: "${ROLL_DIST_SSH_HOST:?}" "${ROLL_DIST_SSH_USER:?}" "${ROLL_DIST_SSH_KEY:?}" "${ROLL_DIST_SSH_KNOWN_HOSTS:?}"
[[ "$ROLL_DIST_SSH_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]
[[ "$ROLL_DIST_SSH_USER" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_-]*$ ]]
ROLL_DIST_SSH_PORT=${ROLL_DIST_SSH_PORT:-22}
[[ "$ROLL_DIST_SSH_PORT" =~ ^[0-9]{1,5}$ ]] || { echo 'Invalid ROLL_DIST_SSH_PORT' >&2; exit 1; }
ROLL_DIST_SSH_PORT=$((10#$ROLL_DIST_SSH_PORT))
(( ROLL_DIST_SSH_PORT >= 1 && ROLL_DIST_SSH_PORT <= 65535 )) || { echo 'Invalid ROLL_DIST_SSH_PORT' >&2; exit 1; }
: "${ROLL_DIST_ROOT:?}"
case "$ROLL_DIST_ROOT" in /*/*) ;; *) echo 'Invalid ROLL_DIST_ROOT' >&2; exit 1;; esac
case "$ROLL_DIST_ROOT" in *[!a-zA-Z0-9/._-]*|*/|*//*|*/.*) echo 'Invalid ROLL_DIST_ROOT' >&2; exit 1;; esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
STAGE_ID="${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
[[ "$STAGE_ID" =~ ^[0-9]+-[0-9]+$ ]]
KEY_DIR=$(mktemp -d)
PULL_PID=
cleanup() {
  if [[ -n "$PULL_PID" ]]; then
    kill "$PULL_PID" 2>/dev/null || true
    wait "$PULL_PID" 2>/dev/null || true
  fi
  rm -rf "$KEY_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$KEY_DIR"
printf '%s\n' "$ROLL_DIST_SSH_KEY" > "$KEY_DIR/key"
printf '%s\n' "$ROLL_DIST_SSH_KNOWN_HOSTS" > "$KEY_DIR/known_hosts"
chmod 600 "$KEY_DIR/key" "$KEY_DIR/known_hosts"
API_TOKEN=${GH_TOKEN:?}
unset GH_TOKEN ROLL_DIST_SSH_KEY ROLL_DIST_SSH_KNOWN_HOSTS
SSH_ARGS=(-i "$KEY_DIR/key" -o "Port=$ROLL_DIST_SSH_PORT" -o "UserKnownHostsFile=$KEY_DIR/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ConnectionAttempts=1 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
REMOTE="$ROLL_DIST_SSH_USER@$ROLL_DIST_SSH_HOST"
STAGE="$ROLL_DIST_ROOT/staging/$STAGE_ID"
# The canonical ASCII root and numeric identifiers are validated before shell interpolation.
# shellcheck disable=SC2029
ssh "${SSH_ARGS[@]}" "$REMOTE" "set -eu; test \"\$(cd '$ROLL_DIST_ROOT' && pwd -P)\" = '$ROLL_DIST_ROOT'; test \"\$(cat '$ROLL_DIST_ROOT/.roll-distribution-root')\" = roll-distribution-v1; test -d '$ROLL_DIST_ROOT/staging'; test ! -L '$ROLL_DIST_ROOT/staging'; test -d '$ROLL_DIST_ROOT/releases'; test ! -L '$ROLL_DIST_ROOT/releases'; mkdir '$STAGE'"
# Pass the short-lived URL only on stdin. The credential-free receiver is shell-quoted as code.
RECEIVER=$(python3 -c 'import pathlib, shlex, sys; print(shlex.quote(pathlib.Path(sys.argv[1]).read_text()))' "$TOOLS/pull-publication.py")
for attempt in 1 2 3; do
  printf '[deploy] Server download attempt %s/3\n' "$attempt" >&2
  if GH_TOKEN="$API_TOKEN" node "$TOOLS/artifact-ticket.mjs" "$ARTIFACT_ID" "$KEY_DIR/ticket"; then
    # shellcheck disable=SC2029 # static receiver quoted above; stage and version validated
    ssh "${SSH_ARGS[@]}" "$REMOTE" "python3 -c $RECEIVER '$STAGE' '$VERSION'" < "$KEY_DIR/ticket" &
    PULL_PID=$!
    if wait "$PULL_PID"; then status=0; else status=$?; fi
    PULL_PID=
    if [[ "$status" == 0 ]]; then break; fi
  else
    status=$?
  fi
  if [[ "$status" != 75 || "$attempt" == 3 ]]; then exit "$status"; fi
  sleep "$attempt"
done
# The release-tag finalizer verifies every file before atomically activating stable.
# shellcheck disable=SC2029 # interpolate validated arguments for the release-tag script
ssh "${SSH_ARGS[@]}" "$REMOTE" "sh -s -- '$VERSION' '$STAGE_ID' '$ROLL_DIST_ROOT'" < "$FINALIZER"
printf '[deploy] Published successfully\n' >&2
