import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { LangId } from './languages.ts'
import type { Skipped } from './scan.ts'
import type { Facts, SymKind } from './types.ts'

export type FileRow = { id: number; path: string; lang: LangId; size: number; mtime: number; hash: string; lines: number }
export type SymRow = {
  id: number
  file_id: number
  name: string
  qualified: string
  kind: SymKind
  start: number
  end: number
  signature: string
  exported: number
  rank: number
}
export type Confidence = 'resolved' | 'inferred' | 'ambiguous'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, lang TEXT NOT NULL,
  size INTEGER NOT NULL, mtime INTEGER NOT NULL, hash TEXT NOT NULL, lines INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL, qualified TEXT NOT NULL, kind TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
  signature TEXT NOT NULL, exported INTEGER NOT NULL, doc TEXT NOT NULL DEFAULT '', rank REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS symbols_qualified ON symbols(qualified);
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL, receiver TEXT, line INTEGER NOT NULL, from_qualified TEXT, kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS refs_file ON refs(file_id);
CREATE TABLE IF NOT EXISTS imports (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source TEXT NOT NULL, local TEXT NOT NULL, imported TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS imports_file ON imports(file_id);
CREATE TABLE IF NOT EXISTS edges (
  ref_id INTEGER NOT NULL REFERENCES refs(id) ON DELETE CASCADE,
  src INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  src_file INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dst INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  confidence TEXT NOT NULL, line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS edges_ref ON edges(ref_id);
CREATE TABLE IF NOT EXISTS skipped (path TEXT PRIMARY KEY, reason TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, words, signature, path, doc, body, tokenize = 'unicode61');
`

/** `getTotalPrice` and `get_total_price` both become `get total price`, so a search for "total" finds them. */
export function nameWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-$.]+/g, ' ')
    .toLowerCase()
    .trim()
}

/** The map of one repository, in one SQLite file. Readers never block the writer (WAL). */
export class Store {
  readonly db: DatabaseSync
  private stmts = new Map<string, StatementSync>()

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  /** A prepared statement, compiled once. */
  sql(text: string): StatementSync {
    let s = this.stmts.get(text)
    if (!s) {
      s = this.db.prepare(text)
      this.stmts.set(text, s)
    }
    return s
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  meta(key: string): string | null {
    const row = this.sql('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.sql('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  files(): Map<string, FileRow> {
    const rows = this.sql('SELECT id, path, lang, size, mtime, hash, lines FROM files').all() as FileRow[]
    return new Map(rows.map(r => [r.path, r]))
  }

  fileByPath(path: string): FileRow | null {
    return (this.sql('SELECT id, path, lang, size, mtime, hash, lines FROM files WHERE path = ?').get(path) as FileRow | undefined) ?? null
  }

  /** Names defined in a file, used to find the calls elsewhere that must be matched again. */
  namesIn(fileId: number): string[] {
    return (this.sql('SELECT DISTINCT name FROM symbols WHERE file_id = ?').all(fileId) as { name: string }[]).map(r => r.name)
  }

  /** Replaces everything known about one file. Returns the file's id. */
  putFile(f: { path: string; lang: LangId; size: number; mtime: number; hash: string; lines: number }, facts: Facts): number {
    const old = this.fileByPath(f.path)
    if (old) this.removeFile(f.path)
    const { lastInsertRowid } = this.sql('INSERT INTO files(path, lang, size, mtime, hash, lines) VALUES(?, ?, ?, ?, ?, ?)').run(
      f.path, f.lang, f.size, f.mtime, f.hash, f.lines,
    )
    const fileId = Number(lastInsertRowid)
    const addSym = this.sql('INSERT INTO symbols(file_id, name, qualified, kind, start, end, signature, exported, doc) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const addFts = this.sql('INSERT INTO symbols_fts(rowid, name, words, signature, path, doc, body) VALUES(?, ?, ?, ?, ?, ?, ?)')
    for (const s of facts.syms) {
      const doc = s.doc ?? ''
      const id = Number(addSym.run(fileId, s.name, s.qualified, s.kind, s.start, s.end, s.signature, s.exported ? 1 : 0, doc).lastInsertRowid)
      addFts.run(id, s.name, `${nameWords(s.qualified)} ${s.qualified}`, s.signature, f.path, doc, s.body ?? '')
    }
    const addRef = this.sql('INSERT INTO refs(file_id, name, receiver, line, from_qualified, kind) VALUES(?, ?, ?, ?, ?, ?)')
    for (const r of facts.refs) addRef.run(fileId, r.name, r.receiver, r.line, r.from, r.kind)
    const addImp = this.sql('INSERT INTO imports(file_id, source, local, imported) VALUES(?, ?, ?, ?)')
    for (const i of facts.imps) addImp.run(fileId, i.source, i.local, i.imported)
    return fileId
  }

  /** Only the size and time changed (same content): no need to read the file again. */
  touchFile(path: string, size: number, mtime: number): void {
    this.sql('UPDATE files SET size = ?, mtime = ? WHERE path = ?').run(size, mtime, path)
  }

  removeFile(path: string): void {
    const row = this.fileByPath(path)
    if (!row) return
    this.sql('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)').run(row.id)
    this.sql('DELETE FROM files WHERE id = ?').run(row.id)
  }

  setSkipped(list: Skipped[]): void {
    this.sql('DELETE FROM skipped').run()
    const add = this.sql('INSERT OR REPLACE INTO skipped(path, reason) VALUES(?, ?)')
    for (const s of list) add.run(s.path, s.reason)
  }

  skipped(): Skipped[] {
    return (this.sql('SELECT path, reason FROM skipped ORDER BY path').all() as Skipped[]).map(r => ({ path: r.path, reason: r.reason }))
  }

  counts(): { files: number; symbols: number; edges: number } {
    const n = (t: string) => (this.sql(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
    return { files: n('files'), symbols: n('symbols'), edges: n('edges') }
  }

  /** Drops every table and creates them again in the current format (used when the map format changes). */
  reset(): void {
    this.stmts.clear()
    this.db.exec(
      'DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS refs; DROP TABLE IF EXISTS symbols_fts; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS skipped; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS meta;',
    )
    this.db.exec(SCHEMA)
  }

  /** Empties the map, keeping the file itself. */
  wipe(): void {
    this.db.exec('DELETE FROM edges; DELETE FROM imports; DELETE FROM refs; DELETE FROM symbols; DELETE FROM symbols_fts; DELETE FROM files; DELETE FROM skipped; DELETE FROM meta;')
  }

  close(): void {
    this.stmts.clear()
    this.db.close()
  }
}
