# Pin n8n instead of using latest so a future release cannot unexpectedly break the free Render deployment.
FROM n8nio/n8n:2.27.0

EXPOSE 10000
ENV NODE_OPTIONS="--max-old-space-size=384"

# Production Qamar workflows. WPPConnect pairing is intentionally not imported.
COPY qamar-hair-agent.json /workflows/qamar-hair-agent.json
COPY qamar-delivery-monitor.json /workflows/qamar-delivery-monitor.json

COPY entrypoint.sh /entrypoint.sh
USER root
RUN chmod +x /entrypoint.sh
USER node
ENTRYPOINT ["/entrypoint.sh"]
