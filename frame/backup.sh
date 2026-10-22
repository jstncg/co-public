#!/bin/bash
# nightly encrypted backup of THE DATA (system-review #6): code is on GitHub; the corpus, claims,
# watches, archive, and transcripts — the memory — were single-copy. AES-256, passphrase in
# frame/.env, 14-day retention, written to iCloud Drive (offsite-ish) + local.
set -e
set -a; source /Users/main/Projects/Secretary/Secretary-Production/projects/co/frame/.env 2>/dev/null || true; set +a
[ -z "$BACKUP_PASSPHRASE" ] && { echo "no passphrase"; exit 1; }
STAMP=$(date +%Y%m%d)
WORK=$(mktemp -d); export WORK
# consistent sqlite snapshots for EVERY tenant, then the flat files. Until 8/9 this
# backed up ONLY the founder's claims.db and transcript — every member's graph, deeds
# and conversation was single-copy (audit find; the founder's own TODAY list). No
# member-classification logic on purpose: a backup that filters is a backup that
# loses someone someday. Fixtures cost KBs.
python3 - <<'PYEOF'
import sqlite3, glob, os, shutil
CLAIMS = '/Users/main/Projects/Secretary/Secretary-Production/projects/co/frame/claims'
WORK = os.environ['WORK']
os.makedirs(f'{WORK}/claims', exist_ok=True)
for db in glob.glob(f'{CLAIMS}/claims*.db') + glob.glob(f'{CLAIMS}/claims*.db.co_memory.db'):
    try:
        src = sqlite3.connect(db); dst = sqlite3.connect(f'{WORK}/claims/{os.path.basename(db)}')
        src.backup(dst); dst.close(); src.close()
    except Exception as e:
        print(f'WARN snapshot {os.path.basename(db)}: {e}')
for side in glob.glob(f'{CLAIMS}/claims*.db.*.json'):        # anchors, muse, wake, threads…
    try: shutil.copy(side, f'{WORK}/claims/')
    except OSError: pass
for tr in glob.glob(os.path.expanduser('~/.co_*_sendblue_transcript.json')):
    try: shutil.copy(tr, WORK)
    except OSError: pass
PYEOF
cp -r ~/.co/journal "$WORK/journal" 2>/dev/null || true
cp ~/.co/co_dualwrite_archive.jsonl ~/.co/outbound_status_log.jsonl "$WORK/" 2>/dev/null || true
# docs/ went gitignored 8/4 — the mind is single-copy without this line
cp -r /Users/main/Projects/Secretary/Secretary-Production/projects/co/docs "$WORK/docs" 2>/dev/null || true
# .agents/ went gitignored 8/5 — same single-copy risk as docs/
cp -r /Users/main/Projects/Secretary/Secretary-Production/projects/co/.agents "$WORK/agents" 2>/dev/null || true

# THE LIVE HARNESS (9/6). The runtime took over the founder's line on 9/6 and is UNTRACKED in git,
# so until a checkpoint commit lands this directory is the only copy of the code answering his
# messages. node_modules is excluded — it is 200MB of reinstallable dependency, and the lockfile
# that pins it is inside the copy.
RUNTIME_SRC=/Users/main/Projects/Secretary/Secretary-Production/projects/co/packages/runtime
if [ -d "$RUNTIME_SRC" ]; then
  mkdir -p "$WORK/runtime"
  tar -cf - -C "$RUNTIME_SRC" --exclude=node_modules --exclude=coverage --exclude=.git . \
    | tar -xf - -C "$WORK/runtime" 2>/dev/null || true
  echo "$(date -u +%FT%TZ) runtime source captured ($(du -sh "$WORK/runtime" 2>/dev/null | cut -f1))"
fi

# THE LIVE RUNTIME DATABASE. Never `cp` a database with an open WAL — a plain copy of a live
# SQLite file is a torn read. `.backup` uses the online backup API and checkpoints WAL into the
# copy, which is the only form of this file that restores.
RUNTIME_STATE=$(ls -td /Users/main/.co-runtime-live-* 2>/dev/null | head -1)
if [ -n "${RUNTIME_STATE:-}" ] && [ -f "$RUNTIME_STATE/migration/candidate.sqlite" ]; then
  mkdir -p "$WORK/runtime-state"
  if /usr/bin/sqlite3 "$RUNTIME_STATE/migration/candidate.sqlite" \
      ".backup '$WORK/runtime-state/candidate.sqlite'" 2>/dev/null; then
    echo "$(date -u +%FT%TZ) runtime db captured ($(du -h "$WORK/runtime-state/candidate.sqlite" | cut -f1))"
  else
    echo "$(date -u +%FT%TZ) WARN runtime db backup FAILED — live state is unprotected this cycle"
  fi
fi
DEST_LOCAL=~/Backups/donna; DEST_CLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs/donna-backups"
mkdir -p "$DEST_LOCAL" "$DEST_CLOUD" 2>/dev/null || mkdir -p "$DEST_LOCAL"
echo "$(date -u +%FT%TZ) tar+encrypt start"
tar -czf - -C "$WORK" . | openssl enc -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -out "$DEST_LOCAL/donna-$STAMP.tar.gz.enc"
rm -rf "$WORK"
find "$DEST_LOCAL" -name "donna-*.enc" -mtime +14 -delete 2>/dev/null || true
echo "$(date -u +%FT%TZ) local ok ($(du -h "$DEST_LOCAL/donna-$STAMP.tar.gz.enc" | cut -f1)); cloud phase (bounded)"
# The ENTIRE cloud phase is bounded to 10 minutes and can never hang the job. Since 8/5
# the retention `find` over Mobile Documents blocked on iCloud's dataless files for the
# reconciler's full 5400s and ate a SIGKILL nightly — archives landed, "backup ok" never
# printed, and rc=-9 masked what a REAL failure would look like (found by audit, 8/9).
(
  cp "$DEST_LOCAL/donna-$STAMP.tar.gz.enc" "$DEST_CLOUD/" 2>/dev/null || true
  find "$DEST_CLOUD" -name "donna-*.enc" -mtime +14 -delete 2>/dev/null || true
) & CLOUD_PID=$!
for _ in $(seq 1 120); do kill -0 "$CLOUD_PID" 2>/dev/null || break; sleep 5; done
if kill -0 "$CLOUD_PID" 2>/dev/null; then
  kill -9 "$CLOUD_PID" 2>/dev/null || true
  echo "$(date -u +%FT%TZ) WARN: cloud phase hit the 10min bound (local backup is safe; check iCloud sync)"
fi
echo "$(date -u +%FT%TZ) backup ok: donna-$STAMP.tar.gz.enc ($(du -h "$DEST_LOCAL/donna-$STAMP.tar.gz.enc" | cut -f1))"
