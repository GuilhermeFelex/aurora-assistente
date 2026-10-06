/**
 * Which engine answers each request — perfil.json → "motores".
 *
 *   "motores": {
 *     "padrao": "gemini",              // conversa do dia a dia (nenhum tipo se aplicou)
 *     "reserva": "claude",             // se o motor escolhido não estiver disponível
 *     "classificador": "palavras+llama",
 *     "tipos": {
 *       "imagem":   { "motor": "codex", "palavras": ["gera uma imagem", "desenha"] },
 *       "web":      { "motor": "codex", "palavras": ["pesquisa", "noticia"] },
 *       "complexa": { "motor": "claude", "modelo": "claude-opus-5", "palavras": ["analisa"], "minPalavras": 35 },
 *       "rapida":   { "motor": "llama", "palavras": ["que horas"], "maxPalavras": 10 }
 *     }
 *   }
 *
 * Order of decision, cheapest first:
 *   1. The user names an engine ("pergunta pro Gemini …").
 *   2. A type's keywords (accents and case ignored), in the order the types
 *      are written. `maxPalavras` limits a type to short requests.
 *   3. A type's `minPalavras` alone (long requests → "complexa").
 *   4. With "palavras+llama", the local Llama picks a type — free, on this PC.
 *   5. motores.padrao.
 *
 * Everything here is pure, so it is tested without any engine running.
 */

import { normalizeEngine } from './aurora.mjs'

export const ENGINES = ['claude', 'codex', 'gemini', 'llama']

export const ENGINE_LABEL = {
  claude: 'Claude',
  codex: 'ChatGPT (Codex)',
  gemini: 'Gemini',
  llama: 'Llama (local)',
}

/** "Llama · llama3.1:8b", "Claude · haiku" — what the page shows under an answer. */
export function engineLabel(engine, profile = {}, modelo = null) {
  const model =
    modelo ||
    (engine === 'claude'
      ? process.env.JARVIS_MODEL || profile.modelo?.nome
      : engine === 'codex'
        ? profile.codex?.modelo
        : engine === 'gemini'
          ? profile.gemini?.modelo
          : engine === 'llama'
            ? profile.llama?.modelo || 'llama3.1:8b'
            : null)
  const name = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Gemini', llama: 'Llama' }[engine] ?? engine
  return model ? `${name} · ${model}` : name
}

/** Lowercase, no accents, single spaces — what keywords are compared against. */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const wordCount = (text) => fold(text).split(' ').filter(Boolean).length

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A keyword matches at the start of a word: "pesquis" finds "pesquisar". */
const keywordRegExp = (words) => {
  const list = (Array.isArray(words) ? words : [])
    .map((w) => fold(w))
    .filter(Boolean)
    .map(escape)
  return list.length ? new RegExp(`(?:^|[^a-z0-9])(?:${list.join('|')})`) : null
}

/** perfil.json → a routing table with its defaults filled in. */
export function routingOf(profile = {}) {
  const m = profile.motores ?? {}
  const padrao = normalizeEngine(process.env.AURORA_MOTOR ?? m.padrao ?? profile.motor) ?? 'claude'
  const reserva = normalizeEngine(m.reserva) ?? 'claude'
  const tipos = Object.entries(m.tipos ?? {})
    .map(([nome, t]) => ({
      nome,
      motor: normalizeEngine(t?.motor),
      modelo: typeof t?.modelo === 'string' && t.modelo.trim() ? t.modelo.trim() : null,
      esforco: typeof t?.esforco === 'string' && t.esforco.trim() ? t.esforco.trim() : null,
      descricao: typeof t?.descricao === 'string' ? t.descricao : '',
      match: keywordRegExp(t?.palavras),
      minPalavras: Number(t?.minPalavras) > 0 ? Number(t.minPalavras) : null,
      maxPalavras: Number(t?.maxPalavras) > 0 ? Number(t.maxPalavras) : null,
    }))
    .filter((t) => t.motor && t.nome)
  const classificador = String(m.classificador ?? 'palavras').toLowerCase()
  return { padrao, reserva, tipos, usarLlama: classificador.includes('llama') }
}

/**
 * "pergunta pro gemini …", "usa o chatgpt", "no claude": the user's own choice.
 * Returns the engine and the request with the instruction taken out.
 */
const EXPLICIT =
  /(?:^|[\s,])(?:pergunt[ae]\w*\s+(?:pro|pra|para o|para a|ao|a)|us[ae]\w*\s+(?:o|a)|pel[oa]|com o|com a|no|na|via)\s+(claude|chat\s?gpt|codex|gemini|llama|ollama|lhama)\b[\s,:]*/i

export function explicitEngine(text) {
  const m = EXPLICIT.exec(String(text ?? ''))
  if (!m) return null
  const motor = normalizeEngine(m[1].replace(/lhama/i, 'llama'))
  if (!motor) return null
  const rest = (String(text).slice(0, m.index) + ' ' + String(text).slice(m.index + m[0].length)).trim()
  return { motor, texto: rest || String(text) }
}

/**
 * The cheap part of the decision. Returns a route, or null when only the
 * classifier (or the default) can decide.
 */
export function classify(text, routing) {
  const named = explicitEngine(text)
  if (named) return { tipo: 'pedido', motor: named.motor, modelo: null, esforco: null, por: 'pedido', texto: named.texto }

  const folded = fold(text)
  const words = wordCount(text)
  for (const t of routing.tipos) {
    if (!t.match || !t.match.test(folded)) continue
    if (t.maxPalavras && words > t.maxPalavras) continue
    return { tipo: t.nome, motor: t.motor, modelo: t.modelo, esforco: t.esforco, por: 'palavra', texto: text }
  }
  for (const t of routing.tipos) {
    if (t.minPalavras && words >= t.minPalavras && (!t.maxPalavras || words <= t.maxPalavras)) {
      return { tipo: t.nome, motor: t.motor, modelo: t.modelo, esforco: t.esforco, por: 'tamanho', texto: text }
    }
  }
  return null
}

export const defaultRoute = (routing, text) => ({
  tipo: 'conversa',
  motor: routing.padrao,
  modelo: null,
  esforco: null,
  por: 'padrao',
  texto: text,
})

/** The route for a type the classifier named; null if it named nothing we know. */
export function routeForType(routing, nome, text) {
  const key = fold(nome).replace(/[^a-z0-9_-]/g, '')
  const t = routing.tipos.find((x) => fold(x.nome) === key)
  if (!t) return null
  return { tipo: t.nome, motor: t.motor, modelo: t.modelo, esforco: t.esforco, por: 'classificador', texto: text }
}

/** The short instruction the local classifier gets. */
export function classifierPrompt(routing, text) {
  const lines = routing.tipos.map((t) => `- ${t.nome}${t.descricao ? `: ${t.descricao}` : ''}`)
  return (
    'Classifique o pedido do usuário em UM destes tipos e responda só com o nome do tipo, sem mais nada.\n' +
    `${lines.join('\n')}\n- conversa: qualquer outra coisa (bate-papo, dúvidas do dia a dia)\n\n` +
    `Pedido: ${String(text).slice(0, 600)}\nTipo:`
  )
}

/**
 * What the next engine should know when it takes over mid-conversation: the
 * turns it did not see, newest last, trimmed so it stays cheap.
 */
export function handoffContext(transcript, engine, { maxTurns = 6, maxChars = 500 } = {}) {
  if (!transcript.length) return ''
  // Turns since this engine last answered — it already knows the rest.
  let start = 0
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].motor === engine) {
      start = i + 1
      break
    }
  }
  const unseen = transcript.slice(start).slice(-maxTurns)
  if (!unseen.length) return ''
  const cut = (s) => (s.length > maxChars ? `${s.slice(0, maxChars)}…` : s)
  const body = unseen
    .map((t) => `Usuário: ${cut(t.pergunta)}\nVocê (via ${ENGINE_LABEL[t.motor] ?? t.motor}): ${cut(t.resposta || '(sem resposta)')}`)
    .join('\n\n')
  return (
    '[Contexto: trechos recentes desta conversa, respondidos por outro motor. ' +
    'Use se for útil; não comente a troca de motor.]\n' +
    `${body}\n\n[Pedido atual]\n`
  )
}
