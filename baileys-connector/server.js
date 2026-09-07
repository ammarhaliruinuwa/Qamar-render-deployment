import express from 'express'
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, useMultiFileAuthState } from 'baileys'
import pino from 'pino'
import fs from 'node:fs'

const app = express()
app.use(express.json())
const PORT = Number(process.env.PORT || 10000)
const API_KEY = process.env.PAIRING_API_KEY || ''
const AUTH_DIR = process.env.AUTH_DIR || './auth_session'
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || ''
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

let sock = null
let connectionState = 'starting'
let pendingPhone = null
let pendingResolve = null
let pendingReject = null
let lastPairingCode = null
let reconnecting = false

function authorized(req) {
  return !API_KEY || req.headers['x-api-key'] === API_KEY
}

async function notifyN8N(event) {
  if (!N8N_WEBHOOK_URL) return
  try {
    await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event)
    })
  } catch (err) {
    logger.warn({ err: String(err) }, 'n8n webhook notification failed')
  }
}

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.ubuntu('Qamar'),
    printQRInTerminal: false,
    logger
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    connectionState = connection || connectionState

    if (qr && pendingPhone && !sock.authState.creds.registered && !lastPairingCode) {
      try {
        const phone = pendingPhone.replace(/[^0-9]/g, '')
        if (!phone) throw new Error('Phone number must contain digits and country code')
        lastPairingCode = await sock.requestPairingCode(phone)
        const code = lastPairingCode
        logger.info({ code }, 'Qamar pairing code generated')
        await notifyN8N({ type: 'PAIRING_CODE_GENERATED', phone, code })
        pendingResolve?.({ code })
      } catch (err) {
        pendingReject?.(err)
      } finally {
        pendingPhone = null
        pendingResolve = null
        pendingReject = null
      }
    }

    if (connection === 'open') {
      lastPairingCode = null
      logger.info({ user: sock.user?.id }, 'Qamar WhatsApp connected')
      await notifyN8N({ type: 'WHATSAPP_CONNECTED', user: sock.user?.id || null })
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode
      logger.warn({ status }, 'Qamar WhatsApp connection closed')
      connectionState = 'closed'
      lastPairingCode = null
      if (status !== DisconnectReason.loggedOut && !reconnecting) {
        reconnecting = true
        setTimeout(async () => {
          reconnecting = false
          try { await startSocket() } catch (err) { logger.error({ err: String(err) }, 'reconnect failed') }
        }, 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
      await notifyN8N({
        type: 'WHATSAPP_MESSAGE',
        from: msg.key.remoteJid,
        messageId: msg.key.id,
        text,
        timestamp: msg.messageTimestamp || null
      })
    }
  })
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'qamar-baileys', connection: connectionState, connected: !!sock?.user, paired: !!sock?.authState?.creds?.registered })
})

app.get('/status', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
  res.json({ connection: connectionState, connected: !!sock?.user, paired: !!sock?.authState?.creds?.registered, user: sock?.user?.id || null })
})

app.post('/pair', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
  if (sock?.authState?.creds?.registered) return res.status(409).json({ error: 'WhatsApp is already paired', user: sock.user?.id || null })
  if (pendingPhone) return res.status(409).json({ error: 'A pairing request is already pending' })

  const phone = String(req.body?.phone || '').replace(/[^0-9]/g, '')
  if (!phone) return res.status(400).json({ error: 'Provide phone with country code, digits only' })

  pendingPhone = phone
  const result = await new Promise((resolve, reject) => {
    pendingResolve = resolve
    pendingReject = reject
    setTimeout(() => reject(new Error('Timed out waiting for WhatsApp pairing window')), 30000)
  }).catch(err => ({ error: err.message }))

  if (result.error) return res.status(504).json(result)
  res.json({ ok: true, phone, pairingCode: result.code, next: 'WhatsApp → Linked Devices → Link with phone number' })
})

app.post('/send', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
  if (!sock?.user) return res.status(409).json({ error: 'WhatsApp is not connected' })
  const to = String(req.body?.to || '').replace(/[^0-9]/g, '')
  const text = String(req.body?.text || '')
  if (!to || !text) return res.status(400).json({ error: 'Provide to and text' })
  const jid = `${to}@s.whatsapp.net`
  const sent = await sock.sendMessage(jid, { text })
  res.json({ ok: true, id: sent?.key?.id || null })
})

app.listen(PORT, '0.0.0.0', async () => {
  logger.info({ port: PORT }, 'Qamar Baileys connector listening')
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  try { await startSocket() } catch (err) { logger.error({ err: String(err) }, 'initial WhatsApp socket failed') }
})
