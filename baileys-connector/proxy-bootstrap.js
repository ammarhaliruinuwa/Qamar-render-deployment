import 'global-agent/bootstrap.js'
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

await import('./server.js')
