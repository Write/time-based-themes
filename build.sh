#!/usr/bin/env bash
#
# Build the extension package.
#
#   ./build.sh              # run the tests, lint, then build
#   ./build.sh --fast       # skip the tests and the lint
#
# Set UPDATE_URL to point the package at a self-hosted update manifest, which is
# what a self-distributed add-on uses to auto-update:
#
#   UPDATE_URL=https://example.com/addons/updates.json ./build.sh
#
# Produces dist/automaticdark-<version>.zip (what you upload to addons.mozilla.org
# for signing) and dist/automaticdark-<version>.xpi (the same bytes under an
# extension name, ready to hand out once signed).
#
# Build artefacts live outside the Nextcloud-synced tree: dist/ is a symlink to
# ~/dev/_noupload/time-based-themes/dist.

set -euo pipefail
cd "$(dirname "$0")"

FAST=0
if [[ "${1:-}" == "--fast" ]]; then
    FAST=1
fi

VERSION=$(node -p "require('./manifest.json').version")
NAME="automaticdark-${VERSION}"
DIST="dist"
STAGE="${DIST}/stage"

if [[ ! -e "$DIST" ]]; then
    mkdir -p "$HOME/dev/_noupload/time-based-themes/dist"
    ln -sfn ../_noupload/time-based-themes/dist "$DIST"
fi

if [[ ! -d "$DIST" ]]; then
    echo "error: $DIST is not a directory (broken symlink?)" >&2
    exit 1
fi

if [[ $FAST -eq 0 ]]; then
    echo "==> tests"
    node --test test/ >/dev/null || {
        node --test test/ 2>&1 | tail -30
        exit 1
    }
fi

echo "==> staging ${NAME}"
rm -rf "${DIST:?}/${STAGE#dist/}" 2>/dev/null || true
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Only runtime files are packaged: tests, docs and the build script itself stay
# out of the XPI.
for item in manifest.json js css html img lib LICENSE PRIVACY.md; do
    cp -R "$item" "$STAGE/"
done

find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name '*.map' -delete

if [[ -n "${UPDATE_URL:-}" ]]; then
    echo "==> update_url ${UPDATE_URL}"
    python3 - "$STAGE/manifest.json" "$UPDATE_URL" <<'PYTHON'
import json, sys
path, url = sys.argv[1], sys.argv[2]
with open(path) as handle:
    manifest = json.load(handle)
manifest["browser_specific_settings"]["gecko"]["update_url"] = url
with open(path, "w") as handle:
    json.dump(manifest, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
PYTHON
fi

if [[ $FAST -eq 0 ]]; then
    echo "==> web-ext lint"
    if ! web-ext lint --source-dir "$STAGE" --output text > "${STAGE}/../lint.txt" 2>&1; then
        cat "${STAGE}/../lint.txt"
        echo "error: lint failed" >&2
        exit 1
    fi
    tail -4 "${STAGE}/../lint.txt"
    rm -f "${STAGE}/../lint.txt"
fi

echo "==> packing"
rm -f "${DIST}/${NAME}.xpi" "${DIST}/${NAME}.zip"
(cd "$STAGE" && zip -qr "../${NAME}.xpi" .)
cp "${DIST}/${NAME}.xpi" "${DIST}/${NAME}.zip"
rm -rf "$STAGE"

SIZE=$(wc -c < "${DIST}/${NAME}.xpi" | tr -d ' ')
HASH=$(shasum -a 256 "${DIST}/${NAME}.xpi" | cut -d' ' -f1)

echo
echo "dist/${NAME}.xpi   ${SIZE} bytes"
echo "sha256            ${HASH}"
echo
echo "Next: upload dist/${NAME}.zip to https://addons.mozilla.org/developers/"
echo "(self-distribution / 'on your own'), then keep the signed XPI it returns."
echo "Signed add-ons are required: unsigned XBIs cannot be installed permanently."
