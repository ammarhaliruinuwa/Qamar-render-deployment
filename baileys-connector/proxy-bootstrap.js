import 'global-agent/bootstrap.js'
import { readFile, writeFile } from 'node:fs/promises'
import https from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

const configuredProxyUrl = process.env.BAILEYS_PROXY_URL || process.env.GLOBAL_AGENT_HTTP_PROXY || ''

function normalizeProxyUrl(value) {
  if (!value) return ''
  try {
    const parsed = new URL(value)
    // Decodo documents gate.decodo.com:7000 as the HTTP(S) gateway.
    // Prefer HTTP CONNECT on that port because it is more reliable for WSS
    // handshakes than forcing a SOCKS tunnel through the same gateway.
    if ((parsed.protocol === 'socks:' || parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:') && parsed.port === '7000') {
      parsed.protocol = 'http:'
      return parsed.toString()
    }
  } catch {}
  return value
}

const proxyUrl = normalizeProxyUrl(configuredProxyUrl)
const isSocksProxy = proxyUrl.startsWith('socks://') || proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks5h://')
const proxyAgent = proxyUrl
  ? (isSocksProxy ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl))
  : null

function redactProxyUrl(value) {
  try {
    const parsed = new URL(value)
    if (parsed.username) parsed.username = '***'
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return '[invalid proxy URL]'
  }
}

async function testWhatsAppProxy() {
  if (!proxyAgent) return

  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const req = https.request('https://ip.decodo.com/ip', {
      method: 'GET',
      agent: proxyAgent,
      timeout: 12000,
      headers: { 'user-agent': 'Qamar-Baileys/1.0' }
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        console.log(`Qamar proxy connectivity test: HTTP ${res.statusCode} ${body.trim().slice(0, 120)}`)
        finish()
      })
      res.on('close', finish)
    })

    req.once('timeout', () => {
      console.error('Qamar proxy connectivity test timed out after 12s')
      req.destroy()
      finish()
    })
    req.once('error', (err) => {
      console.error(`Qamar proxy connectivity test failed: ${err?.code || err?.name || 'Error'} ${err?.message || err}`)
      finish()
    })
    req.end()
  })
}

if (proxyAgent) {
  const originalRequest = https.request.bind(https)

  https.request = function patchedHttpsRequest(...args) {
    let options = args[0]
    let hostname = ''

    if (typeof options === 'string' || options instanceof URL) {
      const parsed = new URL(options)
      hostname = parsed.hostname
      options = parsed
    } else if (options && typeof options === 'object') {
      hostname = String(options.hostname || options.host || '').split(':')[0]
    }

    if (hostname === 'web.whatsapp.com' || hostname.endsWith('.web.whatsapp.com')) {
      if (options instanceof URL) {
        options = new URL(options.toString())
        options.agent = proxyAgent
      } else {
        options = { ...options, agent: proxyAgent }
      }
      args[0] = options
    }

    return originalRequest(...args)
  }

  console.log(`Qamar WhatsApp proxy agent enabled: ${isSocksProxy ? 'SOCKS5' : 'HTTP-CONNECT'} ${redactProxyUrl(proxyUrl)}`)
  if (configuredProxyUrl !== proxyUrl) {
    console.log('Qamar normalized the Decodo 7000 SOCKS URL to HTTP-CONNECT for stable WebSocket TLS')
  }
  await testWhatsAppProxy()
} else {
  console.log('Qamar WhatsApp proxy agent not configured')
}

const serverPath = new URL('./server.js', import.meta.url)
let serverSource = await readFile(serverPath, 'utf8')

// Prefer the live WhatsApp Web revision. Current Baileys reports and community
// reports show that the repo-published resolver can fall behind Meta's revision.
serverSource = serverSource.replace(
  "fetchLatestBaileysVersion, makeCacheableSignalKeyStore",
  "fetchLatestBaileysVersion, fetchLatestWaWebVersion, makeCacheableSignalKeyStore"
)
serverSource = serverSource.replace(
  "const { version } = await fetchLatestBaileysVersion()",
  "const { version } = await fetchLatestWaWebVersion()"
)

if (proxyAgent) {
  const marker = 'const currentSock = makeWASocket({'
  if (!serverSource.includes(marker)) {
    throw new Error('Qamar proxy bootstrap could not find makeWASocket configuration')
  }

  const prelude = `import { HttpsProxyAgent as __QamarHttpsProxyAgent } from 'https-proxy-agent'\nimport { SocksProxyAgent as __QamarSocksProxyAgent } from 'socks-proxy-agent'\nconst __QamarProxyUrl = ${JSON.stringify(proxyUrl)}\nconst __QamarProxyAgent = __QamarProxyUrl.startsWith('socks://') || __QamarProxyUrl.startsWith('socks5://') || __QamarProxyUrl.startsWith('socks5h://') ? new __QamarSocksProxyAgent(__QamarProxyUrl) : new __QamarHttpsProxyAgent(__QamarProxyUrl)\n`
  const replacement = `const currentSock = makeWASocket({\n    agent: __QamarProxyAgent,\n    fetchAgent: __QamarProxyAgent,`
  serverSource = prelude + serverSource.replace(marker, replacement)

  serverSource = serverSource.replace(
    "app.get('/', (_req, res) => {",
    "app.get(['/', '/pair-ui'], (_req, res) => {"
  )

  await writeFile(new URL('./.qamar-server-runtime.mjs', import.meta.url), serverSource, 'utf8')
  console.log('Qamar Baileys direct WebSocket proxy agent injected')
  console.log('Qamar pairing UI alias /pair-ui enabled')
  await import('./.qamar-server-runtime.mjs')
} else {
  await import('./server.js')
}
