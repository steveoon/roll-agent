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
VERSION=$(cut -f1 "$ASSETS/linux-x64.txt")
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
STAGE_ID="${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
[[ "$STAGE_ID" =~ ^[0-9]+-[0-9]+$ ]]
(
  cd "$ASSETS"
  sha256sum --strict -c CHECKSUMS.sha256
)
KEY_DIR=$(mktemp -d)
trap 'rm -rf "$KEY_DIR"' EXIT
chmod 700 "$KEY_DIR"
printf '%s\n' "$ROLL_DIST_SSH_KEY" > "$KEY_DIR/key"
printf '%s\n' "$ROLL_DIST_SSH_KNOWN_HOSTS" > "$KEY_DIR/known_hosts"
chmod 600 "$KEY_DIR/key" "$KEY_DIR/known_hosts"
unset ROLL_DIST_SSH_KEY ROLL_DIST_SSH_KNOWN_HOSTS
SSH_ARGS=(-i "$KEY_DIR/key" -o "Port=$ROLL_DIST_SSH_PORT" -o "UserKnownHostsFile=$KEY_DIR/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes)
REMOTE="$ROLL_DIST_SSH_USER@$ROLL_DIST_SSH_HOST"
STAGE="/var/www/roll-distribution/staging/$STAGE_ID"
# The fixed root and strictly validated numeric identifiers intentionally expand on the client.
# shellcheck disable=SC2029
ssh "${SSH_ARGS[@]}" "$REMOTE" "mkdir -p /var/www/roll-distribution/staging && mkdir '$STAGE'"
scp "${SSH_ARGS[@]}" "$ASSETS"/* "$REMOTE:$STAGE/"
# shellcheck disable=SC2029
ssh "${SSH_ARGS[@]}" "$REMOTE" "sh -s -- '$VERSION' '$STAGE_ID'" < "$(dirname "$0")/finalize.sh"
