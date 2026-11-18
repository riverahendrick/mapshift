import assert from 'node:assert/strict'
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { LOGO_SVG } from '../src/dashboard/logo.ts'
import { page } from '../src/dashboard/page.ts'
import { startDash } from '../src/dashboard/server.ts'
import type { Snapshot } from '../src/dashboard/snapshot.ts'

const DATA: Snapshot = {
  generatedAt: 1,
  project: { root: '/work/app', name: 'app', shown: '/work/app' },
  map: { root: '/work/app', state: 'ready', percent: 100, files: 3, symbols: 9, builtAt: 1 },
  today: { lookups: 2, byAgent: [{ agent: 'codex', label: 'Codex', n: 2 }], withMap: 100, withoutMap: 900, savedUpperBound: 800 },
  week: { lookups: 2, byAgent: [], withMap: 100, withoutMap: 900, savedUpperBound: 800 },
  codex: null,
  recent: [],
  claude: null,
  tools: [],
  mapDetail: null,
}

/** A raw request, so the Host header can be set to anything. */
function get(port: number, path: string, o: { host?: string; method?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { host: o.host ?? `127.0.0.1:${port}` } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', d => (body += d))
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', fail)
    req.end()
  })
}

test('the dashboard listens on 127.0.0.1 only and answers only with its token', async () => {
  const d = await startDash({ data: () => DATA })
  try {
    const addr = d.server.address()
    assert.ok(addr && typeof addr === 'object' && addr.address === '127.0.0.1')
    assert.match(d.url, /^http:\/\/127\.0\.0\.1:\d+\/[\w-]{20,}\/$/)
    assert.equal((await get(d.port, '/')).status, 404)
    assert.equal((await get(d.port, '/api/state')).status, 404)
    assert.equal((await get(d.port, '/wrong-token/api/state')).status, 404)
    assert.equal((await get(d.port, `/${d.token}/`, { host: 'evil.example:80' })).status, 403, 'another host name is refused')
    assert.equal((await get(d.port, `/${d.token}/api/state`, { method: 'POST' })).status, 405, 'read only')

    const html = await get(d.port, `/${d.token}/`)
    assert.equal(html.status, 200)
    assert.match(String(html.headers['content-security-policy']), /default-src 'none'/)
    assert.equal(html.headers['referrer-policy'], 'no-referrer')
    assert.ok(html.body.includes('Mapshift') && html.body.includes('<svg'))
    assert.ok(!/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org)/.test(html.body), 'no external scripts, styles or requests')

    const api = await get(d.port, `/${d.token}/api/state`)
    assert.equal(api.status, 200)
    assert.match(String(api.headers['content-type']), /application\/json/)
    const s = JSON.parse(api.body) as Snapshot
    assert.deepEqual(Object.keys(s).sort(), ['claude', 'codex', 'generatedAt', 'map', 'mapDetail', 'project', 'recent', 'today', 'tools', 'week'])
    assert.equal(s.today.savedUpperBound, 800)
  } finally {
    d.close()
    await d.closed
  }
})

test('the dashboard stops by itself when nobody looks at it', async () => {
  const d = await startDash({ data: () => DATA, idleMs: 150 })
  const t0 = Date.now()
  await d.closed
  assert.ok(Date.now() - t0 < 3000)
})

test('the page uses the fixed limit colours and nonce-only scripts', () => {
  const html = page('abc')
  for (const c of ['#3fb950', '#e3b341', '#f85149']) assert.ok(html.includes(c))
  assert.ok(html.includes('<script nonce="abc">'))
  assert.ok(html.includes('prefers-color-scheme: dark'))
  // limits and money come from Claude Code as well as Codex, the same readings the terminal dashboard shows
  assert.ok(html.includes("'Claude Code · as of '") && html.includes("'Claude Code today: '"))
  assert.ok(!html.includes('${'), 'no template text left in the page')
})

test('the embedded logo is the same as assets/logo.svg', () => {
  const file = readFileSync(join(import.meta.dirname, '..', 'assets', 'logo.svg'), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(LOGO_SVG.replace(/\r\n/g, '\n'), file)
})
