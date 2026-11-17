// Shared constants and plain helpers. The engine lets only the file that declares a state value read or
// write it, and `$` may only be handed to functions of that same file, so all engine work lives in
// register.tsx; this file holds no state access.
import type { Cfg, Live, MapInfo, Money, Snap, Totals } from '../types'

export const PANE = 'mapshift'
export const TITLE = 'Mapshift'

export const money = (): Money => ({ usd: 0, baseUsd: 0, cacheSavedUsd: 0, turns: 0, tokens: 0, cacheRead: 0 })
/** A stored total from an older version, made whole: a missing count reads as 0, never as NaN. */
export const asMoney = (m: Partial<Money> | undefined): Money => {
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return { usd: n(m?.usd), baseUsd: n(m?.baseUsd), cacheSavedUsd: n(m?.cacheSavedUsd), turns: n(m?.turns), tokens: n(m?.tokens), cacheRead: n(m?.cacheRead) }
}
export const EMPTY_TOTALS: Totals = { session: money(), today: money(), day: '', all: money(), switches: 0, misroutes: 0, upgrades: 0, downgrades: 0 }
export const EMPTY_SNAP: Snap = { ctxPct: null, ctxTokens: 0, ctxWindow: null, windows: [], sessionUsd: null, at: 0 }
export const EMPTY_MAP: MapInfo = {
  available: null,
  state: null,
  percent: 0,
  files: 0,
  symbols: 0,
  links: 0,
  languages: [],
  builtAt: null,
  checkedAt: null,
  lookups: 0,
  fileReads: 0,
  statsSession: null,
  statsToday: null,
  usdSession: null,
  usdToday: null,
}
export const EMPTY_LIVE: Live = { busy: false, startedAt: 0, now: 0, tool: null, detail: null, tools: 0, errors: 0, lastSeconds: null, lastTools: null }

// ---- per-project mode: each project folder keeps its own mode (and Manual pick); new projects start on Auto.
export type ProjectPrefs = { mode: Cfg['mode']; lockModel: Cfg['lockModel']; lockEffort: Cfg['lockEffort']; at: number }
export const PROJECT_KEYS = ['mode', 'lockModel', 'lockEffort'] as const
/** The project this session works in (its root folder). */
export const project = { key: '', name: '' }
/** One folder is one key whatever the slashes, trailing slash or letter case. */
export const projectKey = (root: string) => root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
export const projectName = (root: string) => root.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || root

/** A one-shot override the pane can arm for the next prompt ("Use Opus next turn"). */
export type NextForce = { family?: Cfg['lockModel']; effort?: Cfg['lockEffort']; tier?: 'critical' | 'trivial' }
export const nextTurn: { force?: NextForce } = {}
