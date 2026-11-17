import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extract } from '../src/map/extract.ts'
import { startingPoints } from '../src/map/hint.ts'
import { buildNow, openMap } from '../src/map/indexer.ts'
import { find } from '../src/map/query.ts'
import { makeRepo } from './helpers.ts'

const doc = async (lang: Parameters<typeof extract>[0], src: string, name: string) => (await extract(lang, src)).syms.find(s => s.name === name)?.doc

test('the comment that explains a definition is kept, markers removed', async () => {
  assert.equal(
    await doc('typescript', '/**\n * Masks a phone number before it is logged.\n * @param raw the number\n */\nexport function maskPhone(raw: string) { return raw }\n', 'maskPhone'),
    'Masks a phone number before it is logged. raw the number',
  )
  assert.equal(await doc('javascript', '// Sends the weekly digest email.\n// Runs every Monday.\nfunction sendDigest() {}\n', 'sendDigest'), 'Sends the weekly digest email. Runs every Monday.')
  assert.equal(await doc('python', 'def refund(order):\n    """Gives the money back for a cancelled order."""\n    return 1\n', 'refund'), 'Gives the money back for a cancelled order.')
  assert.equal(await doc('go', 'package x\n\n// Charge takes payment from a card.\nfunc Charge() {}\n', 'Charge'), 'Charge takes payment from a card.')
  assert.equal(await doc('typescript', '// unrelated note\n\nexport function lonely() {}\n', 'lonely'), '', 'a comment separated by a blank line is not its doc')
})

test('a map saved in an older format is rebuilt in the new one, not left half-working', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  const { mapDbPath } = await import('../src/core/paths.ts')
  const r = makeRepo({ 'src/a.ts': '/** Says hello. */\nexport function hello() {}\n' })
  try {
    // an old map: no doc column, four search columns, format 2
    mkdirSync(dirname(mapDbPath(r.root)), { recursive: true })
    const old = new DatabaseSync(mapDbPath(r.root))
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('format', '2');
              CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, name TEXT NOT NULL, qualified TEXT NOT NULL, kind TEXT NOT NULL,
                start INTEGER NOT NULL, end INTEGER NOT NULL, signature TEXT NOT NULL, exported INTEGER NOT NULL, rank REAL NOT NULL DEFAULT 0);
              CREATE VIRTUAL TABLE symbols_fts USING fts5(name, words, signature, path);`)
    old.close()
    await buildNow(r.root)
    const row = openMap(r.root).sql('SELECT doc FROM symbols WHERE name = ?').get('hello') as { doc: string }
    assert.equal(row.doc, 'Says hello.')
  } finally {
    r.cleanup()
  }
})

test('a plain-English question finds code by what its comment says, even when the names differ', async () => {
  const r = makeRepo({
    'src/a.ts': '/** Masks phone numbers so they never reach the logs. */\nexport function scrubPii(s: string) { return s }\n',
    'src/b.ts': 'export function formatPhone(s: string) { return s }\n',
  })
  try {
    await buildNow(r.root)
    const store = openMap(r.root)
    assert.match(find(store, r.root, 'where are phone numbers masked before logging').text, /### 1\. scrubPii/)
    assert.match(startingPoints(store, 'mask phone numbers in the logs')?.text ?? '', /scrubPii/)
  } finally {
    r.cleanup()
  }
})
