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
let pairingInProgress = false
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
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    logger
  })

  sock.ev.on('creds.update', saveCreds)

  // Pairing-code authentication is requested directly from the socket.
  // It must not depend on a QR event; pairing code and QR are separate flows.
  if (!state.creds.registered && process.env.AUTO_PAIRING_PHONE) {
    const phone = String(process.env.AUTO_PAIRING_PHONE).replace(/\D/g, '')
    if (phone) {
      try {
        pairingInProgress = true
        const code = await sock.requestPairingCode(phone)
        lastPairingCode = code
        logger.info({ phone, code }, 'Qamar pairing code generated')
        await notifyN8N({ type: 'PAIRING_CODE_GENERATED', phone, code })
      } catch (err) {
        logger.error({ err: String(err) }, 'automatic pairing code generation failed')
      } finally {
        pairingInProgress = false
      }
    }
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    connectionState = connection || connectionState

    if (connection === 'open') {
      lastPairingCode = null
      pairingInProgress = false
      logger.info({ user: sock.user?.id }, 'Qamar WhatsApp connected')
      await notifyN8N({ type: 'WHATSAPP_CONNECTED', user: sock.user?.id || null })
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode
      logger.warn({ status }, 'Qamar WhatsApp connection closed')
      connectionState = 'closed'
      lastPairingCode = null
      pairingInProgress = false
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
  res.json({
    ok: true,
    service: 'qamar-baileys',
    connection: connectionState,
    connected: !!sock?.user,
    paired: !!sock?.authState?.creds?.registered,
    pairingReady: !sock?.authState?.creds?.registered && !!sock
  })
})

app.get('/status', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
  res.json({
    connection: connectionState,
    connected: !!sock?.user,
    paired: !!sock?.authState?.creds?.registered,
    pairingInProgress,
    pairingCodeAvailable: !!lastPairingCode,
    user: sock?.user?.id || null
  })
})

app.post('/pair', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
  if (!sock) return res.status(503).json({ error: 'WhatsApp socket is not ready' })
  if (sock?.authState?.creds?.registered) return res.status(409).json({ error: 'WhatsApp is already paired', user: sock.user?.id || null })
  if (pairingInProgress) return res.status(409).json({ error: 'A pairing request is already pending' })

  const phone = String(req.body?.phone || '').replace(/\D/g, '')
  if (!phone) return res.status(400).json({ error: 'Provide phone with country code, digits only' })

  try {
    pairingInProgress = true
    const code = await sock.requestPairingCode(phone)
    lastPairingCode = code
    await notifyN8N({ type: 'PAIRING_CODE_GENERATED', phone, code })
    res.json({ ok: true, phone, pairingCode: code, next: 'WhatsApp → Linked Devices → Link with phone number' })
  } catch (err) {
    logger.error({ err: String(err) }, 'pairing code generation failed')
    res.status(502).json({ error: String(err?.message || err) })
  } finally {
    pairingInProgress = false
  }
})

app.post('/send', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
  if (!sock?.user) return res.status(409).json({ error: 'WhatsApp is not connected' })
  const to = String(req.body?.to || '').replace(/\D/g, '')
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
