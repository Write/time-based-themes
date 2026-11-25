#!/usr/bin/env bash
#
# Write the update manifest this self-distributed build polls. The packaged
# manifest points at it through browser_specific_settings.gecko.update_url
# (build.sh), and Firefox fetches it from the default branch of this repository:
#
#   https://git.drop.tf/Gliglue/time-based-themes/raw/branch/master/updates.json
#
#   ./tools/mkupdates.sh                     # version + release link only
#   ./tools/mkupdates.sh signed.xpi          # also records the sha256 of the xpi
#
# Run it *after* addons.mozilla.org has signed the release, and pass the file
# Mozilla returned: a Firefox release build refuses an unsigned .xpi and would
# skip the update silently. update_hash is optional to Firefox, but it is what
# makes a corrupted download fail loudly instead of installing.
#
# The link points at a release asset rather than a raw branch URL: the asset
# keeps its URL when the branch moves, and it is the exact file Mozilla signed.

set -euo pipefail
cd "$(dirname "$0")/.."

REPO_URL="https://git.drop.tf/Gliglue/time-based-themes"
XPI="${1:-}"

if [[ -n "$XPI" && ! -f "$XPI" ]]; then
    echo "error: no such file: $XPI" >&2
    exit 1
fi

VERSION=$(node -p "require('./manifest.json').version")
# Same basename build.sh gives the package: no spaces, lowercase.
NAME="automaticdark"
ID=$(node -p "require('./manifest.json').browser_specific_settings.gecko.id")
MIN=$(node -p "require('./manifest.json').browser_specific_settings.gecko.strict_min_version")
LINK="${REPO_URL}/releases/download/v${VERSION}/${NAME}-${VERSION}.xpi"

HASH=""
if [[ -n "$XPI" ]]; then
    HASH=$(shasum -a 256 "$XPI" | cut -d' ' -f1)
fi

python3 - "$ID" "$VERSION" "$LINK" "$MIN" "$HASH" <<'PYTHON'
import json, sys

addon_id, version, link, min_version, digest = sys.argv[1:6]
update = {"version": version, "update_link": link}
if digest:
    update["update_hash"] = f"sha256:{digest}"
update["applications"] = {"gecko": {"strict_min_version": min_version}}
body = json.dumps({"addons": {addon_id: {"updates": [update]}}}, indent=2) + "\n"

# The repository root is what Firefox fetches; dist/ is a copy to hand out with
# the release assets.
written = []
for path in ("updates.json", "dist/updates.json"):
    with open(path, "w") as handle:
        handle.write(body)
    written.append(path)
print("\n".join(written))
print(
    "update_hash recorded from the signed xpi"
    if digest
    else "no xpi given: update_hash omitted, pass the signed .xpi to record it"
)
PYTHON
