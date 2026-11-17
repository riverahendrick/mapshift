import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { limitsFrom, parseRollout, readCodexUsage } from '../src/agents/codex-usage.ts'
import { renderReport, resetText } from '../src/agents/report.ts'
import { agentOfClient, mapStats, readMapEvents, snapshot, type MapEventLite } from '../src/dashboard/snapshot.ts'
import { advise } from '../src/router/route.ts'

// A made-up Codex session in the shape Codex 0.169 writes (no real account data).
const NOW = Date.parse('2026-11-17T12:00:00Z')
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const lines = [
  { timestamp: '2026-11-17T10:00:00Z', type: 'session_meta', payload: { id: 's1', cwd: '/work/app', cli_version: '0.169.0' } },
  { timestamp: '2026-11-17T10:00:01Z', type: 'turn_context', payload: { cwd: '/work/app', model: 'gpt-6-astra', effort: 'high' } },
  {
    timestamp: '2026-11-17T10:00:01Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '# AGENTS.md instructions for /work/app\n\nBe kind.' },
        { type: 'input_text', text: '<environment_context>\n  <cwd>/work/app</cwd>\n</environment_context>' },
      ],
    },
  },
  { timestamp: '2026-11-17T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rename the readme title' }] } },
  { timestamp: '2026-11-17T10:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  {
    timestamp: '2026-11-17T10:00:06Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 } },
      rate_limits: {
        primary: { used_percent: 42, window_minutes: 300, resets_at: sec('2026-11-17T14:30:00Z') },
        secondary: { used_percent: 87.5, window_minutes: 10080, resets_at: sec('2026-11-20T09:00:00Z') },
        plan_type: 'plus',
      },
    },
  },
  'not json at all',
]
const FIXTURE = lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')

test('a Codex session log gives its limits, tokens, model and the last request the person typed', () => {
  const p = parseRollout(FIXTURE)
  assert.equal(p.model, 'gpt-6-astra')
  assert.equal(p.effort, 'high')
  assert.equal(p.lastRequest, 'rename the readme title', 'context Codex injects is not taken as the request')
  assert.deepEqual(p.total, { input: 1000, cached: 600, output: 50, reasoning: 10 })
  assert.equal(p.plan, 'plus')
  const limits = limitsFrom(p.rate, NOW)
  assert.deepEqual(
    limits.map(l => [l.label, l.usedPercent, l.reset]),
    [
      ['5-hour', 42, false],
      ['Weekly', 87.5, false],
    ],
  )
  assert.equal(limits[0]!.resetsAt, Date.parse('2026-11-17T14:30:00Z'), 'epoch seconds become milliseconds')
})

test('a window whose reset time has passed shows as fresh, not with the old percentage', () => {
  const [five] = limitsFrom(parseRollout(FIXTURE).rate, Date.parse('2026-11-17T15:00:00Z'))
  assert.equal(five!.reset, true)
  assert.equal(five!.usedPercent, 0)
})

test('the newest session with limits is found even when the newest file has none yet', () => {
  const codex = mkdtempSync(join(tmpdir(), 'mapshift-codex-'))
  try {
    const day = join(codex, 'sessions', '2026', '11', '17')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, 'rollout-a.jsonl'), FIXTURE)
    writeFileSync(join(day, 'rollout-b.jsonl'), `${JSON.stringify(lines[0])}\n`) // a session just started
    const t = NOW / 1000
    utimesSync(join(day, 'rollout-a.jsonl'), t - 60, t - 60)
    utimesSync(join(day, 'rollout-b.jsonl'), t, t)
    const u = readCodexUsage(codex, NOW)!
    assert.equal(u.limits.length, 2)
    assert.equal(u.model, 'gpt-6-astra')
    assert.equal(u.today.sessions, 1)
    assert.equal(u.today.input, 1000)
    assert.equal(readCodexUsage(join(codex, 'missing'), NOW), null)
  } finally {
    rmSync(codex, { recursive: true, force: true })
  }
})

const ev = (o: Partial<MapEventLite>): MapEventLite => ({ ts: NOW, agent: 'codex-mcp-client', repo: '/work/app', tool: 'map_find', answerTokens: 300, files: [{ path: 'a.ts', tokens: 2000 }], ...o })

test('savings are an upper bound: files pointed to minus answers, per project, never below zero', () => {
  const s = mapStats([ev({}), ev({ agent: 'grok', files: [] }), ev({ repo: '/other' })], '/work/app')
  assert.equal(s.lookups, 2)
  assert.equal(s.withMap, 600)
  assert.equal(s.withoutMap, 2000)
  assert.equal(s.savedUpperBound, 1400)
  assert.deepEqual(s.byAgent.map(b => b.label).sort(), ['Codex', 'Grok'])
  assert.equal(mapStats([ev({ files: [] })]).savedUpperBound, 0)
  assert.equal(agentOfClient('claude-code'), 'claude')
  assert.equal(agentOfClient('antigravity'), 'agy')
  assert.equal(agentOfClient('gemini-cli-mcp-client'), 'gemini')
})

test('the report reads the map log, the Codex session and gives plain, honest text', () => {
  const home = mkdtempSync(join(tmpdir(), 'mapshift-report-'))
  try {
    const codex = join(home, 'codex')
    const day = join(codex, 'sessions', '2026', '11', '17')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, 'rollout-a.jsonl'), FIXTURE)
    utimesSync(join(day, 'rollout-a.jsonl'), NOW / 1000, NOW / 1000)
    mkdirSync(join(home, 'logs'))
    const event = { kind: 'map', ts: NOW - 1000, agent: 'codex-mcp-client', repo: join(home, 'proj'), tool: 'map_find', answerTokens: 250, files: [{ path: 'src/a.ts', tokens: 4000 }] }
    writeFileSync(join(home, 'logs', '2026-11-17.jsonl'), `${JSON.stringify(event)}\nbroken line\n`)
    mkdirSync(join(home, 'proj'))
    assert.equal(readMapEvents(NOW - 86_400_000, NOW, join(home, 'logs')).length, 1)

    const s = snapshot({ root: join(home, 'proj'), codexHome: codex, now: NOW, home })
    assert.equal(s.today.lookups, 1)
    assert.equal(s.map.state, 'none')
    const advice = advise({ text: s.codex!.lastRequest!, provider: 'openai', currentModel: s.codex!.model! })
    const text = renderReport(s, { agent: 'codex', advice, now: NOW })
    assert.match(text, /Not built yet/)
    assert.match(text, /1 today/)
    assert.match(text, /up to 3,750 tokens today/)
    assert.match(text, /upper bound/)
    assert.match(text, /5-hour .*42% used · resets/)
    assert.match(text, /Weekly .*88% used/)
    assert.match(text, /plus plan/)
    assert.match(text, /Last request/)
    assert.ok(!text.includes('rename the readme'), 'the request text itself is never printed')
    assert.ok(!/\x1b\[/.test(text), 'no colour codes when the output is not a terminal')
    // another agent's report leaves out Codex limits
    assert.ok(!renderReport(s, { agent: 'grok', now: NOW }).includes('5-hour'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('reset times read naturally', () => {
  const at = NOW + (2 * 60 + 10) * 60_000
  assert.match(resetText(at, NOW), /\(in 2 h 10 min\)$/)
  assert.match(resetText(NOW + 3 * 86_400_000, NOW), /^[A-Z][a-z]{2} .*\(in 3 days\)$/)
})
