FROM n8nio/n8n:latest

# Bring in your workflow file
COPY qamar-hair-agent.json /workflows/qamar-hair-agent.json

# Custom entrypoint: import the workflow, then start n8n normally
COPY entrypoint.sh /entrypoint.sh
USER root
RUN chmod +x /entrypoint.sh
USER node

ENTRYPOINT ["/entrypoint.sh"]
