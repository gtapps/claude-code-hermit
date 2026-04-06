#!/usr/bin/env python3
"""Print current session cost from .status.json. Exits silently on any error."""
import json, sys

path = sys.argv[1] if len(sys.argv) > 1 else ".claude-code-hermit/sessions/.status.json"
try:
    with open(path) as f:
        d = json.load(f)
    print(f"${d['cost_usd']:.4f} ({round(d['tokens'] / 1000)}K tokens)")
except Exception:
    print("No cost data")
