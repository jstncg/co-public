#!/bin/bash
# tenant_snapshot.sh <tenant> — stage one member's world as a zip on the Desktop.
#
# The trio that IS a member's relationship with co:
#   claims_<t>.db              what co believes (graph: claims/episodes/watches)
#   claims_<t>.db.co_memory.db what co has done (sends, callbacks)
#   ~/.co_<t>_sendblue_transcript.json   what was said (verbatim, both directions)
#
# Proper `sqlite3 .backup` snapshots — never raw copies of live databases.
# For handing a member THEIR OWN data (dev testing, portability). Cross-tenant
# export is not a thing this script enables: one tenant per run, named output.
set -euo pipefail
T="${1:?usage: tenant_snapshot.sh <tenant>  (e.g. p16474013399)}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DB="$HERE/claims/claims_${T}.db"
[ -f "$DB" ] || { echo "no such tenant db: $DB" >&2; exit 1; }
STAMP=$(date +%Y%m%d-%H%M)
WORK=$(mktemp -d)
OUT="$HOME/Desktop/${T}-snapshot-${STAMP}.zip"
sqlite3 "$DB" ".backup '$WORK/claims_${T}.db'"
[ -f "$DB.co_memory.db" ] && sqlite3 "$DB.co_memory.db" ".backup '$WORK/claims_${T}.db.co_memory.db'"
cp "$HOME/.co_${T}_sendblue_transcript.json" "$WORK/" 2>/dev/null || true
(cd "$WORK" && zip -qr "$OUT" .)
rm -rf "$WORK"
echo "staged: $OUT ($(du -h "$OUT" | cut -f1)) — AirDrop/iMessage it; it's a snapshot, stale on arrival"
