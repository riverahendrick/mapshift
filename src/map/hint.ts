import { TEST_PATH } from './resolve.ts'
import { terms, type Answer } from './query.ts'
import type { Store } from './store.ts'

type Row = { id: number; qualified: string; kind: string; start: number; end: number; signature: string; rank: number; path: string }
type Pick = Row & { score: number }

export const HINT_LIMITS = { picks: 4, chars: 1400 }

/** Words that say what to do, not where: they match everything and pick out nothing. */
const VERBS = new Set(
  'fix add make change update create remove delete rename refactor move write build implement improve check test tests use using should would could need want please also every each when then into with from like more less new old'.split(' '),
)

/** "masked" → "mask", "numbers" → "number", "logging" → "logg" (a prefix search then finds "log"/"logger" too). */
export function stem(word: string): string {
  if (word.length <= 4) return word
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length)
  }
  return word
}

const one = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The few places in the code a request is clearly about, as a short list an agent reads before it starts:
 * where each one is, its signature, and who uses it. Strict on purpose: a request has to name something,
 * or use two or more words that all appear in one definition, or there is no hint at all. A wrong hint
 * would cost tokens and send the agent the wrong way, so silence is the default.
 */
export function startingPoints(store: Store, prompt: string, max = HINT_LIMITS.picks): Answer | null {
  const { names, words } = terms(prompt.slice(0, 4000))
  const wantsTests = /\btests?\b|\bspec\b/i.test(prompt)
  const picks = new Map<number, Pick>()
  const add = (r: Row, score: number) => {
    if (!wantsTests && TEST_PATH.test(r.path)) return
    const prev = picks.get(r.id)
    if (!prev || prev.score < score) picks.set(r.id, { ...r, score })
  }
  const base = `SELECT s.id, s.qualified, s.kind, s.start, s.end, s.signature, s.rank, f.path FROM symbols s JOIN files f ON f.id = s.file_id`

  // names the request spells out: `saveOrder`, `Cart.total`
  const byName = store.sql(`${base} WHERE s.qualified = ? OR s.name = ? ORDER BY s.rank DESC LIMIT 4`)
  for (const n of names) {
    const last = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : n
    for (const r of byName.all(n, last) as Row[]) add(r, 100_000 + Math.log1p(r.rank)) // named outright: always first
  }

  // plain words: a definition counts when two or more of the request's words appear in it together
  const w = [...new Set(words.filter(x => x.length > 2 && /^\w+$/.test(x) && !VERBS.has(x)).map(stem))].slice(0, 6)
  if (w.length >= 2) {
    const fts = store.sql(
      `${base.replace('FROM symbols s', ', bm25(symbols_fts, 10.0, 6.0, 1.0, 2.0, 3.0) AS bm FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid')}
       WHERE symbols_fts MATCH ? AND s.kind != 'variable' ORDER BY bm LIMIT 8`,
    )
    const groups: string[][] = [w]
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) groups.push([w[i]!, w[j]!])
    for (const g of groups) {
      try {
        for (const r of fts.all(g.map(t => `"${t}"*`).join(' AND ')) as (Row & { bm: number })[]) {
          add(r, g.length * 10 * Math.max(0.05, -r.bm) * (1 + Math.log1p(r.rank) * 0.35))
        }
      } catch {
        /* a word the search syntax cannot take */
      }
    }
  }
  if (!picks.size) return null

  const top = [...picks.values()].sort((a, b) => b.score - a.score).slice(0, max)
  const callers = store.sql(
    `SELECT DISTINCT COALESCE(s.qualified, f.path) AS who, f.path FROM edges e JOIN files f ON f.id = e.src_file
     LEFT JOIN symbols s ON s.id = e.src WHERE e.dst = ? AND e.confidence != 'ambiguous' LIMIT 12`,
  )
  const uses = store.sql(`SELECT COUNT(*) AS n FROM edges WHERE dst = ? AND confidence != 'ambiguous'`)
  const lines = [
    'Mapshift code map: likely starting points for this request. Open only what you need; map_find, map_trace (use direction "impact" before changing something) and map_file give more.',
  ]
  const files: string[] = []
  for (const p of top) {
    const by = (callers.all(p.id) as { who: string; path: string }[]).filter(c => !TEST_PATH.test(c.path)).slice(0, 3).map(c => c.who)
    const n = (uses.get(p.id) as { n: number }).n
    const entry = [
      `- ${p.qualified} · ${p.kind} · ${p.path}:${p.start}${p.end > p.start ? `-${p.end}` : ''}`,
      `  ${one(p.signature, 140)}`,
      n ? `  used ${n}×${by.length ? `, e.g. by ${by.join(', ')}` : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    if (lines.join('\n').length + entry.length > HINT_LIMITS.chars) break
    lines.push(entry)
    if (!files.includes(p.path)) files.push(p.path)
  }
  return lines.length > 1 ? { text: lines.join('\n'), files } : null
}
