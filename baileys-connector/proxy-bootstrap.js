import 'global-agent/bootstrap.js'
import { readFile, writeFile } from 'node:fs/promises'
import https from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

function buildConfiguredProxyUrl() {
  // Prefer the explicit Decodo credential variables. This avoids accidentally
  // picking up a platform-provided HTTPS_PROXY value and, importantly, keeps
  // the exact Decodo username/password supplied by the user unchanged.
  const user = process.env.DECODO_USERNAME || process.env.DECODO_USER || process.env.PROXY_USERNAME || ''
  const password = process.env.DECODO_PASSWORD || process.env.DECODO_PASS || process.env.PROXY_PASSWORD || ''

  if (user && password) {
    const host = process.env.DECODO_HOST || 'gate.decodo.com'
    const protocol = (process.env.DECODO_PROTOCOL || 'http').replace(/:$/, '')
    const port = process.env.DECODO_PORT || (protocol.startsWith('socks') ? '7001' : '10001')
    return `${protocol}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`
  }

  return process.env.BAILEYS_PROXY_URL || process.env.GLOBAL_AGENT_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
}

const configuredProxyUrl = buildConfiguredProxyUrl()

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

function makeAgent(proxyUrl) {
  if (!proxyUrl) return null
  const isSocks = /^socks5?h:|^socks:|^socks5:/i.test(proxyUrl)
  return isSocks ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl)
}

function candidateProxyUrls(value) {
  if (!value) return []

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return [value]
  }

  const host = parsed.hostname.toLowerCase()
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '')
  const isSocks = ['socks:', 'socks5:', 'socks5h:'].includes(parsed.protocol)
  const candidates = []

  const add = (url) => {
    if (url && !candidates.includes(url)) candidates.push(url)
  }

  if (host === 'gate.decodo.com' && isSocks && port === '7000') {
    const http = new URL(parsed.toString())
    http.protocol = 'http:'
    add(http.toString())

    const socks = new URL(parsed.toString())
    socks.protocol = 'socks5h:'
    socks.port = '7001'
    add(socks.toString())
  } else if (host === 'gate.decodo.com' && isSocks && port === '7001') {
    add(parsed.toString())
    const http = new URL(parsed.toString())
    http.protocol = 'http:'
    http.port = '7000'
    add(http.toString())
  } else {
    add(parsed.toString())
  }

  return candidates
}

async function testProxy(proxyUrl, proxyAgent) {
  if (!proxyAgent) return { ok: true, status: 0 }

  return await new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const req = https.request('https://ip.decodo.com/json', {
      method: 'GET',
      agent: proxyAgent,
      timeout: 12000,
      headers: { 'user-agent': 'Qamar-Baileys/1.0' }
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300 && body.trim().length > 0
        console.log(`Qamar proxy test ${redactProxyUrl(proxyUrl)} -> HTTP ${res.statusCode} ${ok ? 'OK' : 'FAILED'}`)
        finish({ ok, status: res.statusCode, body: body.trim().slice(0, 120) })
      })
      res.on('close', () => finish({ ok: false, status: res.statusCode || 0, body: '' }))
    })

    req.once('timeout', () => {
      console.error(`Qamar proxy test timed out: ${redactProxyUrl(proxyUrl)}`)
      req.destroy()
      finish({ ok: false, status: 0, error: 'TIMEOUT' })
    })
    req.once('error', (err) => {
      console.error(`Qamar proxy test failed: ${redactProxyUrl(proxyUrl)} -> ${err?.code || err?.name || 'Error'} ${err?.message || err}`)
      finish({ ok: false, status: 0, error: err?.code || err?.name || 'ERROR' })
    })
    req.end()
  })
}

const proxyCandidates = candidateProxyUrls(configuredProxyUrl)
let proxyUrl = ''
let proxyAgent = null
let isSocksProxy = false

if (configuredProxyUrl) {
  console.log(`Qamar detected proxy configuration: ${redactProxyUrl(configuredProxyUrl)}`)
} else {
  console.warn('Qamar no proxy configuration detected in Render environment')
}

for (const candidate of proxyCandidates) {
  const agent = makeAgent(candidate)
  const result = await testProxy(candidate, agent)
  if (result.ok) {
    proxyUrl = candidate
    proxyAgent = agent
    isSocksProxy = /^(socks|socks5|socks5h):/i.test(candidate)
    console.log(`Qamar selected working Decodo transport: ${isSocksProxy ? 'SOCKS5' : 'HTTP-CONNECT'} ${redactProxyUrl(candidate)}`)
    break
  }
}

if (configuredProxyUrl && !proxyAgent) {
  console.error('Qamar could not establish a working Decodo proxy transport. WhatsApp will remain disconnected until the proxy endpoint is reachable.')
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
}

const serverPath = new URL('./server.js', import.meta.url)
let serverSource = await readFile(serverPath, 'utf8')

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