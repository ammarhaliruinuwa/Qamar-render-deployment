# Pin n8n instead of using latest so a future release cannot unexpectedly break the free Render deployment.
FROM n8nio/n8n:2.27.0

# Render routes web traffic to the container's HTTP port.
EXPOSE 10000

# Give Node a controlled heap budget that fits the Render Free container better.
ENV NODE_OPTIONS="--max-old-space-size=384"

# Bring in the Qamar workflow for first-start import.
COPY qamar-hair-agent.json /workflows/qamar-hair-agent.json

# Start n8n with Render-compatible host/port settings and import the workflow.
COPY entrypoint.sh /entrypoint.sh
USER root
RUN chmod +x /entrypoint.sh
USER node

ENTRYPOINT ["/entrypoint.sh"]
