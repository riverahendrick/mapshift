import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { mapDbPath, normalizeKey, repoDir, repoId } from '../src/core/paths.ts'
import { acquireLock, buildNow, ensureFresh, openMap, releaseLock, status } from '../src/map/indexer.ts'
import { listFiles } from '../src/map/scan.ts'
import { makeRepo } from './helpers.ts'

const STORE = `export function save(x: number) { return x }\nexport class Repo { find(id: string) { return id } }\n`
const CART = `import { save as persist } from './store'
import { Repo } from './store'
export class Cart {
  total(n: number) {
    persist(n)
    new Repo().find('a')
    return this.helper(n)
  }
  helper(n: number) { return n }
}
`

type Edge = { from: string | null; to: string; confidence: string; file: string }
function edges(root: string): Edge[] {
  const store = openMap(root)
  return store
    .sql(`SELECT s.qualified AS "from", d.qualified AS "to", e.confidence, f.path AS file
          FROM edges e JOIN symbols d ON d.id = e.dst LEFT JOIN symbols s ON s.id = e.src JOIN files f ON f.id = e.src_file`)
    .all() as Edge[]
}

test('a first build maps definitions and resolves calls through imports, aliases and this', async () => {
  const r = makeRepo({ 'src/store.ts': STORE, 'src/cart.ts': CART })
  try {
    const res = await buildNow(r.root)
    assert.ok(res)
    const st = status(r.root)
    assert.equal(st.state, 'ready')
    assert.equal(st.files, 2)
    const e = edges(r.root)
    assert.ok(e.some(x => x.from === 'Cart.total' && x.to === 'save' && x.confidence === 'resolved'), 'alias import')
    assert.ok(e.some(x => x.from === 'Cart.total' && x.to === 'Cart.helper' && x.confidence === 'resolved'), 'this call')
    assert.ok(e.some(x => x.from === 'Cart.total' && x.to === 'Repo' && x.confidence === 'resolved'), 'new through import')
    assert.ok(e.some(x => x.from === 'Cart.total' && x.to === 'Repo.find'), 'method on a built object')
  } finally {
    r.cleanup()
  }
})

test('edits, deletes and renames show up on the next refresh', async () => {
  const r = makeRepo({ 'src/store.ts': STORE, 'src/cart.ts': CART })
  try {
    await buildNow(r.root)
    // edit: the call to persist goes away
    r.write('src/cart.ts', CART.replace('    persist(n)\n', ''))
    const later = new Date(Date.now() + 5000)
    utimesSync(join(r.root, 'src/cart.ts'), later, later)
    await ensureFresh(r.root)
    assert.ok(!edges(r.root).some(x => x.to === 'save'))
    // rename the store file: its definitions move, the import breaks, nothing stale remains
    execFileSync('git', ['mv', 'src/store.ts', 'src/storage.ts'], { cwd: r.root, windowsHide: true })
    await ensureFresh(r.root)
    const store = openMap(r.root)
    const paths = (store.sql('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map(x => x.path)
    assert.deepEqual(paths, ['src/cart.ts', 'src/storage.ts'])
    // delete
    rmSync(join(r.root, 'src/storage.ts'))
    await ensureFresh(r.root)
    assert.equal(status(r.root).symbols, 3) // Cart, Cart.total, Cart.helper
    assert.ok(!edges(r.root).some(x => x.to === 'Repo'))
  } finally {
    r.cleanup()
  }
})

test('a definition moving to another file is matched again', async () => {
  const r = makeRepo({ 'a.py': 'def work():\n    return 1\n', 'b.py': 'from a import work\n\ndef run():\n    work()\n' })
  try {
    await buildNow(r.root)
    assert.ok(edges(r.root).some(x => x.from === 'run' && x.to === 'work' && x.confidence === 'resolved'))
    r.write('a.py', '# moved\n')
    r.write('c.py', 'def work():\n    return 2\n')
    r.write('b.py', 'from c import work\n\ndef run():\n    work()\n')
    const later = new Date(Date.now() + 5000)
    for (const f of ['a.py', 'b.py', 'c.py']) utimesSync(join(r.root, f), later, later)
    await ensureFresh(r.root)
    const e = edges(r.root).filter(x => x.from === 'run')
    assert.equal(e.length, 1)
    assert.equal(e[0]!.file, 'b.py')
    const store = openMap(r.root)
    const target = store.sql('SELECT f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.qualified = ?').get('work') as { path: string }
    assert.equal(target.path, 'c.py')
  } finally {
    r.cleanup()
  }
})

test('a plain folder without git is mapped, skipping big, generated and ignored files', async () => {
  const r = makeRepo(
    {
      'app.js': 'function main() { helper() }\nfunction helper() {}\n',
      'lib/vendor.min.js': 'x',
      'node_modules/pkg/index.js': 'function nope() {}',
      'big.ts': `export const a = 1\n${'// pad\n'.repeat(180_000)}`,
      'wide.js': `var a=${'1+'.repeat(15_000)}1;\n`,
      'notes.txt': 'not code',
    },
    { git: false },
  )
  try {
    const { files, skipped } = listFiles(r.root)
    assert.deepEqual(files.map(f => f.path), ['app.js'])
    assert.deepEqual(
      skipped.map(s => `${s.path}:${s.reason}`).sort(),
      ['big.ts:too large', 'lib/vendor.min.js:generated', 'wide.js:generated'],
    )
    await buildNow(r.root)
    assert.ok(edges(r.root).some(x => x.from === 'main' && x.to === 'helper'))
    assert.equal(status(r.root).skipped.length, 3)
  } finally {
    r.cleanup()
  }
})

test('an unreadable file is listed and the build goes on', async () => {
  const r = makeRepo({ 'ok.ts': 'export function fine() {}\n' })
  try {
    writeFileSync(join(r.root, 'bad.ts'), Buffer.from([0x66, 0x00, 0x6e, 0x00]))
    await buildNow(r.root)
    const st = status(r.root)
    assert.equal(st.files, 1)
    assert.deepEqual(st.skipped, [{ path: 'bad.ts', reason: 'unreadable' }])
  } finally {
    r.cleanup()
  }
})

test('the build lock: one holder at a time, and a dead holder is taken over', () => {
  const r = makeRepo({ 'a.ts': 'export const a = 1\n' })
  try {
    assert.equal(acquireLock(r.root), true)
    assert.equal(acquireLock(r.root), false)
    releaseLock(r.root)
    mkdirSync(repoDir(r.root), { recursive: true })
    writeFileSync(join(repoDir(r.root), 'map.lock'), JSON.stringify({ pid: 2_000_000_000, at: Date.now() }))
    assert.equal(acquireLock(r.root), true, 'stale lock recovered')
    releaseLock(r.root)
  } finally {
    r.cleanup()
  }
})

test('an empty map builds in the background and answers within the budget', async () => {
  const r = makeRepo({ 'src/store.ts': STORE, 'src/cart.ts': CART })
  try {
    const st = await ensureFresh(r.root, 15_000)
    assert.equal(st.state, 'ready')
    assert.equal(st.files, 2)
  } finally {
    r.cleanup()
  }
})

test('the map lives outside the project, and worktrees share one map', () => {
  const r = makeRepo({ 'a.ts': 'export const a = 1\n' })
  try {
    assert.ok(normalizeKey(mapDbPath(r.root)).startsWith(normalizeKey(r.home)))
    const wt = join(r.root, '..', 'wt').replace(/\\/g, '/')
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: r.root, windowsHide: true })
    assert.equal(repoId(wt), repoId(r.root))
    if (process.platform === 'win32') assert.equal(normalizeKey('C:\\Work\\App\\'), normalizeKey('c:/work/app'))
  } finally {
    r.cleanup()
  }
})
