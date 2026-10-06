// Testes do codificador TOON usado nas saídas das ferramentas.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toonObject, toonTable } from '../bridge/toon.mjs'

test('tabela uniforme: campos uma vez, uma linha por registro', () => {
  const t = toonTable('notas', [
    { caminho: '00_HOME/inicio.md', titulo: 'Início', status: 'ativo' },
    { caminho: '03_PROJETOS/x.md', titulo: 'Projeto X', status: null },
  ])
  assert.equal(t, 'notas[2]{caminho,titulo,status}:\n  00_HOME/inicio.md,Início,ativo\n  03_PROJETOS/x.md,Projeto X,null')
})

test('aspas quando o valor tem vírgula, dois-pontos, aspas ou parece número', () => {
  const t = toonTable('r', [{ a: 'um, dois', b: 'x: y', c: 'diz "oi"', d: '42', e: '', f: 'linha\nnova' }])
  assert.equal(t, 'r[1]{a,b,c,d,e,f}:\n  "um, dois","x: y","diz \\"oi\\"","42","","linha\\nnova"')
})

test('lista vazia e objeto simples', () => {
  assert.equal(toonTable('vazio', [], ['a']), 'vazio[0]{a}:')
  assert.equal(toonObject({ modelo: 'claude-sonnet-5', respostas: 3, ok: true }), 'modelo: claude-sonnet-5\nrespostas: 3\nok: true')
})
