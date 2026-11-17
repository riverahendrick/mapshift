import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeRepo } from './helpers.ts'

const MAIN = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url))

/** Talks to the real server over real stdio, the way an agent does. */
function connect(cwd: string, home: string) {
  const child = spawn(process.execPath, [MAIN, 'mcp'], { cwd, env: { ...process.env, MAPSHIFT_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const waiting = new Map<number, (m: any) => void>()
  const rl = createInterface({ input: child.stdout })
  rl.on('line', line => {
    const m = JSON.parse(line)
    waiting.get(m.id)?.(m)
  })
  let id = 0
  const call = (method: string, params: unknown = {}) =>
    new Promise<any>(done => {
      const my = ++id
      waiting.set(my, done)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`)
    })
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  return { call, notify, close: () => new Promise(done => { child.once('exit', done); child.stdin.end() }) }
}

test('MCP over stdio: handshake, five tools, a real answer, and a ledger entry', { timeout: 60_000 }, async () => {
  const r = makeRepo({
    'src/store.ts': 'export function save(x: number) { return x }\n',
    'src/cart.ts': "import { save } from './store'\nexport function checkout() { return save(1) }\n",
  })
  const s = connect(r.root, r.home)
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } })
    assert.equal(init.result.serverInfo.name, 'mapshift')
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.match(init.result.instructions, /map_find/)
    s.notify('notifications/initialized')

    const list = await s.call('tools/list')
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['map_find', 'map_trace', 'map_file', 'map_overview', 'map_search'])

    const res = await s.call('tools/call', { name: 'map_find', arguments: { query: 'checkout' } })
    assert.equal(res.result.isError, false)
    assert.match(res.result.content[0].text, /### 1\. checkout · function · src\/cart\.ts:2/)
    assert.match(res.result.content[0].text, /Calls: save \(src\/store\.ts:1\)/)

    const bad = await s.call('tools/call', { name: 'map_find', arguments: {} })
    assert.equal(bad.result.isError, true)
    const unknown = await s.call('no/such/method')
    assert.equal(unknown.error.code, -32601)
    assert.ok((await s.call('ping')).result)
  } finally {
    await s.close()
  }
  const logs = readdirSync(join(r.home, 'logs'))
  const lines = readFileSync(join(r.home, 'logs', logs[0]!), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const entry = lines.find(l => l.tool === 'map_find')
  assert.equal(entry.agent, 'test-agent')
  assert.deepEqual(entry.files.map((f: { path: string }) => f.path), ['src/cart.ts'])
  assert.ok(entry.answerTokens > 0)
  r.cleanup()
})

test('the command line prints status and answers', { timeout: 60_000 }, async () => {
  const r = makeRepo({ 'app.py': 'def main():\n    helper()\n\ndef helper():\n    pass\n' })
  const run = (...args: string[]) =>
    new Promise<string>(done => {
      const c = spawn(process.execPath, [MAIN, ...args], { cwd: r.root, env: { ...process.env, MAPSHIFT_HOME: r.home, NO_COLOR: '1' }, windowsHide: true })
      let out = ''
      c.stdout.on('data', d => (out += d))
      c.stderr.on('data', d => (out += d))
      c.on('exit', () => done(out))
    })
  try {
    assert.match(await run('--version'), /^\d+\.\d+\.\d+/)
    assert.match(await run('help'), /mapshift map find <words>/)
    const built = await run('map', 'build')
    assert.match(built, /Mapped 1 changed file/)
    assert.match(built, /Definitions\s+2/)
    assert.match(await run('map', 'trace', 'helper'), /- main \(app\.py:2\)/)
    assert.match(await run('map', 'nope'), /Unknown map command/)
  } finally {
    r.cleanup()
  }
})
