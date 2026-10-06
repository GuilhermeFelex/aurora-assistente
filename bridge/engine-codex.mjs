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
 * It can also draw: with "codex.imagens" on, Codex's own image generation is
 * enabled, and every picture it saves under ~/.codex/generated_images during
 * a turn is opened on a blade.
 *
 * Differences worth knowing:
 *   - Codex hands over each reply when it is complete, so she starts speaking
 *     a little later than with Claude (no token-by-token stream).
 *   - Codex's own MCP servers come from ~/.codex/config.toml, not ~/.claude.json.
 *   - Read-only by default: Codex's sandbox is "read-only" unless the bridge
 *     was started with --writes, and her own tools go through decideTool.
 */

import { Codex } from '@openai/codex-sdk'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { personaPrompt, rememberSession, sessionToResume } from './aurora.mjs'
import { brainEnabled, brainPrompt } from './brain.mjs'

export const PROXY = fileURLToPath(new URL('./mcp-proxy.mjs', import.meta.url))

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
  if (/usage limit|rate limit|429/i.test(msg)) return 'Atingimos o limite de uso do ChatGPT por enquanto. Tente de novo mais tarde.'
  return msg
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i

/** Pictures written under `dir` after `since` (ms), newest last. */
export async function imagesSince(dir, since, depth = 3) {
  const found = []
  const walk = async (d, level) => {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory() && level < depth) await walk(full, level + 1)
      else if (e.isFile() && IMAGE_EXT.test(e.name)) {
        try {
          const info = await stat(full)
          if (info.mtimeMs >= since) found.push({ full, at: info.mtimeMs })
        } catch {
          /* gone already */
        }
      }
    }
  }
  await walk(dir, 0)
  return found.sort((a, b) => a.at - b.at).map((f) => f.full)
}

export function createCodexEngine(ctx) {
  const { profile, hub, send, decideTool, operationalPrompt, allowWrites, port, addUsage } = ctx
  const withBrain = brainEnabled(profile)
  const instructions =
    `${personaPrompt(profile)}\n\n` + (withBrain ? `${brainPrompt(profile)}\n\n` : '') + operationalPrompt(false)
  const inline = instructions.length <= MAX_INLINE_INSTRUCTIONS
  const drawing = profile.codex?.imagens !== false
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')

  const codex = new Codex({
    config: {
      ...(inline ? { developer_instructions: instructions } : {}),
      ...(drawing ? { features: { image_generation: true } } : {}),
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
  void decideTool

  const baseOptions = {
    ...(profile.codex?.modelo ? { model: profile.codex.modelo } : {}),
    modelReasoningEffort: profile.codex?.esforco || 'medium',
    sandboxMode: allowWrites ? 'workspace-write' : 'read-only',
    approvalPolicy: 'never',
    workingDirectory: homedir(),
    skipGitRepoCheck: true,
    webSearchMode: 'live',
  }

  const resumeId = sessionToResume(profile, 'codex')
  let threadId = resumeId
  let resumed = Boolean(resumeId)
  let primed = inline || resumed
  if (resumeId) console.log(`[aurora] codex: retomando a conversa ${resumeId.slice(0, 8)}…`)

  // A route can ask for another model or effort for one turn; the thread is the same.
  const threadFor = (route) => {
    const opts = {
      ...baseOptions,
      ...(route?.modelo ? { model: route.modelo } : {}),
      ...(route?.esforco ? { modelReasoningEffort: route.esforco } : {}),
    }
    return threadId ? codex.resumeThread(threadId, opts) : codex.startThread(opts)
  }

  let current = null

  const engine = {
    dead: false,
    interrupt() {
      current?.abort()
    },
    close() {
      current?.abort()
    },
    async run(text, { sink, route }, retry = true) {
      const ctl = new AbortController()
      current = ctl
      const startedAt = Date.now() - 1000
      let tools = 0
      const translator = createTranslator({
        sendTurn: (frame) => (frame.type === 'text' ? sink.text(frame.delta) : sink.tool(frame.name)),
        serverOf: hub.serverOf,
        onThread: (tid) => {
          threadId = tid
          rememberSession(tid, 'codex')
        },
        onUsage: (u) =>
          addUsage('codex', {
            respostas: 1,
            ferramentas: tools,
            tokensEntrada: u?.input_tokens ?? 0,
            tokensSaida: (u?.output_tokens ?? 0) + (u?.reasoning_output_tokens ?? 0),
            tokensCache: u?.cached_input_tokens ?? 0,
            retomada: resumed,
            modelo: `ChatGPT (Codex${route?.modelo || profile.codex?.modelo ? ` · ${route?.modelo || profile.codex.modelo}` : ''})`,
          }),
      })
      const input = primed ? text : `${instructions}\n\n# Primeira mensagem do usuário\n\n${text}`
      let started = false
      let failure = null
      let done = false
      try {
        const thread = threadFor(route)
        const { events } = await thread.runStreamed(input, { signal: ctl.signal })
        for await (const ev of events) {
          if (ev.type?.startsWith('item.') || ev.type === 'turn.completed') started = true
          if (ev.type === 'item.started' && ev.item?.type === 'mcp_tool_call') tools++
          const outcome = translator.handle(ev)
          if (outcome === 'done') {
            done = true
            primed = true
            resumed = false
          } else if (outcome?.error) failure ??= outcome.error
        }
      } catch (err) {
        if (ctl.signal.aborted) return { text: translator.finalText, interrupted: true }
        if (resumed && !started && retry) {
          console.warn('[aurora] codex: não deu para retomar a conversa; começando outra.')
          rememberSession(null, 'codex')
          threadId = null
          resumed = false
          primed = inline
          return engine.run(text, { sink, route }, false)
        }
        failure ??= String(err?.message ?? err)
      } finally {
        if (current === ctl) current = null
      }
      if (drawing) await showImages(startedAt)
      if (done) return { text: translator.finalText }
      if (ctl.signal.aborted) return { text: translator.finalText, interrupted: true }
      const message = explainError(failure ?? 'O Codex terminou sem resposta.')
      console.error('[aurora] codex: turno falhou:', failure)
      // Missing program or no sign-in: let the reserve engine answer instead.
      const missing = message === NOT_LOGGED_IN || /Não encontrei o programa/.test(message)
      return missing && !translator.finalText ? { unavailable: true, message } : { error: message }
    },
  }

  async function showImages(since) {
    const files = await imagesSince(join(codexHome, 'generated_images'), since)
    if (!files.length) return
    const latest = files.slice(-8)
    send({
      type: 'blade',
      blade: {
        id: `img${Date.now().toString(36)}`,
        title: 'IMAGEM',
        kind: latest.length > 1 ? 'gallery' : 'image',
        url: latest.length > 1 ? undefined : latest[0],
        images: latest.length > 1 ? latest : undefined,
        mode: 'reader',
        size: 'wide',
        hold: 'sticky',
      },
    })
  }

  return engine
}
