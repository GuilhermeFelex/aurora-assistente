// Testes da divisão de trabalho entre motores: roteamento por tipo de pedido,
// troca de motor com contexto, motor reserva, interrupção, Gemini e Llama —
// tudo com motores falsos, sem conta nenhuma.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'aurora-motores-'))
let router, connection, gemini, llama, aurora

before(async () => {
  cpSync(new URL('../aurora', import.meta.url), dir, { recursive: true })
  rmSync(join(dir, 'sessao.json'), { force: true })
  process.env.AURORA_DIR = dir
  aurora = await import('../bridge/aurora.mjs')
  router = await import('../bridge/router.mjs')
  connection = await import('../bridge/connection.mjs')
  gemini = await import('../bridge/engine-gemini.mjs')
  llama = await import('../bridge/engine-llama.mjs')
})
after(() => rmSync(dir, { recursive: true, force: true }))

const PROFILE = {
  memoria: { ativa: false },
  brain: { ativo: false },
  motores: {
    padrao: 'gemini',
    reserva: 'claude',
    tipos: {
      imagem: { motor: 'codex', palavras: ['gera uma imagem', 'desenha'] },
      web: { motor: 'ChatGPT', palavras: ['pesquis', 'notícia', 'previsão do tempo'] },
      complexa: { motor: 'claude', modelo: 'claude-opus-5', palavras: ['analisa'], minPalavras: 12 },
      rapida: { motor: 'llama', palavras: ['bom dia', 'obrigad'], maxPalavras: 5 },
    },
  },
}

test('o perfil real é válido e todos os tipos apontam para motores conhecidos', () => {
  const profile = JSON.parse(readFileSync(new URL('../aurora/perfil.json', import.meta.url), 'utf8'))
  const r = router.routingOf(profile)
  assert.ok(router.ENGINES.includes(r.padrao))
  assert.ok(router.ENGINES.includes(r.reserva))
  assert.equal(r.tipos.length, Object.keys(profile.motores.tipos).length)
  for (const t of r.tipos) assert.ok(router.ENGINES.includes(t.motor), t.nome)
})

test('roteamento por palavras, sem ligar para acentos e maiúsculas', () => {
  const r = router.routingOf(PROFILE)
  const route = (t) => router.classify(t, r)
  assert.equal(route('Gera uma imagem de um gato astronauta').motor, 'codex')
  assert.equal(route('PESQUISA o preço do dólar').tipo, 'web')
  assert.equal(route('quais as noticias de hoje?').motor, 'codex')
  assert.equal(route('previsao do tempo amanha').tipo, 'web')
  const c = route('analisa esse contrato pra mim')
  assert.equal(c.motor, 'claude')
  assert.equal(c.modelo, 'claude-opus-5')
  assert.equal(route('bom dia, Aurora').motor, 'llama')
  assert.equal(route('muito obrigado'). tipo, 'rapida')
  // "rapida" só vale para pedidos curtos.
  assert.equal(route('bom dia, me conta como foi a reunião de ontem'), null)
  // Pedido longo sem palavra-chave → complexa pelo tamanho.
  const long = 'eu queria entender melhor como funciona a previdência privada e se vale a pena para mim agora'
  assert.equal(route(long).tipo, 'complexa')
  assert.equal(route(long).por, 'tamanho')
  // Nada se aplica → o classificador (ou o padrão) decide.
  assert.equal(route('me conta uma curiosidade'), null)
  assert.equal(router.defaultRoute(r, 'x').motor, 'gemini')
})

test('palavra só casa no começo de uma palavra', () => {
  const r = router.routingOf({ motores: { tipos: { web: { motor: 'codex', palavras: ['clima'] } } } })
  assert.equal(router.classify('como está o clima?', r)?.tipo, 'web')
  assert.equal(router.classify('o anticlimax do filme', r), null)
})

test('o usuário pode escolher o motor falando', () => {
  const r = router.routingOf(PROFILE)
  const a = router.classify('pergunta pro Gemini qual a capital da Mongólia', r)
  assert.equal(a.motor, 'gemini')
  assert.equal(a.por, 'pedido')
  assert.equal(a.texto, 'qual a capital da Mongólia')
  assert.equal(router.classify('usa o chatgpt e me diz uma receita', r).motor, 'codex')
  assert.equal(router.classify('responde pelo claude: quanto é 2+2', r).motor, 'claude')
  assert.equal(router.classify('no llama, conta uma piada', r).motor, 'llama')
  // Falar de um motor não é escolher um.
  assert.equal(router.explicitEngine('o que você acha do gemini?'), null)
})

test('o classificador recebe os tipos e o nome volta como rota', () => {
  const r = router.routingOf(PROFILE)
  const prompt = router.classifierPrompt(r, 'faz um poema')
  assert.match(prompt, /- imagem/)
  assert.match(prompt, /- conversa/)
  assert.equal(router.routeForType(r, 'Web', 'x').motor, 'codex')
  assert.equal(router.routeForType(r, 'conversa', 'x'), null)
})

test('contexto de troca: só o que o novo motor não viu', () => {
  const t = [
    { pergunta: 'p1', resposta: 'r1', motor: 'gemini' },
    { pergunta: 'p2', resposta: 'r2', motor: 'codex' },
    { pergunta: 'p3', resposta: 'r3', motor: 'codex' },
  ]
  const forGemini = router.handoffContext(t, 'gemini')
  assert.match(forGemini, /p2/)
  assert.match(forGemini, /p3/)
  assert.doesNotMatch(forGemini, /p1/)
  assert.match(forGemini, /\[Pedido atual\]\n$/)
  assert.equal(router.handoffContext(t, 'codex'), '')
  assert.match(router.handoffContext(t, 'claude'), /p1[\s\S]*p3/)
})

/* -------------------------------------------------------------- connection */

class FakeSocket extends EventEmitter {
  OPEN = 1
  readyState = 1
  sent = []
  send(raw) {
    this.sent.push(JSON.parse(raw))
  }
  ask(text, id) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'ask', text, id })))
  }
  frames(id) {
    return this.sent.filter((f) => f.ask === id)
  }
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function fakeEngine(name, log, behaviour = {}) {
  return () => {
    if (behaviour.factoryFails) throw Object.assign(new Error(`${name} ausente`), { unavailable: true })
    let stop = null
    return {
      dead: false,
      interrupt() {
        stop?.()
      },
      close() {},
      async classify() {
        return behaviour.classifyAs ?? 'conversa'
      },
      async run(text, { sink, route }) {
        log.push({ name, text, modelo: route?.modelo ?? null })
        if (behaviour.unavailable) return { unavailable: true, message: `${name} sem login` }
        if (behaviour.slow) {
          sink.text('começo ')
          await new Promise((r) => {
            stop = r
          })
          return { text: 'começo ', interrupted: true }
        }
        const reply = `resposta do ${name}`
        sink.text(reply)
        sink.tool(`mcp__x__${name}`)
        return { text: reply }
      },
    }
  }
}

const deps = (factories, profile = PROFILE) => ({
  profile,
  decideTool: () => true,
  operationalPrompt: () => '',
  allowWrites: false,
  port: 0,
  factories,
})

test('cada pedido vai para o motor do seu tipo, com o contexto do que ele não viu', async () => {
  const log = []
  const socket = new FakeSocket()
  connection.runConnection(
    socket,
    deps({
      gemini: fakeEngine('gemini', log),
      codex: fakeEngine('codex', log),
      claude: fakeEngine('claude', log),
      llama: fakeEngine('llama', log),
    }),
  )
  socket.ask('me conta uma curiosidade', 'a1')
  socket.ask('pesquisa a cotação do euro', 'a2')
  socket.ask('analisa isso', 'a3')
  await settle()
  assert.deepEqual(
    log.map((l) => l.name),
    ['gemini', 'codex', 'claude'],
  )
  assert.equal(log[2].modelo, 'claude-opus-5')
  // O Codex recebe o que o Gemini respondeu antes; o primeiro turno vai limpo.
  assert.equal(log[0].text, 'me conta uma curiosidade')
  assert.match(log[1].text, /resposta do gemini[\s\S]*\[Pedido atual\]\npesquisa a cotação do euro$/)
  assert.deepEqual(
    socket.frames('a2').map((f) => f.type),
    ['text', 'tool', 'done'],
  )
  assert.equal(socket.frames('a2').at(-1).text, 'resposta do codex')
  socket.emit('close')
})

test('motor indisponível → a reserva responde e ele fica de fora por um tempo', async () => {
  const log = []
  const socket = new FakeSocket()
  connection.runConnection(
    socket,
    deps({
      gemini: fakeEngine('gemini', log, { unavailable: true }),
      codex: fakeEngine('codex', log, { factoryFails: true }),
      claude: fakeEngine('claude', log),
      llama: fakeEngine('llama', log),
    }),
  )
  socket.ask('oi, tudo certo por aí?', 'b1')
  socket.ask('pesquisa o placar do jogo', 'b2')
  socket.ask('e agora, me fala uma coisa', 'b3')
  await settle()
  assert.deepEqual(
    log.map((l) => l.name),
    // b1: gemini falha → claude; b2: codex não existe → claude; b3: gemini já está fora → claude
    ['gemini', 'claude', 'claude', 'claude'],
  )
  assert.equal(socket.frames('b1').at(-1).type, 'done')
  assert.equal(socket.frames('b1').at(-1).text, 'resposta do claude')
  socket.emit('close')
})

test('sem nenhuma palavra-chave, o Llama local classifica o pedido', async () => {
  const log = []
  const socket = new FakeSocket()
  connection.runConnection(
    socket,
    deps(
      {
        gemini: fakeEngine('gemini', log),
        codex: fakeEngine('codex', log),
        claude: fakeEngine('claude', log),
        llama: fakeEngine('llama', log, { classifyAs: 'imagem\n' }),
      },
      { ...PROFILE, motores: { ...PROFILE.motores, classificador: 'palavras+llama' } },
    ),
  )
  socket.ask('quero um retrato de um robô pintado a óleo', 'c1')
  await settle()
  assert.deepEqual(
    log.map((l) => l.name),
    ['codex'],
  )
  socket.emit('close')
})

test('interromper encerra o turno com o que já foi dito e libera o próximo', async () => {
  const log = []
  const socket = new FakeSocket()
  connection.runConnection(
    socket,
    deps({
      gemini: fakeEngine('gemini', log, { slow: true }),
      codex: fakeEngine('codex', log),
      claude: fakeEngine('claude', log),
      llama: fakeEngine('llama', log),
    }),
  )
  socket.ask('fala bastante', 'd1')
  await settle()
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'interrupt' })))
  socket.ask('pesquisa outra coisa', 'd2')
  await settle()
  assert.deepEqual(
    socket.frames('d1').map((f) => f.type),
    ['text', 'done'],
  )
  assert.equal(socket.frames('d2').at(-1).text, 'resposta do codex')
  socket.emit('close')
})

/* ------------------------------------------------------------ gemini/llama */

test('Gemini: eventos stream-json viram fala e ferramentas', () => {
  const said = []
  const tools = []
  let session
  const t = gemini.createGeminiTranslator({
    sink: { text: (d) => said.push(d), tool: (n) => tools.push(n) },
    serverOf: (n) => ({ lembrar: 'aurora_memoria', display: 'jarvis' })[n],
    onSession: (id) => (session = id),
  })
  t.handle({ type: 'init', session_id: 'abc' })
  t.handle({ type: 'message', role: 'user', content: 'oi' })
  t.handle({ type: 'tool_use', tool_name: 'google_web_search' })
  t.handle({ type: 'tool_use', tool_name: 'lembrar' })
  t.handle({ type: 'tool_use', tool_name: 'mcp_aurora_display' })
  t.handle({ type: 'message', role: 'assistant', content: 'Olá, ', delta: true })
  t.handle({ type: 'message', role: 'assistant', content: 'senhor.', delta: true })
  t.handle({ type: 'error', severity: 'warning', message: 'aviso' })
  t.handle({ type: 'result', status: 'success', stats: {} })
  assert.equal(session, 'abc')
  assert.deepEqual(said, ['Olá, ', 'senhor.'])
  assert.deepEqual(tools, ['WebSearch', 'mcp__aurora_memoria__lembrar'])
  assert.equal(t.text, 'Olá, senhor.')
  assert.equal(t.status, 'success')
  assert.equal(t.failure, null)
  assert.match(gemini.explainGeminiError('Please set an Auth method'), /não está logado/)
})

test('Gemini: sem o programa instalado, o motor se declara indisponível', () => {
  assert.equal(gemini.findGemini({}, { PATH: '/nao/existe' }), null)
  assert.throws(
    () =>
      gemini.createGeminiEngine({
        profile: { gemini: { caminho: '/nao/existe/gemini.js' } },
        hub: {},
        operationalPrompt: () => '',
        addUsage() {},
      }),
    (err) => err.unavailable === true,
  )
})

test('Llama: conversa pelo Ollama, usando ferramentas da Aurora', async () => {
  const { registerTools } = await import('../bridge/toolhub.mjs')
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')
  const remembered = []
  const servers = {
    aurora_memoria: createSdkMcpServer({
      name: 'mem',
      tools: [
        tool('lembrar', 'Guarda um fato', { texto: z.string() }, async ({ texto }) => {
          remembered.push(texto)
          return { content: [{ type: 'text', text: 'guardado' }] }
        }),
      ],
    }),
  }
  const hub = registerTools(servers, () => true)
  const bodies = []
  let round = 0
  const ndjson = (objs) => {
    const enc = new TextEncoder()
    return {
      ok: true,
      body: (async function* () {
        for (const o of objs) yield enc.encode(JSON.stringify(o) + '\n')
      })(),
    }
  }
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/api/tags')) return { json: async () => ({ models: [{ name: 'llama3.1:8b' }] }) }
    const body = JSON.parse(init.body)
    bodies.push(body)
    if (!body.stream) return { json: async () => ({ message: { content: 'Web' } }) }
    round++
    if (round === 1) {
      return ndjson([
        { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lembrar', arguments: { texto: 'café sem açúcar' } } }] } },
        { done: true, prompt_eval_count: 10, eval_count: 2 },
      ])
    }
    return ndjson([
      { message: { role: 'assistant', content: 'Anotado, ' } },
      { message: { role: 'assistant', content: 'senhor.' } },
      { done: true, prompt_eval_count: 20, eval_count: 4 },
    ])
  }
  const usage = []
  const eng = await llama.createLlamaEngine(
    {
      profile: { brain: { ativo: false }, llama: { modelo: 'llama3.1:8b' } },
      hub,
      addUsage: (e, d) => usage.push(d),
    },
    { fetchImpl },
  )
  const said = []
  const tools = []
  const out = await eng.run('lembra que prefiro café sem açúcar', {
    sink: { text: (d) => said.push(d), tool: (n) => tools.push(n) },
    route: {},
  })
  assert.equal(out.text, 'Anotado, senhor.')
  assert.deepEqual(remembered, ['café sem açúcar'])
  assert.deepEqual(tools, ['mcp__aurora_memoria__lembrar'])
  assert.equal(bodies[0].tools[0].function.name, 'lembrar')
  assert.equal(bodies[1].messages.at(-1).role, 'tool')
  assert.equal(usage[0].tokensEntrada, 30)
  assert.equal(await eng.classify('x'), 'web')
  hub.close()
})

test('Llama: sem Ollama rodando, o motor se declara indisponível', async () => {
  await assert.rejects(
    llama.createLlamaEngine(
      { profile: {}, hub: { token: 'x', serverOf: () => null }, addUsage() {} },
      {
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED')
        },
      },
    ),
    (err) => err.unavailable === true && /Ollama/.test(err.message),
  )
})

test('session file antigo (formato de um motor só) continua sendo lido', () => {
  aurora.rememberSession(null)
  assert.equal(aurora.sessionToResume({ conversa: { retomarMinutos: 60 } }, 'gemini'), null)
})
