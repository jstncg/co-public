#!/bin/bash
# Compatibility fallback for machines that have not installed the dedicated launch agent yet
# An atomic directory lock prevents the router and watchdog from launching two brains together
set -u

# 9/6: the runtime (com.co.runtime-live) owns 8090 and serves the founder's live conversation.
# This script starts frame/brain. If it ran while the runtime was briefly down it would take the
# port, the router would silently talk to the wrong brain, and the member would get a different
# mind carrying none of the migrated history. launchd already keeps the runtime alive
# (KeepAlive=true), so this watchdog has no job while the runtime is installed. Refuse to run.
if [ -f "$HOME/Library/LaunchAgents/com.co.runtime-live.plist" ]; then
  exit 0
fi

if /usr/bin/nc -z 127.0.0.1 8090 2>/dev/null; then
  exit 0
fi

LOCK_DIR="${HOME}/.co/engine-start.lock"
/bin/mkdir -p "${HOME}/.co"
if ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap '/bin/rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Another caller may have completed startup while this caller acquired the lock
if /usr/bin/nc -z 127.0.0.1 8090 2>/dev/null; then
  exit 0
fi

cd /Users/main/Projects/Secretary/Secretary-Production/projects/co/frame/brain
/usr/bin/nohup /bin/bash ./run.sh >> "${HOME}/.co/engine.log" 2>&1 &

# Keep the lock until the child is listening so a concurrent caller cannot race it
for _ in 1 2 3 4 5 6 7 8 9 10; do
  /usr/bin/nc -z 127.0.0.1 8090 2>/dev/null && exit 0
  /bin/sleep 1
done
exit 1
