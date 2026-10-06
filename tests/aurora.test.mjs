// Testes do lado "cérebro" da Aurora: personalidade, memória, sessão e permissões.
// Rodam numa cópia temporária da pasta aurora/, nunca nos arquivos reais.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'aurora-teste-'))
let m

before(async () => {
  cpSync(new URL('../aurora', import.meta.url), dir, { recursive: true })
  rmSync(join(dir, 'memoria.json'), { force: true })
  rmSync(join(dir, 'sessao.json'), { force: true })
  process.env.AURORA_DIR = dir
  m = await import('../bridge/aurora.mjs')
})
after(() => rmSync(dir, { recursive: true, force: true }))

const call = (server, name, args) => {
  const t = server.instance._registeredTools[name]
  return (t.handler ?? t.callback)(args, {})
}

test('a personalidade troca os {{campos}} e remove comentários', () => {
  const p = m.personaPrompt()
  assert.match(p, /Você é Aurora/)
  assert.match(p, /senhor Felex/)
  assert.doesNotMatch(p, /\{\{/)
  assert.doesNotMatch(p, /<!--|-->/)
})

test('o conhecimento entra no prompt', () => {
  writeFileSync(join(dir, 'conhecimento', 'teste.privado.md'), '# Teste\n\nGosta de café sem açúcar.')
  assert.match(m.personaPrompt(), /café sem açúcar/)
})

test('um perfil quebrado não derruba nada', () => {
  const real = readFileSync(join(dir, 'perfil.json'), 'utf8')
  writeFileSync(join(dir, 'perfil.json'), '{ isso não é json')
  try {
    const p = m.loadProfile()
    assert.equal(p.assistente.nome, 'Aurora')
    assert.equal(p.modelo.nome, 'claude-sonnet-5')
  } finally {
    writeFileSync(join(dir, 'perfil.json'), real)
  }
})

test('memória: lembrar, não duplicar, listar e esquecer', async () => {
  const s = m.memoryServer()
  assert.match((await call(s, 'lembrar', { texto: 'Prefere reuniões de manhã.' })).content[0].text, /Guardado/)
  assert.match((await call(s, 'lembrar', { texto: 'prefere reuniões de manhã.' })).content[0].text, /já estava/)
  assert.match((await call(s, 'listar_memorias', {})).content[0].text, /#1 Prefere reuniões/)
  assert.match(m.personaPrompt(), /Prefere reuniões de manhã/)
  assert.match((await call(s, 'esquecer', { alvo: 'reuniões' })).content[0].text, /1 memória/)
  assert.match((await call(s, 'listar_memorias', {})).content[0].text, /vazia/)
})

test('sessão: retoma só se for recente', () => {
  m.rememberSession('abc-123')
  assert.equal(m.sessionToResume(), 'abc-123')
  writeFileSync(join(dir, 'sessao.json'), JSON.stringify({ id: 'velha', at: Date.now() - 2 * 3600_000 }))
  assert.equal(m.sessionToResume(), null)
  m.rememberSession(null)
  assert.equal(m.sessionToResume(), null)
})

test('permissões: bloquear vence permitir; nome curto = servidor inteiro', () => {
  const p = { permissoes: { permitir: ['spotify', 'mcp__agenda__criar*'], bloquear: ['mcp__spotify__apagar*', 'Bash'] } }
  assert.equal(m.permissionOverride('mcp__spotify__tocar', p), true)
  assert.equal(m.permissionOverride('mcp__spotify__apagar_playlist', p), false)
  assert.equal(m.permissionOverride('mcp__agenda__criar_evento', p), true)
  assert.equal(m.permissionOverride('mcp__agenda__apagar_evento', p), null)
  assert.equal(m.permissionOverride('Bash', p), false)
  assert.equal(m.permissionOverride('WebSearch', p), null)
})
