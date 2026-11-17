export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Tier = 'trivial' | 'routine' | 'complex' | 'critical'
export type Mode = 'auto' | 'quality' | 'saver' | 'manual' | 'off'
export type View = 'overview' | 'activity' | 'settings' | 'help'
export type Price = { in: number; out: number; read: number }

export type Cfg = {
  mode: Mode
  /** Model and effort used in Manual mode. */
  lockModel: Family
  lockEffort: Effort
  /** Smart check: ask Haiku about prompts the free rules find unclear (it can only raise the level). */
  classifier: boolean
  /** Let small, safe turns run on a cheaper model when it pays back. */
  allowDowngrade: boolean
  /** Send read-only research helpers (subagents) to a cheaper model. */
  subagents: boolean
  /** Let escalation reach Fable, the top model (about 2x Opus price). */
  allowFable: boolean
  /** Prompt-cache lifetime used in estimates: 60 minutes on a subscription, 5 on an API key. */
  ttlMin: 5 | 60
  /** Show the one-line status bar above the prompt box. */
  band: boolean
  /** Largest one-time cache rewrite (list-price USD) an automatic upgrade may cost before it only recommends. */
  maxSwitchUsd: number
  /** Desktop notification when a long turn finishes. */
  notifyLongTurns: boolean
  /** Never think less than the effort chosen in the app, except for quick read-only questions. */
  respectAppEffort: boolean
  /** Remind the agent (one short section in its instructions) to use the map. */
  mapReminder: boolean
  /** Which tab of the pane is open. */
  view: View
}

export type Last = {
  n: number
  model: string
  family: Family | null
  effort: string
  tier: Tier
  reason: string
  /** One short line saying why, for the dashboard. */
  why?: string
  switched: boolean
  switchUsd: number | null
  suggest: { family: Family; usd: number } | null
  answeredBy: string | null
  mismatch: boolean
  /** What the app itself was set to for this request (model id and effort). */
  appModel: string
  appEffort: string
}

export type LogRow = {
  n: number
  at: number
  model: string
  family: Family | null
  effort: string
  tier: Tier
  reason: string
  switched: boolean
  steps: number
  tools: number
  seconds: number
  fresh: number
  read: number
  wrote: number
  out: number
  usd: number
  baseUsd: number
  misroute: boolean
}

export type StepRow = {
  n: number
  step: number
  at: number
  model: string
  effort: string
  fresh: number
  read: number
  wrote: number
  out: number
}

export type LimitWindow = {
  kind: string
  name: string
  pct: number
  resetsAt: number | null
  /** Share of the window's time already gone (0..1), when its length is known. */
  elapsed: number | null
  perHour: number | null
  projected: number | null
  hitsAt: number | null
}

export type Snap = {
  ctxPct: number | null
  ctxTokens: number
  ctxWindow: number | null
  windows: LimitWindow[]
  sessionUsd: number | null
  at: number
}

export type Money = { usd: number; baseUsd: number; cacheSavedUsd: number; turns: number }
export type Totals = {
  session: Money
  today: Money
  day: string
  all: Money
  switches: number
  misroutes: number
  upgrades: number
  downgrades: number
}

export type MapState = 'empty' | 'building' | 'ready'
export type MapInfo = {
  /** Whether `mapshift map status` answered: null before the first check, false when it failed. */
  available: boolean | null
  state: MapState | null
  percent: number
  files: number
  /** Definitions (functions, classes, methods...) in the map. */
  symbols: number
  /** Call links between definitions. */
  links: number
  languages: { label: string; n: number }[]
  builtAt: number | null
  checkedAt: number | null
  /** Map tool calls (mcp__mapshift__*) seen this session. */
  lookups: number
  /** Read, Grep and Glob calls seen this session: the work the map is meant to replace. */
  fileReads: number
  /** Tokens the map saved, estimated from the map's own log; null when the log could not be read. */
  savedSession: number | null
  savedToday: number | null
}

export type Live = {
  busy: boolean
  startedAt: number
  now: number
  tool: string | null
  detail: string | null
  tools: number
  errors: number
  lastSeconds: number | null
  lastTools: number | null
}

export type AgentRow = { at: number; type: string; description: string; model: string; routed: boolean }
export type UiPrefs = { dark: boolean }
/** What the last automatic self-check found (it recomputes every number from the log). */
export type Health = {
  ok: boolean
  checkedAt: number
  requests: number
  turns: number
  effortChanges: number
  effortKept: number
  mismatches: number
  errors: number
  problems: number
  /** Plain-words lines for each problem found, so the pane can show them. */
  problemLines: string[]
  /** Families the account did not serve when asked: routing to them is paused this session. */
  unavailable: Family[]
}

declare module 'claude-code' {
  interface PluginState {
    mapshift: {
      cfg: Shaped<Cfg>
      last: Shaped<Last | null>
      log: Shaped<LogRow[]>
      steps: Shaped<StepRow[]>
      snap: Shaped<Snap>
      totals: Shaped<Totals>
      map: Shaped<MapInfo>
      seen: Shaped<string[]>
      live: Shaped<Live>
      agents: Shaped<AgentRow[]>
      prefs: Shaped<UiPrefs>
      health: Shaped<Health>
    }
  }
}
