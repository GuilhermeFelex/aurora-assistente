#!/usr/bin/env node
/**
 * Aurora's tools as a stdio MCP server, for engines that run their own agent
 * process (Codex). It holds no tools itself: every list and call is forwarded
 * to the bridge (bridge/toolhub.mjs) over localhost, where the tools actually
 * run — on the same socket as the page, behind the same permission gate.
 *
 *   AURORA_TOOLS_URL=http://127.0.0.1:8787/aurora-tools/<token>  node bridge/mcp-proxy.mjs
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const BASE = process.env.AURORA_TOOLS_URL
if (!BASE) {
  console.error('aurora mcp-proxy: AURORA_TOOLS_URL is not set')
  process.exit(1)
}

const server = new Server(
  { name: 'aurora', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Ferramentas da Aurora: painéis na tela (blade, display), interface (ui_*), câmera (look, watch), ' +
      'memória (lembrar, esquecer, listar_memorias, consultar) e o cofre brain-aurora (brain_*).',
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const res = await fetch(`${BASE}/list`)
  if (!res.ok) throw new Error(`bridge answered ${res.status}`)
  return { tools: await res.json() }
})

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const res = await fetch(`${BASE}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: req.params.name, arguments: req.params.arguments ?? {} }),
    })
    if (!res.ok) throw new Error(`bridge answered ${res.status}`)
    return await res.json()
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `A Aurora não respondeu: ${err?.message ?? err}` }] }
  }
})

await server.connect(new StdioServerTransport())
