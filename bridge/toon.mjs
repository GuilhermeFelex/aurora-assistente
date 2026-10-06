/**
 * TOON (Token-Oriented Object Notation) — just the parts Aurora needs.
 *
 * Lists of records are what the model reads most from her tools (search hits,
 * notes in an area, memories), and JSON repeats every key on every row. TOON
 * states the fields once and then gives one line per record:
 *
 *   notas[2]{caminho,titulo,status}:
 *     00_HOME/inicio.md,Base central de conhecimento da FelexTech,ativo
 *     03_PROJETOS/SAAS-REACT/SAAS-REACT.md,SAAS-REACT,ativo
 *
 * Quoting follows the TOON rules for the comma delimiter: a value is quoted
 * when it is empty, has leading/trailing spaces, contains the delimiter, a
 * colon, a quote, a backslash, brackets/braces, a control character, or would
 * read as a number/boolean/null. Inside quotes, \\ \" \n \r \t are escaped.
 * Spec: https://github.com/toon-format/spec
 */

const NEEDS_QUOTES = /[,:"\\[\]{}\n\r\t]|^\s|\s$|^-/
const LOOKS_LITERAL = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/

function scalar(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'boolean') return String(v)
  const s = String(v)
  if (s === '' || NEEDS_QUOTES.test(s) || LOOKS_LITERAL.test(s)) {
    return (
      '"' +
      s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t') +
      '"'
    )
  }
  return s
}

/**
 * A uniform list of flat records as one TOON table.
 * @param {string} name   the key, e.g. "notas"
 * @param {object[]} rows the records
 * @param {string[]} [fields] which keys, in order (default: keys of the first row)
 */
export function toonTable(name, rows, fields) {
  const list = Array.isArray(rows) ? rows : []
  const keys = fields ?? Object.keys(list[0] ?? {})
  const head = `${name}[${list.length}]{${keys.join(',')}}:`
  if (!list.length) return head
  return [head, ...list.map((r) => '  ' + keys.map((k) => scalar(r?.[k])).join(','))].join('\n')
}

/** Flat key: value lines (nested values are not needed here). */
export function toonObject(obj) {
  return Object.entries(obj ?? {})
    .map(([k, v]) => `${k}: ${scalar(v)}`)
    .join('\n')
}
