#!/usr/bin/env bash
# Every icons/ path in _source must exist in a Foundry install, or the
# compendium shows a broken image. Foundry's icon set is not redistributable,
# so this runs locally against an install rather than in CI.
#
#   tools/check_icons.sh [/path/to/Foundry/app/public]
set -euo pipefail
cd "$(dirname "$0")/.."
PUBLIC="${1:-${FOUNDRY_PUBLIC_DIR:-/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app/public}}"
[ -d "$PUBLIC/icons" ] || { echo "no Foundry icons at $PUBLIC — pass the app's public directory" >&2; exit 2; }

missing=0; n=0
while IFS= read -r p; do
  n=$((n+1))
  if [ ! -f "$PUBLIC/$p" ]; then
    echo "MISSING $p" >&2
    missing=$((missing+1))
  fi
done < <(cat _source/*/*.json | jq -r '.. | objects | (.img // empty), (.texture.src // empty)' | grep '^icons/' | sort -u)

echo "$n distinct core icons referenced, $missing missing"
[ "$missing" -eq 0 ]
