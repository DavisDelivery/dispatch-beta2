#!/bin/bash
# Sync prod-mirror/ from the production dispatch-map app — the 1:1 UAT mirror.
#
# The mirror is a byte-for-byte copy of davis-nuvizz/dispatch-map (UI + functions).
# It points at UAT purely through ENVIRONMENT on its Netlify site (dd-dispatch-map-uat):
#   NUVIZZ_BASE_URL=https://uat.nuvizz.com/deliverit/openapi/v7, company DAVISV5,
#   FIRESTORE_DATABASE=uat-mirror (+ VITE_FIRESTORE_DATABASE) — NO code fork, ever.
# If you find yourself editing prod-mirror/ directly, stop: change davis-nuvizz and re-sync.
#
# Usage:  ./scripts/sync-prod-mirror.sh          (sync from the sibling checkout)
#         SRC=/path/to/davis-nuvizz ./scripts/sync-prod-mirror.sh
# Then:   git add prod-mirror && git commit, and deploy (see prod-mirror/MIRROR-README.md).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SRC:-$HERE/../davis-nuvizz}/dispatch-map"
if [ ! -f "$SRC/package.json" ]; then echo "source not found: $SRC" >&2; exit 1; fi
SHA=$(git -C "$SRC/.." rev-parse --short HEAD 2>/dev/null || echo unknown)
rsync -a --delete --exclude node_modules --exclude dist --exclude .netlify "$SRC/" "$HERE/prod-mirror/"
echo "synced prod-mirror from davis-nuvizz@$SHA"
echo "next: (cd prod-mirror && npm ci && npm test && npm run build), commit, then deploy:"
echo "      cd prod-mirror && netlify deploy --prod --site dd-dispatch-map-uat"
