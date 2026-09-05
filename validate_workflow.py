#!/usr/bin/env python3
import json
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "qamar-hair-agent.json")

if not path.exists():
    print(f"ERROR: workflow file not found: {path}")
    raise SystemExit(1)

try:
    data = json.loads(path.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    print(f"ERROR: invalid JSON: {exc}")
    raise SystemExit(1)

if not isinstance(data, dict):
    print("ERROR: workflow root must be a JSON object")
    raise SystemExit(1)

nodes = data.get("nodes")
connections = data.get("connections")

if not isinstance(nodes, list) or not nodes:
    print("ERROR: workflow must contain a non-empty 'nodes' array")
    raise SystemExit(1)

if not isinstance(connections, dict):
    print("ERROR: workflow must contain a 'connections' object")
    raise SystemExit(1)

node_names = [n.get("name") for n in nodes if isinstance(n, dict)]
missing_names = [i for i, name in enumerate(node_names) if not name]
if missing_names:
    print(f"ERROR: nodes without names at indexes: {missing_names}")
    raise SystemExit(1)

print(f"OK: valid JSON workflow with {len(nodes)} nodes and {len(connections)} connection entries")
