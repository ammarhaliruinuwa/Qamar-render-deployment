import { initAuthCreds, proto, BufferJSON } from 'baileys'

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
const TABLE = 'qamar_baileys_auth_state'

function assertConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase auth persistence is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Render.')
  }
}

function headers(extra = {}) {
  assertConfig()
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'content-type': 'application/json',
    ...extra
  }
}

function encode(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer))
}

function decode(value) {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver)
}

async function readData(key) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${TABLE}`)
  url.searchParams.set('select', 'value')
  url.searchParams.set('key', `eq.${key}`)
  url.searchParams.set('limit', '1')

  const response = await fetch(url, { headers: headers() })
  if (!response.ok) throw new Error(`Supabase auth read failed (${response.status}): ${await response.text()}`)
  const rows = await response.json()
  return rows[0]?.value ?? null
}

async function writeData(key, value) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ key, value: encode(value), updated_at: new Date().toISOString() })
  })
  if (!response.ok) throw new Error(`Supabase auth write failed (${response.status}): ${await response.text()}`)
}

async function removeData(key) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${TABLE}`)
  url.searchParams.set('key', `eq.${key}`)
  const response = await fetch(url, { method: 'DELETE', headers: headers({ Prefer: 'return=minimal' }) })
  if (!response.ok) throw new Error(`Supabase auth delete failed (${response.status}): ${await response.text()}`)
}

export async function useSupabaseAuthState() {
  assertConfig()

  const storedCreds = await readData('creds.json')
  const creds = storedCreds ? decode(storedCreds) : initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(ids.map(async id => {
            let value = await readData(`${type}-${id}.json`)
            if (value && type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(decode(value))
            } else if (value) {
              value = decode(value)
            }
            data[id] = value
          }))
          return data
        },
        set: async data => {
          const tasks = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const key = `${category}-${id}.json`
              tasks.push(value ? writeData(key, value) : removeData(key))
            }
          }
          await Promise.all(tasks)
        }
      }
    },
    saveCreds: async () => writeData('creds.json', creds)
  }
}
