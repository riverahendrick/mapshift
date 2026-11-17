// One picture of how Mapshift is doing, shared by `mapshift report`, the status line and the web dashboard,
// so all three always show the same figures.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { readCodexUsage, type CodexUsage } from '../agents/codex-usage.ts'
import { homeDir, logsDir, normalizeKey } from '../core/paths.ts'
import { quickMap, type QuickMap } from './map-status.ts'
/** A folder with the person's home folder written as ~ (`C:/Users/ana/code/app` → `~/code/app`). */
export function tildePath(path: string, home: string = homedir()): string {
  const p = path.replace(/\\/g, '/')
  const h = home.replace(/\\/g, '/').replace(/\/+$/, '')
  return p.toLowerCase().startsWith(`${h.toLowerCase()}/`) || p.toLowerCase() === h.toLowerCase() ? `~${p.slice(h.length)}` : p
}

export type MapEventLite = { ts: number; agent: string; repo: string; tool: string; answerTokens: number; files: { path: string; tokens: number }[] }

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10)

/** Map lookups logged since `since` (the log keeps one file per UTC day). */
export function readMapEvents(since: number, now = Date.now(), dir = logsDir()): MapEventLite[] {
  const days: string[] = []
  for (let t = since - 86_400_000; t <= now + 86_400_000; t += 86_400_000) days.push(utcDay(t))
  const out: MapEventLite[] = []
  for (const d of [...new Set(days)]) {
    let text: string
    try {
      text = readFileSync(join(dir, `${d}.jsonl`), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let e: Record<string, unknown>
      try {
        e = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (e.kind !== 'map' || typeof e.ts !== 'number' || e.ts < since || e.ts > now + 60_000 || typeof e.repo !== 'string') continue
      const files = Array.isArray(e.files)
        ? (e.files as { path?: unknown; tokens?: unknown }[]).filter(f => typeof f?.path === 'string').map(f => ({ path: f.path as string, tokens: num(f.tokens) }))
        : []
      out.push({ ts: e.ts, agent: String(e.agent ?? 'unknown'), repo: e.repo, tool: String(e.tool ?? ''), answerTokens: num(e.answerTokens), files })
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

export type AgentKey = 'claude' | 'codex' | 'gemini' | 'agy' | 'grok' | 'cursor' | 'other'
export const AGENT_LABEL: Record<AgentKey, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  agy: 'Antigravity',
  grok: 'Grok',
  cursor: 'Cursor',
  other: 'Other',
}

/** Which agent a map lookup came from, by the name the agent gave the map server when it connected. */
export function agentOfClient(name: string): AgentKey {
  if (/claude/i.test(name)) return 'claude'
  if (/codex/i.test(name)) return 'codex'
  if (/antigravity|\bagy\b|jetski/i.test(name)) return 'agy'
  if (/gemini/i.test(name)) return 'gemini'
  if (/grok/i.test(name)) return 'grok'
  if (/cursor/i.test(name)) return 'cursor'
  return 'other'
}

export type MapStats = {
  lookups: number
  byAgent: { agent: AgentKey; label: string; n: number }[]
  /** Tokens the answers cost. */
  withMap: number
  /** Tokens the whole files the answers pointed to would have cost to read. */
  withoutMap: number
  /**
   * The most the map can have saved: pointed-to files minus answers, as if none of those files was read
   * afterwards. For agents whose file reads Mapshift cannot see, this is all it can honestly say.
   */
  savedUpperBound: number
}

export function mapStats(events: MapEventLite[], root?: string): MapStats {
  const key = root ? normalizeKey(root) : null
  const mine = key ? events.filter(e => normalizeKey(e.repo) === key) : events
  const counts = new Map<AgentKey, number>()
  let withMap = 0
  let withoutMap = 0
  for (const e of mine) {
    const a = agentOfClient(e.agent)
    counts.set(a, (counts.get(a) ?? 0) + 1)
    withMap += e.answerTokens
    withoutMap += e.files.reduce((s, f) => s + f.tokens, 0)
  }
  return {
    lookups: mine.length,
    byAgent: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([agent, n]) => ({ agent, label: AGENT_LABEL[agent], n })),
    withMap: Math.round(withMap),
    withoutMap: Math.round(withoutMap),
    savedUpperBound: Math.max(0, Math.round(withoutMap - withMap)),
  }
}

export type Snapshot = {
  generatedAt: number
  project: { root: string; name: string; /** The folder with the home folder shown as ~, so a screenshot never shows a user name. */ shown: string }
  map: QuickMap
  today: MapStats
  week: MapStats
  codex: CodexUsage | null
  /** The newest map lookups in this project, newest first. */
  recent: { ts: number; agent: string; tool: string; files: number; answerTokens: number; pointedTokens: number }[]
}

export function snapshot(o: { root: string; codexHome: string | null; now?: number; home?: string }): Snapshot {
  const now = o.now ?? Date.now()
  const home = o.home ?? homeDir()
  const map = quickMap(o.root, home)
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const weekAgo = now - 7 * 86_400_000
  const events = readMapEvents(weekAgo, now, join(home, 'logs'))
  const key = normalizeKey(map.root)
  const here = events.filter(e => normalizeKey(e.repo) === key)
  let codex: CodexUsage | null = null
  try {
    codex = o.codexHome ? readCodexUsage(o.codexHome, now) : null
  } catch {
    codex = null
  }
  return {
    generatedAt: now,
    project: { root: map.root, name: basename(map.root) || map.root, shown: tildePath(map.root) },
    map,
    today: mapStats(here.filter(e => e.ts >= midnight)),
    week: mapStats(here),
    codex,
    recent: here
      .slice(-12)
      .reverse()
      .map(e => ({
        ts: e.ts,
        agent: AGENT_LABEL[agentOfClient(e.agent)],
        tool: e.tool,
        files: e.files.length,
        answerTokens: e.answerTokens,
        pointedTokens: e.files.reduce((s, f) => s + f.tokens, 0),
      })),
  }
}
