/**
 * The Gemini engine: Aurora driven by Google's Gemini CLI, with the user's own
 * Google sign-in — no API key, the same way Claude and Codex are used.
 *
 * Each turn runs `gemini` once in headless mode (stream-json, so speech starts
 * on the first words) and continues the same saved session. Her persona goes
 * in as Gemini's system prompt (GEMINI_SYSTEM_MD), and her tools — panels,
 * interface, camera, memory, brain-aurora — reach it through the same MCP
 * proxy Codex uses (bridge/mcp-proxy.mjs), declared in a settings file this
 * bridge writes (GEMINI_CLI_SYSTEM_SETTINGS_PATH). The user's own
 * ~/.gemini/settings.json still applies.
 *
 * Gemini is found on PATH (the "gemini" command npm installs) or at
 * perfil.json → gemini.caminho. It is run through Node directly, never through
 * a shell, so nothing the user says can become a command.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { AURORA_DIR, personaPrompt, rememberSession, sessionToResume } from './aurora.mjs'
import { brainEnabled, brainPrompt } from './brain.mjs'
import { PROXY } from './engine-codex.mjs'

const QUIET = /^mcp__jarvis__display$|^mcp__jarvis_ui__/

/** Where `npm install -g @google/gemini-cli` put the program, as a JS file Node can run. */
export function findGemini(profile = {}, env = process.env) {
  const candidates = []
  const custom = profile.gemini?.caminho
  if (custom) candidates.push(custom)
  const pkgDirs = new Set()
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, 'gemini')) || existsSync(join(dir, 'gemini.cmd'))) {
      pkgDirs.add(join(dir, 'node_modules', '@google', 'gemini-cli'))
      pkgDirs.add(join(dirname(dir), 'lib', 'node_modules', '@google', 'gemini-cli'))
    }
  }
  if (env.APPDATA) pkgDirs.add(join(env.APPDATA, 'npm', 'node_modules', '@google', 'gemini-cli'))
  for (const pkg of pkgDirs) {
    try {
      const meta = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
      const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin?.gemini
      if (bin) candidates.push(join(pkg, bin))
    } catch {
      /* not here */
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null
}

/** Gemini's stream-json events → text and tool announcements. Exported for tests. */
export function createGeminiTranslator({ sink, serverOf, onSession, onStats }) {
  let text = ''
  let failure = null
  let status = null
  return {
    get text() {
      return text
    },
    get failure() {
      return failure
    },
    get status() {
      return status
    },
    handle(ev) {
      switch (ev?.type) {
        case 'init':
          if (ev.session_id) onSession?.(ev.session_id)
          break
        case 'message':
          if (ev.role === 'assistant' && typeof ev.content === 'string' && ev.content) {
            text += ev.content
            sink.text(ev.content)
          }
          break
        case 'tool_use': {
          const raw = String(ev.tool_name ?? '')
          // MCP tools arrive as "<tool>" or "mcp_<server>_<tool>"; built-ins by name.
          const bare = raw.replace(/^mcp_aurora_/, '').replace(/^aurora__/, '')
          const server = serverOf?.(bare)
          const name = server
            ? `mcp__${server}__${bare}`
            : /search/i.test(raw)
              ? 'WebSearch'
              : /fetch/i.test(raw)
                ? 'WebFetch'
                : raw
          if (name && !QUIET.test(name)) sink.tool(name)
          break
        }
        case 'error':
          if (ev.severity !== 'warning') failure ??= ev.message
          break
        case 'result':
          status = ev.status
          if (ev.status === 'error') failure = ev.error?.message ?? failure ?? 'falha no Gemini'
          onStats?.(ev.stats)
          break
      }
    },
  }
}

const NOT_LOGGED_IN =
  'O Gemini não está logado neste computador. Rode "gemini" no terminal uma vez e entre com a sua conta do Google.'

export function explainGeminiError(message) {
  const msg = String(message ?? '')
  if (/auth|login|credential|api key|GEMINI_API_KEY|unauthenticated|401|403/i.test(msg)) return NOT_LOGGED_IN
  if (/quota|rate limit|429|exhausted/i.test(msg)) return 'Atingimos o limite de uso do Gemini por enquanto. Tente de novo mais tarde.'
  return msg
}

export function createGeminiEngine(ctx) {
  const { profile, hub, operationalPrompt, allowWrites, port, addUsage } = ctx
  const entry = findGemini(profile)
  if (!entry) {
    throw Object.assign(
      new Error('Não encontrei o Gemini CLI. Instale com "npm install -g @google/gemini-cli" e rode "gemini" uma vez para entrar.'),
      { unavailable: true },
    )
  }

  // Its own working folder: Gemini keeps sessions per folder, and this one is empty.
  const work = join(AURORA_DIR, '.motores', 'gemini')
  mkdirSync(work, { recursive: true })
  const withBrain = brainEnabled(profile)
  const systemFile = join(work, 'sistema.md')
  writeFileSync(
    systemFile,
    `${personaPrompt(profile)}\n\n` + (withBrain ? `${brainPrompt(profile)}\n\n` : '') + operationalPrompt(false),
    'utf8',
  )
  const settingsFile = join(work, 'aurora-settings.json')
  writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        mcpServers: {
          aurora: {
            command: process.execPath,
            args: [PROXY],
            env: { AURORA_TOOLS_URL: `http://127.0.0.1:${port}/aurora-tools/${hub.token}` },
            // Her tools have their own permission gate in the bridge.
            trust: true,
            timeout: 60_000,
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  let sessionId = sessionToResume(profile, 'gemini')
  let resumed = Boolean(sessionId)
  if (sessionId) console.log(`[aurora] gemini: retomando a conversa ${sessionId.slice(0, 8)}…`)
  let child = null

  const engine = {
    dead: false,
    interrupt() {
      child?.kill()
    },
    close() {
      child?.kill()
    },
    run(text, { sink, route }, retry = true) {
      const fresh = !sessionId
      const id = sessionId ?? randomUUID()
      const model = route?.modelo || profile.gemini?.modelo
      const args = [
        entry,
        '--output-format',
        'stream-json',
        '--skip-trust',
        '--approval-mode',
        allowWrites ? 'yolo' : 'default',
        ...(fresh ? ['--session-id', id] : ['--resume', id]),
        ...(model ? ['-m', model] : []),
        // The request itself goes in on stdin: no command-line length limit,
        // and nothing in it is ever parsed as an option.
        '-p',
        ' ',
      ]
      let tools = 0
      const translator = createGeminiTranslator({
        sink: {
          text: sink.text,
          tool: (name) => {
            tools++
            sink.tool(name)
          },
        },
        serverOf: hub.serverOf,
        onSession: (sid) => {
          sessionId = sid
          rememberSession(sid, 'gemini')
        },
        onStats: (st) =>
          addUsage('gemini', {
            respostas: 1,
            ferramentas: tools,
            tokensEntrada: st?.input_tokens ?? 0,
            tokensSaida: st?.output_tokens ?? 0,
            tokensCache: st?.cached ?? 0,
            retomada: resumed,
            modelo: `Gemini${model ? ` · ${model}` : ''}`,
          }),
      })

      return new Promise((resolve) => {
        let stderr = ''
        let killed = false
        const proc = spawn(process.execPath, args, {
          cwd: work,
          env: {
            ...process.env,
            GEMINI_SYSTEM_MD: systemFile,
            GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile,
            GEMINI_CLI_TRUST_WORKSPACE: 'true',
            NO_COLOR: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        child = proc
        const origKill = proc.kill.bind(proc)
        proc.kill = (...a) => {
          killed = true
          return origKill(...a)
        }
        proc.stdin.on('error', () => {})
        proc.stdin.end(text, 'utf8')
        proc.stderr.on('data', (d) => {
          stderr = (stderr + d.toString()).slice(-4000)
        })
        createInterface({ input: proc.stdout }).on('line', (line) => {
          const t = line.trim()
          if (!t.startsWith('{')) return
          try {
            translator.handle(JSON.parse(t))
          } catch {
            /* not one of ours */
          }
        })
        proc.on('error', (err) => {
          child = null
          resolve({ unavailable: true, message: `Não deu para iniciar o Gemini: ${err.message}` })
        })
        proc.on('close', (code) => {
          if (child === proc) child = null
          if (killed) return resolve({ text: translator.text, interrupted: true })
          if (translator.status === 'success' || (code === 0 && translator.text)) {
            resumed = false
            return resolve({ text: translator.text })
          }
          const why = translator.failure ?? (stderr.trim().split('\n').slice(-3).join(' ') || `saiu com código ${code}`)
          // A saved session that no longer exists: start a new one once.
          if (!fresh && retry && /session/i.test(why) && !translator.text) {
            console.warn('[aurora] gemini: não deu para retomar a conversa; começando outra.')
            rememberSession(null, 'gemini')
            sessionId = null
            resumed = false
            return resolve(engine.run(text, { sink, route }, false))
          }
          const message = explainGeminiError(why)
          console.error('[aurora] gemini: turno falhou:', why)
          resolve(message === NOT_LOGGED_IN && !translator.text ? { unavailable: true, message } : { error: message })
        })
      })
    },
  }
  return engine
}
