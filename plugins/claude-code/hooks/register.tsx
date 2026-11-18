import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cfg, Family, Health, LimitWindow, LogRow, MapStats, Mode, StepRow, Tier, Totals } from '../types'
import {
  DEFAULT_CFG,
  FAMILIES,
  PRICES,
  asEffort,
  cap,
  decide,
  escalateEffort,
  familyOf,
  fmtTok,
  fmtUsd,
  hitPct,
  maxEffort,
  maxTier,
  mergeClassifier,
  pace,
  parseOverride,
  scorePrompt,
  stepCost,
  subagentPlan,
  windowName,
  windowPace,
  durationText,
} from './brain'
import { crossedLine, formatEvent, growEffort, growth, verifyAudit } from './brain'
import type { AuditEvent, Force, Ledger, Plan, RateSample, RiskDomain } from './brain'
import { Band, Pane, bandText, mapLine, modelName, shortWhy } from './ui'
import type { Act, Data } from './ui'
import { EMPTY_LIVE, EMPTY_MAP, EMPTY_SNAP, EMPTY_TOTALS, PANE, PROJECT_KEYS, TITLE, asMoney, money, nextTurn, project, projectKey, projectName } from './state'
import type { NextForce, ProjectPrefs } from './state'
import { MAP_REMINDER, addStats, emptyStats, isFileRead, isMapTool, launchers, ledgerFiles, mapSavings, parseRoute, parseStatus, raises, routeText } from './map'
import { mapStatsLine, mapUsd, savingsFor, savingsLines, toolLine } from './savings'
import type { MapRoute } from './map'

type $ = EngineInterface

// ---- state the pane and band draw from (declared here: the engine lets only this file read and write it)
const cfgA = atom({ plugin: 'mapshift', key: 'cfg' } as const, DEFAULT_CFG, { shape: 'cfg-1' })
const lastA = atom({ plugin: 'mapshift', key: 'last' } as const, null, { shape: 'last-1' })
const logA = atom({ plugin: 'mapshift', key: 'log' } as const, [], { shape: 'log-1' })
const stepsA = atom({ plugin: 'mapshift', key: 'steps' } as const, [], { shape: 'steps-1' })
const snapA = atom({ plugin: 'mapshift', key: 'snap' } as const, EMPTY_SNAP, { shape: 'snap-1' })
const totalsA = atom({ plugin: 'mapshift', key: 'totals' } as const, EMPTY_TOTALS, { shape: 'totals-2' })
const mapA = atom({ plugin: 'mapshift', key: 'map' } as const, EMPTY_MAP, { shape: 'map-2' })
const seenA = atom({ plugin: 'mapshift', key: 'seen' } as const, [], { shape: 'seen-1' })
const liveA = atom({ plugin: 'mapshift', key: 'live' } as const, EMPTY_LIVE, { shape: 'live-1' })
const agentsA = atom({ plugin: 'mapshift', key: 'agents' } as const, [], { shape: 'agents-1' })
const prefsA = atom({ plugin: 'mapshift', key: 'prefs' } as const, { dark: true }, { shape: 'prefs-1' })
const healthA = atom(
  { plugin: 'mapshift', key: 'health' } as const,
  { ok: true, checkedAt: 0, requests: 0, turns: 0, effortChanges: 0, effortKept: 0, mismatches: 0, errors: 0, problems: 0, problemLines: [], unavailable: [] } as Health,
  { shape: 'health-1' },
)

// ---- per-session working memory. A hot reload clears it; the brain then falls back to cautious defaults.
type Pre = { tier: Tier; force?: Force; reason0: string; reasons: string[]; edits: boolean; risk: boolean; domain: RiskDomain | null }
type Acc = { fresh: number; read: number; wrote: number; out: number; usd: number; base: number; cacheSaved: number; steps: number }
type TurnPlan = { pre: Pre; plan?: Plan; sessionFam?: Family; errors: number; edited: boolean; files: Set<string>; counts: Record<string, number>; grown: number; tools: number; startedAt: number; acc: Acc; model: string; effort: string }

const turns = new Map<string, TurnPlan>()
let ledger: Ledger = {}
let ledgerSid = ''
let current: Family | null = null
let ctxTokens = 0
let turnNo = 0
let lastSwitchTurn = -99
let switchTurns: number[] = []
let hold = { level: 0, left: 0 }
let pendingForce: Force | undefined
let bigRepo = false
let outTokAvg = 1200
let lastTier: Tier = 'routine'
let lowerVotes = 0
let classifier = { fails: 0, pausedUntil: 0 }
let ticker: { cancel: () => void } | null = null
let rate: Record<string, RateSample[]> = {}
let rootDir = ''
let idleTick: { cancel: () => void } | null = null
const substituted: Record<string, number> = {} // family asked for -> times another model answered
let unavailable: Family[] = []
const alerted = new Set<string>() // limit alerts already shown, per window, line and reset
// ---- the map: how to start the command line once one way has worked, and what this session read
let launcher: string[] | null = null
let mapHome = '' // ~/.mapshift, or MAPSHIFT_HOME
/**
 * Programs are always started from the home folder, never from the project: on Windows a bare program name
 * is looked up in the working folder first, so a project could otherwise plant its own `git` or `mapshift`.
 * The project is passed as an argument instead (`--project`, `git -C`).
 */
let homeDir = ''
const neutralCwd = (): string => homeDir || (/^[a-zA-Z]:[\\/]/.test(rootDir) ? `${rootDir.slice(0, 2)}/` : '/')
let sessionSince = 0
const readPaths = new Set<string>()
let appModel = '' // the app's model at the last request: the route check judges for it

// ---- audit log: every prompt, decision, request, turn, limit reading, helper and error.
// One log PER SESSION (several sessions run at once and would overwrite a shared file):
//   store key  audit:<session id>   (for /mapshift log and /mapshift verify)
//   file       ~/.mapshift/logs/claude/audit-<session id>.jsonl   (for reading on disk)
// Holds token counts, models, reasons and prices: never prompt text.
let audit: AuditEvent[] = []
let auditPath = ''
let auditDirty = false
let curSid = ''
function log(now: number, ev: Record<string, unknown> & { k: string }) {
  audit.push({ ...ev, sid: curSid, ts: now } as AuditEvent)
  if (audit.length > 900) audit = audit.slice(-700)
  auditDirty = true
}
/**
 * Save to the shared store. Two chats can save at the same moment and briefly hold the store's lock;
 * that is normal, so wait a little and try again instead of failing (the old "Lock file is already
 * being held" errors). Only a lock that never frees after the last try is an error.
 */
async function save($: $, key: string, value: unknown) {
  const waits = [120, 350, 900]
  for (let i = 0; ; i++) {
    try {
      await $.store.set(key, value)
      return
    } catch (err) {
      const busy = /lock/i.test(String((err as Error)?.message ?? err))
      if (!busy || i >= waits.length) throw err
      await $.clock.sleep(waits[i]!)
    }
  }
}

async function flushAudit($: $) {
  if (!auditDirty || !curSid) return
  auditDirty = false
  const tail = audit.slice(-700)
  await save($, `audit:${curSid}`, tail)
  if (auditPath) {
    try {
      await $.fs.write(auditPath, tail.map(x => JSON.stringify(x)).join('\n') + '\n')
    } catch {
      auditPath = '' // not writable here: the store copy still works
    }
  }
}
/** Point the log at the current session (also after /clear, which gives the process a new session id). */
async function syncSession($: $) {
  const sid = await $.session.id()
  if (sid === curSid) return
  if (curSid) await flushAudit($)
  curSid = sid
  const custom = (await $.env.get('MAPSHIFT_HOME'))?.trim()
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  homeDir = home ? home.replace(/\\/g, '/') : ''
  mapHome = custom ? custom.replace(/\\/g, '/').replace(/\/+$/, '') : home ? `${home.replace(/\\/g, '/')}/.mapshift` : ''
  auditPath = mapHome ? `${mapHome}/logs/claude/audit-${sid}.jsonl` : ''
  const saved = (await $.store.get(`audit:${sid}`)) as AuditEvent[] | undefined
  audit = Array.isArray(saved) ? saved.slice(-700) : []
  turnNo = Math.max(0, ...audit.filter(x => x.k === 'turn').map(x => Number(x.turn) || 0))
  // this session's map savings count from its first logged moment (a reload keeps it)
  readPaths.clear()
  reminderOn = false
  sessionSince = audit.length ? Math.min(...audit.map(x => x.ts)) : await $.clock.now()
  await update($, mapA, m => ({ ...m, lookups: 0, fileReads: 0, statsSession: null, usdSession: null }))
  // keep the 8 most recent session logs in the store
  const idx = ((await $.store.get('auditSessions')) as string[] | undefined) ?? []
  const next = [sid, ...idx.filter(x => x !== sid)]
  for (const old of next.slice(8)) {
    await $.store.delete(`audit:${old}`)
    await $.store.delete(`ledger:${old}`)
  }
  await save($, 'auditSessions', next.slice(0, 8))
}
async function logErr($: $, where: string, err: unknown) {
  try {
    log(await $.clock.now(), { k: 'error', where, msg: String((err as Error)?.message ?? err).slice(0, 300) })
    await flushAudit($)
  } catch {
    /* never let logging break a turn */
  }
}

// ---- settings: global preferences, plus a mode per project
async function readProjects($: $): Promise<Record<string, ProjectPrefs>> {
  const v = (await $.store.get('projects')) as Record<string, ProjectPrefs> | undefined
  return v && typeof v === 'object' ? v : {}
}

/** Load this project's mode into the live settings; a project never seen before gets Auto. */
async function applyProject($: $, root: string) {
  project.key = projectKey(root)
  project.name = projectName(root)
  const p = (await readProjects($))[project.key]
  await update($, cfgA, c => ({
    ...c,
    mode: p?.mode ?? DEFAULT_CFG.mode,
    lockModel: p?.lockModel ?? DEFAULT_CFG.lockModel,
    lockEffort: p?.lockEffort ?? DEFAULT_CFG.lockEffort,
  }))
}

async function patchCfg($: $, patch: Partial<Cfg>) {
  const next = { ...(await read($, cfgA)), ...patch }
  await update($, cfgA, () => next)
  if (PROJECT_KEYS.some(k => k in patch) && project.key) {
    const all = await readProjects($)
    all[project.key] = { mode: next.mode, lockModel: next.lockModel, lockEffort: next.lockEffort, at: await $.clock.now() }
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 200)
    await save($, 'projects', Object.fromEntries(keep))
  }
  const { mode: _m, lockModel: _l, lockEffort: _e, ...globalPrefs } = next
  void _m
  void _l
  void _e
  await save($, 'cfg', globalPrefs)
}

async function loadData($: $): Promise<Data> {
  return {
    cfg: await read($, cfgA),
    last: await read($, lastA),
    log: await read($, logA),
    steps: await read($, stepsA),
    snap: await read($, snapA),
    totals: await read($, totalsA),
    map: await read($, mapA),
    seen: await read($, seenA),
    live: await read($, liveA),
    agents: await read($, agentsA),
    dark: (await read($, prefsA)).dark,
    health: await read($, healthA),
    ledger,
    current,
    now: await $.clock.now(),
  }
}

async function flagLast($: $) {
  await update($, logA, rows => (rows.length ? [...rows.slice(0, -1), { ...rows[rows.length - 1]!, misroute: true }] : rows))
  await update($, totalsA, tt => ({ ...tt, misroutes: tt.misroutes + 1 }))
  nextTurn.force = { tier: 'critical' }
  hold = { level: Math.min(2, hold.level + 1), left: 3 }
  $.ui.toast('Mapshift: noted. The next requests get a stronger setting.')
}

async function resetSession($: $) {
  await update($, totalsA, tt => ({ ...tt, session: money(), switches: 0, misroutes: 0, upgrades: 0, downgrades: 0 }))
  await update($, logA, () => [])
  await update($, stepsA, () => [])
  await update($, agentsA, () => [])
  $.ui.toast('Mapshift: session numbers cleared.')
}

/** The callbacks the pane and band may press; each one closes over `$` here, in this file. */
function actions($: $): Act {
  return {
    setCfg: (patch: Partial<Cfg>) => void patchCfg($, patch),
    useNext: (force: NextForce, message: string) => {
      nextTurn.force = force
      $.ui.toast(message)
    },
    flag: () => void flagLast($),
    reset: () => void resetSession($),
    openPane: () => void $.ui.open({ id: PANE, title: TITLE }),
  }
}

const CLASSIFIER_SYSTEM =
  'You rate how hard a coding-assistant task is. Judge the work, not how serious it sounds. Reply with exactly one word: ' +
  'light (lookups, tiny edits, questions), standard (normal feature work, known bug fixes, tests), ' +
  'deep (architecture, unknown-cause bugs, large refactors, security, planning, migrations). ' +
  'When unsure choose the harder label.'

let reminderOn = false // once the map reminder is in, it stays all session: the instructions never flip

const SECRET = /(sk-[a-z0-9_-]{8,}|ghp_[a-z0-9]{8,}|AKIA[0-9A-Z]{8,}|Bearer\s+\S+|(password|token|secret|api[_-]?key)\s*[=:]\s*\S+)/gi
const redact = (s: string) => s.replace(SECRET, '••••')

function today(now: number): string {
  try {
    return new Date(now).toLocaleDateString('en-CA')
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}

async function ensureLedger($: $) {
  const sid = await $.session.id()
  if (sid === ledgerSid) return
  ledgerSid = sid
  const saved = ((await $.store.get(`ledger:${sid}`)) ?? (await $.store.get('ledger'))) as { sid?: string; entries?: Ledger; current?: Family | null } | undefined
  if (saved?.entries && (saved.sid === undefined || saved.sid === sid)) {
    ledger = saved.entries
    const newest = Object.entries(ledger).sort((a, b) => b[1].at - a[1].at)[0]
    current = saved.current ?? ((newest && familyOf(newest[0])) || null)
  } else {
    ledger = {}
    current = null
  }
}

async function refreshTheme($: $) {
  try {
    const rows = await $.config.list()
    const theme = rows.find(r => r.key === 'theme')
    if (theme && typeof theme.value === 'string') {
      const dark = !/light/i.test(theme.value)
      await update($, prefsA, () => ({ dark }))
    }
  } catch {
    /* keep the last value */
  }
}

function toolDetail(e: Record<string, unknown>): string {
  const pick = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const raw = pick('command') || pick('file_path') || pick('pattern') || pick('url') || pick('query') || pick('description') || pick('path') || pick('skill')
  return redact(raw.split('\n')[0] ?? '').slice(0, 120)
}

export const register: Register = on => {
  // ------------------------------------------------------------------ start
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mapshift',
      description: 'Mapshift: open the dashboard, or /mapshift auto|quality|saver|manual|off|map on|map off|use <model> [effort]|flag|status|trace|doctor|help',
    })
    try {
      const saved = (await $.store.get('cfg')) as (Partial<Cfg> & { mode?: string }) | undefined
      if (saved && typeof saved === 'object') {
        // global preferences only: the mode belongs to each project
        const { mode: _m, lockModel: _l, lockEffort: _e, ...prefs } = saved
        void _m
        void _l
        void _e
        await update($, cfgA, () => ({ ...DEFAULT_CFG, ...prefs }))
      }
      let root = e.cwd
      try {
        root = (await $.session.root()) || e.cwd
      } catch {
        /* keep cwd */
      }
      rootDir = root
      await applyProject($, root)
      const tot = (await $.store.get('totals2')) as Partial<Totals> | undefined
      const now = await $.clock.now()
      const day = today(now)
      if (tot && tot.all) {
        // a today saved by an older version has money but no token counts: start today afresh rather
        // than show money without the tokens behind it
        const keepToday = tot.day === day && !!tot.today && typeof tot.today.tokens === 'number'
        await update($, totalsA, () => ({
          ...EMPTY_TOTALS,
          all: asMoney(tot.all),
          today: keepToday ? asMoney(tot.today) : money(),
          day,
        }))
      } else await update($, totalsA, t => ({ ...t, day }))
      rate = ((await $.store.get('rate')) as Record<string, RateSample[]> | undefined) ?? {}
    } catch {
      /* defaults stand */
    }
    rootDir = rootDir || e.cwd
    try {
      await syncSession($)
      const v = await $.session.version()
      log(await $.clock.now(), { k: 'session', project: e.cwd, engine: v.version, mod: '0.1.2' })
      await flushAudit($)
    } catch (err) {
      void logErr($, 'session.start audit', err)
    }
    idleTick?.cancel()
    // countdowns, "updated X ago" and cache time left keep moving between replies
    idleTick = $.clock.every(30_000, () => {
      void $.clock.now().then(t => update($, liveA, l => (l.busy ? l : { ...l, now: t })))
    })
    void refreshTheme($)
    if (e.isInteractive) void $.ui.open({ id: PANE, title: TITLE })
    void probeProject($, e.cwd)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      ledger = {}
      current = null
      ctxTokens = 0
      hold = { level: 0, left: 0 }
      lowerVotes = 0
      await save($, `ledger:${ledgerSid}`, { sid: ledgerSid, entries: {}, current: null })
    }
    return next(e)
  })

  // ------------------------------------------------------------------ prompt overrides
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const { text, force } = parseOverride(e.text)
    pendingForce = force ?? (nextTurn.force ? { ...nextTurn.force } : undefined)
    nextTurn.force = undefined
    const out = force ? { ...e, text } : e
    // starting points from the map, handed to Claude beside the prompt (never shown, never blocking)
    let hint: string | null = null
    try {
      const cfg = await read($, cfgA)
      // the map is its own feature: it keeps saving tokens even when model switching is Off
      if (cfg.mapReminder) hint = await askHint($, out.text)
    } catch {
      hint = null
    }
    return next(hint ? { ...out, context: [...(out.context ?? []), hint] } : out)
  })

  // ------------------------------------------------------------------ one decision per turn
  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      await syncSession($)
      const now = await $.clock.now()
      await update($, liveA, l => ({ ...l, busy: true, startedAt: now, now, tool: null, detail: null, tools: 0, errors: 0 }))
      ticker?.cancel()
      ticker = $.clock.every(1000, () => {
        void $.clock.now().then(t => update($, liveA, l => (l.busy ? { ...l, now: t } : l)))
      })

      try {
        const root = await $.session.root()
        if (root && projectKey(root) !== project.key) {
          rootDir = root
          await applyProject($, root) // /cd or a worktree move
          void probeProject($, root)
        }
      } catch {
        /* keep the current project */
      }
      const cfg = await read($, cfgA)
      turnNo += 1
      const force = pendingForce
      pendingForce = undefined
      if (cfg.mode === 'off' || force?.skip) return r
      if (/\bultracode\b/i.test(e.text)) {
        log(now, { k: 'prompt', turn: turnNo, chars: e.text.length, tier: 'n/a', scored: 'n/a', score: 0, reasons: 'you turned on Ultracode yourself: Mapshift stays out of this turn' })
        return r
      }
      const text = e.text
      // the map's view of the same request runs alongside the local scoring; it can only raise the level
      const mapAsk = force?.tier || cfg.mode === 'manual' ? null : askMap($, text)
      const sc = scorePrompt(text, { bigRepo })
      const reasons = [...sc.reasons]
      let tier: Tier = sc.tier
      if ((sc.followUp || text.trim() === '') && !force?.tier) {
        tier = lastTier
        reasons.push('follow-up keeps the level')
      }
      if (sc.correction) {
        hold = { level: Math.min(2, hold.level + 1), left: 3 }
        tier = maxTier(tier, lastTier)
        reasons.push('your correction raised the level')
        await update($, logA, rows => (rows.length ? [...rows.slice(0, -1), { ...rows[rows.length - 1]!, misroute: true }] : rows))
        await update($, totalsA, t => ({ ...t, misroutes: t.misroutes + 1 }))
      }
      if (cfg.classifier && sc.ambiguous && !force?.tier && cfg.mode !== 'manual' && now > classifier.pausedUntil) {
        try {
          const c = await $.model.complete({ model: 'haiku', effort: 'low', maxTokens: 8, timeoutMs: 3500, system: CLASSIFIER_SYSTEM, prompt: text.slice(0, 4000) })
          if (c.isAnswered) {
            classifier.fails = 0
            const merged = mergeClassifier(tier, c.text)
            if (merged !== tier) reasons.push(`smart check raised it to ${merged}`)
            tier = merged
          } else throw new Error('unanswered')
        } catch {
          classifier.fails += 1
          if (classifier.fails >= 3) classifier = { fails: 0, pausedUntil: now + 10 * 60_000 }
        }
      }
      let mapSignal: Record<string, unknown> | null = null
      if (mapAsk) {
        const got = await mapAsk
        if (got.route) {
          const raised = raises(tier, got.route.tier)
          mapSignal = { tier: got.route.tier, raised, reason: got.route.reason, ms: got.ms }
          if (raised) {
            tier = got.route.tier
            if (got.route.reason) reasons.unshift(got.route.reason) // the reason for the level comes first
          }
        } else mapSignal = got.skipped ? null : { failed: got.failed, ms: got.ms }
      }
      log(now, { k: 'prompt', turn: turnNo, chars: text.length, tier, scored: sc.tier, score: sc.score, edits: sc.edits, risk: sc.risk, ambiguous: sc.ambiguous, mode: cfg.mode, force: force ?? null, map: mapSignal, reasons: reasons.join(', ') })
      turns.set(e.turnId, {
        pre: { tier, force, reason0: reasons.join(', '), reasons, edits: sc.edits, risk: sc.risk, domain: sc.domain },
        errors: 0,
        edited: false,
        files: new Set<string>(),
        counts: {},
        grown: 0,
        tools: 0,
        startedAt: now,
        acc: { fresh: 0, read: 0, wrote: 0, out: 0, usd: 0, base: 0, cacheSaved: 0, steps: 0 },
        model: '',
        effort: '',
      })
    } catch (err) {
      void logErr($, 'turn.start', err) // fail open: no plan means the engine's own choice stands
    }
    return r
  })

  // ------------------------------------------------------------------ apply it, identically, on every step of the turn
  on('turn.step', async function* ($, e, next) {
    let req: { model: string; effort?: typeof e.effort } = { model: e.model, effort: e.effort }
    let tp: TurnPlan | undefined
    try {
      if (e.agentId === undefined) {
        tp = turns.get(e.turnId)
        appModel = e.model
        if (tp) {
          await ensureLedger($)
          if (!tp.plan) {
            const cfg = await read($, cfgA)
            const now = await $.clock.now()
            tp.sessionFam = familyOf(e.model)
            tp.plan = decide({
              cfg,
              model: e.model,
              current: current ?? undefined,
              effort: e.effort,
              tier: tp.pre.tier,
              edits: tp.pre.edits,
              risk: tp.pre.risk,
              force: tp.pre.force,
              struggle: hold.left > 0 ? hold.level : 0,
              ctxTokens,
              ledger,
              now,
              turnsSinceSwitch: turnNo - lastSwitchTurn,
              switchesRecent: switchTurns.filter(t => turnNo - t < 10).length,
              lowerVotes,
              outTokAvg,
              prices: PRICES,
              domain: tp.pre.domain,
              unavailable,
            })
            const plan = tp.plan
            log(now, {
              k: 'decision',
              turn: turnNo,
              appModel: e.model,
              appEffort: String(e.effort ?? 'default'),
              current,
              ctx: ctxTokens,
              ledger: Object.fromEntries(Object.entries(ledger).map(([f, l]) => [f, { ageS: Math.round((now - l.at) / 1000), tokens: l.tokens }])),
              lowerVotes,
              struggle: hold.left > 0 ? hold.level : 0,
              sendFamily: plan.family ?? null,
              sendModel: plan.model ?? null,
              sendEffort: plan.effort ?? String(e.effort ?? 'default'),
              switched: plan.switched,
              switchUsd: plan.switchUsd ?? null,
              suggest: plan.suggest ?? null,
              reason: plan.reason,
            })
            lowerVotes = plan.wantedLower && !plan.switched ? lowerVotes + 1 : 0
            if (plan.switched) {
              lastSwitchTurn = turnNo
              switchTurns = [...switchTurns.filter(t => turnNo - t < 10), turnNo]
              const from = current ?? tp.sessionFam
              const up = plan.family && from ? FAMILIES.indexOf(plan.family) > FAMILIES.indexOf(from) : false
              await update($, totalsA, t => ({ ...t, switches: t.switches + 1, upgrades: t.upgrades + (up ? 1 : 0), downgrades: t.downgrades + (up ? 0 : 1) }))
              $.ui.toast(`Mapshift: ${up ? 'moved up' : 'moved'} to ${modelName(plan.family ?? '')} for this task.`)
            }
            lastTier = plan.tier
            const effortShown = String(plan.effort ?? e.effort ?? 'default')
            await update($, lastA, () => ({
              n: turnNo,
              model: plan.model ?? e.model,
              family: plan.family ?? familyOf(e.model) ?? null,
              effort: effortShown,
              tier: plan.tier,
              reason: `${plan.reason}${tp!.pre.reason0 ? ` · ${tp!.pre.reason0}` : ''}`.slice(0, 220),
              why: shortWhy(tp!.pre.reasons, plan.reason),
              switched: plan.switched,
              switchUsd: plan.switchUsd ?? null,
              suggest: plan.suggest ?? null,
              answeredBy: null,
              mismatch: false,
              appModel: e.model,
              appEffort: String(e.effort ?? 'default'),
            }))
            const seenIds = await read($, seenA)
            const shownId = plan.model ? [...seenIds].reverse().find(m => familyOf(m) === plan.family) ?? plan.model : e.model
            $.ui.status(bandText({ tier: plan.tier, model: shownId, effort: effortShown, map: await read($, mapA) }))
          }
          const plan = tp.plan
          let eff = escalateEffort(plan.effort ?? asEffort(e.effort), tp.errors)
          if (tp.edited && eff) eff = maxEffort(eff, 'medium') // tool evidence beats the label
          // the job turned out bigger than its prompt: more effort for the rest of the turn (keeps the cache)
          const g = growth({ editedFiles: tp.files.size, tools: tp.tools, steps: e.index })
          if (g > 0 && eff && !tp.pre.force?.effort && (await read($, cfgA)).mode !== 'manual') {
            const grown = growEffort(eff, g)
            if (g > tp.grown && grown !== eff) {
              tp.grown = g
              const note = `turn grew (${tp.files.size} files edited, ${tp.tools} tool calls): effort raised to ${grown}`
              log(await $.clock.now(), { k: 'grow', turn: turnNo, step: e.index, files: tp.files.size, tools: tp.tools, from: eff, to: grown })
              await update($, lastA, l => (l ? { ...l, effort: String(grown), reason: `${note} · ${l.reason}`.slice(0, 240), why: 'The job grew while working, so thinking effort went up' } : l))
            }
            eff = grown
          }
          req = { model: plan.model ?? e.model, effort: eff ?? e.effort }
          tp.model = req.model
          tp.effort = String(req.effort ?? 'default')
        }
      }
    } catch (err) {
      req = { model: e.model, effort: e.effort }
      void logErr($, 'turn.step decide', err)
    }
    if (req.effort !== e.effort && !asEffort(req.effort)) req = { ...req, effort: e.effort }
    const r = yield* next(req.model === e.model && req.effort === e.effort ? e : { ...e, model: req.model, effort: req.effort })
    try {
      if (tp) await recordStep($, e.index, tp, r.usage)
    } catch (err) {
      void logErr($, 'turn.step record', err) // bookkeeping never breaks a turn
    }
    return r
  })

  // ------------------------------------------------------------------ tools: live card, failures, edits, map use
  on('tool.call', async ($, e, next) => {
    const main = (e as { agentId?: string }).agentId === undefined
    const name = String(e.tool)
    try {
      if (main) await update($, liveA, l => ({ ...l, tool: name.replace(/^mcp__([^_]+)__/, '$1 · '), detail: toolDetail(e as Record<string, unknown>), tools: l.tools + 1 }))
      if (isMapTool(name)) await update($, mapA, m => ({ ...m, lookups: m.lookups + 1 }))
      else if (isFileRead(name)) {
        await update($, mapA, m => ({ ...m, fileReads: m.fileReads + 1 }))
        const f = (e as Record<string, unknown>).file_path
        if (name === 'Read' && typeof f === 'string' && readPaths.size < 5000) readPaths.add(f)
      }
    } catch {
      /* display only */
    }
    const ran = await next(e)
    try {
      if (main) {
        const tp = [...turns.values()].at(-1)
        if (tp) {
          tp.tools += 1
          tp.counts[name] = (tp.counts[name] ?? 0) + 1
          if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) {
            tp.edited = true
            const f = (e as Record<string, unknown>).file_path ?? (e as Record<string, unknown>).notebook_path
            if (typeof f === 'string') tp.files.add(f.toLowerCase())
          }
          if ((ran as { isError?: boolean } | undefined)?.isError) {
            tp.errors += 1
            await update($, liveA, l => ({ ...l, errors: l.errors + 1 }))
          }
        }
      }
    } catch {
      /* ignore */
    }
    return ran
  })

  // ------------------------------------------------------------------ close the turn out
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      ticker?.cancel()
      ticker = null
      const now = await $.clock.now()
      const tp = turns.get(e.turnId)
      turns.delete(e.turnId)
      const seconds = tp ? Math.round((now - tp.startedAt) / 1000) : Math.round(e.durationMs / 1000)
      await update($, liveA, l => ({ ...l, busy: false, now, tool: null, detail: null, lastSeconds: seconds, lastTools: tp?.tools ?? l.tools }))
      const cfg = await read($, cfgA)
      if (cfg.notifyLongTurns && seconds >= 60 && !e.isAborted) {
        void $.ui.notify(`Finished in ${seconds}s${tp?.plan?.family ? ` on ${modelName(tp.plan.family)}` : ''}.`, { title: 'Claude is done', key: 'mapshift-done' }).catch(() => undefined)
      }
      void refreshMap($)
      void refreshTheme($)
      if (!tp || !tp.plan) return r
      if (hold.left > 0) hold = { ...hold, left: hold.left - 1 }
      if (tp.errors >= 3) hold = { level: Math.max(hold.level, 1), left: 2 }
      if (tp.grown >= 1) lastTier = maxTier(lastTier, 'complex') // a "continue" keeps the bigger level
      if (tp.acc.steps > 0) outTokAvg = Math.round(outTokAvg * 0.7 + (tp.acc.out / tp.acc.steps) * 0.3) || outTokAvg
      const row: LogRow = {
        n: turnNo,
        at: now,
        model: tp.model || 'session',
        family: tp.plan.family ?? null,
        effort: tp.effort || 'default',
        tier: tp.plan.tier,
        reason: tp.plan.reason.slice(0, 160),
        switched: tp.plan.switched,
        steps: tp.acc.steps,
        tools: tp.tools,
        seconds,
        fresh: tp.acc.fresh,
        read: tp.acc.read,
        wrote: tp.acc.wrote,
        out: tp.acc.out,
        usd: tp.acc.usd,
        baseUsd: tp.acc.base,
        misroute: false,
      }
      await update($, logA, rows => [...rows, row].slice(-80))
      const add = (m: Totals['session']) => ({
        usd: m.usd + row.usd,
        baseUsd: m.baseUsd + row.baseUsd,
        cacheSavedUsd: m.cacheSavedUsd + tp.acc.cacheSaved,
        turns: m.turns + 1,
        tokens: m.tokens + row.fresh + row.read + row.wrote + row.out,
        cacheRead: m.cacheRead + row.read,
      })
      const day = today(now)
      const totals = await update($, totalsA, t => ({
        ...t,
        session: add(t.session),
        today: add(t.day === day ? t.today : EMPTY_TOTALS.today),
        day,
        all: add(t.all),
      }))
      void totals
      const tt = await read($, totalsA)
      await save($, 'totals2', { all: tt.all, today: tt.today, day: tt.day })
      const engineUsd = (await read($, snapA)).sessionUsd
      const top = Object.entries(tp.counts).sort((a, b) => b[1] - a[1]).slice(0, 12)
      log(now, { k: 'tools', turn: row.n, map: Object.entries(tp.counts).filter(([n]) => isMapTool(n)).reduce((a, [, c]) => a + c, 0), counts: Object.fromEntries(top) })
      log(now, { k: 'turn', turn: row.n, steps: row.steps, tools: row.tools, errors: tp.errors, edited: tp.edited, seconds, usd: row.usd, baseUsd: row.baseUsd, cacheSaved: tp.acc.cacheSaved })
      log(now, { k: 'totals', sessionUsd: tt.session.usd, sessionBaseUsd: tt.session.baseUsd, sessionCacheSaved: tt.session.cacheSavedUsd, turns: tt.session.turns, engineUsd })
      await flushAudit($)
      const v = verifyAudit(audit, PRICES)
      await update($, healthA, () => ({ ok: v.ok, checkedAt: now, ...v.stats, problemLines: v.problemLines.slice(0, 3).map(l => l.slice(0, 140)), unavailable }))
    } catch (err) {
      void logErr($, 'turn.complete', err)
    }
    return r
  })

  // ------------------------------------------------------------------ one short section telling Claude to use the map where one exists
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    try {
      if (e.traits.includes('analysis')) return out
      const cfg = await read($, cfgA)
      const m = await read($, mapA)
      if (!cfg.mapReminder) return out // independent of the routing mode
      // added once a map exists, then kept for the rest of the session even if a later status check fails
      if (!reminderOn && m.state !== 'ready' && m.state !== 'building') return out
      if (out.sections.some(s => s.id === 'mapshift:map')) return out
      if (!reminderOn) {
        reminderOn = true
        log(await $.clock.now(), { k: 'map-reminder', on: true })
      }
      return { sections: [...out.sections, { id: 'mapshift:map', scope: 'session' as const, text: MAP_REMINDER }] }
    } catch {
      return out
    }
  })

  // ------------------------------------------------------------------ subagents: chosen once at spawn
  on('agent.spawn', async ($, e, next) => {
    let model = e.model
    let routed = false
    try {
      const cfg = await read($, cfgA)
      const sp = subagentPlan(cfg, {
        subagentType: e.subagentType,
        description: e.description,
        prompt: e.prompt,
        model: e.model,
        parentModel: e.parentModel,
        builtIn: e.provider?.plugin === 'engine',
      })
      let why = sp.why
      if (sp.model && unavailable.includes(sp.model as Family)) why = `${sp.model} is not being served: helper keeps the chat model`
      else if (sp.model) {
        model = sp.model
        routed = true
      }
      const now = await $.clock.now()
      log(now, { k: 'subagent', type: e.subagentType, description: e.description.slice(0, 60), model: model ?? 'inherits', routed, why })
      await update($, agentsA, rows =>
        [...rows, { at: now, type: e.subagentType, description: e.description.slice(0, 60), model: model ?? e.parentModel, routed }].slice(-30),
      )
    } catch (err) {
      void logErr($, 'agent.spawn', err) // fail open: the engine's own pick stands
      routed = false
    }
    return routed ? next({ ...e, model }) : next(e)
  })

  // ------------------------------------------------------------------ live usage: context, every limit window, pace
  on('session.measure', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      const windows: LimitWindow[] = []
      for (const w of e.rateLimits) {
        const list = rate[w.kind] ?? []
        const lastS = list[list.length - 1]
        if (!lastS || lastS.pct !== w.percentUsed || now - lastS.at > 10 * 60_000) list.push({ at: now, pct: w.percentUsed })
        rate[w.kind] = list.slice(-200)
        const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : null
        const reset = Number.isFinite(resetsAt as number) ? (resetsAt as number) : null
        const burn = pace(rate[w.kind]!, reset, now)
        const win = windowPace(w.kind, w.percentUsed, reset, now)
        windows.push({
          kind: w.kind,
          name: windowName(w.kind),
          pct: w.percentUsed,
          resetsAt: reset,
          elapsed: win.elapsed,
          perHour: burn.perHour,
          projected: win.projected ?? burn.projected,
          hitsAt: win.hitsAt ?? burn.hitsAt,
        })
      }
      windows.sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : a.kind.localeCompare(b.kind)))
      const before = await read($, snapA)
      for (const w of windows) {
        const prev = before.windows.find(x => x.kind === w.kind)?.pct ?? null
        const line = crossedLine(prev, w.pct)
        const id = `${w.kind}:${line}:${w.resetsAt ?? ''}`
        if (line && !alerted.has(id)) {
          alerted.add(id)
          const reset = w.resetsAt ? ` It resets in ${durationText(w.resetsAt - now)}.` : ''
          const msg = `${w.name} limit at ${w.pct}%.${reset}${line >= 90 ? ' Saver mode stretches what is left.' : ''}`
          $.ui.toast(`Mapshift: ${msg}`)
          if (line >= 90) void $.ui.notify(msg, { title: 'Claude usage', key: `mapshift-limit-${w.kind}` }).catch(() => undefined)
          log(now, { k: 'limit-alert', window: w.name, pct: w.pct, line })
        }
      }
      if (e.changed.includes('rateLimits')) {
        await save($, 'rate', rate)
        log(now, { k: 'limits', windows: windows.map(w => ({ name: w.name, pct: w.pct, resetsAt: w.resetsAt })), ctxPct: e.context.percent ?? null, engineUsd: e.cost?.usd ?? null })
      }
      await update($, snapA, s => ({
        ctxPct: e.context.percent ?? s.ctxPct,
        ctxTokens: e.context.tokens ?? s.ctxTokens,
        ctxWindow: e.context.window ?? s.ctxWindow,
        windows: windows.length ? windows : s.windows,
        sessionUsd: e.cost?.usd ?? s.sessionUsd,
        at: now,
      }))
    } catch {
      /* ignore */
    }
    return next(e)
  })

  // ------------------------------------------------------------------ /mapshift
  on('command.run', { command: 'mapshift' }, async ($, e) => {
    const [cmd = '', a1 = '', a2 = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const modes: Mode[] = ['auto', 'quality', 'saver', 'manual', 'off']
    if (cmd === '' || cmd === 'open') {
      await $.ui.open({ id: PANE, title: TITLE, focus: true })
      return { text: 'Mapshift is open. /mapshift help lists everything.' }
    }
    if ((modes as string[]).includes(cmd)) {
      await patchCfg($, { mode: cmd as Mode })
      return {
        text:
          cmd === 'off'
            ? 'Model switching is off: your own model picker is used. The map keeps working (/mapshift map off turns it off too).'
            : `Mapshift mode: ${cap(cmd)}.`,
      }
    }
    // the map on its own: separate from model switching
    if (cmd === 'map' && (a1 === 'on' || a1 === 'off')) {
      await patchCfg($, { mapReminder: a1 === 'on' })
      return {
        text:
          a1 === 'on'
            ? '🗺️ Map on: Claude gets starting points from the map with each prompt.'
            : '🗺️ Map off: no starting points or map reminder. The map tools stay available if Claude asks for them.',
      }
    }
    if (cmd === 'use' || cmd === 'lock') {
      const fam = FAMILIES.find(f => f === a1)
      if (!fam) return { text: 'Usage: /mapshift use <haiku|sonnet|opus|fable> [low|medium|high|xhigh|max]' }
      await patchCfg($, { mode: 'manual', lockModel: fam, lockEffort: asEffort(a2) ?? 'medium' })
      return { text: `Manual: ${cap(fam)} · ${asEffort(a2) ?? 'medium'} effort. /mapshift auto hands control back.` }
    }
    if (cmd === 'flag') {
      await flagLast($)
      return { text: 'Noted: the next requests get a stronger setting, and the last one is marked as a wrong pick.' }
    }
    if (cmd === 'budget') {
      const v = Number(a1)
      if (!(v > 0)) return { text: 'Usage: /mapshift budget <usd>, for example /mapshift budget 3' }
      await patchCfg($, { maxSwitchUsd: v })
      return { text: `Upgrade budget: ${fmtUsd(v)} per one-time cache rewrite.` }
    }
    if (cmd === 'ttl') {
      await patchCfg($, { ttlMin: a1 === '5' ? 5 : 60 })
      return { text: `Cache lifetime assumed: ${a1 === '5' ? '5' : '60'} minutes.` }
    }
    if (cmd === 'status') {
      const cfg = await read($, cfgA)
      const t = await read($, totalsA)
      const s = await read($, snapA)
      const m = await read($, mapA)
      const last = await read($, lastA)
      const appName = last?.appModel ? modelName(last.appModel) : 'your model'
      const mapStats = (label: string, st: MapStats | null) => (st ? [`Map ${label}: ${mapStatsLine(st)}`, `  ${toolLine(st)} · answers ${fmtTok(st.answerTokens)} tokens, without the map ${fmtTok(st.wouldRead)} tokens`] : [])
      return {
        text: [
          `Mode: ${cap(cfg.mode)}${cfg.mode === 'manual' ? ` (${cap(cfg.lockModel)} · ${cfg.lockEffort} effort)` : ''} · upgrade budget ${fmtUsd(cfg.maxSwitchUsd)} · cache ${cfg.ttlMin} min`,
          last ? `Last request: ${last.family ? cap(last.family) : 'session model'} · ${last.effort} effort (${last.tier}) · ${last.reason}` : 'No request routed yet.',
          ...s.windows.map(w => `${w.name}: ${w.pct}%${w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : ''}${w.projected !== null ? `, on pace for ${Math.round(w.projected)}% at reset` : ''}`),
          ...savingsLines('This chat', savingsFor(t.session, m.statsSession, m.usdSession), appName),
          ...savingsLines('Today', savingsFor(t.today, m.statsToday, m.usdToday), appName),
          `Cache (in both figures, not added): ${fmtUsd(t.session.cacheSavedUsd)} this chat · ${fmtUsd(t.today.cacheSavedUsd)} today`,
          `Map: ${mapLine(m)} · ${m.lookups} lookups, ${m.fileReads} file reads this chat`,
          ...mapStats('this chat', m.statsSession),
          ...mapStats('today', m.statsToday),
          'Estimates: dollars at list prices; map answers and file sizes in tokens are characters / 4.',
        ].join('\n'),
      }
    }
    if (cmd === 'trace') {
      const rows = await read($, stepsA)
      return {
        text: rows.length
          ? rows
              .slice(-15)
              .map(r => `#${r.n}.${r.step} ${r.model} · ${r.effort}  read ${fmtTok(r.read)}  wrote ${fmtTok(r.wrote)}  new ${fmtTok(r.fresh)}  → ${hitPct(r.read, r.fresh, r.wrote)}% from cache`)
              .join('\n')
          : 'No requests recorded yet.',
      }
    }
    if (cmd === 'doctor') return { text: await doctor($) }
    if (cmd === 'log') {
      const n = Math.max(1, Math.min(80, Number(a1) || 25))
      return { text: audit.length ? audit.slice(-n).map(formatEvent).join('\n') + (auditPath ? `\n\nFull log: ${auditPath}` : '') : 'The log is empty: send a prompt first.' }
    }
    if (cmd === 'verify') {
      const v = verifyAudit(audit, PRICES)
      return { text: [`Mapshift check: ${v.ok ? 'everything adds up' : 'problems found'} (${audit.length} log entries)`, ...v.lines].join('\n') }
    }
    return {
      text: [
        'Mapshift commands:',
        '  /mapshift                  open the dashboard',
        '  /mapshift auto|quality|saver|manual|off   model switching (Off: your own model picker)',
        '  /mapshift map on|off       the map, on its own: starting points with each prompt',
        '  /mapshift use opus high    pick one model and effort (Manual mode)',
        '  /mapshift flag             the last pick was wrong: think harder next',
        '  /mapshift budget 3         most a one-time upgrade may cost before it only recommends',
        '  /mapshift status | trace | doctor | log | verify',
        'Prompt prefixes: "++ " maximum effort · "-- " quick · "~ " skip routing · "@opus" · "!high" · or [model:opus] [effort:high] anywhere',
      ].join('\n'),
    }
  })

  // ------------------------------------------------------------------ drawing
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const d = await loadData($)
    if (!d.cfg.band || e.props.hasSurvey) return next(e)
    return Band($.ui.resolve(e), e, d, actions($)) as never
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const d = await loadData($)
    return Pane($.ui.resolve(e), e, d, actions($)) as never
  })
}

// ---------------------------------------------------------------------- bookkeeping
async function recordStep(
  $: $,
  index: number,
  tp: TurnPlan,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string } | null,
) {
  if (!usage) return
  const cfg = await read($, cfgA)
  const now = await $.clock.now()
  const fam = familyOf(usage.model)
  const fresh = usage.input_tokens
  const readT = usage.cache_read_input_tokens
  const wrote = usage.cache_creation_input_tokens
  const out = usage.output_tokens
  if (fam) {
    ledger = { ...ledger, [fam]: { at: now, tokens: fresh + readT + wrote } }
    current = fam
  }
  ctxTokens = fresh + readT + wrote
  await save($, `ledger:${ledgerSid}`, { sid: ledgerSid, entries: ledger, current })

  const p = PRICES[fam ?? 'opus']
  const baseP = PRICES[tp.sessionFam ?? fam ?? 'opus']
  tp.acc.fresh += fresh
  tp.acc.read += readT
  tp.acc.wrote += wrote
  tp.acc.out += out
  tp.acc.steps += 1
  const usd = stepCost(p, { fresh, read: readT, wrote, out }, cfg.ttlMin)
  const baseUsd = stepCost(baseP, { fresh, read: readT, wrote, out }, cfg.ttlMin)
  const cacheSaved = (readT * (p.in - p.read)) / 1e6
  tp.acc.usd += usd
  tp.acc.base += baseUsd
  tp.acc.cacheSaved += cacheSaved
  log(now, {
    k: 'step',
    turn: turnNo,
    i: index,
    sent: tp.model,
    sentEffort: tp.effort,
    answered: usage.model,
    fresh,
    read: readT,
    wrote,
    out,
    ttlMin: cfg.ttlMin,
    baseFamily: tp.sessionFam ?? fam ?? 'opus',
    usd,
    baseUsd,
    cacheSaved,
  })

  const row: StepRow = { n: turnNo, step: index, at: now, model: fam ?? modelName(usage.model), effort: tp.effort, fresh, read: readT, wrote, out }
  await update($, stepsA, rows => [...rows, row].slice(-40))
  if (index === 0 || index % 5 === 0) await save($, 'steps', (await read($, stepsA)).slice(-40))

  const wanted = tp.plan?.family
  const swapped = !!wanted && !!fam && wanted !== fam && tp.model !== '' && familyOf(tp.model) === wanted
  await update($, lastA, l => (l ? { ...l, answeredBy: usage.model, mismatch: swapped } : l))
  if (swapped && wanted) {
    substituted[wanted] = (substituted[wanted] ?? 0) + 1
    log(now, { k: 'substituted', asked: wanted, answered: usage.model, times: substituted[wanted] })
    if (substituted[wanted] >= 2 && !unavailable.includes(wanted)) {
      unavailable = [...unavailable, wanted]
      await update($, healthA, hc => ({ ...hc, unavailable }))
      $.ui.toast(`Mapshift: ${cap(wanted)} was asked for but ${modelName(usage.model)} answered twice. Routing to ${cap(wanted)} is paused for this session; your app's model stands in.`)
    }
  }

  const seen = await read($, seenA)
  if (!seen.includes(usage.model)) {
    await update($, seenA, s => [...s, usage.model].slice(-12))
    if (seen.length > 0) $.ui.toast(`Mapshift: new model detected (${modelName(usage.model)}). It is routed as ${fam ? cap(fam) : 'an unknown model'}${fam ? '' : ' and left untouched'}.`)
  }
}

// ---------------------------------------------------------------------- the map's command line

/**
 * Runs `mapshift <args>` and returns what it printed, or null. Tries the way that worked last time first,
 * then MAPSHIFT_BIN, then `mapshift` and `cmd /c mapshift`. Failures are silent: the card says what to do.
 */
async function runMapshift($: $, args: string[], timeoutMs: number): Promise<string | null> {
  const others = launchers(await $.env.get('MAPSHIFT_BIN'))
  const tries = launcher ? [launcher, ...others.filter(x => x.join(' ') !== launcher!.join(' '))] : others
  for (const pre of tries) {
    try {
      const r = await $.process.run([...pre, ...args, ...(rootDir ? ['--project', rootDir] : [])], { cwd: neutralCwd(), timeoutMs })
      if (r.exitCode === 0 && r.stdout.trim()) {
        launcher = pre
        return r.stdout
      }
    } catch {
      /* try the next way */
    }
  }
  return null
}

type MapAsk = { route: MapRoute | null; failed?: string; skipped?: boolean; ms: number }

/**
 * The map's judgement of one request (`mapshift route ... --json`): one attempt with the way already proven
 * by the status check, 1.5 seconds at most. Never rejects; any failure leaves the local score alone.
 */
async function askMap($: $, text: string): Promise<MapAsk> {
  let t0 = 0
  try {
    t0 = await $.clock.now()
    const m = await read($, mapA)
    const words = routeText(text)
    if (!launcher || (m.state !== 'ready' && m.state !== 'building') || !words) return { route: null, skipped: true, ms: 0 }
    const model = /^[\w.:[\]-]{1,80}$/.test(appModel) ? appModel : ''
    const r = await $.process.run(
      [...launcher, 'route', ...(model ? ['--model', model] : []), ...(rootDir ? ['--project', rootDir] : []), '--json', '--', words],
      { cwd: neutralCwd(), timeoutMs: 1500 },
    )
    const ms = (await $.clock.now()) - t0
    if (r.exitCode !== 0) return { route: null, failed: `exit ${r.exitCode}`, ms }
    const route = parseRoute(r.stdout)
    return route ? { route, ms } : { route: null, failed: 'unreadable answer', ms }
  } catch (err) {
    const ms = t0 ? (await $.clock.now().catch(() => t0)) - t0 : 0
    return { route: null, failed: /time/i.test(String((err as Error)?.message ?? err)) ? 'timeout' : 'error', ms }
  }
}

/**
 * Starting points for one prompt (`mapshift hint`): the few definitions the request is clearly about, read
 * from the map and handed to Claude beside the prompt, so it starts in the right place instead of searching.
 * One attempt with the launcher the status check proved, 1.5 seconds at most; quiet on any failure. The
 * map logs each hint, so it counts as a lookup on the dashboard and in the savings.
 */
async function askHint($: $, text: string): Promise<string | null> {
  const m = await read($, mapA)
  const words = routeText(text)
  if (!launcher || !rootDir || (m.state !== 'ready' && m.state !== 'building') || words.length < 8) return null
  try {
    const r = await $.process.run([...launcher, 'hint', '--project', rootDir, '--agent', 'claude-code', '--', words], { cwd: neutralCwd(), timeoutMs: 1500 })
    const out = r.exitCode === 0 ? r.stdout.trim() : ''
    return out.startsWith('Mapshift code map:') ? out.slice(0, 2000) : null
  } catch {
    return null
  }
}

/** Map status for the card and the reminder, and the session's map savings from the map's own log. */
async function refreshMap($: $) {
  try {
    const now = await $.clock.now()
    const out = await runMapshift($, ['map', 'status', '--json'], 10_000)
    const st = out ? parseStatus(out) : null
    // a failed check after a good one keeps the last good picture (a slow moment is not a missing map)
    await update($, mapA, m => (st ? { ...m, ...st, available: true, checkedAt: now } : m.available ? m : { ...m, available: false, state: null, checkedAt: now }))
    if (!st) return
    const m = await read($, mapA)
    let session: MapStats | null = m.lookups === 0 ? emptyStats() : null
    if (m.lookups > 0 && mapHome) {
      let log = ''
      let any = false
      for (const f of ledgerFiles(now)) {
        try {
          log += `${String(await $.fs.read(`${mapHome}/logs/${f}`))}\n`
          any = true
        } catch {
          /* no log for that day */
        }
      }
      if (any) session = mapSavings(log, { root: rootDir, since: sessionSince, reads: [...readPaths] })
    }
    // saved map tokens are priced at the input price of the model picked in the app (unknown model: no price)
    const fam = familyOf(appModel || (await read($, lastA))?.appModel || '')
    const price = fam ? PRICES[fam].in : null
    // today: this chat's latest figures plus the other chats of the day, each kept once by session id
    // (a chat's entry is replaced, never added to, so no chat is counted twice)
    const day = today(now)
    type Kept = { day?: string; bySid?: Record<string, { stats?: MapStats; price?: unknown }> }
    const kept = ((await $.store.get('mapStats')) as Kept | undefined) ?? {}
    const bySid = kept.day === day && kept.bySid && typeof kept.bySid === 'object' ? { ...kept.bySid } : {}
    if (session !== null && curSid) bySid[curSid] = { stats: session, price }
    if (session && session.lookups > 0 && curSid) await save($, 'mapStats', { day, bySid })
    const entries = Object.values(bySid).filter(x => !!x && typeof x.stats === 'object' && x.stats !== null)
    const priced = entries.filter(x => typeof x.price === 'number')
    const statsToday = entries.length ? addStats(entries.map(x => x.stats as MapStats)) : null
    const usdToday = priced.length ? priced.reduce((a, x) => a + (mapUsd(addStats([x.stats as MapStats]).saved, x.price as number) ?? 0), 0) : null
    await update($, mapA, x => ({ ...x, statsSession: session, statsToday, usdSession: session ? mapUsd(session.saved, price) : null, usdToday }))
  } catch {
    /* the card shows the last known state */
  }
}

async function probeProject($: $, cwd: string) {
  await refreshMap($)
  try {
    const files = await $.process.run(['git', '-C', rootDir || cwd, '-c', 'core.fsmonitor=false', 'ls-files'], { cwd: neutralCwd(), timeoutMs: 10000 })
    if (files.exitCode === 0) bigRepo = files.stdout.split('\n').filter(Boolean).length > 1500
  } catch {
    /* not a repository */
  }
}

async function doctor($: $): Promise<string> {
  const lines: string[] = ['Mapshift doctor']
  const ok = (good: boolean, text: string, fix?: string) => lines.push(`${good ? '✓' : '✗'} ${text}${!good && fix ? `  → ${fix}` : ''}`)
  try {
    const v = await $.session.version()
    ok(true, `Claude Code ${v.version}`)
  } catch {
    ok(false, 'Could not read the Claude Code version')
  }
  const cfg = await read($, cfgA)
  ok(cfg.mode !== 'off', `Mode: ${cap(cfg.mode)}`, '/mapshift auto')
  const last = await read($, lastA)
  ok(!!last, last ? `Last request: ${last.family ? cap(last.family) : 'session model'} · ${last.effort} effort` : 'No request routed yet', 'send a prompt')
  if (last?.answeredBy) ok(!last.mismatch, `Answered by ${last.answeredBy}`, 'the requested model was substituted; check /model and your plan')
  try {
    await save($, 'doctor', Date.now())
    ok((await $.store.get('doctor')) !== undefined, 'Settings storage works')
  } catch {
    ok(false, 'Settings storage failed')
  }
  await refreshMap($)
  const m = await read($, mapA)
  ok(m.available === true, `Map: ${mapLine(m)}`, 'run `npx mapshift setup` in this project')
  ok(classifier.pausedUntil < Date.now(), classifier.pausedUntil < Date.now() ? 'Smart check healthy' : 'Smart check paused after 3 failures (resumes in 10 min)')
  const steps = await read($, stepsA)
  const lastS = steps[steps.length - 1]
  if (lastS) ok(hitPct(lastS.read, lastS.fresh, lastS.wrote) >= 50 || lastS.step === 0, `Last request read ${hitPct(lastS.read, lastS.fresh, lastS.wrote)}% from cache`)
  return lines.join('\n')
}
