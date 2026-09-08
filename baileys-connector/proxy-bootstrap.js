import 'global-agent/bootstrap.js'
import { readFile, writeFile } from 'node:fs/promises'
import https from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'

const proxyUrl = process.env.BAILEYS_PROXY_URL || process.env.GLOBAL_AGENT_HTTP_PROXY || ''
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null

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

  console.log('Qamar WhatsApp HTTPS proxy agent enabled')
} else {
  console.log('Qamar WhatsApp proxy agent not configured')
}

// Baileys 6.x exposes `agent` and `fetchAgent` on makeWASocket().
// Inject the proxy agent directly into that socket config so the `ws`
// WebSocket client receives the agent, rather than relying only on a
// global https.request monkey-patch.
const serverPath = new URL('./server.js', import.meta.url)
let serverSource = await readFile(serverPath, 'utf8')

if (proxyAgent) {
  const marker = 'const currentSock = makeWASocket({'
  if (!serverSource.includes(marker)) {
    throw new Error('Qamar proxy bootstrap could not find makeWASocket configuration')
  }

  const prelude = `import { HttpsProxyAgent as __QamarHttpsProxyAgent } from 'https-proxy-agent'\nconst __QamarProxyUrl = process.env.BAILEYS_PROXY_URL || process.env.GLOBAL_AGENT_HTTP_PROXY || ''\nconst __QamarProxyAgent = __QamarProxyUrl ? new __QamarHttpsProxyAgent(__QamarProxyUrl) : undefined\n`
  serverSource = `${prelude}${serverSource.replace(marker, `const currentSock = makeWASocket({\n    agent: __QamarProxyAgent,\n    fetchAgent: __QamarProxyAgent,`)}`
  await writeFile(new URL('./.qamar-server-runtime.mjs', import.meta.url), serverSource, 'utf8')
  console.log('Qamar Baileys direct WebSocket proxy agent injected')
  await import('./.qamar-server-runtime.mjs')
} else {
  await import('./server.js')
}
