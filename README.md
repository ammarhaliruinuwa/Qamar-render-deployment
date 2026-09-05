# Qamar Hair AI Agent — n8n Docker Deployment

## What this does
This Dockerfile builds on the official n8n image and automatically imports
`qamar-hair-agent.json` every time the container starts, so you don't have
to manually re-import the workflow after every redeploy.

## Deploy steps

### 1. Push this folder to a GitHub repo
- Create a new repo on GitHub (e.g. `qamar-hair-n8n`)
- Upload these 3 files: `Dockerfile`, `entrypoint.sh`, `qamar-hair-agent.json`
- Commit and push

### 2. Connect the repo to Render
- Render Dashboard -> New -> Web Service
- Choose "Build and deploy from a Git repository"
- Select your new repo
- Environment: Render will auto-detect the Dockerfile

### 3. Set environment variables in Render
- N8N_HOST = your-app-name.onrender.com
- N8N_PORT = 5678
- N8N_PROTOCOL = https
- WEBHOOK_URL = https://your-app-name.onrender.com/
- N8N_ENCRYPTION_KEY = (any long random string - save this somewhere safe)
- PORT = 5678

### 4. Add a Persistent Disk (Render dashboard -> your service -> Disks)
Without this, credentials you enter and execution history will be wiped
on every redeploy or restart. Mount path: /home/node/.n8n

### 5. Deploy
Render will build the Docker image and start the container. Watch the
Logs tab - you should see "Importing workflow..." followed by n8n's
normal startup logs.

### 6. Open the n8n UI, then:
- Finish first-time owner account setup (if new instance)
- Re-enter credentials: Supabase, WhatsApp account, OpenAI
- Open "Verify Token Match?" node, set your chosen verify token
- Activate the workflow

### 7. Meta Portal
- Callback URL: https://your-app-name.onrender.com/webhook/whatsapp-webhook
- Verify Token: same string as step 6

### Note on the free-tier sleep issue
Docker does NOT fix Render's free-tier auto-sleep after 15 min inactivity.
Set up a free keep-alive cron (cron-job.org or UptimeRobot) pinging your
URL every 5-10 minutes to prevent this.
