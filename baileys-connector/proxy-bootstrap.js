import 'global-agent/bootstrap.js'
import { readFile, writeFile } from 'node:fs/promises'
import https from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

const proxyUrl = process.env.BAILEYS_PROXY_URL || process.env.GLOBAL_AGENT_HTTP_PROXY || ''
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
    const req = https.request('https://web.whatsapp.com/', {
      method: 'HEAD',
      agent: proxyAgent,
      timeout: 15000,
      headers: { 'user-agent': 'Mozilla/5.0' }
    }, (res) => {
      console.log(`Qamar proxy TLS test succeeded: HTTP ${res.statusCode}`)
      res.resume()
      res.once('end', resolve)
    })

    req.once('timeout', () => {
      console.error('Qamar proxy TLS test timed out after 15s')
      req.destroy()
      resolve()
    })
    req.once('error', (err) => {
      console.error(`Qamar proxy TLS test failed: ${err?.code || err?.name || 'Error'} ${err?.message || err}`)
      resolve()
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

  console.log(`Qamar WhatsApp proxy agent enabled: ${isSocksProxy ? 'SOCKS5' : 'HTTPS'} ${redactProxyUrl(proxyUrl)}`)
  await testWhatsAppProxy()
} else {
  console.log('Qamar WhatsApp proxy agent not configured')
}

const serverPath = new URL('./server.js', import.meta.url)
let serverSource = await readFile(serverPath, 'utf8')

if (proxyAgent) {
  const marker = 'const currentSock = makeWASocket({'
  if (!serverSource.includes(marker)) {
    throw new Error('Qamar proxy bootstrap could not find makeWASocket configuration')
  }

  const prelude = `import { HttpsProxyAgent as __QamarHttpsProxyAgent } from 'https-proxy-agent'\nimport { SocksProxyAgent as __QamarSocksProxyAgent } from 'socks-proxy-agent'\nconst __QamarProxyUrl = process.env.BAILEYS_PROXY_URL || process.env.GLOBAL_AGENT_HTTP_PROXY || ''\nconst __QamarProxyAgent = __QamarProxyUrl.startsWith('socks://') || __QamarProxyUrl.startsWith('socks5://') || __QamarProxyUrl.startsWith('socks5h://') ? new __QamarSocksProxyAgent(__QamarProxyUrl) : new __QamarHttpsProxyAgent(__QamarProxyUrl)\n`
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
