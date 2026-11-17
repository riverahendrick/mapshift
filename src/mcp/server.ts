import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { findRepoRoot } from '../core/paths.ts'
import { ensureFresh } from '../map/indexer.ts'
import { VERSION } from '../version.ts'
import { ALWAYS_LOAD, callTool, INSTRUCTIONS, TOOLS } from './tools.ts'

type Msg = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

/**
 * A Model Context Protocol server over stdio: one JSON-RPC message per line. It speaks just what
 * coding agents use (initialize, tools/list, tools/call, ping) and asks the client for its project
 * folder when the client offers one.
 */
export async function runMcp(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, cwd = process.cwd()): Promise<void> {
  let root = findRepoRoot(cwd)
  let agent = 'unknown'
  let nextId = 1
  const pending = new Map<number, (m: Msg) => void>()

  const send = (m: Msg) => output.write(`${JSON.stringify(m)}\n`)
  const reply = (id: Msg['id'], result: unknown) => send({ jsonrpc: '2.0', id: id ?? null, result })
  const fail = (id: Msg['id'], code: number, message: string) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const ask = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Msg>(done => {
      const id = nextId++
      pending.set(id, done)
      send({ jsonrpc: '2.0', id: `mapshift-${id}`, method, params })
      setTimeout(() => pending.delete(id) && done({ jsonrpc: '2.0', error: 'timeout' }), 3000).unref()
    })
  let clientHasRoots = false

  const warm = () => void ensureFresh(root, 0).catch(() => undefined) // start the first build at once

  const handle = async (m: Msg) => {
    // answers to our own requests (roots/list)
    if (m.method === undefined && typeof m.id === 'string' && m.id.startsWith('mapshift-')) {
      const done = pending.get(Number(m.id.slice(9)))
      if (done) {
        pending.delete(Number(m.id.slice(9)))
        done(m)
      }
      return
    }
    switch (m.method) {
      case 'initialize': {
        const p = m.params ?? {}
        agent = String((p.clientInfo as { name?: string } | undefined)?.name ?? 'unknown')
        clientHasRoots = !!(p.capabilities as { roots?: unknown } | undefined)?.roots
        reply(m.id, {
          protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mapshift', title: 'Mapshift', version: VERSION },
          instructions: INSTRUCTIONS,
        })
        return
      }
      case 'notifications/initialized': {
        if (clientHasRoots) {
          const r = await ask('roots/list')
          const first = (r.result as { roots?: { uri?: string }[] } | undefined)?.roots?.[0]?.uri
          if (first?.startsWith('file:')) root = findRepoRoot(fileURLToPath(first))
        }
        warm()
        return
      }
      case 'ping':
        reply(m.id, {})
        return
      case 'tools/list':
        reply(m.id, { tools: TOOLS.map(t => ({ ...t, _meta: ALWAYS_LOAD })) })
        return
      case 'tools/call': {
        const name = String(m.params?.name ?? '')
        try {
          const out = await callTool(root, name, m.params?.arguments ?? {}, agent)
          reply(m.id, { content: [{ type: 'text', text: out.text }], isError: out.isError })
        } catch (err) {
          reply(m.id, { content: [{ type: 'text', text: `Mapshift could not answer: ${(err as Error).message}` }], isError: true })
        }
        return
      }
      default:
        if (m.id !== undefined && m.method) fail(m.id, -32601, `Method not found: ${m.method}`)
    }
  }

  const lines = createInterface({ input, crlfDelay: Infinity })
  const inflight = new Set<Promise<void>>()
  for await (const line of lines) {
    if (!line.trim()) continue
    let msg: Msg
    try {
      msg = JSON.parse(line) as Msg
    } catch {
      fail(null, -32700, 'Parse error')
      continue
    }
    const job = handle(msg).catch(() => undefined)
    inflight.add(job)
    void job.finally(() => inflight.delete(job))
  }
  await Promise.all(inflight)
}
