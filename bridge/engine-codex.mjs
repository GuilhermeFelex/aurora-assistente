/**
 * The Codex engine: Aurora driven by OpenAI's Codex (ChatGPT) instead of
 * Claude, through the Codex SDK — which runs the `codex` CLI on this machine
 * with the user's own ChatGPT sign-in, the same way the Claude path runs
 * Claude Code. No API key either way.
 *
 * Everything around the model stays the same: the page, the voice, the
 * persona/knowledge/memory files, the brain-aurora vault and her on-screen
 * tools. Those tools still run here in the bridge; Codex reaches them through
 * bridge/mcp-proxy.mjs (a stdio MCP server it spawns) and bridge/toolhub.mjs.
 *
 * Differences worth knowing:
 *   - Codex hands over each reply when it is complete, so she starts speaking
 *     a little later than with Claude (no token-by-token stream).
 *   - Codex's own MCP servers come from ~/.codex/config.toml, not ~/.claude.json.
 *   - Read-only by default: Codex's sandbox is "read-only" unless the bridge
 *     was started with --writes, and her own tools go through decideTool.
 */

import { Codex } from '@openai/codex-sdk'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { visionServer } from './vision.mjs'
import { memoryServer, personaPrompt, rememberSession, sessionToResume } from './aurora.mjs'
import { brainEnabled, brainPrompt, brainServer } from './brain.mjs'
import { registerTools } from './toolhub.mjs'

const PROXY = fileURLToPath(new URL('./mcp-proxy.mjs', import.meta.url))

/** Windows caps a command line at 32 767 characters; the instructions ride on it. */
const MAX_INLINE_INSTRUCTIONS = 24_000

/** Tools that are the interface drawing itself — not "work" worth a badge. */
const QUIET = /^mcp__jarvis__display$|^mcp__jarvis_ui__/

/**
 * Turns Codex's event stream into the bridge's wire frames. Kept separate (and
 * exported) so it can be tested without a ChatGPT account.
 */
export function createTranslator({ sendTurn, serverOf, onThread, onUsage }) {
  const spoken = new Map()
  let anyText = false
  let finalText = ''
  const announced = new Set()

  const tool = (id, name) => {
    if (!name || announced.has(id)) return
    announced.add(id)
    if (!QUIET.test(name)) sendTurn({ type: 'tool', name })
  }

  return {
    get finalText() {
      return finalText
    },
    handle(ev) {
      switch (ev?.type) {
        case 'thread.started':
          onThread?.(ev.thread_id)
          return null
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = ev.item ?? {}
          if (item.type === 'mcp_tool_call') {
            const server = item.server === 'aurora' ? (serverOf?.(item.tool) ?? 'aurora') : item.server
            tool(item.id, `mcp__${server}__${item.tool}`)
          } else if (item.type === 'web_search') {
            tool(item.id, 'WebSearch')
          } else if (item.type === 'command_execution') {
            tool(item.id, 'Bash')
          } else if (item.type === 'agent_message' && typeof item.text === 'string') {
            const before = spoken.get(item.id) ?? 0
            const fresh = item.text.slice(before)
            if (fresh) {
              spoken.set(item.id, item.text.length)
              const delta = before === 0 && anyText ? ` ${fresh}` : fresh
              anyText = true
              finalText += delta
              sendTurn({ type: 'text', delta })
            }
          }
          return null
        }
        case 'turn.completed':
          onUsage?.(ev.usage)
          return 'done'
        case 'turn.failed':
          return { error: ev.error?.message ?? 'falha no turno' }
        case 'error':
          // "Reconnecting... 2/5" and the like are progress notes, not failures;
          // a real failure still ends the turn with turn.failed.
          if (/^reconnecting/i.test(ev.message ?? '')) return null
          return { error: ev.message ?? 'erro no Codex' }
        default:
          return null
      }
    },
  }
}

const NOT_LOGGED_IN =
  'O Codex não está logado neste computador. Rode "codex" no terminal uma vez e entre com a sua conta do ChatGPT.'

/** Friendlier wording for the failures a person can actually fix. */
export function explainError(message) {
  const msg = String(message ?? '')
  if (/401|unauthori[sz]ed|not logged in|login|sign in|authentication/i.test(msg)) return NOT_LOGGED_IN
  if (/ENOENT|spawn/i.test(msg)) return 'Não encontrei o programa do Codex. Rode "npm install" na pasta da Aurora e reinicie.'
  if (/usage limit|rate limit|429/i.test(msg)) return 'Atingimos o limite de uso do ChatGPT por enquanto. Tente de novo mais tarde, ou volte o motor para "claude".'
  return msg
}

export function runCodexConnection(socket, deps) {
  const { profile, decideTool, operationalPrompt, allowWrites, port } = deps

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  // The camera asks the page for a frame and waits — same protocol as Claude.
  const waiting = new Map()
  let asks = 0
  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) return reject(new Error('the interface is not connected'))
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  // Her tools, registered on the hub for the proxy to reach.
  const withBrain = brainEnabled(profile)
  const servers = {
    jarvis: displayServer(
      (panel) => send({ type: 'panel', panel }),
      (blade) => send({ type: 'blade', blade }),
    ),
    jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
    jarvis_eyes: visionServer(ask),
    ...(profile.memoria?.ativa === false ? {} : { aurora_memoria: memoryServer() }),
    ...(withBrain ? { aurora_brain: brainServer(profile) } : {}),
  }
  const hub = registerTools(servers, decideTool)

  const instructions =
    `${personaPrompt(profile)}\n\n` + (withBrain ? `${brainPrompt(profile)}\n\n` : '') + operationalPrompt(false)
  const inline = instructions.length <= MAX_INLINE_INSTRUCTIONS

  const codex = new Codex({
    config: {
      ...(inline ? { developer_instructions: instructions } : {}),
      mcp_servers: {
        aurora: {
          command: process.execPath,
          args: [PROXY],
          env: { AURORA_TOOLS_URL: `http://127.0.0.1:${port}/aurora-tools/${hub.token}` },
          default_tools_approval_mode: 'approve',
          startup_timeout_sec: 20,
        },
      },
    },
  })

  const threadOptions = {
    ...(profile.codex?.modelo ? { model: profile.codex.modelo } : {}),
    modelReasoningEffort: profile.codex?.esforco || 'medium',
    sandboxMode: allowWrites ? 'workspace-write' : 'read-only',
    approvalPolicy: 'never',
    workingDirectory: homedir(),
    skipGitRepoCheck: true,
    webSearchMode: 'live',
  }

  const resumeId = sessionToResume(profile, 'codex')
  let thread = resumeId ? codex.resumeThread(resumeId, threadOptions) : codex.startThread(threadOptions)
  let resumed = Boolean(resumeId)
  let primed = inline || resumed
  if (resumeId) console.log(`[aurora] codex: retomando a conversa ${resumeId.slice(0, 8)}…`)

  const usage = {
    respostas: 0,
    ferramentas: 0,
    tokensEntrada: 0,
    tokensSaida: 0,
    tokensCache: 0,
    custoUsd: 0,
    modelo: `codex${profile.codex?.modelo ? ` · ${profile.codex.modelo}` : ''}`,
    retomada: resumed,
  }

  send({ type: 'ready', servers: ['codex', ...(withBrain ? ['brain-aurora'] : [])] })
  console.log(`[aurora] motor codex (ChatGPT) · sandbox ${threadOptions.sandboxMode}`)

  let current = null
  let chain = Promise.resolve()
  let closed = false

  const runTurn = async (text, id, retry = true) => {
    answering = id
    const ctl = new AbortController()
    current = ctl
    const translator = createTranslator({
      sendTurn,
      serverOf: hub.serverOf,
      onThread: (tid) => rememberSession(tid, 'codex'),
      onUsage: (u) => {
        usage.respostas++
        usage.tokensEntrada += u?.input_tokens ?? 0
        usage.tokensSaida += (u?.output_tokens ?? 0) + (u?.reasoning_output_tokens ?? 0)
        usage.tokensCache += u?.cached_input_tokens ?? 0
      },
    })
    const input = primed ? text : `${instructions}\n\n# Primeira mensagem do usuário\n\n${text}`
    let started = false
    let settled = false
    let failure = null
    try {
      const { events } = await thread.runStreamed(input, { signal: ctl.signal })
      for await (const ev of events) {
        if (ev.type?.startsWith('item.') || ev.type === 'turn.completed') started = true
        if (ev.type === 'item.started' && ev.item?.type === 'mcp_tool_call') usage.ferramentas++
        const outcome = translator.handle(ev)
        if (outcome === 'done') {
          primed = true
          resumed = false
          settled = true
          send({ type: 'usage', usage })
          sendTurn({ type: 'done', text: translator.finalText, costUsd: null })
        } else if (outcome?.error) {
          // One error ends the turn on the page; keep the first and report it once.
          failure ??= outcome.error
        }
      }
      if (!settled) {
        settled = true
        if (failure) {
          console.error('[aurora] codex: turno falhou:', failure)
          sendTurn({ type: 'error', message: explainError(failure) })
        } else sendTurn({ type: 'done', text: translator.finalText, costUsd: null })
      }
    } catch (err) {
      if (settled) {
        /* already answered */
      } else if (ctl.signal.aborted) {
        // Barge-in: settle the abandoned question so its listener lets go.
        sendTurn({ type: 'done', text: translator.finalText, costUsd: null })
      } else if (resumed && !started && retry) {
        // The saved conversation is gone — start a fresh one and try again.
        console.warn('[aurora] codex: não deu para retomar a conversa; começando outra.')
        rememberSession(null)
        resumed = false
        primed = inline
        thread = codex.startThread(threadOptions)
        return runTurn(text, id, false)
      } else {
        console.error('[aurora] codex: erro no turno:', failure ?? err?.message ?? err)
        sendTurn({ type: 'error', message: explainError(failure ?? err?.message ?? err) })
      }
    } finally {
      if (current === ctl) current = null
    }
  }

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type === 'ask' && typeof msg.text === 'string') {
      const id = typeof msg.id === 'string' ? msg.id : null
      chain = chain.then(() => (closed ? null : runTurn(msg.text, id))).catch(() => {})
    }
    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }
    if (msg.type === 'interrupt') current?.abort()
  })

  socket.on('close', () => {
    console.log('[jarvis] client disconnected')
    closed = true
    current?.abort()
    hub.close()
  })
}
