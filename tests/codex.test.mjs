// Testes do motor Codex (ChatGPT): tradução dos eventos, ponte de ferramentas
// (toolhub + mcp-proxy, de ponta a ponta) e separação das conversas por motor.
// Nada aqui precisa de conta do ChatGPT.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const dir = mkdtempSync(join(tmpdir(), 'aurora-codex-'))
let aurora, codex, hub

before(async () => {
  cpSync(new URL('../aurora', import.meta.url), dir, { recursive: true })
  rmSync(join(dir, 'sessao.json'), { force: true })
  process.env.AURORA_DIR = dir
  aurora = await import('../bridge/aurora.mjs')
  codex = await import('../bridge/engine-codex.mjs')
  hub = await import('../bridge/toolhub.mjs')
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('engineOf escolhe o motor padrão pelo perfil (e aceita apelidos)', () => {
  assert.equal(aurora.engineOf({}), 'claude')
  assert.equal(aurora.engineOf({ motor: 'codex' }), 'codex')
  assert.equal(aurora.engineOf({ motor: ' ChatGPT ' }), 'codex')
  assert.equal(aurora.engineOf({ motores: { padrao: 'Ollama' } }), 'llama')
  assert.equal(aurora.engineOf({ motores: { padrao: 'gemini' }, motor: 'codex' }), 'gemini')
  assert.equal(aurora.engineOf({ motor: 'qualquer' }), 'claude')
})

test('cada motor guarda e retoma a própria conversa', () => {
  aurora.rememberSession('thread-codex', 'codex')
  assert.equal(aurora.sessionToResume(undefined, 'codex'), 'thread-codex')
  assert.equal(aurora.sessionToResume(undefined, 'claude'), null)
  aurora.rememberSession('sessao-claude')
  assert.equal(aurora.sessionToResume(), 'sessao-claude')
  assert.equal(aurora.sessionToResume(undefined, 'codex'), 'thread-codex')
  aurora.rememberSession(null, 'codex')
  assert.equal(aurora.sessionToResume(undefined, 'codex'), null)
  assert.equal(aurora.sessionToResume(), 'sessao-claude')
  aurora.rememberSession(null)
})

test('o tradutor transforma eventos do Codex nos quadros da ponte', () => {
  const sent = []
  let thread, usage
  const t = codex.createTranslator({
    sendTurn: (m) => sent.push(m),
    serverOf: (name) => ({ lembrar: 'aurora_memoria', display: 'jarvis' })[name],
    onThread: (id) => (thread = id),
    onUsage: (u) => (usage = u),
  })
  const evs = [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'item.started', item: { id: 'a', type: 'mcp_tool_call', server: 'aurora', tool: 'lembrar' } },
    { type: 'item.completed', item: { id: 'a', type: 'mcp_tool_call', server: 'aurora', tool: 'lembrar' } },
    { type: 'item.started', item: { id: 'b', type: 'web_search' } },
    { type: 'item.started', item: { id: 'c', type: 'mcp_tool_call', server: 'aurora', tool: 'display' } },
    { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'Pois não,' } },
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Pois não, senhor.' } },
    { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Feito.' } },
  ]
  for (const e of evs) assert.equal(t.handle(e), null)
  assert.equal(t.handle({ type: 'turn.completed', usage: { input_tokens: 5 } }), 'done')
  assert.equal(thread, 't1')
  assert.deepEqual(usage, { input_tokens: 5 })
  assert.deepEqual(sent, [
    { type: 'tool', name: 'mcp__aurora_memoria__lembrar' },
    { type: 'tool', name: 'WebSearch' },
    { type: 'text', delta: 'Pois não,' },
    { type: 'text', delta: ' senhor.' },
    { type: 'text', delta: ' Feito.' },
  ])
  assert.equal(t.finalText, 'Pois não, senhor. Feito.')
  assert.deepEqual(t.handle({ type: 'turn.failed', error: { message: 'x' } }), { error: 'x' })
})

test('as ferramentas da Aurora chegam ao Codex pelo proxy MCP, com o portão de permissões', async () => {
  const calls = []
  const srv = createSdkMcpServer({
    name: 'teste',
    tools: [
      tool('eco', 'Repete o texto', { texto: z.string() }, async ({ texto }) => {
        calls.push(texto)
        return { content: [{ type: 'text', text: `eco: ${texto}` }] }
      }),
      tool('proibida', 'Nunca deve rodar', {}, async () => {
        calls.push('proibida')
        return { content: [] }
      }),
    ],
  })
  const reg = hub.registerTools({ teste: srv }, (full) => full !== 'mcp__teste__proibida')
  assert.equal(reg.serverOf('eco'), 'teste')

  const http = createServer(async (req, res) => {
    if (!(await hub.handleToolRequest(req, res))) res.writeHead(404).end()
  })
  await new Promise((r) => http.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${http.address().port}/aurora-tools`

  // Um navegador (com Origin) é recusado; um token desconhecido também.
  assert.equal((await fetch(`${base}/${reg.token}/list`, { headers: { origin: 'http://x' } })).status, 403)
  assert.equal((await fetch(`${base}/${'0'.repeat(36)}/list`)).status, 404)

  const client = new Client({ name: 'teste', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../bridge/mcp-proxy.mjs', import.meta.url))],
      env: { ...process.env, AURORA_TOOLS_URL: `${base}/${reg.token}` },
    }),
  )
  try {
    const { tools } = await client.listTools()
    const eco = tools.find((t) => t.name === 'eco')
    assert.ok(eco)
    assert.equal(eco.inputSchema.properties.texto.type, 'string')

    const ok = await client.callTool({ name: 'eco', arguments: { texto: 'olá' } })
    assert.equal(ok.content[0].text, 'eco: olá')

    const bad = await client.callTool({ name: 'eco', arguments: { texto: 3 } })
    assert.equal(bad.isError, true)

    const denied = await client.callTool({ name: 'proibida', arguments: {} })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, /Bloqueado/)
    assert.deepEqual(calls, ['olá'])
  } finally {
    await client.close()
    reg.close()
    http.close()
  }
  assert.equal((await fetch(`${base}/${reg.token}/list`).catch(() => null))?.status ?? 404, 404)
})
