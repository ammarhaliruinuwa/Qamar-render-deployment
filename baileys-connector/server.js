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
let authState = null
let connectionState = 'starting'
let pairingInProgress = false
let lastPairingCode = null
let reconnecting = false
let startupError = null
let socketGeneration = 0

function authorized(req) {
  return !API_KEY || req.headers['x-api-key'] === API_KEY
}

function validApiKey(value) {
  return !API_KEY || value === API_KEY
}

function isPaired() {
  return !!authState?.state?.creds?.registered
}

async function postToN8N(event) {
  if (!N8N_WEBHOOK_URL) {
    logger.warn('N8N_WEBHOOK_URL is not configured')
    return { ok: false, status: 0, body: '', data: null }
  }

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event)
    })

    const body = await response.text().catch(() => '')
    let data = null
    if (body) {
      try { data = JSON.parse(body) } catch { data = null }
    }

    logger.info({ status: response.status, ok: response.ok, body: body.slice(0, 500) }, 'n8n webhook POST completed')
    return { ok: response.ok, status: response.status, body, data }
  } catch (err) {
    logger.error({ err: String(err) }, 'n8n webhook POST failed')
    return { ok: false, status: 0, body: '', data: null }
  }
}

async function notifyN8N(event) {
  const result = await postToN8N(event)
  return result.ok
}

function extractN8NReply(data, rawBody = '') {
  let value = data
  if (Array.isArray(value)) value = value[0] || null

  if (value && typeof value === 'object') {
    const text = value.text ?? value.reply ?? value.message ?? value.output ?? value.response
    if (typeof text === 'string' && text.trim()) return text.trim()
  }

  if (typeof rawBody === 'string' && rawBody.trim()) {
    const plain = rawBody.trim()
    if (!plain.startsWith('{') && !plain.startsWith('[')) return plain
  }

  return ''
}

async function processIncomingMessage(payload, fallbackTo) {
  const result = await postToN8N(payload)

  if (!result.ok) {
    logger.error({ from: fallbackTo, status: result.status, body: result.body.slice(0, 1000) }, 'Qamar message could not be delivered to n8n')
    return
  }

  const replyText = extractN8NReply(result.data, result.body)
  if (!replyText) {
    logger.warn({ from: fallbackTo, body: result.body.slice(0, 1000) }, 'n8n returned no usable reply text')
    return
  }

  const responseData = Array.isArray(result.data) ? (result.data[0] || {}) : (result.data || {})
  const target = String(responseData.to || fallbackTo || '').replace(/\D/g, '')

  if (!target) {
    logger.error({ from: fallbackTo }, 'n8n reply has no valid WhatsApp recipient')
    return
  }

  if (!sock?.user) {
    logger.error({ target }, 'Cannot send n8n reply because WhatsApp is not connected')
    return
  }

  try {
    const sent = await sock.sendMessage(`${target}@s.whatsapp.net`, { text: replyText })
    logger.info({ target, messageId: sent?.key?.id || null, text: replyText.slice(0, 200) }, 'WhatsApp reply sent')
  } catch (err) {
    logger.error({ target, err: String(err) }, 'WhatsApp reply send failed')
  }
}

async function waitForPairingSocketReady(currentSock, timeoutMs = 15000) {
  if (!currentSock) throw new Error('WhatsApp socket is not ready')
  if (isPaired()) return

  await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('WhatsApp socket did not become ready for pairing in time'))
    }, timeoutMs)

    const onUpdate = ({ connection }) => {
      if (settled) return
      if (connection === 'open' || connection === 'connecting') {
        settled = true
        clearTimeout(timer)
        currentSock.ev.off('connection.update', onUpdate)
        resolve()
      }
    }

    currentSock.ev.on('connection.update', onUpdate)
  })

  await new Promise(resolve => setTimeout(resolve, 1200))
}

async function generatePairingCode(phone) {
  if (!sock) throw new Error('WhatsApp socket is not ready')
  if (isPaired()) throw new Error('WhatsApp is already paired')
  if (connectionState === 'closed') throw new Error('WhatsApp connection is closed; wait for reconnect')
  if (pairingInProgress) throw new Error('A pairing request is already pending')

  const currentSock = sock
  pairingInProgress = true

  try {
    await waitForPairingSocketReady(currentSock)
    if (currentSock !== sock) throw new Error('WhatsApp socket changed; please try pairing again')

    const normalizedPhone = String(phone).replace(/\D/g, '')
    if (!normalizedPhone) throw new Error('Invalid phone number')

    logger.info({ phone: normalizedPhone }, 'Requesting Qamar WhatsApp pairing code')
    const code = await currentSock.requestPairingCode(normalizedPhone)
    lastPairingCode = code
    await notifyN8N({ type: 'PAIRING_CODE_GENERATED', phone: normalizedPhone, code })
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
  const generation = ++socketGeneration
  const stateBundle = await useSupabaseAuthState()
  authState = stateBundle
  const { state, saveCreds } = stateBundle
  const { version } = await fetchLatestBaileysVersion()

  const currentSock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    logger
  })

  sock = currentSock
  connectionState = 'connecting'
  startupError = null

  currentSock.ev.on('creds.update', saveCreds)

  currentSock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (currentSock !== sock || generation !== socketGeneration) return

    connectionState = connection || connectionState

    if (connection === 'open') {
      lastPairingCode = null
      pairingInProgress = false
      startupError = null
      logger.info({ user: currentSock.user?.id }, 'Qamar WhatsApp connected with persistent Supabase auth')
      await notifyN8N({ type: 'WHATSAPP_CONNECTED', user: currentSock.user?.id || null })
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
          if (currentSock !== sock || generation !== socketGeneration) return
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

  currentSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (currentSock !== sock || generation !== socketGeneration) return
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
              metadata: { phone_number_id: currentSock?.user?.id || '' },
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
      await processIncomingMessage(payload, from)
    }
  })

  // Pair only after the socket event handlers are attached and the connection has had time to initialize.
  // This avoids the previous race where requestPairingCode() ran before connection.update was subscribed.
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
    paired: isPaired(),
    pairingReady: !isPaired() && !!sock && connectionState !== 'closed',
    persistence: 'supabase',
    startupError
  })
})

app.get('/status', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
  res.json({
    connection: connectionState,
    connected: !!sock?.user,
    paired: isPaired(),
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
  if (isPaired()) return res.status(409).type('html').send('<h3>Already paired</h3><p>Qamar WhatsApp is already paired.</p><p><a href="/">Back</a></p>')

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
  if (isPaired()) return res.status(409).json({ error: 'WhatsApp is already paired', user: sock.user?.id || null })

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
    res.json({ ok: true, to, messageId: sent?.key?.id || null })
  } catch (err) {
    logger.error({ to, err: String(err) }, 'WhatsApp send failed')
    res.status(502).json({ error: String(err?.message || err) })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT }, 'Qamar Baileys connector listening')
})

startSocket().catch(err => {
  startupError = String(err)
  connectionState = 'error'
  logger.error({ err: startupError }, 'initial WhatsApp socket startup failed')
})
