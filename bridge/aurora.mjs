/**
 * Aurora's configurable side: profile, personality, knowledge and memory.
 *
 * Everything the user is meant to tune lives as plain files under aurora/:
 *
 *   aurora/perfil.json         names, wake words, model, voice, memory switch
 *   aurora/personalidade.md    who she is and how she talks (Portuguese prose)
 *   aurora/regras.md           extra standing rules
 *   aurora/conhecimento/*.md   things she should know (*.privado.md stay local)
 *   aurora/memoria.json        what she chose to remember (written by her)
 *
 * The files are re-read for every connection, so editing the Markdown and
 * reloading the page is enough. perfil.json is also read by vite.config.ts for
 * the browser half (wake words, display name), which is why a change there
 * wants an `npm start` restart.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// AURORA_DIR can be pointed elsewhere (the tests use a scratch copy).
export const AURORA_DIR =
  process.env.AURORA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'aurora')
const MEMORY_FILE = join(AURORA_DIR, 'memoria.json')
const SESSION_FILE = join(AURORA_DIR, 'sessao.json')

const DEFAULTS = {
  assistente: { nome: 'Aurora' },
  usuario: {
    nome: '',
    tratamento: 'senhor',
    tratamentoCurto: 'senhor',
    cidade: '',
    fusoHorario: 'America/Sao_Paulo',
  },
  modelo: { nome: 'claude-sonnet-5', esforco: 'medium' },
  voz: { elevenlabsVoiceId: 'EXAVITQu4vr4xnSDxMaL' },
  memoria: { ativa: true, limite: 200 },
  conversa: { retomarMinutos: 60 },
  permissoes: { permitir: [], bloquear: [] },
  brain: { ativo: true, pasta: '~/brain-aurora', escrita: 'inbox' },
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object'
        ? merge(base[k], v)
        : v
  }
  return out
}

/** perfil.json merged over the defaults. A broken file never stops the bridge. */
export function loadProfile() {
  try {
    const raw = readFileSync(join(AURORA_DIR, 'perfil.json'), 'utf8')
    return merge(DEFAULTS, JSON.parse(raw))
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn(`[aurora] perfil.json ignorado (${err.message}) — usando valores padrão.`)
    }
    return DEFAULTS
  }
}

/** Reads a Markdown file, minus HTML comments; '' when absent or empty. */
function readMd(path) {
  try {
    return readFileSync(path, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return ''
  }
}

/** {{usuario.tratamento}} → value from the profile. Unknown keys are left as they are. */
function fill(text, profile) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), profile)
    return v == null || typeof v === 'object' ? whole : String(v)
  })
}

function knowledge(profile) {
  const dir = join(AURORA_DIR, 'conhecimento')
  if (!existsSync(dir)) return ''
  const parts = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const body = readMd(join(dir, name))
    if (body) parts.push(fill(body, profile))
  }
  return parts.join('\n\n')
}

/* ------------------------------------------------------------------ memory */

function readMemories() {
  try {
    const list = JSON.parse(readFileSync(MEMORY_FILE, 'utf8'))
    return Array.isArray(list) ? list.filter((m) => m && typeof m.texto === 'string') : []
  } catch {
    return []
  }
}

function writeMemories(list) {
  // Write-then-rename, so a crash mid-write cannot leave half a JSON file.
  const tmp = `${MEMORY_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8')
  renameSync(tmp, MEMORY_FILE)
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

/**
 * Her long-term memory as tools. Writes only ever touch aurora/memoria.json,
 * so it is allowed in read-only mode: remembering a preference changes nothing
 * outside her own notebook.
 */
export function memoryServer() {
  return createSdkMcpServer({
    name: 'aurora_memoria',
    version: '1.0.0',
    instructions:
      'Memória de longo prazo da Aurora. Use `lembrar` quando o usuário contar algo duradouro ' +
      'sobre si (preferências, pessoas, datas, gostos) ou pedir para você lembrar de algo. ' +
      'Use `esquecer` quando ele pedir. Não anuncie que salvou; no máximo confirme em poucas palavras.',
    alwaysLoad: true,
    tools: [
      tool(
        'lembrar',
        'Guarda um fato duradouro sobre o usuário ou um pedido explícito de lembrar algo. ' +
          'Uma frase curta e autossuficiente, em português. Não guarde coisas passageiras.',
        { texto: z.string().min(3).max(500).describe('O fato, em uma frase. Ex.: "Prefere café sem açúcar."') },
        async ({ texto }) => {
          const profile = loadProfile()
          if (profile.memoria?.ativa === false) return text('A memória está desligada no perfil.', true)
          const list = readMemories()
          const clean = texto.trim()
          if (list.some((m) => m.texto.toLowerCase() === clean.toLowerCase())) {
            return text('Isso já estava guardado.')
          }
          const id = list.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0) + 1
          list.push({ id, texto: clean, quando: new Date().toISOString() })
          const limit = Math.max(1, Number(profile.memoria?.limite) || 200)
          writeMemories(list.slice(-limit))
          console.log(`[aurora] lembrar #${id}: ${clean}`)
          return text(`Guardado (#${id}).`)
        },
      ),
      tool(
        'esquecer',
        'Apaga memórias. Passe o número (#) ou um trecho do texto da memória.',
        { alvo: z.string().min(1).describe('Número da memória, ou um trecho do texto dela.') },
        async ({ alvo }) => {
          const list = readMemories()
          const q = alvo.trim().replace(/^#/, '').toLowerCase()
          const keep = list.filter((m) => String(m.id) !== q && !m.texto.toLowerCase().includes(q))
          const gone = list.length - keep.length
          if (!gone) return text('Nenhuma memória corresponde a isso.')
          writeMemories(keep)
          console.log(`[aurora] esquecer "${alvo}": ${gone} removida(s)`)
          return text(`${gone} memória(s) apagada(s).`)
        },
      ),
      tool('listar_memorias', 'Lista tudo o que está guardado na memória, com os números.', {}, async () => {
        const list = readMemories()
        return text(list.length ? list.map((m) => `#${m.id} ${m.texto}`).join('\n') : 'A memória está vazia.')
      }),
    ],
  })
}

/* ------------------------------------------------------------------ prompt */

function now(profile) {
  const tz = profile.usuario?.fusoHorario || 'America/Sao_Paulo'
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: tz,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date())
  } catch {
    return new Date().toString()
  }
}

/**
 * The persona half of the system prompt, assembled from the files. The
 * operational half (blades, browser, camera, tool etiquette) stays in
 * server.mjs, because it describes this program rather than her character.
 */
export function personaPrompt(profile = loadProfile()) {
  const sections = []

  const persona = readMd(join(AURORA_DIR, 'personalidade.md'))
  sections.push(
    persona
      ? fill(persona, profile)
      : `Você é ${profile.assistente.nome}, uma assistente de voz. Fale sempre em português do Brasil, no feminino, em frases curtas.`,
  )

  const rules = readMd(join(AURORA_DIR, 'regras.md'))
  if (rules) sections.push(`# Regras extras do usuário\n\n${fill(rules, profile)}`)

  const u = profile.usuario ?? {}
  const facts = [
    u.nome && `Nome do usuário: ${u.nome}.`,
    u.cidade && `Cidade: ${u.cidade}.`,
    `Data e hora quando esta conversa começou: ${now(profile)} (fuso ${u.fusoHorario || 'America/Sao_Paulo'}).`,
  ].filter(Boolean)
  sections.push(`# Contexto\n\n${facts.join('\n')}`)

  const known = knowledge(profile)
  if (known) sections.push(`# O que você sabe\n\n${known}`)

  if (profile.memoria?.ativa !== false) {
    const mem = readMemories()
    sections.push(
      '# Sua memória\n\n' +
        (mem.length
          ? 'Coisas que você guardou em conversas anteriores (use com naturalidade, sem citar os números):\n' +
            mem.map((m) => `- #${m.id} ${m.texto}`).join('\n')
          : 'Ainda vazia. Use a ferramenta `lembrar` para guardar fatos duradouros sobre o usuário.'),
    )
  }

  return sections.join('\n\n')
}

/* ----------------------------------------------------------------- session */

/**
 * The conversation to pick up again after a reload or a restart: the SDK's
 * session id, and when it was last used. Older than `conversa.retomarMinutos`
 * and a fresh conversation starts instead — yesterday's thread is what memory
 * is for.
 */
export function sessionToResume(profile = loadProfile()) {
  const minutes = Number(profile.conversa?.retomarMinutos ?? 60)
  if (!(minutes > 0)) return null
  try {
    const { id, at } = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
    if (typeof id !== 'string' || !id) return null
    return Date.now() - Number(at) < minutes * 60_000 ? id : null
  } catch {
    return null
  }
}

export function rememberSession(id) {
  try {
    if (id) writeFileSync(SESSION_FILE, JSON.stringify({ id, at: Date.now() }) + '\n', 'utf8')
    else writeFileSync(SESSION_FILE, '{}\n', 'utf8')
  } catch {
    /* not being able to resume later is not worth failing a turn over */
  }
}

/* ------------------------------------------------------------- permissions */

/**
 * One rule from perfil.json → permissoes.permitir / permissoes.bloquear, as a
 * matcher on the full tool name the SDK reports:
 *
 *   "spotify"              → every tool of the MCP server "spotify"
 *   "mcp__spotify__play*"  → a glob on the full name
 *   "WebFetch"             → a built-in tool by name
 */
function ruleToRegExp(rule) {
  const r = String(rule ?? '').trim()
  if (!r) return null
  const glob = /^[a-z0-9_-]+$/i.test(r) && !/^[A-Z]/.test(r) ? `mcp__${r}__*` : r
  const src = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${src}$`, 'i')
}

/**
 * The user's own word on a tool, ahead of the built-in read-only gate:
 * `false` when a "bloquear" rule matches (blocking always wins), `true` when a
 * "permitir" rule matches, `null` when neither says anything.
 */
export function permissionOverride(toolName, profile = loadProfile()) {
  const p = profile.permissoes ?? {}
  const matches = (list) =>
    (Array.isArray(list) ? list : []).some((rule) => ruleToRegExp(rule)?.test(toolName))
  if (matches(p.bloquear)) return false
  if (matches(p.permitir)) return true
  return null
}
