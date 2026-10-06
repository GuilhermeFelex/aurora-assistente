/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 */

import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'

/**
 * Keep node_modules in step with package-lock.json.
 *
 * When an update to the project changes the lockfile (a removed dependency, a
 * security fix), the installed packages are stale until someone remembers to
 * run `npm install`. Checking here means every way of starting Aurora — the
 * .bat, the hidden launcher, `npm start` — picks the change up on its own.
 * npm writes node_modules/.package-lock.json after every install, so its mtime
 * is a cheap "last installed" stamp.
 */
function ensureDependencies() {
  const stamp = 'node_modules/.package-lock.json'
  let stale = !existsSync(stamp)
  if (!stale) {
    try {
      stale = statSync('package-lock.json').mtimeMs > statSync(stamp).mtimeMs + 1000
    } catch {
      stale = false
    }
  }
  if (!stale) return
  console.log('  atualizando as dependências (só acontece quando o projeto muda)...')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const res = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    stdio: 'inherit',
    // npm.cmd is a batch file; Windows only runs those through a shell.
    shell: process.platform === 'win32',
  })
  if (res.status !== 0) {
    console.warn('  a atualização das dependências falhou — seguindo com as que já estão instaladas.')
  }
}

ensureDependencies()

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []

function run(name, command, args, colour, env) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

vendorWasm()

console.log('\nA.U.R.O.R.A. iniciando — o cérebro e a interface.\n')
run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

const url = `http://localhost:${port || 5173}`
console.log(
  `\nQuando o servidor disser que está pronto, abra ${url} no Chrome,\n` +
    'clique em INICIAR e diga "Ei Aurora". Ctrl-C desliga tudo.\n',
)

/**
 * `--abrir` (used by "Iniciar Aurora.bat"): wait until the face actually
 * answers, then open it in Chrome — falling back to the default browser. The
 * first start can take twenty seconds while Vite bundles, so a fixed delay
 * would either be too short or waste time.
 */
if (process.argv.includes('--abrir')) {
  const deadline = Date.now() + 120_000
  const tryOpen = async () => {
    if (stopping) return
    try {
      const res = await fetch(url)
      if (res.ok) return openBrowser(url)
    } catch {
      /* not up yet */
    }
    if (Date.now() < deadline) setTimeout(tryOpen, 1000)
    else console.log(`  não consegui confirmar que a interface subiu — abra ${url} manualmente.`)
  }
  setTimeout(tryOpen, 1500)
}

function openBrowser(target) {
  const open = (cmd, args) =>
    new Promise((ok) => {
      const p = spawn(cmd, args, {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        // cmd's `start` needs its empty title argument passed through verbatim.
        windowsVerbatimArguments: cmd === 'cmd',
      })
      p.on('error', () => ok(false))
      p.on('exit', (code) => ok(code === 0))
      p.unref()
    })
  ;(async () => {
    let done = false
    if (process.platform === 'win32') {
      // `start chrome` resolves Chrome through App Paths; if it is missing,
      // fall back to whatever browser is the default.
      done = await open('cmd', ['/c', `start "" chrome "${target}"`])
      if (!done) done = await open('cmd', ['/c', `start "" "${target}"`])
    } else if (process.platform === 'darwin') {
      done = await open('open', ['-a', 'Google Chrome', target])
      if (!done) done = await open('open', [target])
    } else {
      done = await open('xdg-open', [target])
    }
    console.log(done ? `  abri ${target} no navegador.` : `  abra ${target} no Chrome.`)
  })()
}
