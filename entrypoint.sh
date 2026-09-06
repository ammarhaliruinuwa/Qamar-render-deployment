#!/bin/sh
set -e

# Render exposes the public web-service port through PORT (normally 10000).
# n8n must listen on all interfaces so Render's proxy can reach it.
export N8N_LISTEN_ADDRESS="0.0.0.0"
export N8N_PORT="${PORT:-10000}"

# Keep the Free Render instance lightweight. The Python task runner is not
# required by the Qamar workflow and can consume additional memory.
export N8N_RUNNERS_ENABLED="false"
export N8N_DIAGNOSTICS_ENABLED="false"
export N8N_PERSONALIZATION_ENABLED="false"

WORKFLOW_FILE="/workflows/qamar-hair-agent.json"

if [ -f "$WORKFLOW_FILE" ]; then
  echo "Importing Qamar workflow..."
  n8n import:workflow --input="$WORKFLOW_FILE" || {
    echo "WARNING: workflow import failed; starting n8n so the startup error can be inspected."
  }
else
  echo "WARNING: $WORKFLOW_FILE not found; starting n8n without workflow import."
fi

echo "Starting n8n on ${N8N_LISTEN_ADDRESS}:${N8N_PORT}..."
exec n8n start
