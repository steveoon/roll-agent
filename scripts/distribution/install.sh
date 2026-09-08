#!/bin/sh
# Roll standalone installer. This file intentionally needs no Node, npm, jq or Python.
set -eu
ORIGIN='https://roll.duliday.com'
VERSION=stable
INSTALL_DIR=
MODIFY_PATH=1
LOCKED=0

fail() { printf 'roll install: %s\n' "$*" >&2; exit 1; }
status() { printf 'roll install: %s\n' "$*" >&2; }
usage() { printf '%s\n' 'Usage: install.sh [--version VERSION] [--install-dir ABSOLUTE_PATH] [--no-modify-path]'; }
version_valid() {
  printf '%s\n' "$1" | LC_ALL=C awk '
    NR != 1 { exit 1 }
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/ { exit 1 }
    { sub(/\+.*/, ""); if (match($0, /-/)) { n=split(substr($0,RSTART+1),p,"."); for(i=1;i<=n;i++) if(p[i] ~ /^0[0-9]+$/) exit 1 } }'
}
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
download() {
  set -- "$1" -o "$2"
  # Piped installation has non-TTY stdin; curl draws its progress on stderr.
  if [ -t 2 ]; then set -- --progress-bar "$@"
  else set -- --silent "$@"; fi
  curl --fail --show-error --proto '=https' --tlsv1.2 --max-redirs 0 --connect-timeout 30 --max-time 900 "$@"
}
cleanup() { if [ "$LOCKED" = 1 ]; then rm -rf "$INSTALL_DIR/.install-lock"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || fail '--version requires a value'; VERSION=$2; shift 2 ;;
    --install-dir) [ "$#" -ge 2 ] || fail '--install-dir requires a value'; INSTALL_DIR=$2; shift 2 ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
status 'Checking system requirements...'
[ "$VERSION" = stable ] || version_valid "$VERSION" || fail 'Invalid version'
[ -n "${HOME:-}" ] || fail 'HOME is required'
for tool in curl tar awk sed tr wc cmp diff mktemp cut grep find; do command -v "$tool" >/dev/null 2>&1 || fail "Required tool missing: $tool"; done
if command -v sha256sum >/dev/null 2>&1; then HASH_TOOL=sha256sum
elif command -v shasum >/dev/null 2>&1; then HASH_TOOL=shasum
else fail 'sha256sum or shasum is required'; fi
case "$(uname -s)" in
  Darwin) OS=darwin; command -v sw_vers >/dev/null 2>&1 || fail 'Cannot determine macOS version'
    sw_vers -productVersion | awk -F. '{ exit !($1>13 || ($1==13 && $2>=5)) }' || fail 'macOS 13.5 or newer is required' ;;
  Linux) OS=linux
    command -v getconf >/dev/null 2>&1 || fail 'glibc 2.28 or newer is required (musl is unsupported)'
    LIBC=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'glibc is required (musl is unsupported)'
    printf '%s\n' "$LIBC" | awk '{ if($1!="glibc") exit 1; split($2,v,"."); exit !(v[1]>2 || (v[1]==2 && v[2]>=28)) }' || fail 'glibc 2.28 or newer is required'
    uname -r | awk -F. '{ exit !($1>4 || ($1==4 && $2>=18)) }' || fail 'Linux kernel 4.18 or newer is required' ;;
  *) fail 'Unsupported operating system; Windows users should run install.ps1' ;;
esac
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) fail 'Unsupported CPU architecture' ;; esac
PLATFORM=$OS-$ARCH
if [ -z "$INSTALL_DIR" ]; then INSTALL_DIR=$HOME/.local/share/roll; BIN_DIR=$HOME/.local/bin
else BIN_DIR=$INSTALL_DIR/bin; fi
case "$INSTALL_DIR" in /*) ;; *) fail '--install-dir must be absolute' ;; esac
case "$INSTALL_DIR$BIN_DIR" in *"
"*|*"$(printf '\r')"*) fail 'Installation path cannot contain line breaks' ;; esac
[ ! -L "$INSTALL_DIR" ] || fail 'Installation root must not be a symbolic link'
mkdir -p "$INSTALL_DIR"
INSTALL_DIR=$(cd "$INSTALL_DIR" && pwd -P)
if [ -f "$INSTALL_DIR/installation.json" ]; then
  [ "$(tr -d '[:space:]' < "$INSTALL_DIR/installation.json")" = '{"schemaVersion":1,"channel":"standalone"}' ] || fail 'Unrecognized installation metadata'
elif [ -n "$(ls -A "$INSTALL_DIR")" ]; then fail 'Installation directory is not empty and is not a Roll standalone installation'; fi
mkdir "$INSTALL_DIR/.install-lock" 2>/dev/null || fail 'Another install or update owns .install-lock; no files were replaced'
LOCKED=1
STAGE=$(mktemp -d "$INSTALL_DIR/.install-lock/stage.XXXXXXXX")
status "Fetching $VERSION release information for $PLATFORM..."
download "$ORIGIN/releases/$VERSION/$PLATFORM.txt" "$STAGE/index"
# Exactly one TSV record with a required terminal newline; no permissive shell field parsing.
awk -F '\t' 'NR!=1 || NF!=4 || $3 !~ /^[1-9][0-9]*$/ { exit 1 } END { if(NR!=1) exit 1 }' "$STAGE/index" || fail 'Invalid release index'
[ "$(wc -l < "$STAGE/index" | tr -d '[:space:]')" = 1 ] || fail 'Invalid release index newline'
RELEASE=$(cut -f1 "$STAGE/index")
SHA=$(cut -f2 "$STAGE/index")
SIZE=$(cut -f3 "$STAGE/index")
ASSET=$(cut -f4 "$STAGE/index")
version_valid "$RELEASE" || fail 'Invalid release version'
[ "$VERSION" = stable ] || [ "$VERSION" = "$RELEASE" ] || fail 'Release version does not match request'
[ "${#SHA}" -eq 64 ] || fail 'Invalid release checksum'
printf '%s\n' "$SHA" | LC_ALL=C grep -Eq '^[0-9a-f]+$' || fail 'Invalid release checksum'
[ "$ASSET" = "roll-$RELEASE-$PLATFORM.tar.gz" ] || fail 'Invalid asset filename'
SIZE_MIB=$(LC_ALL=C awk -v bytes="$SIZE" 'BEGIN { printf "%.1f", bytes / 1048576 }')
status "Downloading Roll $RELEASE for $PLATFORM ($SIZE_MIB MiB)..."
download "$ORIGIN/releases/$RELEASE/$ASSET" "$STAGE/archive.tar.gz"
status 'Verifying download...'
[ "$(wc -c < "$STAGE/archive.tar.gz" | tr -d '[:space:]')" = "$SIZE" ] || fail 'Asset size mismatch'
if [ "$HASH_TOOL" = sha256sum ]; then ACTUAL=$(sha256sum "$STAGE/archive.tar.gz" | cut -d ' ' -f1)
else ACTUAL=$(shasum -a 256 "$STAGE/archive.tar.gz" | cut -d ' ' -f1); fi
[ "$ACTUAL" = "$SHA" ] || fail 'Asset checksum mismatch'
tar -tzf "$STAGE/archive.tar.gz" > "$STAGE/entries" || fail 'Cannot read archive'
LC_ALL=C awk '
  /^\// || /\\/ || /[[:cntrl:]]/ { exit 1 }
  { n=split($0,p,"/"); for(i=1;i<=n;i++) if(p[i]=="..") exit 1 }
  END { if(NR==0) exit 1 }' "$STAGE/entries" || fail 'Archive contains unsafe paths'
# Distribution archives contain regular files/directories only: reject links and special files before extraction.
tar -tvzf "$STAGE/archive.tar.gz" > "$STAGE/types" || fail 'Cannot inspect archive'
LC_ALL=C awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" { exit 1 }' "$STAGE/types" || fail 'Archive contains links or special files'
mkdir "$STAGE/candidate" "$STAGE/home"
# Stop config discovery before it can walk upward into the user's actual home/workspace.
printf '{}\n' > "$STAGE/home/roll.config.yaml"
status 'Extracting installation...'
tar -xzf "$STAGE/archive.tar.gz" -C "$STAGE/candidate" || fail 'Cannot extract archive'
CANDIDATE=$STAGE/candidate
NODE=$CANDIDATE/runtime/bin/node
[ -x "$NODE" ] && [ -f "$CANDIDATE/app/bin/roll.js" ] && [ -f "$CANDIDATE/runtime/lib/node_modules/npm/bin/npm-cli.js" ] && [ -f "$CANDIDATE/runtime/lib/node_modules/npm/bin/npx-cli.js" ] || fail 'Archive is missing runtime files'
# Use only the downloaded private runtime to verify metadata, then smoke in an isolated home/cwd.
status 'Checking installation...'
env -u NODE_OPTIONS -u NODE_PATH "$NODE" -e '
const fs=require("node:fs"); const [root,version,platform]=process.argv.slice(1);
const d=JSON.parse(fs.readFileSync(root+"/distribution.json","utf8"));
const p=JSON.parse(fs.readFileSync(root+"/app/package.json","utf8"));
if(d.schemaVersion!==1 || d.channel!=="standalone" || d.version!==version || d.platform!==platform || typeof d.nodeVersion!=="string" || process.versions.node!==d.nodeVersion || p.version!==version || p.rollDistribution?.schemaVersion!==1 || p.rollDistribution?.channel!=="standalone") process.exit(1);
' "$CANDIDATE" "$RELEASE" "$PLATFORM" < /dev/null || fail 'Distribution metadata mismatch'
(
  cd "$STAGE/home"
  smoke() {
    env -u NODE_OPTIONS -u NODE_PATH -u ROLL_CONFIG_PATH -u ROLL_CONFIG \
      HOME="$STAGE/home" USERPROFILE="$STAGE/home" XDG_CONFIG_HOME="$STAGE/home/config" \
      XDG_DATA_HOME="$STAGE/home/data" XDG_CACHE_HOME="$STAGE/home/cache" \
      "$NODE" "$CANDIDATE/app/bin/roll.js" "$@" < /dev/null
  }
  smoke --version
  smoke agent health
) >&2 || fail 'Candidate startup check failed'
mkdir -p "$BIN_DIR"
BIN_DIR=$(cd "$BIN_DIR" && pwd -P)
LAUNCHER=$BIN_DIR/roll
{
  printf '%s\n' '#!/bin/sh' '# Roll standalone launcher v1' 'set -eu'
  printf 'ROLL_ROOT=%s\n' "$(quote "$INSTALL_DIR")"
  cat <<'LAUNCH'
IFS= read -r version < "$ROLL_ROOT/current.txt" || { echo 'roll: missing installation pointer' >&2; exit 1; }
case "$version" in ''|*[!0-9A-Za-z.+-]*|.*) echo 'roll: invalid installation pointer' >&2; exit 1 ;; esac
exec "$ROLL_ROOT/versions/$version/runtime/bin/node" "$ROLL_ROOT/versions/$version/app/bin/roll.js" "$@"
LAUNCH
} > "$STAGE/launcher"
if [ -e "$LAUNCHER" ] || [ -L "$LAUNCHER" ]; then
  [ ! -L "$LAUNCHER" ] || fail "Existing launcher is a symbolic link: $LAUNCHER"
  cmp -s "$STAGE/launcher" "$LAUNCHER" || fail "Existing launcher is owned by another installation: $LAUNCHER"
fi
DEST=$INSTALL_DIR/versions/$RELEASE
status 'Finishing installation...'
[ ! -L "$INSTALL_DIR/versions" ] && [ ! -L "$DEST" ] || fail 'Version directory must not be a symbolic link'
mkdir -p "$INSTALL_DIR/versions"
if [ -e "$DEST" ]; then
  [ -z "$(find "$DEST" -type l -print)" ] || fail 'Existing version contains symbolic links'
  diff -qr "$CANDIDATE" "$DEST" >/dev/null || fail 'Existing version differs from the verified release; refusing to overwrite'
else mv "$CANDIDATE" "$DEST"; fi
printf '%s\n' '{"schemaVersion":1,"channel":"standalone"}' > "$STAGE/installation.json"
mv "$STAGE/installation.json" "$INSTALL_DIR/installation.json"
chmod 755 "$STAGE/launcher"
if [ ! -e "$LAUNCHER" ]; then mv "$STAGE/launcher" "$LAUNCHER"; fi
printf '%s\n' "$RELEASE" > "$STAGE/current.txt"
mv -f "$STAGE/current.txt" "$INSTALL_DIR/current.txt"
if [ "$MODIFY_PATH" = 1 ]; then
  case "${SHELL:-}" in */zsh) PROFILE=$HOME/.zshrc ;; */bash) PROFILE=$HOME/.bashrc ;; *) PROFILE=$HOME/.profile ;; esac
  LINE="export PATH=$(quote "$BIN_DIR"):\$PATH # Roll standalone PATH"
  if ! grep -Fqx "$LINE" "$PROFILE" 2>/dev/null; then
    if ! printf '\n%s\n' "$LINE" >> "$PROFILE"; then printf 'Could not update %s; use the PATH command below.\n' "$PROFILE" >&2; fi
  fi
fi
printf '\nRoll %s installed: %s\n' "$RELEASE" "$LAUNCHER" >&2
CURRENT=$(command -v roll 2>/dev/null || true)
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$LAUNCHER" ]; then printf 'Your current PATH selects another Roll: %s\n' "$CURRENT" >&2; fi
printf '%s\n' "For this terminal: export PATH=$(quote "$BIN_DIR"):\$PATH" >&2
printf 'Update with roll update; install subagents with roll agent install <package>.\n' >&2
