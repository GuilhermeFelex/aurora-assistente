/**
 * The Llama engine: a model running on this PC through Ollama
 * (https://ollama.com). Free, private and with no account at all — the right
 * place for quick everyday answers and for deciding which engine should take
 * a request (the "palavras+llama" classifier in bridge/router.mjs).
 *
 *   perfil.json → "llama": { "modelo": "llama3.1:8b", "url": "http://127.0.0.1:11434",
 *                            "ferramentas": true, "contexto": 8192 }
 *
 * Ollama's chat endpoint is on localhost; nothing leaves the computer. With
 * "ferramentas" on, the model gets a small, light set of her tools (memory,
 * brain-aurora, interface) — the heavy display docs are left out so a small
 * model is not drowned in instructions.
 */

import { personaPrompt } from './aurora.mjs'
import { brainEnabled, brainPrompt } from './brain.mjs'
import { callRegistered, listRegistered } from './toolhub.mjs'

const LIGHT_SERVERS = new Set(['aurora_memoria', 'aurora_brain', 'jarvis_ui'])
const MAX_TOOL_ROUNDS = 5
const HISTORY_KEEP = 24

const unavailable = (message) => Object.assign(new Error(message), { unavailable: true })

/** Turns an MCP tool result into the plain text a chat model reads back. */
export function toolResultText(result) {
  const parts = (result?.content ?? []).map((c) => (c?.type === 'text' ? c.text : `[${c?.type ?? 'conteúdo'}]`))
  const text = parts.join('\n').trim() || '(sem conteúdo)'
  return result?.isError ? `ERRO: ${text}` : text
}

/** Reads an Ollama NDJSON stream, calling onChunk for each object. */
async function readNdjson(body, onChunk) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const part of body) {
    buffer += decoder.decode(part, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) onChunk(JSON.parse(line))
    }
  }
  if (buffer.trim()) onChunk(JSON.parse(buffer.trim()))
}

export async function createLlamaEngine(ctx, { fetchImpl = fetch } = {}) {
  const { profile, hub, addUsage } = ctx
  const cfg = profile.llama ?? {}
  const base = String(cfg.url || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = cfg.modelo || 'llama3.1:8b'

  // Is Ollama running, and does it have the model?
  let tags
  try {
    const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) })
    tags = await res.json()
  } catch {
    throw unavailable('O Ollama não está rodando neste computador. Instale em ollama.com e abra o aplicativo.')
  }
  const names = (tags?.models ?? []).map((m) => m.name ?? m.model)
  const has = (m) => names.some((n) => n === m || n === `${m}:latest` || n.split(':')[0] === m)
  if (!has(model)) {
    throw unavailable(`O modelo ${model} não está baixado no Ollama. Rode "ollama pull ${model}" uma vez.`)
  }

  const withBrain = brainEnabled(profile)
  const system =
    `${personaPrompt(profile)}\n\n` +
    (withBrain ? `${brainPrompt(profile)}\n\n` : '') +
    'Você está rodando localmente (Llama). Responda curto, em português do Brasil, ' +
    'em texto corrido próprio para ser falado — sem markdown, listas ou emojis. ' +
    'Você não tem acesso à internet: se o pedido precisar de pesquisa na web, diga isso em uma frase.'

  const tools =
    cfg.ferramentas === false
      ? []
      : (listRegistered(hub.token) ?? [])
          .filter((t) => LIGHT_SERVERS.has(hub.serverOf(t.name)))
          .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))

  const history = []
  let current = null

  const chat = (messages, { signal, stream = true, withTools = true, options = {}, modelName = model }) =>
    fetchImpl(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: modelName,
        messages,
        stream,
        keep_alive: '30m',
        ...(withTools && tools.length ? { tools } : {}),
        options: { num_ctx: Number(cfg.contexto) || 8192, ...options },
      }),
    })

  return {
    dead: false,
    interrupt() {
      current?.abort()
    },
    close() {
      current?.abort()
    },

    /** One word back, for the router. Kept tiny so it costs a fraction of a second. */
    async classify(prompt) {
      const res = await chat([{ role: 'user', content: prompt }], {
        stream: false,
        withTools: false,
        options: { temperature: 0, num_predict: 6 },
        signal: AbortSignal.timeout(4000),
      })
      const data = await res.json()
      return String(data?.message?.content ?? '').trim().toLowerCase()
    },

    async run(text, { sink, route }) {
      const ctl = new AbortController()
      current = ctl
      const turn = [{ role: 'user', content: text }]
      let answer = ''
      let tokensIn = 0
      let tokensOut = 0
      let toolCount = 0
      try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const res = await chat([{ role: 'system', content: system }, ...history, ...turn], {
            signal: ctl.signal,
            modelName: route?.modelo || model,
          })
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            return { error: `O Llama respondeu com erro (${res.status}). ${body.slice(0, 200)}` }
          }
          let content = ''
          const calls = []
          await readNdjson(res.body, (chunk) => {
            const m = chunk.message ?? {}
            if (m.content) {
              content += m.content
              answer += m.content
              sink.text(m.content)
            }
            if (Array.isArray(m.tool_calls)) calls.push(...m.tool_calls)
            if (chunk.done) {
              tokensIn += chunk.prompt_eval_count ?? 0
              tokensOut += chunk.eval_count ?? 0
            }
          })
          turn.push({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) })
          if (!calls.length) break
          for (const call of calls) {
            const name = call.function?.name
            let args = call.function?.arguments ?? {}
            if (typeof args === 'string') {
              try {
                args = JSON.parse(args)
              } catch {
                args = {}
              }
            }
            toolCount++
            const server = hub.serverOf(name)
            if (server && server !== 'jarvis_ui') sink.tool(`mcp__${server}__${name}`)
            const result = await callRegistered(hub.token, name, args)
            turn.push({ role: 'tool', tool_name: name, content: toolResultText(result) })
          }
        }
      } catch (err) {
        if (ctl.signal.aborted) return { text: answer, interrupted: true }
        return answer
          ? { error: `O Llama parou no meio: ${err?.message ?? err}` }
          : { unavailable: true, message: `Não deu para falar com o Ollama: ${err?.message ?? err}` }
      } finally {
        if (current === ctl) current = null
        // Keep the conversation (without tool chatter) for the next turn.
        history.push({ role: 'user', content: text }, { role: 'assistant', content: answer })
        while (history.length > HISTORY_KEEP) history.shift()
        addUsage('llama', {
          respostas: 1,
          ferramentas: toolCount,
          tokensEntrada: tokensIn,
          tokensSaida: tokensOut,
          modelo: `Llama · ${route?.modelo || model}`,
        })
      }
      return { text: answer }
    },
  }
}
