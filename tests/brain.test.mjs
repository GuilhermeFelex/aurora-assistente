// Testes da integração com o brain-aurora (cofre do Obsidian), num cofre falso.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brainEnabled, brainServer, frontMatter, searchVault } from '../bridge/brain.mjs'

const vault = mkdtempSync(join(tmpdir(), 'brain-teste-'))
after(() => rmSync(vault, { recursive: true, force: true }))

const note = (rel, meta, body) => {
  mkdirSync(join(vault, rel, '..'), { recursive: true })
  const fm = Object.entries(meta).map(([k, v]) => `${k}: "${v}"`).join('\n')
  writeFileSync(join(vault, rel), `---\n${fm}\n---\n\n${body}\n`)
}
note('03_PROJETOS/SAAS-REACT/SAAS-REACT.md', { titulo: 'SAAS-REACT', status: 'ativo' }, '# SAAS-REACT\n\n## Migração\n\nMigração do frontend para React em andamento.\n\n## Outro\n\nNada.')
note('98_TEMPLATES/template-nota.md', { titulo: 'Template' }, 'migração react modelo')
note('16_PESQUISAS/indexacao.md', { titulo: 'Indexação', status: 'precisa-validacao' }, 'Contrato de indexação proposto.')
mkdirSync(join(vault, '90_INBOX'), { recursive: true })

const profile = { brain: { pasta: vault }, usuario: { fusoHorario: 'America/Sao_Paulo' } }
const s = brainServer(profile)
const call = (name, args) => {
  const t = s.instance._registeredTools[name]
  return (t.handler ?? t.callback)(args, {})
}

test('detecta o cofre configurado', () => {
  assert.equal(brainEnabled(profile), true)
  assert.equal(brainEnabled({ brain: { pasta: join(vault, 'nao-existe') } }), false)
  assert.equal(brainEnabled({ brain: { pasta: vault, ativo: false } }), false)
})

test('lê o front matter', () => {
  assert.equal(frontMatter('---\ntitulo: "X"\ncliente: null\n---\ncorpo').meta.titulo, 'X')
})

test('busca sem acento e ignorando templates', () => {
  const hits = searchVault(vault, 'migracao react')
  assert.equal(hits[0].caminho, '03_PROJETOS/SAAS-REACT/SAAS-REACT.md')
  assert.ok(hits.every((h) => !h.caminho.startsWith('98_TEMPLATES')))
  assert.equal(searchVault(vault, 'indexação')[0].status, 'precisa-validacao')
})

test('lê uma seção e não sai do cofre', async () => {
  const sec = (await call('brain_ler', { caminho: '03_PROJETOS/SAAS-REACT/SAAS-REACT', secao: 'migração' })).content[0].text
  assert.match(sec, /^## Migração/)
  assert.doesNotMatch(sec, /Nada\./)
  assert.equal((await call('brain_ler', { caminho: '../../../etc/passwd' })).isError, true)
})

test('captura cria nota nova na Inbox, no modelo, e recusa segredos', async () => {
  const r = await call('brain_capturar', { titulo: 'Ideia nova', conteudo: 'Testar a Aurora.' })
  assert.match(r.content[0].text, /90_INBOX\/\d{4}-\d{2}-\d{2}-ideia-nova\.md/)
  const r2 = await call('brain_capturar', { titulo: 'Ideia nova', conteudo: 'De novo.' })
  assert.match(r2.content[0].text, /ideia-nova-2\.md/)
  const files = readdirSync(join(vault, '90_INBOX'))
  const body = readFileSync(join(vault, '90_INBOX', files[0]), 'utf8')
  assert.match(body, /status: "precisa-validacao"/)
  assert.equal((await call('brain_capturar', { titulo: 'Chave', conteudo: 'token: abcdef123456' })).isError, true)
})

test('com escrita "nao", não existe ferramenta de escrita', () => {
  const ro = brainServer({ brain: { pasta: vault, escrita: 'nao' } })
  assert.equal('brain_capturar' in ro.instance._registeredTools, false)
})
