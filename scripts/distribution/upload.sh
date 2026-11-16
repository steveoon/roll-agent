#!/bin/bash
# CI-only transport: no dependency install/build with deployment credentials.
set -euo pipefail
ASSETS=${1:?publication directory required}
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
VERSION=$(cut -f1 "$ASSETS/linux-x64.txt")
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
STAGE_ID="${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
[[ "$STAGE_ID" =~ ^[0-9]+-[0-9]+$ ]]
(
  cd "$ASSETS"
  sha256sum --strict -c CHECKSUMS.sha256
)
printf '[deploy] Local checksums verified\n' >&2
KEY_DIR=$(mktemp -d)
UPLOAD_PID=
cleanup() {
  if [[ -n "$UPLOAD_PID" ]]; then
    kill "$UPLOAD_PID" 2>/dev/null || true
    wait "$UPLOAD_PID" 2>/dev/null || true
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
unset ROLL_DIST_SSH_KEY ROLL_DIST_SSH_KNOWN_HOSTS
SSH_ARGS=(-i "$KEY_DIR/key" -o "Port=$ROLL_DIST_SSH_PORT" -o "UserKnownHostsFile=$KEY_DIR/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ConnectionAttempts=1 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
REMOTE="$ROLL_DIST_SSH_USER@$ROLL_DIST_SSH_HOST"
STAGE="$ROLL_DIST_ROOT/staging/$STAGE_ID"
# The canonical ASCII root and numeric identifiers are validated before shell interpolation.
# shellcheck disable=SC2029
ssh "${SSH_ARGS[@]}" "$REMOTE" "set -eu; test \"\$(cd '$ROLL_DIST_ROOT' && pwd -P)\" = '$ROLL_DIST_ROOT'; test \"\$(cat '$ROLL_DIST_ROOT/.roll-distribution-root')\" = roll-distribution-v1; test -d '$ROLL_DIST_ROOT/staging'; test ! -L '$ROLL_DIST_ROOT/staging'; test -d '$ROLL_DIST_ROOT/releases'; test ! -L '$ROLL_DIST_ROOT/releases'; mkdir '$STAGE'"
UPLOAD_BYTES=$(wc -c "$ASSETS"/* | awk 'END { print $1 }')
printf '[deploy] Remote staging ready; uploading %s bytes\n' "$UPLOAD_BYTES" >&2
UPLOAD_STARTED=$SECONDS
NEXT_HEARTBEAT=30
scp "${SSH_ARGS[@]}" "$ASSETS"/* "$REMOTE:$STAGE/" &
UPLOAD_PID=$!
# Supervise one transport child; no separate heartbeat daemon or automatic retry.
while kill -0 "$UPLOAD_PID" 2>/dev/null; do
  sleep 1
  ELAPSED=$((SECONDS - UPLOAD_STARTED))
  if (( ELAPSED >= NEXT_HEARTBEAT )) && kill -0 "$UPLOAD_PID" 2>/dev/null; then
    printf '[deploy] Upload process still running; elapsed %ss (not byte progress)\n' "$ELAPSED" >&2
    NEXT_HEARTBEAT=$((ELAPSED + 30))
  fi
done
if wait "$UPLOAD_PID"; then
  UPLOAD_PID=
else
  UPLOAD_STATUS=$?
  UPLOAD_PID=
  printf '[deploy] Upload failed (exit %s); not publishing\n' "$UPLOAD_STATUS" >&2
  exit "$UPLOAD_STATUS"
fi
printf '[deploy] Upload complete; verifying and publishing remotely\n' >&2
# shellcheck disable=SC2029
ssh "${SSH_ARGS[@]}" "$REMOTE" "sh -s -- '$VERSION' '$STAGE_ID' '$ROLL_DIST_ROOT'" < "$(dirname "$0")/finalize.sh"
printf '[deploy] Published successfully\n' >&2
