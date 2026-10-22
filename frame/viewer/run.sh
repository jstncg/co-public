#!/bin/sh
# co memory viewer — starts the read-only server and prints per-tenant URLs.
#   ./run.sh            start (foreground)
#   ./run.sh --print    just print the tenant URLs and exit
cd "$(dirname "$0")" || exit 1
exec /usr/bin/env python3 serve.py "$@"
