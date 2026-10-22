#!/bin/bash
# co ingest receiver — launchd entry (re-homed to the monorepo 8/4; the old copy ran
# orphaned from projects/co-ingest with launchd pointing at a nonexistent path)
export PATH="/Users/main/.nvm/versions/node/v24.13.0/bin:/usr/bin:/bin"
cd /Users/main/Projects/Secretary/Secretary-Production/projects/co/apps/web
exec node_modules/.bin/next start -p 3010
