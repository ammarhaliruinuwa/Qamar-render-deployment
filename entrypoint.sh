#!/bin/sh
set -e

WORKFLOW_FILE="/workflows/qamar-hair-agent.json"

if [ -f "$WORKFLOW_FILE" ]; then
  echo "Importing workflow..."
  n8n import:workflow --input="$WORKFLOW_FILE" || {
    echo "Workflow import failed. Continuing with n8n startup so logs can be inspected."
  }
else
  echo "WARNING: $WORKFLOW_FILE not found; starting n8n without workflow import."
fi

echo "Starting n8n..."
exec n8n start
