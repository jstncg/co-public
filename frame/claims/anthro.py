#!/usr/bin/env python3
"""The Anthropic async client factory — the co-native replacement for the Donna bridge's donna_warm.
As of 8/5 every claims organ uses THIS and the bridge is out of the repo, so the product tree (claims/,
the router, the crons) has zero dependency on the founder-stack bridge. OAuth token first (Claude Code
subscription), ANTHROPIC_API_KEY fallback. Import: `from anthro import make_client`."""
import os

from anthropic import AsyncAnthropic


def make_client():
    tok = os.getenv("CLAUDE_CODE_OAUTH_TOKEN", "")
    if tok:
        return AsyncAnthropic(auth_token=tok, default_headers={"anthropic-beta": "oauth-2025-04-20"})
    return AsyncAnthropic()  # ANTHROPIC_API_KEY fallback
