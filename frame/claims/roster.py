#!/usr/bin/env python3
"""The roster — who a lane is on for (8/28)."""
from __future__ import annotations


def _rostered(tenant: str, lane_var: str) -> bool:
    """ONE ROSTER (8/28). Onboarding a member was surgery across six env vars, two of which I
    added today. CO_MEMBERS is the default for every lane; a lane-specific var still overrides it
    so a single lane can be trialled or held back, but nobody has to be listed six times."""
    import os as _os
    lane = [t.strip() for t in _os.environ.get(lane_var, "").split(",") if t.strip()]
    if lane:
        return tenant in lane
    return tenant in [t.strip() for t in _os.environ.get("CO_MEMBERS", "").split(",") if t.strip()]
