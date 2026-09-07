#!/bin/sh
# Run only as the restricted distribution user on the Linux publishing host.
set -eu
umask 022
ROOT=/var/www/roll-distribution
VERSION=${1:?version required}
STAGE_ID=${2:?staging id required}
case "$VERSION" in *[!0-9.]*|'') echo 'Invalid version' >&2; exit 1;; esac
printf '%s\n' "$VERSION" | awk -F. 'NF != 3 || $1 == "" || $2 == "" || $3 == "" { exit 1 }'
case "$STAGE_ID" in *[!a-zA-Z0-9-]*|'') echo 'Invalid staging id' >&2; exit 1;; esac
STAGE="$ROOT/staging/$STAGE_ID"
RELEASE="$ROOT/releases/$VERSION"
test -d "$STAGE"
test ! -L "$STAGE"
mkdir "$ROOT/.publish-lock" || { echo 'Another publication owns the lock' >&2; exit 1; }
trap 'rmdir "$ROOT/.publish-lock"' EXIT HUP INT TERM
cd "$STAGE"
# Never follow transferred links or accept arbitrary pathnames in checksum input.
test -z "$(find . -type l -print)"
awk 'NF != 2 || length($1) != 64 || $1 ~ /[^a-f0-9]/ || $2 ~ /[^a-zA-Z0-9.-]/ || $2 ~ /^\./ { exit 1 }' CHECKSUMS.sha256
sha256sum --strict -c CHECKSUMS.sha256
test "$(wc -l < CHECKSUMS.sha256 | tr -d ' ')" = 15
test "$(find . -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" = 16
for platform in darwin-x64 darwin-arm64 linux-x64 linux-arm64 win32-x64 win32-arm64; do
  test -f "$platform.txt"
  extension=tar.gz
  case "$platform" in win32-*) extension=zip;; esac
  asset="roll-$VERSION-$platform.$extension"
  test -s "$asset"
  expected=$(printf '%s\t%s\t%s\t%s' "$VERSION" "$(sha256sum "$asset" | cut -d ' ' -f 1)" "$(wc -c < "$asset" | tr -d ' ')" "$asset")
  test "$(cat "$platform.txt")" = "$expected"
done
test -f install.sh
test -f install.ps1
test -f manifest.json
mkdir -p "$ROOT/releases"
if test -e "$RELEASE"; then
  test ! -L "$RELEASE"
  diff -qr "$STAGE" "$RELEASE"
  # A verified duplicate has no diagnostic value; only discard this exact staging directory.
  cd "$ROOT"
  rm -rf -- "$STAGE"
else
  mv "$STAGE" "$RELEASE"
fi
# Do not let a delayed older CI run downgrade stable.
if test -L "$ROOT/releases/stable"; then
  old=$(readlink "$ROOT/releases/stable")
  latest=$(printf '%s\n%s\n' "$old" "$VERSION" | sort -V | tail -n 1)
  test "$latest" = "$VERSION" || { echo 'Refusing to downgrade stable' >&2; exit 1; }
fi
NEXT="$ROOT/releases/.stable-$STAGE_ID"
ln -s "$VERSION" "$NEXT"
mv -Tf "$NEXT" "$ROOT/releases/stable"
