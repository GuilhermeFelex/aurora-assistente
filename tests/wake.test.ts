// Testes da palavra de ativação ("Ei Aurora") e dos falsos positivos.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const load = async (perfil: Record<string, unknown>, tag: string) => {
  ;(globalThis as Record<string, unknown>).__AURORA__ = perfil
  return import(`../src/aurora.ts?${tag}`)
}

const nomes = ['aurora', 'arora', 'a urora']
const saudacoes = ['ei', 'oi', 'olá', 'e aí']

test('acorda com o nome, com ou sem saudação', async () => {
  const { WAKE } = await load({ nomes, saudacoes }, 'a')
  for (const t of ['Ei Aurora, que horas são', 'aurora qual o clima', 'Olá Aurora', 'oi arora', 'e aí aurora'])
    assert.ok(WAKE.test(t), t)
})

test('não acorda falando da aurora', async () => {
  const { WAKE } = await load({ nomes, saudacoes }, 'b')
  for (const t of ['vi a aurora boreal ontem', 'falei com a aurora', 'a aurora é linda', 'foto da aurora austral', 'boa noite'])
    assert.ok(!WAKE.test(t), t)
})

test('com exigirSaudacao, só o nome não basta', async () => {
  const { WAKE } = await load({ nomes, saudacoes, exigirSaudacao: true }, 'c')
  assert.ok(WAKE.test('ei aurora'))
  assert.ok(!WAKE.test('aurora, que horas são'))
})

test('valores padrão quando o perfil vem vazio', async () => {
  const { AURORA } = await load({}, 'd')
  assert.equal(AURORA.nome, 'Aurora')
  assert.equal(AURORA.tratamento, 'senhor')
})
