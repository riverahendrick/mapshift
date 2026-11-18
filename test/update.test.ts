import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newer, runUpdate } from '../src/setup/update.ts'

test('version order: numbers compare as numbers, a release beats its pre-release', () => {
  assert.equal(newer('0.1.10', '0.1.9'), true)
  assert.equal(newer('1.0.0', '0.9.9'), true)
  assert.equal(newer('0.1.0', '0.1.0'), false)
  assert.equal(newer('0.1.0', '0.1.0-beta.1'), true)
  assert.equal(newer('0.1.0-beta.1', '0.1.0'), false)
})

function fakeRun(latest: string, installOk = true) {
  const calls: string[][] = []
  const run = (exe: string, args: string[]) => {
    calls.push([exe, ...args])
    if (args.includes('view')) return { status: 0, stdout: `${latest}\n` }
    if (args.includes('install')) return { status: installOk ? 0 : 1, stdout: '' }
    return { status: 0, stdout: '' }
  }
  return { run, calls }
}

test('update: up to date installs nothing', async () => {
  const f = fakeRun('0.1.0')
  const lines: string[] = []
  assert.equal(await runUpdate({ current: '0.1.0', run: f.run, out: s => lines.push(s), claude: null, missing: () => [{ label: 'Cursor' }, { label: 'Kiro' }] }), 0)
  assert.ok(!f.calls.some(c => c.includes('install')))
  assert.match(lines.join('\n'), /newest version/)
  assert.match(lines.join('\n'), /Found without Mapshift: Cursor · Kiro/, 'agents installed since setup are pointed out')
})

test('update: a newer version is installed, and the Claude Code add-on updated', async () => {
  const f = fakeRun('0.2.0')
  const lines: string[] = []
  assert.equal(await runUpdate({ current: '0.1.0', run: f.run, out: s => lines.push(s), claude: '/bin/claude' }), 0)
  assert.ok(f.calls.some(c => c.includes('install') && c.includes('mapshift@0.2.0')))
  assert.ok(f.calls.some(c => c[0] === '/bin/claude' && c.includes('update') && c.includes('mapshift@mapshift')))
  assert.match(lines.join('\n'), /0\.1\.0 → 0\.2\.0/)
})

test('update --check only looks', async () => {
  const f = fakeRun('0.2.0')
  assert.equal(await runUpdate({ current: '0.1.0', check: true, run: f.run, out: () => {}, claude: null }), 0)
  assert.ok(!f.calls.some(c => c.includes('install')))
})

test('update: a failed install says so and stops', async () => {
  const f = fakeRun('0.2.0', false)
  const lines: string[] = []
  assert.equal(await runUpdate({ current: '0.1.0', run: f.run, out: s => lines.push(s), claude: '/bin/claude' }), 1)
  assert.ok(!f.calls.some(c => c[0] === '/bin/claude'))
  assert.match(lines.join('\n'), /could not install/)
})
