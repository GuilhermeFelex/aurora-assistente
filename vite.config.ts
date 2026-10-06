import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

/**
 * The browser's share of aurora/perfil.json: her name, the user's form of
 * address, wake words and voice preferences. Baked in at dev-server start, so
 * a change to perfil.json wants an `npm start` restart. The bridge reads the
 * same file for everything else.
 */
function auroraProfile(): unknown {
  try {
    const p = JSON.parse(readFileSync(new URL('./aurora/perfil.json', import.meta.url), 'utf8'))
    return {
      nome: p?.assistente?.nome,
      tratamento: p?.usuario?.tratamento,
      tratamentoCurto: p?.usuario?.tratamentoCurto,
      nomes: p?.ativacao?.nomes,
      saudacoes: p?.ativacao?.saudacoes,
      exigirSaudacao: p?.ativacao?.exigirSaudacao,
      vozes: p?.voz?.preferidas,
    }
  } catch (err) {
    console.warn(`[aurora] could not read aurora/perfil.json: ${(err as Error).message}`)
    return {}
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __AURORA__: JSON.stringify(auroraProfile()),
  },
  optimizeDeps: {
    // Aurora: name the dependencies up front so Vite pre-bundles them when the
    // server starts. Discovered lazily, they were bundled only after the page
    // had loaded — which forced a full reload of the interface on first start
    // (the "client connected / disconnected" pair in the log).
    include: [
      'react',
      'react-dom/client',
      'react/jsx-runtime',
      'three',
      '@react-three/fiber',
      '@react-three/postprocessing',
      'postprocessing',
      'framer-motion',
      'zustand',
      'dompurify',
    ],
  },
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
  },
})
