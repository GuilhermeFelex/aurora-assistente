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
  assert.match((await call(s, 'listar_memorias', {})).content[0].text, /memorias\[1\]\{id,texto,quando\}:\n  1,Prefere reuniões de manhã\.,/)
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

test('memória no cofre: migra o JSON, grava nota legível e aceita linhas escritas à mão', async () => {
  const vault = join(dir, 'cofre')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(vault, { recursive: true })
  const perfil = JSON.parse(readFileSync(join(dir, 'perfil.json'), 'utf8'))
  perfil.brain.pasta = vault
  writeFileSync(join(dir, 'perfil.json'), JSON.stringify(perfil))
  // memória antiga, ainda no JSON
  writeFileSync(join(dir, 'memoria.json'), JSON.stringify([{ id: 7, texto: 'Mora em São Paulo.', quando: '2026-10-01T10:00:00Z' }]))

  const lista = m.readMemories()
  assert.equal(lista.length, 1)
  const notaPath = join(vault, '07_IA_E_AGENTES', 'AURORA', 'memoria-da-aurora.md')
  const nota = readFileSync(notaPath, 'utf8')
  assert.match(nota, /^---\ntitulo: "Memória da Aurora"/)
  assert.match(nota, /- Mora em São Paulo\. \(2026-10-01\) \^m7/)
  assert.equal(m.readMemories().length, 1, 'não migra duas vezes')

  // o usuário acrescenta uma linha no Obsidian, sem número
  writeFileSync(notaPath, nota.replace('^m7\n', '^m7\n- Torce para o Corinthians.\n'))
  const s = m.memoryServer()
  await call(s, 'lembrar', { texto: 'Prefere respostas curtas.' })
  const depois = readFileSync(notaPath, 'utf8')
  assert.match(depois, /- Torce para o Corinthians\. \^m8/)
  assert.match(depois, /- Prefere respostas curtas\. \(\d{4}-\d{2}-\d{2}\) \^m9/)
  assert.match(depois, /\[\[07_IA_E_AGENTES\/ia-e-agentes\|IA e agentes\]\]/)
  assert.match(m.personaPrompt(), /Torce para o Corinthians/)
})

test('material de consulta: listado no prompt e aberto sob demanda', async () => {
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(dir, 'conhecimento', 'consulta'), { recursive: true })
  writeFileSync(join(dir, 'conhecimento', 'consulta', 'manual.md'), '# Manual do teste\n\nDetalhe longo.')
  const p = m.personaPrompt()
  assert.match(p, /consulta\[\d+\]\{arquivo,assunto\}:/)
  assert.match(p, /manual,Manual do teste/)
  assert.doesNotMatch(p, /Detalhe longo/)
  const r = await call(m.memoryServer(), 'consultar', { arquivo: 'manual' })
  assert.match(r.content[0].text, /Detalhe longo/)
  assert.equal((await call(m.memoryServer(), 'consultar', { arquivo: '../perfil' })).isError, true)
})
