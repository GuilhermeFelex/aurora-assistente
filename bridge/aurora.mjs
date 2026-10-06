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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brainEnabled, vaultPath } from './brain.mjs'
import { toonTable } from './toon.mjs'

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
  motor: 'claude',
  motores: { padrao: null, reserva: 'claude', classificador: 'palavras', tipos: {} },
  codex: { modelo: '', esforco: 'medium', imagens: true },
  gemini: { modelo: '' },
  llama: { modelo: 'llama3.1:8b', url: 'http://127.0.0.1:11434', ferramentas: true, contexto: 8192 },
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
    // Files marked <!-- sob-demanda --> are reference material: listed in the
    // prompt, opened with `consultar` only when needed.
    if (onDemand(join(dir, name))) continue
    const body = readMd(join(dir, name))
    if (body) parts.push(fill(body, profile))
  }
  return parts.join('\n\n')
}

/* ------------------------------------------------------------------ memory */

/**
 * Where her memory lives.
 *
 * With the brain-aurora vault available (and memoria.local not "local"), it is
 * one Markdown note in the vault, so it can be read, searched and edited in
 * Obsidian like everything else:
 *
 *   ## Fatos
 *   - Prefere café sem açúcar. (2026-10-06) ^m1
 *
 * "^m1" is a native Obsidian block id, which doubles as the memory's number.
 * Without the vault it falls back to aurora/memoria.json, as before. The
 * first time the vault is used, anything in memoria.json is moved over and
 * the JSON is kept as memoria.migrada.json — nothing is deleted.
 */
const DEFAULT_MEMORY_NOTE = '07_IA_E_AGENTES/AURORA/memoria-da-aurora.md'

function memoryNote(profile) {
  if (profile.memoria?.local === 'local' || !brainEnabled(profile)) return null
  return join(vaultPath(profile), profile.memoria?.notaBrain || DEFAULT_MEMORY_NOTE)
}

function today(profile) {
  return new Date().toLocaleDateString('sv-SE', { timeZone: profile.usuario?.fusoHorario || 'America/Sao_Paulo' })
}

function readJsonMemories() {
  try {
    const list = JSON.parse(readFileSync(MEMORY_FILE, 'utf8'))
    return Array.isArray(list) ? list.filter((m) => m && typeof m.texto === 'string') : []
  } catch {
    return []
  }
}

const BULLET = /^- (.+?)(?: \((\d{4}-\d{2}-\d{2})\))?(?: \^m(\d+))?\s*$/

/** The "## Fatos" bullets of the vault note; lines added by hand get numbers on the next write. */
export function parseMemoryNote(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Fatos\s*$/i.test(l))
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) {
    const m = BULLET.exec(lines[i].trim())
    if (m) out.push({ id: m[3] ? Number(m[3]) : null, texto: m[1].trim(), quando: m[2] ?? null })
  }
  return out
}

function renderMemoryNote(list, previous, profile) {
  const date = today(profile)
  const bullets = list.map((m) => `- ${m.texto}${m.quando ? ` (${String(m.quando).slice(0, 10)})` : ''} ^m${m.id}`)
  if (previous && /^##\s+Fatos\s*$/im.test(previous)) {
    // Keep everything the user wrote around the list; only the list and the
    // update date change.
    const lines = previous.split(/\r?\n/)
    const start = lines.findIndex((l) => /^##\s+Fatos\s*$/i.test(l))
    let end = start + 1
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end]) && !/^\[\[/.test(lines[end])) end++
    const out = [...lines.slice(0, start + 1), '', ...bullets, '', ...lines.slice(end)]
    return out.join('\n').replace(/^data_atualizacao: .*$/m, `data_atualizacao: "${date}"`)
  }
  return [
    '---',
    'titulo: "Memória da Aurora"',
    'tipo: "memoria"',
    'status: "ativo"',
    `data_criacao: "${date}"`,
    `data_atualizacao: "${date}"`,
    'tags: ["aurora", "memoria"]',
    'projeto: null',
    'produto: null',
    'cliente: null',
    'fonte: ["conversas com a Aurora"]',
    'relacionados: []',
    'confidencialidade: "interno"',
    '---',
    '',
    '# Memória da Aurora',
    '',
    'Fatos duradouros que a Aurora guardou nas conversas por voz. Ela lê esta nota no começo de cada conversa.',
    'Pode editar à vontade: uma linha por fato, no formato `- texto (AAAA-MM-DD) ^m12`. Linhas sem o `^m` ganham um número sozinhas.',
    '',
    '## Fatos',
    '',
    ...bullets,
    '',
    '[[07_IA_E_AGENTES/ia-e-agentes|IA e agentes]]',
    '',
  ].join('\n')
}

/** Give hand-written lines a number, keeping existing ones. */
function numbered(list) {
  let next = list.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0)
  return list.map((m) => (m.id ? m : { ...m, id: ++next }))
}

export function readMemories(profile = loadProfile()) {
  const note = memoryNote(profile)
  if (!note) return readJsonMemories()
  let list = []
  try {
    list = parseMemoryNote(readFileSync(note, 'utf8'))
  } catch {
    list = []
  }
  // One-time move of the old JSON memory into the vault.
  const old = readJsonMemories()
  if (old.length) {
    const have = new Set(list.map((m) => m.texto.toLowerCase()))
    const used = new Set(list.map((m) => m.id).filter(Boolean))
    const moved = old
      .filter((m) => !have.has(m.texto.toLowerCase()))
      .map((m) => {
        const id = Number(m.id) || null
        const keep = id && !used.has(id)
        if (keep) used.add(id)
        return { ...m, id: keep ? id : null }
      })
    const merged = numbered([...list, ...moved])
    writeMemories(merged, profile)
    try {
      renameSync(MEMORY_FILE, join(AURORA_DIR, 'memoria.migrada.json'))
      console.log(`[aurora] memória movida para o brain-aurora (${relative(vaultPath(profile), note)})`)
    } catch {
      /* the merge already happened; the rename only stops it repeating */
    }
    return merged
  }
  return numbered(list)
}

export function writeMemories(list, profile = loadProfile()) {
  const note = memoryNote(profile)
  const target = note ?? MEMORY_FILE
  const body = note
    ? renderMemoryNote(numbered(list), existsSync(note) ? readFileSync(note, 'utf8') : null, profile)
    : JSON.stringify(list, null, 2) + '\n'
  // Write-then-rename, so a crash mid-write cannot leave half a file.
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, target)
}

/* --------------------------------------------------- on-demand knowledge */

/**
 * Reference material that does not need to ride along on every turn:
 * aurora/conhecimento/consulta/*.md. Only the list (name + first heading) goes
 * into the prompt; she opens a file with `consultar` when a question needs it.
 */
const REFERENCE_DIR = () => join(AURORA_DIR, 'conhecimento', 'consulta')
const ON_DEMAND = /<!--\s*sob-demanda\s*-->/i

function onDemand(path) {
  try {
    return ON_DEMAND.test(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
}

/** consulta/*.md, plus any conhecimento/*.md marked <!-- sob-demanda -->. */
function referencePaths() {
  const out = new Map()
  const consulta = REFERENCE_DIR()
  if (existsSync(consulta)) {
    for (const n of readdirSync(consulta).filter((n) => n.endsWith('.md'))) out.set(n.replace(/\.md$/, ''), join(consulta, n))
  }
  const base = join(AURORA_DIR, 'conhecimento')
  if (existsSync(base)) {
    for (const n of readdirSync(base).filter((n) => n.endsWith('.md'))) {
      if (onDemand(join(base, n))) out.set(n.replace(/\.md$/, ''), join(base, n))
    }
  }
  return out
}

function referenceFiles() {
  return [...referencePaths()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([arquivo, path]) => {
      const body = readMd(path)
      const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? arquivo
      return { arquivo, assunto: title }
    })
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

/**
 * Her long-term memory (and the on-demand knowledge) as tools. Writes only
 * touch her own memory note / file, so they are allowed in read-only mode.
 */
export function memoryServer() {
  return createSdkMcpServer({
    name: 'aurora_memoria',
    version: '1.0.0',
    instructions:
      'Memória de longo prazo da Aurora. Use `lembrar` quando o usuário contar algo duradouro ' +
      'sobre si (preferências, pessoas, datas, gostos) ou pedir para você lembrar de algo. ' +
      'Use `esquecer` quando ele pedir. Não anuncie que salvou; no máximo confirme em poucas palavras. ' +
      'Use `consultar` para abrir um arquivo de consulta listado no seu prompt.',
    alwaysLoad: true,
    tools: [
      tool(
        'lembrar',
        'Guarda um fato duradouro sobre o usuário ou um pedido explícito de lembrar algo. ' +
          'Uma frase curta e autossuficiente, em português. Não guarde coisas passageiras nem segredos.',
        { texto: z.string().min(3).max(500).describe('O fato, em uma frase. Ex.: "Prefere café sem açúcar."') },
        async ({ texto }) => {
          const profile = loadProfile()
          if (profile.memoria?.ativa === false) return text('A memória está desligada no perfil.', true)
          const list = readMemories(profile)
          const clean = texto.trim().replace(/\s+/g, ' ').replace(/\^m\d+/g, '')
          if (list.some((m) => m.texto.toLowerCase() === clean.toLowerCase())) {
            return text('Isso já estava guardado.')
          }
          const id = list.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0) + 1
          list.push({ id, texto: clean, quando: today(profile) })
          const limit = Math.max(1, Number(profile.memoria?.limite) || 200)
          writeMemories(list.slice(-limit), profile)
          console.log(`[aurora] lembrar #${id}: ${clean}`)
          return text(`Guardado (#${id}).`)
        },
      ),
      tool(
        'esquecer',
        'Apaga memórias. Passe o número (#) ou um trecho do texto da memória.',
        { alvo: z.string().min(1).describe('Número da memória, ou um trecho do texto dela.') },
        async ({ alvo }) => {
          const profile = loadProfile()
          const list = readMemories(profile)
          const q = alvo.trim().replace(/^#/, '').toLowerCase()
          const keep = list.filter((m) => String(m.id) !== q && !m.texto.toLowerCase().includes(q))
          const gone = list.length - keep.length
          if (!gone) return text('Nenhuma memória corresponde a isso.')
          writeMemories(keep, profile)
          console.log(`[aurora] esquecer "${alvo}": ${gone} removida(s)`)
          return text(`${gone} memória(s) apagada(s).`)
        },
      ),
      tool('listar_memorias', 'Lista tudo o que está guardado na memória, com os números.', {}, async () => {
        const list = readMemories()
        return text(list.length ? toonTable('memorias', list, ['id', 'texto', 'quando']) : 'A memória está vazia.')
      }),
      tool(
        'consultar',
        'Abre um arquivo de consulta da pasta aurora/conhecimento/consulta (os nomes estão no seu prompt).',
        { arquivo: z.string().describe('Nome do arquivo, sem .md. Ex.: "sobre-a-aurora".') },
        async ({ arquivo }) => {
          const name = String(arquivo).replace(/\.md$/i, '').replace(/[^\w.-]/g, '')
          const full = referencePaths().get(name)
          if (!name || !full) {
            return text(`Arquivo não encontrado. Disponíveis: ${referenceFiles().map((f) => f.arquivo).join(', ') || 'nenhum'}.`, true)
          }
          return text(fill(readMd(full), loadProfile()))
        },
      ),
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

  const refs = referenceFiles()
  if (refs.length) {
    sections.push(
      '# Material de consulta (abra com a ferramenta `consultar` só quando precisar)\n\n' +
        toonTable('consulta', refs, ['arquivo', 'assunto']),
    )
  }

  if (profile.memoria?.ativa !== false) {
    const mem = readMemories(profile)
    sections.push(
      '# Sua memória\n\n' +
        (mem.length
          ? 'Coisas que você guardou em conversas anteriores (use com naturalidade, sem citar os números):\n' +
            toonTable('memorias', mem, ['id', 'texto', 'quando'])
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
function readSessions() {
  try {
    const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
    // Old single-session format: { id, at, motor? }.
    if (typeof saved?.id === 'string') return { [saved.motor ?? 'claude']: { id: saved.id, at: saved.at } }
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  } catch {
    return {}
  }
}

/** Each engine keeps its own conversation: a Claude session id means nothing to Codex. */
export function sessionToResume(profile = loadProfile(), motor = 'claude') {
  const minutes = Number(profile.conversa?.retomarMinutos ?? 60)
  if (!(minutes > 0)) return null
  const entry = readSessions()[motor]
  if (typeof entry?.id !== 'string' || !entry.id) return null
  return Date.now() - Number(entry.at) < minutes * 60_000 ? entry.id : null
}

export function rememberSession(id, motor = 'claude') {
  try {
    const all = readSessions()
    if (id) all[motor] = { id, at: Date.now() }
    else delete all[motor]
    writeFileSync(SESSION_FILE, JSON.stringify(all) + '\n', 'utf8')
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

/** Which engine runs her: "claude" (default) or "codex". AURORA_MOTOR overrides. */
/** The engine used when no route applies (motores.padrao, or the older "motor"). */
export function engineOf(profile = loadProfile()) {
  return normalizeEngine(process.env.AURORA_MOTOR ?? profile.motores?.padrao ?? profile.motor) ?? 'claude'
}

const ENGINE_ALIASES = {
  claude: 'claude', anthropic: 'claude',
  codex: 'codex', chatgpt: 'codex', openai: 'codex', gpt: 'codex',
  gemini: 'gemini', google: 'gemini',
  llama: 'llama', ollama: 'llama', local: 'llama',
}

/** "ChatGPT" → "codex", "Ollama" → "llama"; null for anything unknown. */
export function normalizeEngine(name) {
  const key = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '')
  return ENGINE_ALIASES[key] ?? null
}
