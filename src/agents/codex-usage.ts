// Reads Codex's own session logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) for the usage limits,
// token counts and model in use. Read only; prompt text is used for routing advice and never printed.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type Limit = {
  /** "5-hour", "Weekly", or the window's length. */
  label: string
  minutes: number
  usedPercent: number
  /** When the window resets, in milliseconds. */
  resetsAt: number | null
  /** The reset time has passed since Codex last reported, so the figure is out of date and the window is fresh. */
  reset: boolean
}

export type Tokens = { input: number; cached: number; output: number; reasoning: number }

export type CodexUsage = {
  /** When Codex last reported its limits. */
  at: number | null
  plan: string | null
  limits: Limit[]
  model: string | null
  effort: string | null
  /** The newest request the person typed (for routing advice only). */
  lastRequest: string | null
  /** Tokens of the sessions active today, as Codex counted them. */
  today: Tokens & { sessions: number }
}

type Parsed = {
  limitsAt: number | null
  rate: Record<string, unknown> | null
  plan: string | null
  total: Tokens | null
  model: string | null
  effort: string | null
  lastRequest: string | null
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null)

/** Text the person typed, not the context Codex adds itself (instructions files, environment notes). */
const typed = (s: string): boolean => {
  const t = s.trimStart()
  return t.length > 0 && !t.startsWith('<') && !/^# AGENTS\.md instructions/i.test(t)
}

/** The facts Mapshift uses from one session log. Lines it does not understand are skipped. */
export function parseRollout(text: string): Parsed {
  const out: Parsed = { limitsAt: null, rate: null, plan: null, total: null, model: null, effort: null, lastRequest: null }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let j: Record<string, unknown> | null
    try {
      j = obj(JSON.parse(line))
    } catch {
      continue
    }
    const p = obj(j?.payload)
    if (!j || !p) continue
    if (j.type === 'turn_context') {
      if (typeof p.model === 'string') out.model = p.model
      if (typeof p.effort === 'string') out.effort = p.effort
    } else if (j.type === 'event_msg' && p.type === 'token_count') {
      const t = obj(obj(p.info)?.total_token_usage)
      if (t) out.total = { input: num(t.input_tokens), cached: num(t.cached_input_tokens), output: num(t.output_tokens), reasoning: num(t.reasoning_output_tokens) }
      const rate = obj(p.rate_limits)
      if (rate && (obj(rate.primary) || obj(rate.secondary))) {
        out.rate = rate
        out.plan = typeof rate.plan_type === 'string' ? rate.plan_type : out.plan
        const ts = Date.parse(String(j.timestamp ?? ''))
        out.limitsAt = Number.isFinite(ts) ? ts : out.limitsAt
      }
    } else if (j.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
      const texts = (p.content as unknown[]).map(c => obj(c)).filter(c => c?.type === 'input_text' && typeof c.text === 'string').map(c => c!.text as string)
      const mine = texts.filter(typed)
      if (mine.length) out.lastRequest = mine[mine.length - 1]!
    }
  }
  return out
}

const windowLabel = (minutes: number): string => (minutes === 300 ? '5-hour' : minutes === 10080 ? 'Weekly' : minutes % 1440 === 0 ? `${minutes / 1440}-day` : `${Math.round(minutes / 60)}-hour`)

/** The usage windows from one `rate_limits` record, the shorter window first. */
export function limitsFrom(rate: Record<string, unknown> | null, now: number): Limit[] {
  if (!rate) return []
  const out: Limit[] = []
  for (const key of ['primary', 'secondary']) {
    const w = obj(rate[key])
    if (!w) continue
    const minutes = num(w.window_minutes)
    const raw = num(w.resets_at)
    const resetsAt = raw ? (raw < 1e12 ? raw * 1000 : raw) : null
    const reset = resetsAt !== null && resetsAt <= now
    out.push({ label: windowLabel(minutes), minutes, usedPercent: reset ? 0 : Math.max(0, Math.min(100, num(w.used_percent))), resetsAt, reset })
  }
  return out.sort((a, b) => a.minutes - b.minutes)
}

type FileInfo = { path: string; mtime: number; size: number }

/** Session logs of the last `days` day folders, newest first. */
export function sessionFiles(codexHome: string, days = 8): FileInfo[] {
  const root = join(codexHome, 'sessions')
  const sub = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter(n => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a))
    } catch {
      return []
    }
  }
  const dayDirs: string[] = []
  outer: for (const y of sub(root))
    for (const m of sub(join(root, y)))
      for (const d of sub(join(root, y, m))) {
        dayDirs.push(join(root, y, m, d))
        if (dayDirs.length >= days) break outer
      }
  const files: FileInfo[] = []
  for (const dir of dayDirs) {
    let names: string[] = []
    try {
      names = readdirSync(dir).filter(n => /^rollout-.*\.jsonl$/.test(n))
    } catch {
      continue
    }
    for (const n of names) {
      try {
        const st = statSync(join(dir, n))
        files.push({ path: join(dir, n), mtime: st.mtimeMs, size: st.size })
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime)
}

const cache = new Map<string, { mtime: number; size: number; parsed: Parsed }>()

function parsedFile(f: FileInfo): Parsed {
  const hit = cache.get(f.path)
  if (hit && hit.mtime === f.mtime && hit.size === f.size) return hit.parsed
  let parsed: Parsed
  try {
    parsed = parseRollout(readFileSync(f.path, 'utf8'))
  } catch {
    parsed = parseRollout('')
  }
  cache.set(f.path, { mtime: f.mtime, size: f.size, parsed })
  return parsed
}

/** Codex's usage from its newest session logs, or null when there are none. */
export function readCodexUsage(codexHome: string, now = Date.now(), maxFiles = 40): CodexUsage | null {
  const files = sessionFiles(codexHome).slice(0, maxFiles)
  if (!files.length) return null
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const usage: CodexUsage = { at: null, plan: null, limits: [], model: null, effort: null, lastRequest: null, today: { sessions: 0, input: 0, cached: 0, output: 0, reasoning: 0 } }
  let haveLimits = false
  let haveTurn = false
  for (const f of files) {
    const isToday = f.mtime >= midnight
    if (haveLimits && haveTurn && !isToday) break
    const p = parsedFile(f)
    if (!haveLimits && p.rate) {
      usage.at = p.limitsAt
      usage.plan = p.plan
      usage.limits = limitsFrom(p.rate, now)
      haveLimits = true
    }
    if (!haveTurn && p.model) {
      usage.model = p.model
      usage.effort = p.effort
      usage.lastRequest = p.lastRequest
      haveTurn = true
    }
    if (isToday && p.total) {
      usage.today.sessions++
      usage.today.input += p.total.input
      usage.today.cached += p.total.cached
      usage.today.output += p.total.output
      usage.today.reasoning += p.total.reasoning
    }
  }
  return usage
}
