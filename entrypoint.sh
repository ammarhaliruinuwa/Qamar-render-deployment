#!/bin/sh
set -e

export N8N_LISTEN_ADDRESS="0.0.0.0"
export N8N_PORT="${PORT:-10000}"
export N8N_RUNNERS_ENABLED="false"
export N8N_DIAGNOSTICS_ENABLED="false"
export N8N_PERSONALIZATION_ENABLED="false"

import_and_publish() {
  FILE="$1"
  ID="$2"
  if [ -f "$FILE" ]; then
    echo "Importing $FILE ..."
    PREPARED="/tmp/$(basename "$FILE")"
    cp "$FILE" "$PREPARED"
    sed -i 's/"typeVersion": 4.5/"typeVersion": 4.2/g' "$PREPARED"
    n8n import:workflow --input="$PREPARED"
    if [ -n "$ID" ]; then
      echo "Publishing workflow $ID ..."
      n8n publish:workflow --id="$ID" || echo "Publish skipped/failed for $ID; n8n will still start."
    fi
  else
    echo "WARNING: $FILE not found."
  fi
}

import_and_publish /workflows/qamar-hair-agent.json ArQMxMULBvyMgPDd
import_and_publish /workflows/qamar-delivery-monitor.json QamarDeliveryMonitorV1

echo "Starting n8n on ${N8N_LISTEN_ADDRESS}:${N8N_PORT}..."
exec n8n start
