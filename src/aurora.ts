/**
 * The browser's view of aurora/perfil.json, injected by vite.config.ts.
 * Everything has a default, so a missing or half-filled profile still works.
 */

type Raw = {
  nome?: string
  tratamento?: string
  tratamentoCurto?: string
  nomes?: string[]
  saudacoes?: string[]
  exigirSaudacao?: boolean
  vozes?: string[]
}

declare const __AURORA__: Raw | undefined

const raw: Raw = typeof __AURORA__ === 'object' && __AURORA__ ? __AURORA__ : {}

const list = (v: unknown, fallback: string[]) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length ? (v as string[]) : fallback

export const AURORA = {
  nome: raw.nome || 'Aurora',
  tratamento: raw.tratamento || 'senhor',
  tratamentoCurto: raw.tratamentoCurto || raw.tratamento || 'senhor',
  nomes: list(raw.nomes, ['aurora']),
  saudacoes: list(raw.saudacoes, ['ei', 'oi', 'olá', 'ola', 'hey', 'ok']),
  exigirSaudacao: raw.exigirSaudacao === true,
  vozes: list(raw.vozes, []),
}

/** Escape a phrase for a RegExp, and let any run of spaces in it match loosely. */
const esc = (s: string) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')

/** Alternation of her names, longest first so "aurorah" wins over "aurora". */
export const NAME_SRC = `(?:${[...AURORA.nomes]
  .sort((a, b) => b.length - a.length)
  .map(esc)
  .join('|')})`

/** Alternation of the greetings that may precede her name. */
export const GREETING_SRC = `(?:${[...AURORA.saudacoes]
  .sort((a, b) => b.length - a.length)
  .map(esc)
  .join('|')})`

/**
 * The wake phrase.
 *
 * "Aurora" is an ordinary word, so two guards keep conversation about the dawn
 * (or about her) from waking her:
 *   - not straight after an article or preposition: "a aurora", "da aurora",
 *     "na aurora", "uma aurora", "pela aurora";
 *   - not followed by "boreal" or "austral".
 * With `exigirSaudacao` on, a greeting ("ei", "oi"...) is mandatory as well.
 */
export const WAKE = new RegExp(
  (AURORA.exigirSaudacao ? `\\b${GREETING_SRC}[\\s,]+` : `(?:\\b${GREETING_SRC}[\\s,]+)?`) +
    `(?<!(?:^|\\s)(?:a|à|da|na|uma|pela|com\\s+a|sobre\\s+a)\\s+)` +
    `\\b${NAME_SRC}\\b(?!\\s+(?:boreal|austral))`,
  'i',
)
