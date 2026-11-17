import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_WIDTH, statusLine, width } from '../src/agents/statusline.ts'
import { repoId } from '../src/core/paths.ts'
import { quickMap, quickRepo } from '../src/dashboard/map-status.ts'
import { buildNow } from '../src/map/indexer.ts'
import { makeRepo } from './helpers.ts'

const MAIN = join(import.meta.dirname, '..', 'src', 'cli', 'main.ts')
const MAP = '\u{1F5FA}️' // the map emoji

test('the quick map id matches the one git gives, for a repository, a subfolder and a worktree', () => {
  const r = makeRepo({ 'src/a.ts': 'export const a = 1\n' })
  try {
    assert.equal(quickRepo(r.root).id, repoId(r.root))
    assert.equal(quickRepo(join(r.root, 'src')).id, repoId(r.root))
    assert.equal(quickRepo(join(r.root, 'src')).root, r.root)
    const wt = join(r.root, '..', 'wt').replace(/\\/g, '/')
    execFileSync('git', ['-C', r.root, 'worktree', 'add', '-q', wt], { cwd: r.root, stdio: 'ignore', windowsHide: true })
    assert.equal(quickRepo(wt).id, repoId(wt))
    assert.equal(quickRepo(wt).id, quickRepo(r.root).id, 'worktrees share one map')
    const plain = join(r.root, '..', 'plain')
    mkdirSync(plain)
    assert.equal(quickRepo(plain).id, repoId(plain), 'a folder outside git')
  } finally {
    r.cleanup()
  }
})

test('the quick map status reads a built map without changing it', async () => {
  const r = makeRepo({ 'src/a.ts': 'export function hello() { return 1 }\n' })
  try {
    assert.equal(quickMap(r.root, r.home).state, 'none')
    await buildNow(r.root)
    const m = quickMap(r.root, r.home)
    assert.equal(m.state, 'ready')
    assert.equal(m.files, 1)
    assert.ok(m.symbols >= 1)
    assert.ok(m.builtAt)
  } finally {
    r.cleanup()
  }
})

test('the status line shows the map, the model and what the agent reports, within 70 characters', async () => {
  const r = makeRepo({ 'src/a.ts': 'export const a = 1\n' })
  try {
    await buildNow(r.root)
    const grok = statusLine(
      { model: { id: 'grok-4.6', display_name: 'Grok 4.6' }, effort: { level: 'high' }, context_window: { used_percentage: 23.4 }, cost: { total_cost_usd: 0.4242 }, workspace: { repo_root: r.root } },
      { agent: 'grok', home: r.home },
    )
    assert.equal(grok, `${MAP} Map ready · Grok 4.6 high · ctx 23% · $0.42`)
    const agy = statusLine({ model: { display_name: 'Gemini 4 Hydrogen' }, quota: { remaining_fraction: 0.58 }, cwd: r.root }, { agent: 'agy', home: r.home })
    assert.equal(agy, `${MAP} Map ready · Quota 58% left`)
    const long = statusLine(
      { model: { display_name: 'A very long experimental model name that goes on and on' }, context_window: { used_percentage: 99 }, cost: { total_cost_usd: 12 }, workspace: { repo_root: r.root } },
      { agent: 'grok', home: r.home },
    )
    assert.ok(width(long) <= MAX_WIDTH, long)
    assert.equal(statusLine({}, { agent: 'grok', home: r.home, cwd: join(r.root, '..') }), `${MAP} No map yet`)
  } finally {
    r.cleanup()
  }
})

test('the statusline command never fails, whatever it is given', () => {
  const r = makeRepo({ 'a.ts': 'export const a = 1\n' })
  try {
    const run = (input: string) =>
      execFileSync(process.execPath, [MAIN, 'statusline', '--agent', 'grok'], { input, cwd: r.root, env: { ...process.env, MAPSHIFT_HOME: r.home }, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    assert.equal(run('this is not json').trim(), `${MAP} No map yet`)
    assert.equal(run('﻿{"model":{"display_name":"Grok 4.6"},"workspace":{"repo_root":"/nowhere/at/all"}}\n').trim(), `${MAP} No map yet · Grok 4.6`)
    assert.equal(run('').trim(), `${MAP} No map yet`)
  } finally {
    r.cleanup()
  }
})
