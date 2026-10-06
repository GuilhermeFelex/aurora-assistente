/**
 * The tool hub: Aurora's own tools, offered to engines that run out of process.
 *
 * With Claude, her tools (blades, interface, camera, memory, brain) are SDK
 * servers living inside this process. Other engines — Codex — spawn their own
 * agent process and only speak MCP over stdio, so they reach the same tools
 * through bridge/mcp-proxy.mjs, which forwards every call back here over
 * localhost HTTP. The tools therefore still run in the bridge, on the same
 * socket as the page, exactly as they do with Claude.
 *
 *   GET  /aurora-tools/<token>/list   → [{ name, description, inputSchema }]
 *   POST /aurora-tools/<token>/call   { name, arguments } → MCP tool result
 *
 * Each connection registers its own tool set under a random token, so a call
 * can only reach the conversation that owns it, and the token dies with it.
 */

import { randomBytes } from 'node:crypto'
import { z } from 'zod'

const sessions = new Map()

/**
 * @param {Record<string, {instance: any}>} servers  SDK servers keyed by name
 * @param {(fullName: string) => boolean} decide    the permission gate
 * @returns {{ token: string, serverOf: (tool: string) => string | undefined, close: () => void }}
 */
export function registerTools(servers, decide) {
  const tools = new Map()
  for (const [server, sdk] of Object.entries(servers)) {
    const registered = sdk?.instance?._registeredTools ?? {}
    for (const [name, def] of Object.entries(registered)) {
      if (def?.enabled === false || tools.has(name)) continue
      tools.set(name, { server, def })
    }
  }
  const token = randomBytes(18).toString('hex')
  sessions.set(token, { tools, decide })
  return {
    token,
    serverOf: (tool) => tools.get(tool)?.server,
    close: () => sessions.delete(token),
  }
}

function jsonSchemaOf(def) {
  try {
    const schema = z.toJSONSchema(def.inputSchema)
    delete schema.$schema
    return schema
  } catch {
    return { type: 'object', properties: {} }
  }
}

const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 2_000_000) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

/** Handles /aurora-tools/… ; returns false when the URL is not ours. */
export async function handleToolRequest(req, res) {
  const m = /^\/aurora-tools\/([a-f0-9]{36})\/(list|call)$/.exec(req.url ?? '')
  if (!m) return false
  // Only the local proxy calls this; it sends no Origin. A browser page does,
  // and has no business here.
  if (req.headers.origin) return reply(res, 403, { error: 'forbidden' }), true
  const session = sessions.get(m[1])
  if (!session) return reply(res, 404, { error: 'unknown session' }), true

  if (m[2] === 'list' && req.method === 'GET') {
    const list = [...session.tools].map(([name, { def }]) => ({
      name,
      description: def.description ?? '',
      inputSchema: jsonSchemaOf(def),
    }))
    return reply(res, 200, list), true
  }

  if (m[2] === 'call' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return reply(res, 400, { error: 'bad request' }), true
    }
    const entry = session.tools.get(String(body?.name ?? ''))
    if (!entry) {
      return reply(res, 200, { isError: true, content: [{ type: 'text', text: 'Ferramenta desconhecida.' }] }), true
    }
    const full = `mcp__${entry.server}__${body.name}`
    if (!session.decide(full)) {
      return (
        reply(res, 200, {
          isError: true,
          content: [{ type: 'text', text: 'Bloqueado pelas permissões da Aurora (modo somente leitura ou perfil.json).' }],
        }),
        true
      )
    }
    let args
    try {
      args = z.parse(entry.def.inputSchema, body.arguments ?? {})
    } catch (err) {
      const why = err?.issues?.map((i) => `${i.path?.join('.') || 'argumento'}: ${i.message}`).join('; ')
      return reply(res, 200, { isError: true, content: [{ type: 'text', text: `Argumentos inválidos: ${why || err}` }] }), true
    }
    try {
      const result = await entry.def.handler(args, {})
      return reply(res, 200, result ?? { content: [] }), true
    } catch (err) {
      return reply(res, 200, { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] }), true
    }
  }

  return reply(res, 405, { error: 'method not allowed' }), true
}
