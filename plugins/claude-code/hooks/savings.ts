// What Mapshift saved, as one set of rules shared by the dashboard and `/mapshift status`, so the two
// can never disagree. Plain functions only (no engine access), so they can be tested alone.
//
// With Mapshift:    money = what the requests cost on the models used (list prices)
//                   tokens = tokens processed, as logged (fresh input + cache reads + cache writes + output)
// Without Mapshift: money = every request on the model picked in the app, plus the map's saved tokens
//                   priced at that model's input price
//                   tokens = the same tokens processed, plus the map's saved tokens (switching models does
//                   not change token counts, so no difference is invented for it)
// Saved = without − with, for money and for tokens. Negative money means the routing spent more on
// stronger models than the map and cheaper models saved; it is shown as that, never hidden.
// The cache saving is Claude Code's own prompt cache: it is inside both sides, so it is shown, not added.
import type { MapStats, Money } from '../types'
import { fmtTok, fmtUsd } from './brain'
import { savedPct } from './map'

export type Side = { usd: number; tokens: number }
export type Savings = {
  with: Side
  without: Side
  /** without − with. */
  saved: Side
  /** The map's part: saved tokens, and their price on the app's model (null when that price is unknown). */
  map: { tokens: number; usd: number | null }
  /** Model switching: every request on the app's model, less what it cost; negative when it cost more. */
  routingUsd: number
  /** Claude Code's prompt cache: what reading from it saved, and the tokens read from it. Not in the total. */
  cache: { usd: number; tokens: number }
}

/** Map tokens priced at an input price (US dollars per million tokens); null when the price is unknown. */
export const mapUsd = (tokens: number, inPerMTok: number | null): number | null => (inPerMTok === null ? null : (tokens * inPerMTok) / 1e6)

export function savings(m: Money, map: { tokens: number; usd: number | null } | null): Savings {
  const mapTok = map?.tokens ?? 0
  const withS = { usd: m.usd, tokens: m.tokens }
  const without = { usd: m.baseUsd + (map?.usd ?? 0), tokens: m.tokens + mapTok }
  return {
    with: withS,
    without,
    saved: { usd: without.usd - withS.usd, tokens: without.tokens - withS.tokens },
    map: { tokens: mapTok, usd: map ? map.usd : null },
    routingUsd: m.baseUsd - m.usd,
    cache: { usd: m.cacheSavedUsd, tokens: m.cacheRead },
  }
}

/**
 * How much a usage limit was stretched. `ratio` is today's with ÷ without (money, list prices): limits are
 * counted in usage, which follows cost closely but not exactly, so everything here is an estimate.
 * - withoutPct: where the limit would be without Mapshift (`pct ÷ ratio`); kept = the difference.
 * - extraMs: at the pace since the window opened, how much longer it lasts before running out. Only set when
 *   the "without" pace would have run out before the reset; otherwise neither runs out and only `kept` counts.
 */
export type Stretch = { withoutPct: number; kept: number; extraMs: number | null }
export function stretch(w: { pct: number; resetsAt: number | null }, lengthMs: number | null, ratio: number, now: number): Stretch | null {
  if (!(ratio > 0) || ratio >= 0.995 || !(w.pct > 0)) return null // nothing saved, or more spent on stronger models
  const withoutPct = w.pct / ratio
  let extraMs: number | null = null
  if (lengthMs && w.resetsAt) {
    const left = w.resetsAt - now
    const elapsed = lengthMs - left
    if (elapsed > 60_000 && left > 0) {
      const rate = w.pct / elapsed // percent per millisecond, with Mapshift
      const lastsWith = (100 - w.pct) / rate
      const lastsWithout = withoutPct >= 100 ? 0 : (100 - withoutPct) / (rate / ratio)
      if (lastsWithout < left) extraMs = Math.min(lastsWith, left) - lastsWithout
    }
  }
  return { withoutPct, kept: withoutPct - w.pct, extraMs }
}

/** One period's savings from its money and its map figures (null when the map's log could not be read). */
export const savingsFor = (m: Money, stats: MapStats | null, usd: number | null): Savings => savings(m, stats ? { tokens: stats.saved, usd } : null)

/** A share of a whole, rounded; null when the whole is 0. */
export const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null)
/** Below a twentieth of a cent a money difference shows as none (fmtUsd shows four decimals). */
const TINY = 0.00005

/** A signed money difference in words: "$0.20", "$0.50 more" or "$0". */
export const signedUsd = (v: number): string => (v >= TINY ? fmtUsd(v) : v <= -TINY ? `${fmtUsd(-v)} more` : '$0')

/** "Saved $0.35 (23%)", or "$0.50 more, spent on stronger models for harder work", or "Saved $0". */
export function moneyVerdict(s: Savings): string {
  const d = s.saved.usd
  if (d >= TINY) {
    const p = pct(d, s.without.usd)
    return `Saved ${fmtUsd(d)}${p !== null ? ` (${p}%)` : ''}`
  }
  if (d <= -TINY) return `${fmtUsd(-d)} more, spent on stronger models for harder work`
  return 'Saved $0'
}

/** "37.8k tokens saved (13%)", or "No tokens saved". */
export function tokenVerdict(s: Savings): string {
  const d = s.saved.tokens
  if (d < 0) return `${fmtTok(-d)} more tokens: the map answers cost more than the reads they spared`
  if (d === 0) return 'No tokens saved'
  const p = pct(d, s.without.tokens)
  return `${fmtTok(d)} tokens saved${p !== null ? ` (${p}%)` : ''}`
}

export const sideText = (x: Side) => `${fmtUsd(x.usd)} · ${fmtTok(x.tokens)} tokens`

/** The with/without lines for one period, as `/mapshift status` prints them. */
export function savingsLines(label: string, s: Savings, appModel: string): string[] {
  return [
    `${label} with Mapshift: ${sideText(s.with)}`,
    `${label} without Mapshift: ${sideText(s.without)} (every request on ${appModel}, no map)`,
    `${label} difference: ${moneyVerdict(s)} · ${tokenVerdict(s)}`,
  ]
}

const TOOL_LABEL: [keyof MapStats['byTool'], string][] = [
  ['find', 'Find'],
  ['trace', 'Trace'],
  ['file', 'File outline'],
  ['overview', 'Overview'],
  ['search', 'Search'],
  ['other', 'Starting points'],
]
const n0 = (n: number) => Math.round(n).toLocaleString('en-US')
const plural = (n: number, one: string, many = `${one}s`) => `${n0(n)} ${n === 1 ? one : many}`

/** "Find 2 · Trace 1 · File outline 1": the tools used, in a fixed order. */
export const toolLine = (s: MapStats): string =>
  TOOL_LABEL.filter(([k]) => s.byTool[k] > 0)
    .map(([k, label]) => `${label} ${n0(s.byTool[k])}`)
    .join(' · ') || 'No lookups yet'

/** "🔍 12 lookups · 📄 9 files not opened · 💚 37.8k tokens saved (92%)". */
export function mapStatsLine(s: MapStats): string {
  const p = savedPct(s)
  const head = `🔍 ${plural(s.lookups, 'lookup')} · 📄 ${plural(s.filesSkipped, 'file')} not opened`
  if (s.saved < 0) return `${head} · ${fmtTok(-s.saved)} more tokens than the reads they spared`
  return `${head} · 💚 ${fmtTok(s.saved)} tokens saved${p !== null ? ` (${p}%)` : ''}`
}
