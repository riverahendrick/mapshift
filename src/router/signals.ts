import { terms } from '../map/query.ts'
import type { Store } from '../map/store.ts'

/** What the map says about how big a request really is. */
export type MapSignals = {
  /** Definitions the request names or clearly points at. */
  matched: string[]
  /** Definitions a change to them can reach within two steps, tests left out. */
  reach: number
  /** Files those reach into. */
  files: number
  /** Top-level areas (packages, apps, folders) involved. */
  areas: number
  /** True when the map has no say (nothing matched, or no map yet). */
  silent: boolean
}

const TEST = /(^|\/)(test|tests|__tests__|spec|specs|fixtures?|mocks?|e2e)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i
const area = (path: string): string => {
  const p = path.split('/')
  return p.length > 2 && /^(packages|apps|libs|services|modules|src)$/.test(p[0]!) ? `${p[0]}/${p[1]}` : (p[0] ?? '')
}

/**
 * Reads the request against the map: the names it mentions, and how far a change to them would spread.
 * Takes a few milliseconds on a built map; never reads source files.
 */
export function mapSignals(store: Store, text: string): MapSignals {
  const { names, words } = terms(text)
  const ids = new Map<number, { qualified: string; path: string }>()
  const bySql = store.sql(
    `SELECT s.id, s.qualified, f.path FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.qualified = ? OR s.name = ? ORDER BY s.rank DESC LIMIT 3`,
  )
  for (const n of names) {
    const last = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : n
    for (const r of bySql.all(n, last) as { id: number; qualified: string; path: string }[]) ids.set(r.id, r)
  }
  // plain words only count when they pick out a few definitions clearly (two or more words in one name)
  if (ids.size === 0 && words.length >= 2) {
    try {
      const rows = store
        .sql(
          `SELECT s.id, s.qualified, f.path, bm25(symbols_fts, 10.0, 6.0, 1.0, 1.0) AS bm FROM symbols_fts
           JOIN symbols s ON s.id = symbols_fts.rowid JOIN files f ON f.id = s.file_id
           WHERE symbols_fts MATCH ? ORDER BY bm LIMIT 3`,
        )
        .all(words.map(w => `"${w}"*`).join(' AND ')) as { id: number; qualified: string; path: string }[]
      for (const r of rows) if (!TEST.test(r.path)) ids.set(r.id, r)
    } catch {
      /* not a query the search accepts */
    }
  }
  if (ids.size === 0) return { matched: [], reach: 0, files: 0, areas: 0, silent: true }

  const callers = store.sql(`SELECT e.src AS id, f.path FROM edges e JOIN files f ON f.id = e.src_file WHERE e.dst = ? AND e.confidence != 'ambiguous'`)
  const seen = new Set(ids.keys())
  const files = new Set([...ids.values()].map(v => v.path))
  let frontier = [...ids.keys()]
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    const next: number[] = []
    for (const id of frontier) {
      for (const e of callers.all(id) as { id: number | null; path: string }[]) {
        if (TEST.test(e.path)) continue
        files.add(e.path)
        if (e.id !== null && !seen.has(e.id)) {
          seen.add(e.id)
          next.push(e.id)
        }
      }
    }
    frontier = next
  }
  return {
    matched: [...ids.values()].map(v => v.qualified),
    reach: seen.size - ids.size,
    files: files.size,
    areas: new Set([...files].map(area)).size,
    silent: false,
  }
}

/**
 * How many levels the map raises a request: a change that spreads far is harder than its wording says.
 * The map only ever raises, never lowers: wording that sounds hard stays hard.
 */
export function mapLift(s: MapSignals): { lift: 0 | 1 | 2; why: string | null } {
  if (s.silent) return { lift: 0, why: null }
  const many = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`
  if (s.reach >= 80 || s.areas >= 5) return { lift: 2, why: `the change reaches ${many(s.reach, 'definition')} across ${many(s.areas, 'area')}` }
  if (s.reach >= 20 || s.files >= 10 || s.areas >= 3) return { lift: 1, why: `the change reaches ${many(s.reach, 'definition')} in ${many(s.files, 'file')}` }
  return { lift: 0, why: null }
}
