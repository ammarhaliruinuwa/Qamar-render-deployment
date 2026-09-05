FROM n8nio/n8n:latest

# Render routes web traffic to the container's HTTP port.
# n8n is configured below to listen on 0.0.0.0:10000.
EXPOSE 10000

# Bring in the Qamar workflow for first-start import.
COPY qamar-hair-agent.json /workflows/qamar-hair-agent.json

# Start n8n with Render-compatible host/port settings and import the workflow.
COPY entrypoint.sh /entrypoint.sh
USER root
RUN chmod +x /entrypoint.sh
USER node

ENTRYPOINT ["/entrypoint.sh"]
