// The code map, as this plugin sees it: how to run the mapshift command line, how to read its answers,
// and how much the map saved. Plain functions only (no engine access), so they can be tested alone.
import type { MapInfo, MapState, MapStats, MapTool, Tier } from '../types'
import { projectKey } from './state'

/** Map tools as Claude Code names them: mcp__mapshift__map_find and so on. */
export const isMapTool = (tool: string) => /^mcp__mapshift__/.test(tool)
export const isFileRead = (tool: string) => /^(Read|Grep|Glob)$/.test(tool)

/** The ways to start the command line, best first. MAPSHIFT_BIN (a script or a program) wins when set. */
export function launchers(bin: string | undefined): string[][] {
  const b = bin?.trim()
  if (b) return [/\.(m|c)?[jt]s$/i.test(b) ? ['node', b] : [b]]
  return [['mapshift'], ['cmd', '/c', 'mapshift']]
}

const STATES: MapState[] = ['empty', 'building', 'ready']
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)

/** `mapshift map status --json`, checked field by field. Anything else is not an answer. */
export function parseStatus(stdout: string): Pick<MapInfo, 'state' | 'percent' | 'files' | 'symbols' | 'links' | 'languages' | 'builtAt'> | null {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(stdout.trim()) as Record<string, unknown>
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || !STATES.includes(j.state as MapState)) return null
  const langs = Array.isArray(j.languages) ? j.languages : []
  return {
    state: j.state as MapState,
    percent: Math.min(100, Math.round(num(j.percent))),
    files: num(j.files),
    symbols: num(j.symbols),
    links: num(j.links),
    languages: langs
      .filter((l): l is { label: string; n: number } => !!l && typeof (l as { label?: unknown }).label === 'string')
      .map(l => ({ label: l.label.slice(0, 40), n: num(l.n) }))
      .slice(0, 12),
    builtAt: typeof j.builtAt === 'number' && Number.isFinite(j.builtAt) ? j.builtAt : null,
  }
}

const TIERS: Tier[] = ['trivial', 'routine', 'complex', 'critical']
export type MapRoute = { tier: Tier; reason: string | null }

/** `mapshift route ... --json`: the level it judged, and its first reason. */
export function parseRoute(stdout: string): MapRoute | null {
  try {
    const j = JSON.parse(stdout.trim()) as { tier?: unknown; reasons?: unknown }
    if (!TIERS.includes(j.tier as Tier)) return null
    const first = Array.isArray(j.reasons) && typeof j.reasons[0] === 'string' ? j.reasons[0].slice(0, 160) : null
    return { tier: j.tier as Tier, reason: first }
  } catch {
    return null
  }
}

/** True when the map's level is above the local one: the map may only raise a level, never lower it. */
export const raises = (local: Tier, map: Tier) => TIERS.indexOf(map) > TIERS.indexOf(local)

/**
 * The request text as it may be handed to the command line: letters, digits, spaces and the punctuation
 * of file names and sentences only. A Windows shell would act on characters like & | > % ^ " ! in an
 * argument, and a long paste would overflow its line, so both are removed. The text only feeds signals.
 */
export function routeText(text: string): string {
  return text
    .replace(/[^\p{L}\p{N} .,:;_/\\'#@+=?-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500)
    .trim()
}

/** The section added to the agent's instructions while a map exists. Stays the same all session (it is cached). */
export const MAP_REMINDER =
  'This project has a code map (the mapshift tools). To locate code, call map_find before grepping or reading files; ' +
  "use map_file for a file's API, and map_trace with direction \"impact\" before changing a function. " +
  'If those tools are deferred, load them once with ToolSearch (select:mcp__mapshift__map_find,mcp__mapshift__map_file,mcp__mapshift__map_trace). ' +
  'Read a file only when you need lines the map did not show.'

/** Today's and yesterday's map log names (the map writes one file per UTC day). */
export function ledgerFiles(now: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10)
  return [...new Set([day(now - 86_400_000), day(now)])].map(d => `${d}.jsonl`)
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

const TOOL_NAMES: MapTool[] = ['find', 'trace', 'file', 'overview', 'search']
/**
 * 'map_find' or 'mcp__mapshift__map_find' is 'find'. Anything else the map logs is 'other': today that is
 * 'map_hint', the starting points handed over with a prompt, which the dashboard calls "Starting points".
 */
export const mapToolOf = (tool: string): MapTool => {
  const t = tool.replace(/^mcp__mapshift__/, '').replace(/^map_/, '') as MapTool
  return TOOL_NAMES.includes(t) ? t : 'other'
}
export const emptyStats = (): MapStats => ({
  lookups: 0,
  byTool: { find: 0, trace: 0, file: 0, overview: 0, search: 0, other: 0 },
  answerTokens: 0,
  wouldRead: 0,
  saved: 0,
  filesSkipped: 0,
})

/**
 * What the map did, from its own log, for the map answers in this project since `since` (one chat):
 * - lookups: the answers logged, also counted per tool;
 * - answerTokens: what the answers cost (the map logs characters / 4);
 * - wouldRead: the full size of the files each answer pointed at that the agent did not open in this
 *   chat (`reads`, before or after the answer), i.e. what it would have read without the map;
 * - saved: wouldRead less answerTokens, exactly (it can be negative: then the map cost more than it spared);
 * - filesSkipped: the distinct files pointed at and not opened.
 * Estimates: sizes are characters / 4.
 */
export function mapSavings(log: string, o: { root: string; since: number; reads: string[] }): MapStats {
  const repo = projectKey(o.root)
  const reads = o.reads.map(norm)
  const wasRead = (path: string) => {
    const p = norm(path)
    return reads.some(r => r === p || r.endsWith(`/${p}`))
  }
  const s = emptyStats()
  const skipped = new Set<string>()
  for (const line of log.split('\n')) {
    if (!line.trim()) continue
    let e: { kind?: unknown; ts?: unknown; repo?: unknown; tool?: unknown; answerTokens?: unknown; files?: unknown }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (!e || e.kind !== 'map' || typeof e.ts !== 'number' || e.ts < o.since || typeof e.repo !== 'string' || projectKey(e.repo) !== repo) continue
    const files = Array.isArray(e.files) ? (e.files as { path?: unknown; tokens?: unknown }[]) : []
    const notOpened = files.filter((f): f is { path: string; tokens?: unknown } => typeof f?.path === 'string' && !wasRead(f.path))
    const spared = notOpened.reduce((a, f) => a + num(f.tokens), 0)
    const answer = num(e.answerTokens)
    s.lookups += 1
    s.byTool[mapToolOf(typeof e.tool === 'string' ? e.tool : '')] += 1
    s.answerTokens += answer
    s.wouldRead += spared
    s.saved += spared - answer // net, so "with" and "without" always add up
    for (const f of notOpened) skipped.add(norm(f.path))
  }
  s.filesSkipped = skipped.size
  s.answerTokens = Math.round(s.answerTokens)
  s.wouldRead = Math.round(s.wouldRead)
  s.saved = Math.round(s.saved)
  return s
}

/** Several chats' figures added field by field (today = each chat's latest figures, once each). */
export function addStats(list: MapStats[]): MapStats {
  const s = emptyStats()
  for (const x of list) {
    s.lookups += num(x?.lookups)
    for (const k of [...TOOL_NAMES, 'other'] as MapTool[]) s.byTool[k] += num(x?.byTool?.[k])
    s.answerTokens += num(x?.answerTokens)
    s.wouldRead += num(x?.wouldRead)
    s.saved += num(x?.saved)
    s.filesSkipped += num(x?.filesSkipped)
  }
  return s
}

/** Saved as a share of what would have been read, rounded; null when nothing would have been read. */
export const savedPct = (s: MapStats): number | null => (s.wouldRead > 0 ? Math.round((s.saved / s.wouldRead) * 100) : null)
