/**
 * One browser connection, any number of engines.
 *
 * The page speaks one protocol (ask / interrupt / reply in, text / tool / done
 * / error / panel / blade / ui / usage out). This module owns the socket and,
 * for every question, picks the engine that should answer it (bridge/router.mjs),
 * hands it the turns it missed, and falls back to the reserve engine when the
 * chosen one is not available on this computer.
 *
 * An engine is anything with:
 *   run(text, { sink, route }) → Promise<{ text?, error?, unavailable?, interrupted? }>
 *   interrupt()   stop the turn in flight; run() still resolves
 *   close()       the page went away
 *   dead?         true once it cannot take another turn (it is rebuilt)
 *   classify?(prompt) → Promise<string>   only the local Llama has this
 *
 * Engines emit text and tool announcements through `sink`; the final done or
 * error frame is sent here, so a fallback can still happen when an engine
 * turns out to be missing.
 */

import { brainEnabled, brainServer } from './brain.mjs'
import { memoryServer } from './aurora.mjs'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { visionServer } from './vision.mjs'
import { registerTools } from './toolhub.mjs'
import {
  ENGINE_LABEL,
  classifierPrompt,
  classify,
  defaultRoute,
  engineLabel,
  handoffContext,
  routeForType,
  routingOf,
} from './router.mjs'

/** How long an engine that turned out to be missing is skipped before trying again. */
const DOWN_MS = 5 * 60_000
const CLASSIFY_TIMEOUT_MS = 2500
const TRANSCRIPT_KEEP = 20

/**
 * @param {import('ws').WebSocket} socket
 * @param {{
 *   profile: any,
 *   decideTool: (name: string) => boolean,
 *   operationalPrompt: (chromeOk: boolean) => string,
 *   allowWrites: boolean,
 *   port: number,
 *   factories: Record<string, (ctx: any) => any | Promise<any>>,
 *   readyServers?: string[],
 * }} deps
 */
export function runConnection(socket, deps) {
  const { profile, factories } = deps
  const routing = routingOf(profile)

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  // The camera asks the page for a frame and waits for it.
  const waiting = new Map()
  let asks = 0
  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) return reject(new Error('the interface is not connected'))
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  // Her own tools, built once and shared by every engine of this connection.
  const withBrain = brainEnabled(profile)
  const servers = {
    jarvis: displayServer(
      (panel) => send({ type: 'panel', panel }),
      (blade) => send({ type: 'blade', blade }),
    ),
    jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
    jarvis_eyes: visionServer(ask),
    ...(profile.memoria?.ativa === false ? {} : { aurora_memoria: memoryServer() }),
    ...(withBrain ? { aurora_brain: brainServer(profile) } : {}),
  }
  const hub = registerTools(servers, deps.decideTool)

  // Running totals for the diagnostics panel (D), across every engine used.
  const usage = {
    respostas: 0,
    ferramentas: 0,
    tokensEntrada: 0,
    tokensSaida: 0,
    tokensCache: 0,
    custoUsd: 0,
    modelo: ENGINE_LABEL[routing.padrao] ?? routing.padrao,
    retomada: false,
    motores: {},
  }
  const addUsage = (engine, delta = {}) => {
    for (const k of ['respostas', 'ferramentas', 'tokensEntrada', 'tokensSaida', 'tokensCache', 'custoUsd']) {
      usage[k] += Number(delta[k]) || 0
    }
    if (delta.retomada) usage.retomada = true
    usage.motores[engine] = (usage.motores[engine] ?? 0) + (Number(delta.respostas) || 0)
    usage.modelo = Object.keys(usage.motores)
      .map((e) => (e === engine && delta.modelo ? delta.modelo : ENGINE_LABEL[e] ?? e))
      .join(' · ')
    send({ type: 'usage', usage })
  }

  const ctx = {
    send,
    ask,
    profile,
    servers,
    hub,
    decideTool: deps.decideTool,
    operationalPrompt: deps.operationalPrompt,
    allowWrites: deps.allowWrites,
    port: deps.port,
    addUsage,
  }

  const engines = new Map()
  const down = new Map()
  const building = new Map()

  async function engine(name) {
    const have = engines.get(name)
    if (have && !have.dead) return have
    if (building.has(name)) return building.get(name)
    const factory = factories[name]
    if (!factory) throw Object.assign(new Error(`motor desconhecido: ${name}`), { unavailable: true })
    const pending = Promise.resolve()
      .then(() => factory(ctx))
      .then((e) => {
        engines.set(name, e)
        return e
      })
      .finally(() => building.delete(name))
    building.set(name, pending)
    return pending
  }

  const isDown = (name) => (down.get(name) ?? 0) > Date.now()

  async function decide(text) {
    const quick = classify(text, routing)
    if (quick) return quick
    if (routing.usarLlama && routing.tipos.length && !isDown('llama') && factories.llama) {
      try {
        const llama = await engine('llama')
        const answer = await Promise.race([
          llama.classify(classifierPrompt(routing, text)),
          new Promise((r) => setTimeout(() => r(null), CLASSIFY_TIMEOUT_MS)),
        ])
        const routed = answer ? routeForType(routing, String(answer).split(/\s/)[0], text) : null
        if (routed) return routed
      } catch (err) {
        if (err?.unavailable) down.set('llama', Date.now() + DOWN_MS)
      }
    }
    return defaultRoute(routing, text)
  }

  const transcript = []
  let current = null
  let interrupted = false
  let closed = false
  let chain = Promise.resolve()

  async function turn(text, id) {
    interrupted = false
    const route = await decide(text)
    const order = [...new Set([route.motor, routing.reserva])]
    let partial = ''
    const sink = {
      text: (delta) => {
        if (!delta) return
        partial += delta
        send({ type: 'text', delta, ask: id })
      },
      tool: (name) => name && send({ type: 'tool', name, ask: id }),
    }
    let lastProblem = null

    for (const name of order) {
      if (closed) return
      if (isDown(name) && name !== order[order.length - 1]) continue
      const own = name === route.motor
      console.log(
        `[aurora] ${route.tipo} → ${ENGINE_LABEL[name] ?? name}` +
          (own && route.modelo ? ` (${route.modelo})` : '') +
          (own ? ` · por ${route.por}` : ' · reserva'),
      )
      let eng
      try {
        eng = await engine(name)
      } catch (err) {
        lastProblem = String(err?.message ?? err)
        console.warn(`[aurora] motor ${name} indisponível: ${lastProblem}`)
        down.set(name, Date.now() + DOWN_MS)
        continue
      }
      current = eng
      // Which engine is answering, for the line under the answer on screen.
      send({
        type: 'engine',
        motor: name,
        label: engineLabel(name, profile, own ? route.modelo : null),
        tipo: route.tipo,
        reserva: !own,
        ask: id,
      })
      let out
      try {
        out = await eng.run(handoffContext(transcript, name) + route.texto, {
          sink,
          route: own ? route : { ...route, modelo: null, esforco: null },
        })
      } catch (err) {
        out = { error: String(err?.message ?? err) }
      } finally {
        current = null
      }
      if (eng.dead) engines.delete(name)

      if (out?.unavailable && !partial && !interrupted) {
        lastProblem = out.message ?? out.error ?? `${name} indisponível`
        console.warn(`[aurora] motor ${name} indisponível: ${lastProblem}`)
        down.set(name, Date.now() + DOWN_MS)
        continue
      }
      if (out?.error && !interrupted) {
        send({ type: 'error', message: out.error, ask: id })
        return
      }
      const answer = out?.text || partial
      transcript.push({ pergunta: route.texto, resposta: answer, motor: name })
      if (transcript.length > TRANSCRIPT_KEEP) transcript.shift()
      send({ type: 'done', text: answer, costUsd: null, motor: name, ask: id })
      return
    }
    send({
      type: 'error',
      message: lastProblem ?? 'Nenhum motor disponível agora.',
      ask: id,
    })
  }

  send({ type: 'ready', servers: deps.readyServers ?? Object.keys(servers) })
  console.log(
    `[aurora] motores: padrão ${ENGINE_LABEL[routing.padrao]}, reserva ${ENGINE_LABEL[routing.reserva]}` +
      (routing.tipos.length
        ? ` · tipos: ${routing.tipos.map((t) => `${t.nome}→${t.motor}`).join(', ')}`
        : ''),
  )
  // Start the usual engine now so the first answer does not wait for it.
  engine(routing.padrao).catch(() => {})

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type === 'ask' && typeof msg.text === 'string') {
      const id = typeof msg.id === 'string' ? msg.id : null
      chain = chain
        .then(() => (closed ? null : turn(msg.text, id)))
        .catch((err) => {
          console.error('[aurora] erro no turno:', err)
          send({ type: 'error', message: String(err?.message ?? err), ask: id })
        })
    }
    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }
    if (msg.type === 'interrupt') {
      interrupted = true
      current?.interrupt()
    }
  })

  socket.on('close', () => {
    console.log('[jarvis] client disconnected')
    closed = true
    current?.interrupt()
    for (const e of engines.values()) {
      try {
        e.close()
      } catch {
        /* closing anyway */
      }
    }
    hub.close()
  })

  return { engines, routing }
}
