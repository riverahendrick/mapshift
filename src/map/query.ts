import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { LANGS, type LangId } from './languages.ts'
import { status as mapStatus, type MapStatus } from './indexer.ts'
import { nameWords, type Store, type SymRow } from './store.ts'

/** What every map tool returns: the text for the agent, and the files it points at (for the savings ledger). */
export type Answer = { text: string; files: string[] }

export const LIMITS = { findChars: 6000, codeLines: 12, searchHits: 200, traceNodes: 60 }

type Hit = SymRow & { path: string; lang: LangId; score: number }

const STOP = new Set(
  'a an and are as at be by can do does for from get got how i if in into is it its me my of on or that the this to what when where which who why with work works working code file files function functions method class implement implemented handle handled logic find show me please use used using'.split(' '),
)
const TESTY = /(^|\/)(test|tests|__tests__|spec|specs|fixtures?|mocks?|examples?|e2e|testdata)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|^test_.*\.py$/i
const KIND_WEIGHT: Record<string, number> = { class: 1.3, interface: 1.15, function: 1.25, method: 1.2, type: 1, enum: 1, module: 0.9, variable: 0.7 }

/** The words of a question, plus any exact names in it (`getTotal`, `cart_total`, `Cart.total`). */
export function terms(q: string): { words: string[]; names: string[] } {
  const names = [...q.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)]
    .map(m => m[0])
    .filter(t => /[A-Z_$.]/.test(t.slice(1)) || /[a-z][A-Z]/.test(t) || t.includes('_'))
  const words = [...new Set(nameWords(q.replace(/[^\w$. ]+/g, ' ')).split(/\s+/))].filter(w => w.length > 1 && !STOP.has(w))
  return { words, names: [...new Set(names)] }
}

const row = (store: Store, sql: string, ...args: (string | number)[]) => store.sql(sql).all(...args) as unknown as Hit[]
const HIT_SQL = `SELECT s.*, f.path, f.lang FROM symbols s JOIN files f ON f.id = s.file_id`

function readLines(root: string, path: string): string[] | null {
  try {
    return readFileSync(join(root, path), 'utf8').split('\n')
  } catch {
    return null
  }
}

/** Up to `max` lines of a definition, numbered, with a note for the rest. */
function codeBlock(root: string, h: { path: string; start: number; end: number; lang: string }, max = LIMITS.codeLines): string {
  const lines = readLines(root, h.path)
  if (!lines) return '(file no longer on disk)'
  const end = Math.min(h.end, h.start + max - 1, lines.length)
  const width = String(end).length
  const body = []
  for (let n = h.start; n <= end; n++) body.push(`${String(n).padStart(width)}  ${(lines[n - 1] ?? '').replace(/\r$/, '')}`)
  const more = h.end - end
  const fence = (LANGS[h.lang as LangId]?.grammar ?? '').replace('c_sharp', 'csharp').replace('tsx', 'tsx')
  return `\`\`\`${fence}\n${body.join('\n')}${more > 0 ? `\n${' '.repeat(width)}  … ${more} more line${more === 1 ? '' : 's'}` : ''}\n\`\`\``
}

const tag = (c: string): string => (c === 'resolved' ? '' : ` (${c})`)
const where = (h: { path: string; start: number; end?: number }): string => `${h.path}:${h.start}${h.end && h.end !== h.start ? `-${h.end}` : ''}`

type Link = { who: string; path: string; line: number; uses: number; confidence: string; rank: number }

/**
 * Callers grouped one line each (`createLogEvent (log-event.ts:55) ×3`), real code before tests, and the
 * tests summed up in one line, so a busy function's list stays short and useful.
 */
function summarize(list: Link[], max: number): string[] {
  const code = list.filter(l => !TESTY.test(l.path)).sort((a, b) => b.rank - a.rank || b.uses - a.uses)
  const tests = list.filter(l => TESTY.test(l.path))
  const out = code.slice(0, max).map(l => `${l.who} (${l.path}:${l.line})${l.uses > 1 ? ` ×${l.uses}` : ''}${tag(l.confidence)}`)
  if (code.length > max) out.push(`${code.length - max} more`)
  if (tests.length) {
    const uses = tests.reduce((s, l) => s + l.uses, 0)
    const files = new Set(tests.map(l => l.path)).size
    out.push(`${uses} from tests in ${files} file${files === 1 ? '' : 's'}`)
  }
  return out
}

function links(store: Store, id: number): { callers: string[]; calls: string[] } {
  const callers = store
    .sql(
      `SELECT COALESCE(s.qualified, '(top of file)') AS who, f.path, MIN(e.line) AS line, COUNT(*) AS uses,
              MIN(e.confidence) AS confidence, COALESCE(MAX(s.rank), 0) AS rank
       FROM edges e JOIN files f ON f.id = e.src_file LEFT JOIN symbols s ON s.id = e.src
       WHERE e.dst = ? GROUP BY who, f.path LIMIT 400`,
    )
    .all(id) as Link[]
  const calls = store
    .sql(
      `SELECT d.qualified AS who, f.path, d.start AS line, COUNT(*) AS uses, MIN(e.confidence) AS confidence, d.rank AS rank
       FROM edges e JOIN symbols d ON d.id = e.dst JOIN files f ON f.id = d.file_id
       WHERE e.src = ? GROUP BY d.id LIMIT 400`,
    )
    .all(id) as Link[]
  return { callers: summarize(callers, 5), calls: summarize(calls, 6) }
}

/** Lines that tell the agent the map is not complete yet, or left files out. */
function notices(st: MapStatus): string[] {
  const out: string[] = []
  if (st.state === 'building') out.push(`Note: the map is ${st.percent}% built, so results may be incomplete.`)
  if (st.state === 'empty') out.push('Note: the map is still being built. Try again in a moment, or use your usual search meanwhile.')
  return out
}

function score(h: Hit, base: number, names: Set<string>, words: string[]): number {
  let s = base
  const lname = h.name.toLowerCase()
  if (names.has(h.name) || names.has(h.qualified)) s *= 4
  else if ([...names].some(n => n.toLowerCase() === lname)) s *= 3
  if (words.length && words.every(w => nameWords(h.qualified).includes(w))) s *= 1.8
  s *= KIND_WEIGHT[h.kind] ?? 1
  s *= 1 + Math.log1p(h.rank) * 0.35
  if (TESTY.test(h.path)) s *= 0.4
  if (h.exported) s *= 1.1
  return s
}

/** Ranked definitions for a question or a list of names, with their code. */
export function find(store: Store, root: string, q: string, opts: { limit?: number } = {}): Answer {
  const limit = Math.max(1, Math.min(opts.limit ?? 6, 15))
  const st = mapStatus(root, store)
  const { words, names } = terms(q)
  const nameSet = new Set(names)
  const scored = new Map<number, Hit>()

  const add = (rows: Hit[], base: (h: Hit, i: number) => number) => {
    rows.forEach((h, i) => {
      const s = score(h, base(h, i), nameSet, words)
      const prev = scored.get(h.id)
      if (!prev || prev.score < s) scored.set(h.id, { ...h, score: s })
    })
  }

  // exact names first: `Cart.total`, `getTotal`
  for (const n of names) {
    const last = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : n
    add(row(store, `${HIT_SQL} WHERE s.qualified = ? OR s.name = ? COLLATE NOCASE LIMIT 30`, n, last), () => 10)
  }
  // then full-text over names, name words, signatures and paths
  const ftsTerms = [...new Set([...words, ...names.flatMap(n => nameWords(n).split(' '))])].filter(t => /^[\w]+$/.test(t) && t.length > 1)
  if (ftsTerms.length) {
    const match = ftsTerms.map(t => `"${t}"*`).join(' OR ')
    try {
      const rows = store
        .sql(
          `SELECT s.*, f.path, f.lang, bm25(symbols_fts, 10.0, 6.0, 1.5, 2.5) AS bm FROM symbols_fts
           JOIN symbols s ON s.id = symbols_fts.rowid JOIN files f ON f.id = s.file_id
           WHERE symbols_fts MATCH ? ORDER BY bm LIMIT 300`,
        )
        .all(match) as unknown as (Hit & { bm: number })[]
      add(rows, h => Math.max(0.05, -(h as Hit & { bm: number }).bm))
    } catch {
      /* a query the search syntax cannot take: the exact-name pass still answers */
    }
  }

  const hits = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  const head = notices(st)
  if (!hits.length) {
    return { text: [...head, `Map · no matches for "${q}". Try other words, a function or class name, or map_search for exact text.`].join('\n'), files: [] }
  }

  const parts: string[] = [...head, `Map · ${hits.length} result${hits.length === 1 ? '' : 's'} for "${q}"`]
  const files: string[] = []
  let size = parts.join('\n').length
  for (const [i, h] of hits.entries()) {
    const l = links(store, h.id)
    const block = [
      ``,
      `### ${i + 1}. ${h.qualified} · ${h.kind} · ${where(h)}`,
      l.callers.length ? `Called by: ${l.callers.join(', ')}` : '',
      l.calls.length ? `Calls: ${l.calls.join(', ')}` : '',
      codeBlock(root, h, i < 3 ? LIMITS.codeLines : 6),
    ]
      .filter(Boolean)
      .join('\n')
    if (size + block.length > LIMITS.findChars && i > 0) {
      parts.push(`\n… ${hits.length - i} more not shown (answer size limit). Ask again with a narrower question.`)
      break
    }
    parts.push(block)
    size += block.length
    if (!files.includes(h.path)) files.push(h.path)
  }
  return { text: parts.join('\n'), files }
}

/** The definitions a name refers to, best first. Accepts `name`, `Class.method` or `path:line`. */
function lookup(store: Store, symbol: string): Hit[] {
  const at = /^(.+?):(\d+)$/.exec(symbol)
  if (at) {
    return row(
      store,
      `${HIT_SQL} WHERE (f.path = ? OR f.path LIKE ?) AND s.start <= ? AND s.end >= ? ORDER BY (s.end - s.start) LIMIT 1`,
      at[1]!,
      `%/${at[1]!}`,
      Number(at[2]),
      Number(at[2]),
    )
  }
  const exact = row(store, `${HIT_SQL} WHERE s.qualified = ? ORDER BY s.rank DESC LIMIT 5`, symbol)
  if (exact.length) return exact
  const last = symbol.includes('.') ? symbol.slice(symbol.lastIndexOf('.') + 1) : symbol
  return row(store, `${HIT_SQL} WHERE s.name = ? ORDER BY s.rank DESC LIMIT 5`, last)
}

/** Who calls a definition, what it calls, or everything a change to it can reach. */
export function trace(
  store: Store,
  root: string,
  symbol: string,
  opts: { direction?: 'in' | 'out' | 'impact'; depth?: number } = {},
): Answer {
  const direction = opts.direction ?? 'in'
  const depth = Math.max(1, Math.min(opts.depth ?? (direction === 'impact' ? 3 : 2), 6))
  const st = mapStatus(root, store)
  const roots = lookup(store, symbol)
  if (!roots.length) return { text: [...notices(st), `Map · no definition named "${symbol}". Try map_find to look it up first.`].join('\n'), files: [] }

  const out: string[] = [...notices(st)]
  const files = new Set<string>()
  if (roots.length > 1) out.push(`Map · "${symbol}" has ${roots.length} definitions; showing each.`)
  const step =
    direction === 'out'
      ? `SELECT d.id, d.qualified AS who, f.path, d.start AS line, e.confidence FROM edges e JOIN symbols d ON d.id = e.dst JOIN files f ON f.id = d.file_id WHERE e.src = ?`
      : `SELECT s.id, COALESCE(s.qualified, '(top of file)') AS who, f.path, e.line, e.confidence FROM edges e JOIN files f ON f.id = e.src_file LEFT JOIN symbols s ON s.id = e.src WHERE e.dst = ?`
  const label = direction === 'out' ? 'calls' : direction === 'impact' ? 'is reached by' : 'is called by'

  type Row = { id: number | null; who: string; path: string; line: number; confidence: string }
  for (const r of roots.slice(0, 3)) {
    files.add(r.path)
    out.push(``, `${r.qualified} · ${r.kind} · ${where(r)} ${label}:`)
    const seen = new Set<number>([r.id])
    let frontier = [r.id]
    let shown = 0
    const reachedFiles = new Set<string>()
    const testUses = new Map<string, number>()
    for (let level = 1; level <= depth && frontier.length; level++) {
      const next: number[] = []
      // one line per caller, with how many times it calls; tests are counted, not listed
      const grouped = new Map<string, Row & { uses: number }>()
      for (const id of frontier) {
        for (const e of store.sql(step).all(id) as Row[]) {
          reachedFiles.add(e.path)
          if (TESTY.test(e.path)) {
            testUses.set(e.path, (testUses.get(e.path) ?? 0) + 1)
            continue
          }
          const key = e.id !== null ? `#${e.id}` : `${e.who}@${e.path}`
          const g = grouped.get(key)
          if (g) g.uses++
          else grouped.set(key, { ...e, uses: 1 })
        }
      }
      for (const e of grouped.values()) {
        if (e.id !== null) {
          if (seen.has(e.id)) continue
          seen.add(e.id)
          next.push(e.id)
        }
        files.add(e.path)
        if (shown < LIMITS.traceNodes) out.push(`${'  '.repeat(level)}- ${e.who} (${e.path}:${e.line})${e.uses > 1 ? ` ×${e.uses}` : ''}${tag(e.confidence)}`)
        shown++
      }
      frontier = next
    }
    if (shown > LIMITS.traceNodes) out.push(`  … ${shown - LIMITS.traceNodes} more`)
    if (testUses.size) {
      const uses = [...testUses.values()].reduce((a, b) => a + b, 0)
      out.push(`  + ${uses} use${uses === 1 ? '' : 's'} from tests in ${testUses.size} file${testUses.size === 1 ? '' : 's'}`)
    }
    if (shown === 0 && !testUses.size) out.push(direction === 'out' ? '  - nothing it calls is in the map' : '  - no callers found in the map')
    if (direction === 'impact') out.push(`  Impact: ${seen.size - 1} definitions in ${reachedFiles.size} files within ${depth} steps.`)
  }
  return { text: out.join('\n').trim(), files: [...files] }
}

/** Every definition in one file, in order, with its lines: the file's whole API at a glance. */
export function fileApi(store: Store, root: string, path: string): Answer {
  const norm = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const file =
    (store.sql('SELECT id, path, lang, lines FROM files WHERE path = ?').get(norm) as { id: number; path: string; lang: LangId; lines: number } | undefined) ??
    (store.sql('SELECT id, path, lang, lines FROM files WHERE path LIKE ? ORDER BY length(path) LIMIT 1').get(`%${norm}`) as
      | { id: number; path: string; lang: LangId; lines: number }
      | undefined)
  if (!file) {
    const skipped = store.skipped().find(s => s.path.endsWith(norm))
    return { text: skipped ? `Map · ${skipped.path} is not mapped (${skipped.reason}).` : `Map · no mapped file matches "${path}".`, files: [] }
  }
  const syms = store.sql('SELECT * FROM symbols WHERE file_id = ? ORDER BY start, end DESC').all(file.id) as unknown as SymRow[]
  const lines = [`Map · ${file.path} · ${LANGS[file.lang]?.label ?? file.lang} · ${file.lines} lines · ${syms.length} definitions`, '']
  for (const s of syms) {
    const indent = '  '.repeat(Math.max(0, s.qualified.split('.').length - 1))
    lines.push(`${indent}${s.start}-${s.end} ${s.kind} ${s.name}${s.exported ? '' : ' (private)'}: ${s.signature}`)
  }
  if (!syms.length) lines.push('(no definitions found in this file)')
  return { text: lines.join('\n'), files: [file.path] }
}

/** Files per language, with TypeScript and TSX (and the like) counted under one name. */
export function langCounts(store: Store): { label: string; n: number }[] {
  const by = new Map<string, number>()
  for (const r of store.sql('SELECT lang, COUNT(*) AS n FROM files GROUP BY lang').all() as { lang: LangId; n: number }[]) {
    const label = LANGS[r.lang]?.label ?? r.lang
    by.set(label, (by.get(label) ?? 0) + r.n)
  }
  return [...by.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n)
}

/** A first look at a project: languages, main folders, the most used definitions and likely entry points. */
export function overview(store: Store, root: string): Answer {
  const st = mapStatus(root, store)
  const langs = langCounts(store)
  const files = store.sql('SELECT path FROM files').all() as { path: string }[]
  const dirs = new Map<string, number>()
  for (const f of files) {
    const parts = f.path.split('/')
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length === 2 ? parts[0]! : '.'
    dirs.set(key, (dirs.get(key) ?? 0) + 1)
  }
  const hubs = (
    store
      .sql(
        `SELECT s.qualified, s.kind, f.path, s.start, (SELECT COUNT(*) FROM edges e WHERE e.dst = s.id AND e.confidence != 'ambiguous') AS uses
         FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind != 'variable' ORDER BY s.rank DESC LIMIT 40`,
      )
      .all() as { qualified: string; kind: string; path: string; start: number; uses: number }[]
  )
    .filter(h => !TESTY.test(h.path) && h.uses > 1)
    .slice(0, 12)
  const entries = files
    .map(f => f.path)
    .filter(p => /(^|\/)(main|index|app|server|cli|program|manage|__main__)\.[a-z]+$/i.test(p) && !TESTY.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length)
    .slice(0, 8)

  const out = [
    ...notices(st),
    `Map · ${posix.basename(root)} · ${st.files} files · ${st.symbols} definitions · ${st.links} call links`,
    '',
    `Languages: ${langs.map(l => `${l.label} ${l.n}`).join(', ') || 'none yet'}`,
    '',
    'Main folders:',
    ...[...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, n]) => `- ${d} (${n} files)`),
  ]
  if (entries.length) out.push('', 'Likely entry points:', ...entries.map(p => `- ${p}`))
  if (hubs.length) out.push('', 'Most used definitions:', ...hubs.map(h => `- ${h.qualified} · ${h.kind} · ${h.path}:${h.start} · used ${h.uses}×`))
  if (st.skipped.length) {
    const by = new Map<string, number>()
    for (const s of st.skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1)
    out.push('', `Not mapped: ${[...by.entries()].map(([r, n]) => `${n} ${r}`).join(', ')}. map_search still searches large files.`)
  }
  return { text: out.join('\n'), files: [] }
}

/** Every line matching exact text or a regular expression, grouped by the definition it sits in. */
export function search(store: Store, root: string, pattern: string, opts: { regex?: boolean; ignoreCase?: boolean; path?: string } = {}): Answer {
  let re: RegExp
  try {
    re = new RegExp(opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.ignoreCase === false ? '' : 'i')
  } catch (err) {
    return { text: `Map · that pattern is not a valid regular expression: ${(err as Error).message}`, files: [] }
  }
  const scope = opts.path?.replace(/\\/g, '/').replace(/^\.\//, '')
  const paths = [
    ...(store.sql('SELECT id, path FROM files ORDER BY path').all() as { id: number; path: string }[]),
    ...store.skipped().filter(s => s.reason === 'too large').map(s => ({ id: -1, path: s.path })),
  ].filter(f => !scope || f.path.startsWith(scope))
  const symsOf = store.sql('SELECT qualified, start, end FROM symbols WHERE file_id = ? ORDER BY (end - start)')
  const groups = new Map<string, string[]>()
  const files: string[] = []
  let count = 0
  outer: for (const f of paths) {
    const lines = readLines(root, f.path)
    if (!lines) continue
    const syms = f.id >= 0 ? (symsOf.all(f.id) as { qualified: string; start: number; end: number }[]) : []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!re.test(line)) continue
      const n = i + 1
      const inside = syms.find(s => s.start <= n && n <= s.end)
      const key = `${f.path} · ${inside ? inside.qualified : 'top of file'}`
      const list = groups.get(key) ?? []
      list.push(`  ${n}: ${line.trim().slice(0, 160)}`)
      groups.set(key, list)
      if (!files.includes(f.path)) files.push(f.path)
      if (++count >= LIMITS.searchHits) break outer
    }
  }
  if (!count) return { text: `Map · no lines match "${pattern}"${scope ? ` in ${scope}` : ''}.`, files: [] }
  const out = [`Map · ${count}${count >= LIMITS.searchHits ? '+' : ''} matching lines for "${pattern}" in ${files.length} files`]
  for (const [k, v] of groups) out.push('', k, ...v)
  if (count >= LIMITS.searchHits) out.push('', `Stopped at ${LIMITS.searchHits} lines. Narrow the pattern or pass a folder in "path".`)
  return { text: out.join('\n'), files }
}
