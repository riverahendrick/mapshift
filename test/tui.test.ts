import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { after, test } from 'node:test'
import { readClaudeUsage, snapshot, type Snapshot } from '../src/dashboard/snapshot.ts'
import { ENTER, LEAVE, runUi } from '../src/tui/app.ts'
import { decode, decodeChunk, tabAt } from '../src/tui/input.ts'
import { inText, modelName, renderFrame } from '../src/tui/render.ts'
import { colorDepth, makeStyle } from '../src/tui/style.ts'
import { fit, pad, strip, width } from '../src/tui/width.ts'

const MAIN = join(import.meta.dirname, '..', 'src', 'cli', 'main.ts')
const NOW = new Date(2026, 10, 17, 15, 0, 0).getTime() // 3 PM local time, so "yesterday" is before midnight
const plain = makeStyle(0)

/** Runs the command line with no colour and a private, empty home. */
function cli(args: string[], home: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', MAPSHIFT_HOME: join(home, 'mapshift') }
  delete env.FORCE_COLOR
  return execFileSync(process.execPath, [MAIN, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
}

function tempHome(): { home: string; project: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'mapshift-tui-'))
  const project = join(home, 'proj')
  mkdirSync(project)
  return { home, project, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const line = (o: Record<string, unknown>) => JSON.stringify(o)

/** Two chats' audit logs, as the Claude Code add-on writes them. */
function writeAudit(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'audit-older.jsonl'),
    [
      line({ k: 'limits', windows: [{ name: '5-hour', pct: 20, resetsAt: NOW + 3_600_000 }], ctxPct: 10, sid: 'older', ts: NOW - 3 * 3_600_000 }),
      line({ k: 'turn', turn: 1, usd: 5, baseUsd: 9, sid: 'older', ts: NOW - 24 * 3_600_000 }), // yesterday: left out
      line({ k: 'turn', turn: 2, usd: 1, baseUsd: 2, sid: 'older', ts: NOW - 2 * 3_600_000 }),
      line({ k: 'prompt', turn: 2, tier: 'routine', sid: 'older', ts: NOW - 2 * 3_600_000 - 5000 }),
      line({ k: 'decision', turn: 2, appModel: 'claude-opus-5-5', appEffort: 'high', sendFamily: 'sonnet', sendModel: null, sendEffort: 'medium', switched: true, reason: 'everyday work', sid: 'older', ts: NOW - 2 * 3_600_000 - 4000 }),
    ].join('\n'),
  )
  writeFileSync(
    join(dir, 'audit-newer.jsonl'),
    [
      line({ k: 'session', project: '/x', sid: 'newer', ts: NOW - 3_600_000 }),
      'not json at all',
      line({ k: 'limits', windows: [{ name: '5-hour', pct: 58, resetsAt: NOW + 130 * 60_000 }, { name: 'Weekly', pct: 91, resetsAt: NOW + 3 * 86_400_000 }], ctxPct: 40, sid: 'newer', ts: NOW - 10 * 60_000 }),
      line({ k: 'prompt', turn: 3, tier: 'complex', sid: 'newer', ts: NOW - 6 * 60_000 }),
      line({ k: 'decision', turn: 3, appModel: 'claude-opus-5-5', appEffort: 'high', sendFamily: 'opus', sendModel: null, sendEffort: 'high', switched: false, reason: 'stayed on Opus', sid: 'newer', ts: NOW - 5 * 60_000 }),
      line({ k: 'turn', turn: 3, usd: 0.5, baseUsd: 1.5, cacheSaved: 3, sid: 'newer', ts: NOW - 4 * 60_000 }),
    ].join('\n'),
  )
}

test('display width counts emoji as two cells and escape codes as none', () => {
  assert.equal(width('abc'), 3)
  assert.equal(width('🗺️ Map'), 6)
  assert.equal(width('📊 ✅ ⏳ ⚪ ❓'), 14)
  assert.equal(width('\x1b[1;38;2;1;2;3mab\x1b[0m'), 2)
  assert.equal(width('╭─│█░…·'), 7)
  assert.equal(width('é'), 1, 'a combining accent takes no cell')
  const cut = fit('\x1b[1mhello world\x1b[0m', 6)
  assert.equal(strip(cut), 'hello…')
  assert.ok(cut.endsWith('\x1b[0m'), 'colours are reset after a cut')
  assert.equal(fit('📊📊📊', 4), '📊…', 'an emoji is never split')
  assert.equal(width(pad('🎯 x', 10)), 10)
  assert.equal(pad('7', 3, 'right'), '  7')
})

test('mapshift ui --once draws the tab bar and every card, with no escape codes under NO_COLOR', () => {
  const t = tempHome()
  try {
    for (const w of [120, 70]) {
      const out = cli(['ui', '--once', '--width', String(w), '--project', t.project, '--home', t.home], t.home)
      assert.ok(!out.includes('\x1b'), `no escape codes at width ${w}`)
      for (const s of ['q quit', '[ 📊 Overview ]','📜 Activity', '🗺️ Map', '❓ Help', '🎯 Right now', '⏱️ Limits', '💸 Savings (estimates)', '🗺️ Mapshift'])
        assert.ok(out.includes(s), `"${s}" at width ${w}`)
      const lines = out.trimEnd().split('\n')
      for (const l of lines) assert.ok(width(l) <= w, `line fits in ${w}: ${l}`)
      // two columns on a wide screen, one on a narrow one
      const sideBySide = lines.some(l => l.includes('🎯 Right now') && l.includes('🗺️ Map'))
      assert.equal(sideBySide, w >= 100)
      // an empty home shows the empty states, never an error
      assert.match(out, /Shows after your first request in Claude Code\./)
      assert.match(out, /Shows after your first request\./)
      assert.match(out, /Money shows after your first request in Claude Code\./)
      assert.match(out, /⚪ Not built yet/)
      // the folder is shown, but never through a user name in the home folder
      assert.ok(out.includes('proj'))
      assert.ok(!out.toLowerCase().includes(homedir().replace(/\\/g, '/').toLowerCase()), 'the home folder is written as ~')
    }
    const activity = cli(['ui', '--once', '--width', '90', '--tab', 'activity', '--project', t.project, '--home', t.home], t.home)
    assert.ok(activity.includes('[ 📜 Activity ]') && activity.includes('Shows after your first request.'))
    const map = cli(['ui', '--once', '--width', '90', '--tab', 'map', '--project', t.project, '--home', t.home], t.home)
    assert.ok(map.includes('Shows once the map is built.'))
  } finally {
    t.cleanup()
  }
})

test('mapshift with no arguments prints help when it is not on an interactive terminal', () => {
  const t = tempHome()
  try {
    assert.match(cli([], t.home), /Get started/)
  } finally {
    t.cleanup()
  }
})

test('keys and mouse clicks decode, and a click on the second tab picks Activity', () => {
  const t = tempHome()
  after(t.cleanup)
  const s = snapshot({ root: t.project, codexHome: null, now: NOW, home: join(t.home, 'mapshift') })
  const f = renderFrame(s, { tab: 'overview', width: 100, height: 30, style: makeStyle(0, true) })
  const second = f.tabs[1]!
  assert.equal(second.tab, 'activity')
  // the region matches where "Activity" is drawn on the plain frame
  const plainBar = renderFrame(s, { tab: 'overview', width: 100, style: plain }).lines[1]!
  const col = width(plainBar.slice(0, plainBar.indexOf('📜'))) + 1
  assert.ok(col >= second.x0 && col <= second.x1)

  const evs = decode(`\x1b[<0;${second.x0 + 2};2M\x1b[<0;${second.x0 + 2};2m`)
  assert.deepEqual(evs, [{ type: 'click', x: second.x0 + 2, y: 2 }], 'the release is ignored')
  const click = evs[0]!
  assert.ok(click.type === 'click')
  assert.equal(tabAt(f.tabs, click.x, click.y), 'activity')
  assert.equal(tabAt(f.tabs, click.x, 5), null, 'a click below the tab bar is not a tab')
  assert.equal(tabAt(f.tabs, f.tabs[0]!.x0, 2), 'overview')

  assert.deepEqual(decode('\x1b[<64;5;5M\x1b[<65;5;5M'), [
    { type: 'wheel', dir: 'up' },
    { type: 'wheel', dir: 'down' },
  ])
  assert.deepEqual(decode('\x1b[<32;5;2M'), [], 'a drag is not a click')
  assert.deepEqual(decode('\x1b[<2;5;2M'), [], 'a right click is not a click')
  assert.deepEqual(decode('\x1b[C\x1b[D\t\x1b[Z'), ['right', 'left', 'tab', 'backtab'].map(key => ({ type: 'key', key })))
  assert.deepEqual(decode('\x1b'), [{ type: 'key', key: 'esc' }])
  assert.deepEqual(decode('\x03'), [{ type: 'key', key: 'ctrl-c' }])
  assert.deepEqual(decode('2q'), [
    { type: 'char', char: '2' },
    { type: 'char', char: 'q' },
  ])
  assert.deepEqual(decode('\x1b[15~x'), [{ type: 'char', char: 'x' }], 'an unknown key is skipped whole')
  assert.deepEqual(decode('\x1bq'), [], 'Alt+q does not quit')
  assert.deepEqual(decode('\x1b[M !!x'), [{ type: 'char', char: 'x' }], 'an old-style mouse report is never read as keys')
  assert.deepEqual(decode('\x1b[M q!'), [], 'not even when its bytes spell q')
  // a click split across two reads is put back together
  const first = decodeChunk('1\x1b[<0;12')
  assert.deepEqual(first, { events: [{ type: 'char', char: '1' }], rest: '\x1b[<0;12' })
  assert.deepEqual(decodeChunk(`${first.rest};2M`).events, [{ type: 'click', x: 12, y: 2 }])
})

test('the terminal is put back after a crash, an early exit and a normal quit', () => {
  const t = tempHome()
  try {
    const script = join(t.home, 'run-ui.mts')
    const url = (p: string) => pathToFileURL(join(import.meta.dirname, '..', 'src', ...p.split('/'))).href
    writeFileSync(
      script,
      [
        `import { runUi } from '${url('tui/app.ts')}'`,
        `import { snapshot } from '${url('dashboard/snapshot.ts')}'`,
        'const [mode, root, home] = process.argv.slice(2)',
        'const s = snapshot({ root, codexHome: null, home })',
        'const done = runUi({ data: () => s, refreshMs: 60_000, depth: 0 })',
        "if (mode === 'throw') setTimeout(() => { throw new Error('boom') }, 100)",
        "if (mode === 'exit') setTimeout(() => process.exit(3), 100)",
        'done.then(code => { process.exitCode = code })',
      ].join('\n'),
    )
    const run = (mode: string, input: string) =>
      spawnSync(process.execPath, [script, mode, t.project, join(t.home, 'mapshift')], { input, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    const crash = run('throw', '')
    assert.equal(crash.status, 1)
    assert.ok(crash.stdout.startsWith(ENTER) && crash.stdout.endsWith(LEAVE), 'restored after a crash')
    assert.match(crash.stderr, /Mapshift dashboard stopped: Error: boom/)
    const exit = run('exit', '')
    assert.equal(exit.status, 3)
    assert.ok(exit.stdout.endsWith(LEAVE), 'restored on an early exit')
    const quit = run('quit', 'q')
    assert.equal(quit.status, 0, 'q quits and nothing keeps the process alive')
    assert.ok(quit.stdout.includes('[ 📊 Overview ]') && quit.stdout.endsWith(LEAVE), 'restored on quit')
  } finally {
    t.cleanup()
  }
})

test('the snapshot reads the Claude Code audit logs: newest limits, today\'s money and the last decision', () => {
  const t = tempHome()
  try {
    const mh = join(t.home, 'mapshift')
    assert.equal(readClaudeUsage(join(mh, 'logs', 'claude'), NOW), null, 'no folder: null')
    assert.equal(snapshot({ root: t.project, codexHome: null, now: NOW, home: mh }).claude, null)
    mkdirSync(join(mh, 'logs', 'claude'), { recursive: true })
    assert.equal(readClaudeUsage(join(mh, 'logs', 'claude'), NOW), null, 'an empty folder: null')

    writeAudit(join(mh, 'logs', 'claude'))
    const c = readClaudeUsage(join(mh, 'logs', 'claude'), NOW)!
    assert.equal(c.limits!.at, NOW - 10 * 60_000, 'the newest reading of any chat')
    assert.deepEqual(
      c.limits!.windows.map(w => [w.name, w.pct]),
      [
        ['5-hour', 58],
        ['Weekly', 91],
      ],
    )
    assert.equal(c.limits!.ctxPct, 40)
    assert.deepEqual(c.today, { turns: 2, usd: 1.5, baseUsd: 3.5 }, "yesterday's request is left out")
    assert.equal(c.decisions.length, 2)
    assert.deepEqual(
      { tier: c.decisions[0]!.tier, model: c.decisions[0]!.model, effort: c.decisions[0]!.effort },
      { tier: 'complex', model: 'claude-opus-5-5', effort: 'high' },
    )
    assert.equal(c.decisions[1]!.model, 'sonnet', 'a switch shows the model it moved to')
    assert.equal(c.decisions[1]!.tier, 'routine')

    const s = snapshot({ root: t.project, codexHome: null, now: NOW, home: mh })
    const text = renderFrame(s, { tab: 'overview', width: 120, style: plain, now: NOW }).lines.join('\n')
    assert.match(text, /Complex/)
    assert.match(text, /Opus 5\.5 · high effort/)
    assert.match(text, /Saved \$2\.00 \(57%\)/)
    assert.match(text, /Without Mapshift .*\$3\.50/)
    assert.match(text, /With Mapshift .*\$1\.50/)
    assert.match(text, /58%  resets in 2 h 10 min/)
    assert.match(text, /91%/)
    assert.ok(!/Shows after your first request/.test(text))
    const activity = renderFrame(s, { tab: 'activity', width: 120, style: plain, now: NOW }).lines.join('\n')
    assert.match(activity, /🎯 Complex/)
    assert.match(activity, /Sonnet · medium effort · switched model/)

    // red appears for the limit at 91% and for nothing else
    const red = '38;2;248;81;73'
    const colour = renderFrame(s, { tab: 'overview', width: 120, style: makeStyle(24), now: NOW }).lines.join('\n')
    assert.ok(colour.includes(red))
    const calm: Snapshot = { ...s, claude: { ...s.claude!, limits: { ...s.claude!.limits!, windows: [{ name: '5-hour', pct: 30, resetsAt: null }], ctxPct: 10 } } }
    for (const tab of ['overview', 'activity', 'map', 'help'] as const)
      assert.ok(!renderFrame(calm, { tab, width: 120, style: makeStyle(24), now: NOW }).lines.join('').includes(red), `no red on ${tab}`)
  } finally {
    t.cleanup()
  }
})

test('the live dashboard switches tab on a click and puts the terminal back on quit', async () => {
  const t = tempHome()
  after(t.cleanup)
  const s = snapshot({ root: t.project, codexHome: null, now: NOW, home: join(t.home, 'mapshift') })
  const input = Object.assign(new PassThrough(), { isTTY: true, raw: [] as boolean[], setRawMode(on: boolean) { this.raw.push(on) } })
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 })
  let written = ''
  output.on('data', d => (written += String(d)))
  const done = runUi({ data: () => s, input, output, depth: 0, refreshMs: 60_000 })
  await new Promise(r => setImmediate(r))
  assert.ok(written.startsWith(ENTER), 'alternate screen, hidden cursor and mouse on first')
  assert.ok(written.includes('[ 📊 Overview ]'))
  const regions = renderFrame(s, { tab: 'overview', width: 100, height: 30, style: makeStyle(0, true) }).tabs
  input.write(`\x1b[<0;${regions[1]!.x0 + 1};2M`)
  await new Promise(r => setImmediate(r))
  assert.ok(written.slice(written.lastIndexOf('\x1b[?2026h')).includes('[ 📜 Activity ]'), 'the click opened Activity')
  input.write('4')
  await new Promise(r => setImmediate(r))
  assert.ok(written.slice(written.lastIndexOf('\x1b[?2026h')).includes('[ ❓ Help ]'))
  input.write('q')
  assert.equal(await done, 0)
  assert.ok(written.endsWith(LEAVE), 'the terminal is put back')
  assert.deepEqual(input.raw, [true, false])
})

test('colour follows NO_COLOR and FORCE_COLOR, and the 16-colour violet is never pink', () => {
  const tty = { isTTY: true, getColorDepth: () => 24 }
  assert.equal(colorDepth(tty, { NO_COLOR: '1' }), 0)
  assert.equal(colorDepth({ isTTY: false }, {}), 0)
  assert.equal(colorDepth({ isTTY: false }, { FORCE_COLOR: '3' }), 24)
  assert.equal(colorDepth(tty, { FORCE_COLOR: '0' }), 0)
  assert.equal(colorDepth(tty, { COLORTERM: 'truecolor' }), 24)
  assert.equal(colorDepth({ isTTY: true, getColorDepth: () => 8 }, {}), 8)
  assert.ok(makeStyle(24).fg('teal', 'x').includes('38;2;94;234;212'))
  assert.ok(makeStyle(4).fg('violet', 'x').includes('[94m'))
  assert.ok(!makeStyle(4).fg('violet', 'x').includes('[35m'))
  assert.equal(makeStyle(0).fg('teal', 'x'), 'x')
})

test('plain words for models and waiting times', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5')
  assert.equal(modelName('sonnet'), 'Sonnet')
  assert.equal(modelName('gpt-5-codex'), 'gpt-5-codex')
  assert.equal(inText(130 * 60_000), '2 h 10 min')
  assert.equal(inText(45 * 60_000), '45 min')
  assert.equal(inText(3 * 86_400_000 + 4 * 3_600_000), '3 days 4 h')
})
