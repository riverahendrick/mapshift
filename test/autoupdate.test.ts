import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AUTO_UPDATE_EVERY_MS, cannotSelfUpdate, maybeAutoUpdate, readAutoUpdate, releaseAutoUpdateLock, writeAutoUpdate } from '../src/setup/autoupdate.ts'

/** An installed copy (no git folder) and an empty Mapshift home, in a throwaway folder. */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'mapshift-auto-'))
  const pkg = join(base, 'lib', 'node_modules', 'mapshift')
  mkdirSync(join(pkg, 'dist', 'cli'), { recursive: true })
  const script = join(pkg, 'dist', 'cli', 'main.js')
  writeFileSync(script, '')
  const home = join(base, 'home')
  const started: string[][] = []
  const run = (now: number, env: NodeJS.ProcessEnv = {}) => maybeAutoUpdate({ script, home, now, env, start: (_exe, args) => started.push(args) })
  return { base, pkg, script, home, started, run, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

const NOW = 1_800_000_000_000

test('auto-update: on by default, runs at most every 3 days, in the background with update --auto', () => {
  const s = sandbox()
  try {
    assert.equal(readAutoUpdate(s.home).enabled, true, 'on with no settings file')
    assert.equal(s.run(NOW), 'started')
    assert.deepEqual(s.started, [[s.script, 'update', '--auto']])
    releaseAutoUpdateLock(s.home) // the background run removes it when done
    assert.equal(s.run(NOW + 60_000), 'not-due', 'checked a minute ago')
    assert.equal(s.run(NOW + AUTO_UPDATE_EVERY_MS - 1), 'not-due')
    assert.equal(s.run(NOW + AUTO_UPDATE_EVERY_MS + 1), 'started')
    assert.equal(s.started.length, 2)
  } finally {
    s.cleanup()
  }
})

test('auto-update: agents starting at the same moment start only one update; a lock left by a crash expires', () => {
  const s = sandbox()
  try {
    assert.equal(s.run(NOW), 'started')
    writeAutoUpdate({ enabled: true, lastCheck: null }, s.home) // as if the check had not been recorded yet
    assert.equal(s.run(NOW), 'busy', 'the first one holds the lock')
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(join(s.home, 'auto-update.lock'), old, old)
    assert.equal(s.run(NOW), 'started', 'a lock from an hour ago no longer blocks')
  } finally {
    s.cleanup()
  }
})

test('auto-update: off when turned off, when MAPSHIFT_AUTO_UPDATE=0, and in CI', () => {
  const s = sandbox()
  try {
    assert.equal(s.run(NOW, { MAPSHIFT_AUTO_UPDATE: '0' }), 'off')
    assert.equal(s.run(NOW, { CI: 'true' }), 'off')
    writeAutoUpdate({ enabled: false, lastCheck: null }, s.home)
    assert.equal(s.run(NOW), 'off')
    assert.equal(s.started.length, 0)
  } finally {
    s.cleanup()
  }
})

test("auto-update never replaces a development checkout or npm's temporary copy", () => {
  const s = sandbox()
  try {
    assert.equal(cannotSelfUpdate(s.script, {}), null)
    mkdirSync(join(s.pkg, '.git'))
    assert.equal(cannotSelfUpdate(s.script, {}), 'a development checkout')
    assert.equal(s.run(NOW), 'unsupported')
    assert.equal(s.started.length, 0)
    assert.equal(cannotSelfUpdate('/home/a/.npm/_npx/123/node_modules/mapshift/dist/cli/main.js', {}), 'a temporary npx copy')
  } finally {
    s.cleanup()
  }
})
