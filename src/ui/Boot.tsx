import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore } from '../store'
import { AURORA } from '../aurora'

/**
 * The start-up sequence, in the style of a film-assistant boot.
 *
 * Four beats, in order, cyan on black:
 *   1. an angular status bar — "INITIATING SYSTEM" — over a scrolling boot log,
 *      with a segmented bar filling left to right;
 *   2. concentric reticle rings assembling inward until her name resolves
 *      at the centre;
 *   3. her own beat — aurora curtains with voice and memory read-outs;
 *   4. the triangular arc reactor lighting from a dim outline to full glow,
 *      which is the hand-off into the live scene behind it.
 *
 * It is one full-frame overlay driven by a small stage clock rather than four
 * components, so the timing is legible in one place. Everything is SVG and CSS
 * — no images to load, nothing that can arrive late and stall the first beat.
 */

/** The stage boundaries, in milliseconds from power-on. `done` is when the
 *  overlay dissolves; App owns the actual hand-off, this is only for pacing. */
const T = { rings: 2600, suit: 5200, reactor: 7200 }

const LOG = [
  'CARREGANDO PERFIL ............. OK',
  'PERSONALIDADE ................. OK',
  'BASE DE CONHECIMENTO .......... OK',
  'MEMÓRIA DE LONGO PRAZO ........ OK',
  'CALIBRANDO VOZ (PT-BR) ........ OK',
  'CONECTANDO AO CÉREBRO',
]

type Stage = 'bar' | 'rings' | 'suit' | 'reactor'

export function Boot() {
  const phase = useStore((s) => s.phase)
  const reduced = useReducedMotion()
  const [t, setT] = useState(0)

  // A single clock: elapsed milliseconds since the boot phase began. Every
  // stage reads from it, so nothing can drift out of step with anything else.
  //
  // Driven by setInterval over wall-clock time, NOT requestAnimationFrame —
  // rAF is throttled to a crawl (and paused outright) whenever the tab is not
  // the focused one, which froze the sequence on its first beat. An interval
  // reading Date.now advances by real elapsed time whatever the browser does
  // with its frame budget: throttling can cost smoothness, never correctness.
  useEffect(() => {
    if (phase !== 'boot') {
      setT(0)
      return
    }
    const start = Date.now()
    setT(0)
    const id = setInterval(() => setT(Date.now() - start), 50)
    return () => clearInterval(id)
  }, [phase])

  if (phase !== 'boot') return null

  const stage: Stage =
    t >= T.reactor ? 'reactor' : t >= T.suit ? 'suit' : t >= T.rings ? 'rings' : 'bar'

  const logShown = Math.min(LOG.length, Math.floor((t / T.rings) * (LOG.length + 1)))
  const barPct = Math.min(1, t / (T.rings - 300))

  return (
    <AnimatePresence>
      <motion.div
        className="boot"
        initial={{ opacity: 1 }}
        exit={{ opacity: 0, filter: 'blur(10px)' }}
        transition={{ duration: 0.8 }}
      >
        {/* ---- beat 1: the status bar, dimming once its work is done ---- */}
        <div className={`boot-bar ${stage !== 'bar' ? 'boot-bar-dim' : ''}`}>
          <div className="boot-bar-frame">
            <span className="boot-bar-title">
              INICIANDO SISTEMA<span className="boot-dots">…</span>
              <span className="boot-cursor" />
            </span>
            <div className="boot-seg">
              {Array.from({ length: 22 }, (_, i) => (
                <span
                  key={i}
                  className="boot-seg-cell"
                  data-on={i / 22 < barPct ? '1' : '0'}
                />
              ))}
            </div>
          </div>
          <div className="boot-log">
            {LOG.slice(0, logShown).map((l) => (
              <div key={l} className="boot-log-line">
                {l}
              </div>
            ))}
          </div>
        </div>

        {/* ---- beats 2-4: the centre stage ---- */}
        <div className="boot-stage">
          {stage === 'rings' && <Rings reduced={!!reduced} />}
          {stage === 'suit' && <Aurora reduced={!!reduced} />}
          {stage === 'reactor' && <Reactor reduced={!!reduced} t={t - T.reactor} />}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

/* ------------------------------------------------------------------ beat 2 */

/** Concentric reticle rings drawing inward, with the name resolving last. */
function Rings({ reduced }: { reduced: boolean }) {
  const ease = 'easeOut'
  const ring = (r: number, delay: number, dash: string, w = 1) => (
    <motion.circle
      cx="0"
      cy="0"
      r={r}
      className="boot-ring"
      strokeDasharray={dash}
      strokeWidth={w}
      initial={reduced ? { opacity: 1 } : { opacity: 0, rotate: -40, scale: 1.15 }}
      animate={{ opacity: 1, rotate: 0, scale: 1 }}
      transition={{ duration: 0.7, delay, ease }}
    />
  )
  return (
    <svg className="boot-rings" viewBox="-160 -160 320 320">
      <g>
        {ring(150, 0.0, '3 6')}
        {ring(128, 0.08, '40 8 12 8', 1.4)}
        {ring(104, 0.16, '2 4')}
        {ring(84, 0.24, '30 6 6 6', 1.6)}
        {ring(60, 0.34, '1 3')}
      </g>
      <motion.text
        x="0"
        y="6"
        className="boot-name"
        initial={reduced ? { opacity: 1 } : { opacity: 0, letterSpacing: '1.4em' }}
        animate={{ opacity: 1, letterSpacing: '0.42em' }}
        transition={{ duration: 0.7, delay: 0.5, ease }}
      >
        {AURORA.nome.toUpperCase().split('').join('.')}
      </motion.text>
    </svg>
  )
}

/* ------------------------------------------------------------------ beat 3 */

/**
 * Her own beat in place of the armour blueprint: curtains of light rising and
 * swaying like an aurora, flanked by two read-outs — voice on one side, memory
 * on the other. Same wireframe language as the rest of the boot.
 */
function Aurora({ reduced }: { reduced: boolean }) {
  // Four curtains of light: gentle sine bands, tallest in the middle.
  const curtains = [
    { y: -46, amp: 14, k: 0.045, ph: 0.0, dim: false, delay: 0 },
    { y: -18, amp: 18, k: 0.038, ph: 1.3, dim: true, delay: 0.15 },
    { y: 10, amp: 12, k: 0.05, ph: 2.1, dim: false, delay: 0.3 },
    { y: 38, amp: 16, k: 0.034, ph: 3.4, dim: true, delay: 0.45 },
  ]
  const W = 140
  const wave = (y: number, amp: number, k: number, ph: number) => {
    const pts: string[] = []
    for (let x = -W; x <= W; x += 5) {
      const env = Math.cos((x / W) * (Math.PI / 2)) // fades out at both ends
      pts.push(`${x},${(y + Math.sin(x * k + ph) * amp * env).toFixed(1)}`)
    }
    return `M${pts.join(' L')}`
  }
  // Vertical rays hanging from the curtains, longer near the centre.
  const rays = Array.from({ length: 15 }, (_, i) => -W + 10 + i * ((2 * W - 20) / 14))
  return (
    <svg className="boot-suit" viewBox="-230 -150 460 300">
      <g className="boot-suit-fig">
        {rays.map((x, i) => {
          const h = 60 + Math.cos((x / W) * (Math.PI / 2)) * 50
          return (
            <motion.line
              key={x}
              className="boot-wire boot-wire-dim"
              x1={x}
              x2={x}
              y1={70}
              y2={70 - h}
              style={{ originY: 1 }}
              initial={reduced ? { opacity: 0.5 } : { opacity: 0, scaleY: 0 }}
              animate={{ opacity: 0.5, scaleY: 1 }}
              transition={{ duration: 0.9, delay: 0.2 + Math.abs(i - 7) * 0.05 }}
            />
          )
        })}
        {curtains.map((c, i) => (
          <motion.path
            key={i}
            className={c.dim ? 'boot-wire boot-wire-dim' : 'boot-wire'}
            d={wave(c.y, c.amp, c.k, c.ph)}
            initial={reduced ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 1.2, delay: c.delay, ease: 'easeInOut' }}
          />
        ))}
      </g>

      {[-190, 190].map((x, i) => (
        <motion.g
          key={x}
          className="boot-callout"
          initial={reduced ? { opacity: 1 } : { opacity: 0, x: x > 0 ? 20 : -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.3 + i * 0.12 }}
        >
          <circle className="boot-wire" cx={x} cy="-10" r="26" strokeDasharray="30 6 6 6" />
          <circle className="boot-wire boot-wire-dim" cx={x} cy="-10" r="15" />
          <circle className="boot-wire" cx={x} cy="-10" r="3" />
          <path
            className="boot-wire boot-wire-dim"
            d={x > 0 ? `M${x - 26},-10 L${W + 8},-10` : `M${x + 26},-10 L-${W + 8},-10`}
          />
        </motion.g>
      ))}
      <text x="-190" y="34" className="boot-tag">VOZ / PT-BR</text>
      <text x="190" y="34" className="boot-tag">MEMÓRIA</text>
    </svg>
  )
}

/* ------------------------------------------------------------------ beat 4 */

/** The triangular chest reactor, lighting from a dim outline to full glow. */
function Reactor({ reduced, t }: { reduced: boolean; t: number }) {
  const glow = reduced ? 1 : Math.min(1, Math.max(0, t / 1400))
  const seg = Array.from({ length: 16 }, (_, i) => i)
  return (
    <svg
      className="boot-reactor"
      viewBox="-120 -120 240 240"
      style={{ ['--glow' as string]: glow }}
    >
      {seg.map((i) => {
        const a = (i / seg.length) * Math.PI * 2 - Math.PI / 2
        const on = i / seg.length < glow * 1.05
        return (
          <line
            key={i}
            x1={Math.cos(a) * 70}
            y1={Math.sin(a) * 70}
            x2={Math.cos(a) * 100}
            y2={Math.sin(a) * 100}
            className={on ? 'boot-r-seg boot-r-on' : 'boot-r-seg'}
          />
        )
      })}
      <circle className="boot-r-ring" cx="0" cy="0" r="102" />
      <circle className="boot-r-ring boot-r-ring-in" cx="0" cy="0" r="66" />
      <path className="boot-r-tri" d="M0,-52 L46,30 L-46,30 Z" />
      <path className="boot-r-tri boot-r-tri-in" d="M0,-30 L28,20 L-28,20 Z" />
      <path className="boot-r-v" d="M-11,-4 L0,14 L11,-4" />
    </svg>
  )
}
