import express from 'express'
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from 'baileys'
import pino from 'pino'
import { useSupabaseAuthState } from './supabase-auth-state.js'

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

const PORT = Number(process.env.PORT || 10000)
const API_KEY = process.env.PAIRING_API_KEY || ''
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || ''
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

let sock = null
let connectionState = 'starting'
let pairingInProgress = false
let lastPairingCode = null
let reconnecting = false
let startupError = null

function authorized(req) {
  return !API_KEY || req.headers['x-api-key'] === API_KEY
}

function validApiKey(value) {
  return !API_KEY || value === API_KEY
}

async function notifyN8N(event) {
  if (!N8N_WEBHOOK_URL) {
    logger.warn('N8N_WEBHOOK_URL is not configured')
    return false
  }
  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event)
    })
    const body = await response.text().catch(() => '')
    logger.info({ status: response.status, ok: response.ok, body: body.slice(0, 500) }, 'n8n webhook POST completed')
    return response.ok
  } catch (err) {
    logger.error({ err: String(err) }, 'n8n webhook POST failed')
    return false
  }
}

async function generatePairingCode(phone) {
  if (!sock) throw new Error('WhatsApp socket is not ready')
  if (sock?.authState?.creds?.registered) throw new Error('WhatsApp is already paired')
  if (pairingInProgress) throw new Error('A pairing request is already pending')

  pairingInProgress = true
  try {
    const code = await sock.requestPairingCode(phone)
    lastPairingCode = code
    await notifyN8N({ type: 'PAIRING_CODE_GENERATED', phone, code })
    return code
  } finally {
    pairingInProgress = false
  }
}

function extractMessageText(message) {
  if (!message) return ''
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || message.documentMessage?.caption
    || message.buttonsResponseMessage?.selectedDisplayText
    || message.listResponseMessage?.title
    || message.templateButtonReplyMessage?.selectedDisplayText
    || ''
}

function normalizeInboundMessage(msg) {
  const message = msg.message || {}
  return {
    key: {
      id: msg.key?.id || '',
      remoteJid: msg.key?.remoteJid || '',
      fromMe: !!msg.key?.fromMe
    },
    message,
    messageTimestamp: msg.messageTimestamp || null,
    pushName: msg.pushName || ''
  }
}

async function startSocket() {
  const { state, saveCreds } = await useSupabaseAuthState()
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

  if (!state.creds.registered && process.env.AUTO_PAIRING_PHONE) {
    const phone = String(process.env.AUTO_PAIRING_PHONE).replace(/\D/g, '')
    if (phone) {
      try {
        const code = await generatePairingCode(phone)
        logger.info({ phone, code }, 'Qamar pairing code generated')
      } catch (err) {
        logger.error({ err: String(err) }, 'automatic pairing code generation failed')
      }
    }
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    connectionState = connection || connectionState

    if (connection === 'open') {
      lastPairingCode = null
      pairingInProgress = false
      startupError = null
      logger.info({ user: sock.user?.id }, 'Qamar WhatsApp connected with persistent Supabase auth')
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
          try {
            await startSocket()
          } catch (err) {
            startupError = String(err)
            logger.error({ err: startupError }, 'reconnect failed')
          }
        }, 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    logger.info({ eventType: type, count: messages?.length || 0 }, 'WhatsApp messages.upsert received')
    if (type !== 'notify') return

    for (const rawMsg of messages) {
      if (rawMsg.key?.fromMe || !rawMsg.message) continue

      const msg = normalizeInboundMessage(rawMsg)
      const text = extractMessageText(msg.message)
      const messageType = msg.message?.audioMessage ? 'audio'
        : msg.message?.imageMessage ? 'image'
        : msg.message?.videoMessage ? 'video'
        : msg.message?.documentMessage ? 'document'
        : 'text'

      const from = String(msg.key?.remoteJid || '').replace(/@s\.whatsapp\.net$|@lid$/g, '')
      if (!from || !msg.key?.id) {
        logger.warn({ remoteJid: msg.key?.remoteJid, id: msg.key?.id }, 'Skipping inbound message with missing sender or id')
        continue
      }

      const payload = {
        object: 'whatsapp_baileys',
        entry: [{
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: sock?.user?.id || '' },
              contacts: [{ profile: { name: msg.pushName || '' }, wa_id: from }],
              messages: [{
                from,
                id: msg.key.id,
                timestamp: String(msg.messageTimestamp || Math.floor(Date.now() / 1000)),
                type: messageType,
                ...(messageType === 'text' ? { text: { body: text } } : {}),
                ...(messageType === 'audio' ? { audio: { id: msg.key.id } } : {})
              }]
            }
          }]
        }],
        type: 'WHATSAPP_MESSAGE'
      }

      logger.info({ from, messageId: msg.key.id, messageType, text: text.slice(0, 200) }, 'Forwarding WhatsApp message to n8n')
      const ok = await notifyN8N(payload)
      if (!ok) logger.error({ from, messageId: msg.key.id }, 'Qamar message could not be delivered to n8n')
    }
  })
}

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qamar WhatsApp Pairing</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:20px}input,button{width:100%;box-sizing:border-box;padding:14px;margin:8px 0;font-size:16px}button{cursor:pointer}.card{padding:20px;border:1px solid #ddd;border-radius:14px}.code{font-size:28px;font-weight:700;letter-spacing:4px;text-align:center;margin:20px 0}small{color:#666}</style></head><body><div class="card"><h2>Qamar WhatsApp Pairing</h2><p>Generate a WhatsApp pairing code. Authentication is stored in Supabase so Render redeploys do not erase the session.</p><form method="post" action="/pair-ui"><label>Pairing access key</label><input type="password" name="key" autocomplete="off" required><label>WhatsApp number with country code</label><input type="tel" name="phone" placeholder="2348012345678" inputmode="numeric" required><button type="submit">Generate Pairing Code</button></form><small>Your access key is sent only over HTTPS and is not displayed in the result.</small></div></body></html>`)
})

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'qamar-baileys',
    connection: connectionState,
    connected: !!sock?.user,
    paired: !!sock?.authState?.creds?.registered,
    pairingReady: !sock?.authState?.creds?.registered && !!sock,
    persistence: 'supabase',
    startupError
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
    persistence: 'supabase',
    user: sock?.user?.id || null,
    startupError
  })
})

app.post('/pair-ui', async (req, res) => {
  const key = String(req.body?.key || '')
  if (!validApiKey(key)) return res.status(401).type('html').send('<h3>Unauthorized</h3><p>Invalid pairing access key.</p><p><a href="/">Back</a></p>')
  if (!sock) return res.status(503).type('html').send('<h3>Not ready</h3><p>WhatsApp socket is not ready yet. Refresh and try again.</p><p><a href="/">Back</a></p>')
  if (sock?.authState?.creds?.registered) return res.status(409).type('html').send('<h3>Already paired</h3><p>Qamar WhatsApp is already paired.</p><p><a href="/">Back</a></p>')

  const phone = String(req.body?.phone || '').replace(/\D/g, '')
  if (!phone) return res.status(400).type('html').send('<h3>Invalid number</h3><p>Enter the WhatsApp number with country code, digits only.</p><p><a href="/">Back</a></p>')

  try {
    const code = await generatePairingCode(phone)
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qamar Pairing Code</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:20px}.card{padding:20px;border:1px solid #ddd;border-radius:14px}.code{font-size:34px;font-weight:700;letter-spacing:5px;text-align:center;margin:25px 0}</style></head><body><div class="card"><h2>Qamar pairing code</h2><div class="code">${code}</div><p>On your WhatsApp phone:</p><ol><li>Open <b>Linked Devices</b></li><li>Tap <b>Link a device</b></li><li>Choose <b>Link with phone number instead</b></li><li>Enter the code above</li></ol><p><a href="/">Generate another code</a></p></div></body></html>`)
  } catch (err) {
    logger.error({ err: String(err) }, 'pairing code generation failed from pairing page')
    res.status(502).type('html').send(`<h3>Pairing failed</h3><p>${String(err?.message || err)}</p><p><a href="/">Back</a></p>`)
  }
})

app.post('/pair', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
  if (!sock) return res.status(503).json({ error: 'WhatsApp socket is not ready' })
  if (sock?.authState?.creds?.registered) return res.status(409).json({ error: 'WhatsApp is already paired', user: sock.user?.id || null })

  const phone = String(req.body?.phone || '').replace(/\D/g, '')
  if (!phone) return res.status(400).json({ error: 'Provide phone with country code, digits only' })

  try {
    const code = await generatePairingCode(phone)
    res.json({ ok: true, phone, pairingCode: code, next: 'WhatsApp → Linked Devices → Link with phone number' })
  } catch (err) {
    logger.error({ err: String(err) }, 'pairing code generation failed')
    res.status(502).json({ error: String(err?.message || err) })
  }
})

app.post('/send', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
  if (!sock?.user) return res.status(409).json({ error: 'WhatsApp is not connected' })
  const to = String(req.body?.to || '').replace(/\D/g, '')
  const text = String(req.body?.text || '')
  if (!to || !text) return res.status(400).json({ error: 'Provide to and text' })
  try {
    const sent = await sock.sendMessage(`${to}@s.whatsapp.net`, { text })
    res.json({ ok: true, id: sent?.key?.id || null })
  } catch (err) {
    logger.error({ err: String(err) }, 'WhatsApp send failed')
    res.status(502).json({ error: String(err?.message || err) })
  }
})

app.listen(PORT, '0.0.0.0', async () => {
  logger.info({ port: PORT }, 'Qamar Baileys connector listening')
  try {
    await startSocket()
  } catch (err) {
    startupError = String(err)
    logger.error({ err: startupError }, 'initial WhatsApp socket failed')
  }
})
