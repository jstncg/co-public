#!/bin/bash
# co ingest receiver — launchd entry (mirrors homebase run.sh pattern)
export PATH="/Users/main/.nvm/versions/node/v24.13.0/bin:/usr/bin:/bin"
cd /Users/main/Projects/Secretary/Secretary-Production/projects/co-ingest/apps/web
exec node_modules/.bin/next start -p 3010
