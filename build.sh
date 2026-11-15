#!/bin/bash
# Build the Slackware package and stamp version + MD5 into borg-backup.plg.
#
#   ./build.sh            -> version = today (YYYY.MM.DD)
#   ./build.sh 2026.11.15a
set -euo pipefail
cd "$(dirname "$0")"

NAME=borg-backup
VERSION="${1:-$(date +%Y.%m.%d)}"
OUT="archive/${NAME}-${VERSION}-x86_64-1.txz"
mkdir -p archive

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/bb-build.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -R source/. "$STAGE/"
find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name '.claude' -type d -prune -exec rm -rf {} +
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
chmod 755 "$STAGE/usr/local/emhttp/plugins/$NAME/include/runner.php"
# the installer compares this with the .plg version to detect a failed upgradepkg
printf '%s\n' "$VERSION" > "$STAGE/usr/local/emhttp/plugins/$NAME/VERSION"
chmod 644 "$STAGE/usr/local/emhttp/plugins/$NAME/VERSION"

rm -f "$OUT"
if tar --version 2>/dev/null | grep -q bsdtar; then
  (cd "$STAGE" && COPYFILE_DISABLE=1 tar --uid 0 --gid 0 --uname root --gname root --no-xattrs -cJf - usr) > "$OUT"
else
  (cd "$STAGE" && tar --owner=root --group=root -cJf - usr) > "$OUT"
fi

if command -v md5sum >/dev/null; then MD5=$(md5sum "$OUT" | awk '{print $1}'); else MD5=$(md5 -q "$OUT"); fi

# update the version and checksum entities in place
sed -i.bak -E \
  -e "s|(<!ENTITY version +\")[^\"]*\"|\1${VERSION}\"|" \
  -e "s|(<!ENTITY pkgMD5 +\")[^\"]*\"|\1${MD5}\"|" \
  "${NAME}.plg"
rm -f "${NAME}.plg.bak"

echo "Built $OUT"
echo "  version: $VERSION"
echo "  md5:     $MD5"
echo "Commit archive/ and ${NAME}.plg, then install from:"
echo "  https://raw.githubusercontent.com/macmillernz/borg-backup/main/${NAME}.plg"
