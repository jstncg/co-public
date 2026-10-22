#!/bin/bash
# co receiver watchdog — restarts the ingest receiver if :3010 is dead (cron, every minute)
if ! /usr/sbin/lsof -iTCP:3010 -sTCP:LISTEN -t >/dev/null 2>&1; then
  /usr/bin/nohup /bin/bash /Users/main/Projects/Secretary/Secretary-Production/projects/co-ingest/run-receiver.sh >> /Users/main/.donna/homebase/co-ingest.log 2>&1 &
fi
