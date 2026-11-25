#!/usr/bin/env bash
#
# Print the JSON update manifest a self-distributed (unlisted) add-on uses to
# keep itself updated. Host the output next to the signed XPI, point the add-on
# at it with UPDATE_URL, done.
#
#   ./tools/mkupdates.sh dist/automaticdark-2.0.0.xpi https://example.com/addons/
#
# The XPI must be the SIGNED one returned by addons.mozilla.org — its bytes, and
# therefore the hash below, differ from the unsigned build.

set -euo pipefail
cd "$(dirname "$0")/.."

XPI="${1:-}"
BASE_URL="${2:-}"

if [[ -z "$XPI" || -z "$BASE_URL" ]]; then
    echo "usage: $0 <signed.xpi> <base-url-of-the-xpi>" >&2
    exit 1
fi

if [[ ! -f "$XPI" ]]; then
    echo "error: no such file: $XPI" >&2
    exit 1
fi

BASE_URL="${BASE_URL%/}/"
FILE=$(basename "$XPI")
VERSION=$(python3 - "$XPI" <<'PYTHON'
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.loads(archive.read("manifest.json"))["version"])
PYTHON
)
ID=$(python3 - "$XPI" <<'PYTHON'
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.loads(archive.read("manifest.json"))
          ["browser_specific_settings"]["gecko"]["id"])
PYTHON
)
HASH=$(shasum -a 256 "$XPI" | cut -d' ' -f1)
MIN=$(python3 - "$XPI" <<'PYTHON'
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    gecko = json.loads(archive.read("manifest.json"))["browser_specific_settings"]["gecko"]
    print(gecko.get("strict_min_version", "140.0"))
PYTHON
)

cat <<JSON
{
  "addons": {
    "${ID}": {
      "updates": [
        {
          "version": "${VERSION}",
          "update_link": "${BASE_URL}${FILE}",
          "update_hash": "sha256:${HASH}",
          "applications": {
            "gecko": {
              "strict_min_version": "${MIN}"
            }
          }
        }
      ]
    }
  }
}
JSON
