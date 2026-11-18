// One picture of how Mapshift is doing, shared by `mapshift report`, the status line and the web dashboard,
// so all three always show the same figures.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readCodexUsage, type CodexUsage } from '../agents/codex-usage.ts'
import { homeDir, logsDir, normalizeKey } from '../core/paths.ts'
import { LANGS } from '../map/languages.ts'
import { quickMap, quickRepo, type QuickMap } from './map-status.ts'
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

/** What the Claude Code add-on logged: its newest limits reading, today's money and its routing choices. */
export type ClaudeUsage = {
  /** The newest limits reading of any chat, or null before the first one. */
  limits: { at: number; windows: { name: string; pct: number; resetsAt: number | null }[]; ctxPct: number | null } | null
  /** Today's finished requests (local day): what they cost, and what they would have cost without Mapshift. */
  today: { turns: number; usd: number; baseUsd: number }
  /** Routing choices, newest first. `tier` is trivial, routine, complex or critical (null when Mapshift stayed out). */
  decisions: { ts: number; tier: string | null; model: string | null; effort: string | null; switched: boolean; reason: string }[]
}

/** Map facts the cheap status read leaves out: call links, languages and files left out of the map. */
export type MapDetail = { links: number; languages: { label: string; n: number }[]; skipped: { reason: string; n: number }[] }

export type Snapshot = {
  generatedAt: number
  project: { root: string; name: string; /** The folder with the home folder shown as ~, so a screenshot never shows a user name. */ shown: string }
  map: QuickMap
  today: MapStats
  week: MapStats
  codex: CodexUsage | null
  /** The newest map lookups in this project, newest first. */
  recent: { ts: number; agent: string; tool: string; files: number; answerTokens: number; pointedTokens: number }[]
  /** Claude Code's add-on log; null when it has never written one. */
  claude: ClaudeUsage | null
  /** Map lookups this week in this project, per tool, most used first. */
  tools: { tool: string; n: number }[]
  /** Null while there is no map. */
  mapDetail: MapDetail | null
}

const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)

/**
 * Reads the Claude Code add-on's per-chat logs (`<home>/logs/claude/audit-<chat>.jsonl`). Each file holds
 * the chat's latest events only (the add-on keeps a rolling tail), so long chats can undercount today's money.
 * Never throws: an unreadable or missing folder gives null.
 */
export function readClaudeUsage(dir: string, now = Date.now(), maxFiles = 40): ClaudeUsage | null {
  let names: string[]
  try {
    names = readdirSync(dir).filter(f => /^audit-.+\.jsonl$/.test(f))
  } catch {
    return null
  }
  const files: { path: string; mtime: number }[] = []
  for (const f of names) {
    try {
      files.push({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs })
    } catch {
      /* gone since the listing */
    }
  }
  if (!files.length) return null
  files.sort((a, b) => b.mtime - a.mtime)
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const out: ClaudeUsage = { limits: null, today: { turns: 0, usd: 0, baseUsd: 0 }, decisions: [] }
  type Ev = Record<string, unknown>
  // the newest chat always, plus any chat active in the last week
  for (const f of files.slice(0, maxFiles).filter((f, i) => i === 0 || f.mtime >= now - 7 * 86_400_000)) {
    let text: string
    try {
      text = readFileSync(f.path, 'utf8')
    } catch {
      continue
    }
    const tiers = new Map<string, string>() // sid:turn -> tier, from the prompt lines
    const decisions: Ev[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let e: Ev
      try {
        e = JSON.parse(line) as Ev
      } catch {
        continue
      }
      if (!e || typeof e !== 'object' || typeof e.ts !== 'number' || e.ts > now + 60_000) continue
      if (e.k === 'limits' && Array.isArray(e.windows) && (!out.limits || e.ts > out.limits.at)) {
        const windows = (e.windows as Ev[])
          .filter(w => w && typeof w.name === 'string' && typeof w.pct === 'number' && Number.isFinite(w.pct))
          .map(w => ({ name: w.name as string, pct: w.pct as number, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null }))
        out.limits = { at: e.ts, windows, ctxPct: typeof e.ctxPct === 'number' ? e.ctxPct : null }
      } else if (e.k === 'turn' && e.ts >= midnight) {
        out.today.turns++
        out.today.usd += num(e.usd)
        out.today.baseUsd += num(e.baseUsd)
      } else if (e.k === 'prompt') {
        tiers.set(`${String(e.sid)}:${String(e.turn)}`, String(e.tier ?? ''))
      } else if (e.k === 'decision') {
        decisions.push(e)
      }
    }
    for (const d of decisions) {
      const tier = tiers.get(`${String(d.sid)}:${String(d.turn)}`)
      out.decisions.push({
        ts: d.ts as number,
        tier: tier && ['trivial', 'routine', 'complex', 'critical'].includes(tier) ? tier : null,
        model: str(d.sendModel) ?? (str(d.sendFamily) && str(d.appModel) && !String(d.appModel).includes(String(d.sendFamily)) ? str(d.sendFamily) : str(d.appModel)),
        effort: str(d.sendEffort) ?? str(d.appEffort),
        switched: d.switched === true,
        reason: str(d.reason) ?? '',
      })
    }
  }
  out.decisions.sort((a, b) => b.ts - a.ts)
  out.decisions = out.decisions.slice(0, 30)
  return out
}

/** Call links, languages and skipped files, read straight from the map file without changing it. */
export function readMapDetail(dir: string, home: string): MapDetail | null {
  const { id } = quickRepo(dir)
  const db = join(home, 'repos', id, 'map.db')
  if (!existsSync(db)) return null
  let conn: DatabaseSync | null = null
  try {
    conn = new DatabaseSync(db, { readOnly: true })
    const links = Number((conn.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n)
    const by = new Map<string, number>()
    for (const r of conn.prepare('SELECT lang, COUNT(*) AS n FROM files GROUP BY lang').all() as { lang: string; n: number }[]) {
      const label = (LANGS as Record<string, { label: string } | undefined>)[r.lang]?.label ?? r.lang
      by.set(label, (by.get(label) ?? 0) + Number(r.n))
    }
    const skipped = conn.prepare('SELECT reason, COUNT(*) AS n FROM skipped GROUP BY reason ORDER BY n DESC').all() as { reason: string; n: number }[]
    return {
      links,
      languages: [...by.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n })),
      skipped: skipped.map(s => ({ reason: s.reason, n: Number(s.n) })),
    }
  } catch {
    return null
  } finally {
    conn?.close()
  }
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
  let claude: ClaudeUsage | null = null
  try {
    claude = readClaudeUsage(join(home, 'logs', 'claude'), now)
  } catch {
    claude = null
  }
  const toolCounts = new Map<string, number>()
  for (const e of here) toolCounts.set(e.tool || 'other', (toolCounts.get(e.tool || 'other') ?? 0) + 1)
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
    claude,
    tools: [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tool, n]) => ({ tool, n })),
    mapDetail: map.state === 'none' ? null : readMapDetail(o.root, home),
  }
}
