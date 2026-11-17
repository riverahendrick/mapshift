import { expect, mock, test } from 'claude-code/testing'

import {
  DEFAULT_CFG,
  PRICES,
  decide,
  economics,
  effortKeepsCache,
  escalateEffort,
  familyOf,
  mergeClassifier,
  pace,
  parseOverride,
  scorePrompt,
  subagentModel,
  crossedLine,
  growEffort,
  growth,
  riskDomain,
  stepCost,
  verifyAudit,
  windowName,
  windowPace,
} from './brain'
import type { MapInfo } from '../types'
import type { DecideInput } from './brain'
import { STATUS, statusColor } from './charts'
import { addStats, launchers, mapSavings, mapToolOf, parseRoute, parseStatus, raises, routeText, savedPct } from './map'
import { mapStatsLine, mapUsd, moneyVerdict, savingsFor, savingsLines, signedUsd, stretch, tokenVerdict, toolLine } from './savings'
import { projectKey } from './state'
import { bandText, inText, shortWhy } from './ui'

const NOW = 1_800_000_000_000
const base: DecideInput = {
  cfg: DEFAULT_CFG,
  model: 'claude-opus-5-5',
  effort: 'medium',
  tier: 'routine',
  edits: true,
  risk: false,
  struggle: 0,
  ctxTokens: 100_000,
  ledger: {},
  now: NOW,
  turnsSinceSwitch: 9,
  switchesRecent: 0,
  lowerVotes: 1,
  outTokAvg: 1200,
  prices: PRICES,
}
const warmOpus = { opus: { at: NOW - 30_000, tokens: 100_000 } }

/**
 * The map's log for one chat in C:/work/alpha (the agent later reads src/b.ts):
 *   find     answer 300, points at a.ts 4000 + b.ts 2000  → would read 4000, credit 3700
 *   trace    answer 250, points at c.ts 1500              → would read 1500, credit 1250
 *   file     answer 400, points at d.ts 9000              → would read 9000, credit 8600
 *   search   answer 500, points at b.ts 2000 (read)       → would read 0,    credit 0 (not −500)
 *   overview answer 150, points at a.ts 4000 again        → would read 4000, credit 3850
 * plus one answer in another project and one from before this chat, which never count.
 */
const LEDGER = [
  { kind: 'map', ts: NOW + 1000, agent: 'claude-code', repo: 'C:/work/alpha', tool: 'map_find', answerTokens: 300, files: [{ path: 'src/a.ts', tokens: 4000 }, { path: 'src/b.ts', tokens: 2000 }] },
  { kind: 'map', ts: NOW + 1100, agent: 'claude-code', repo: 'C:/work/alpha', tool: 'map_trace', answerTokens: 250, files: [{ path: 'src/c.ts', tokens: 1500 }] },
  { kind: 'map', ts: NOW + 1200, agent: 'claude-code', repo: 'C:/work/alpha', tool: 'map_file', answerTokens: 400, files: [{ path: 'src/d.ts', tokens: 9000 }] },
  { kind: 'map', ts: NOW + 1300, agent: 'claude-code', repo: 'C:/work/alpha', tool: 'map_search', answerTokens: 500, files: [{ path: 'src/b.ts', tokens: 2000 }] },
  { kind: 'map', ts: NOW + 1400, agent: 'claude-code', repo: 'C:/work/alpha', tool: 'map_overview', answerTokens: 150, files: [{ path: 'src/a.ts', tokens: 4000 }] },
  { kind: 'map', ts: NOW + 1500, agent: 'claude-code', repo: 'C:/work/beta', tool: 'map_find', answerTokens: 300, files: [{ path: 'src/z.ts', tokens: 9000 }] },
  { kind: 'map', ts: NOW - 60_000, agent: 'claude-code', repo: 'C:/work/alpha', tool: 'map_find', answerTokens: 300, files: [{ path: 'src/e.ts', tokens: 5000 }] },
]
const LEDGER_STATS = {
  lookups: 5,
  byTool: { find: 1, trace: 1, file: 1, overview: 1, search: 1, other: 0 },
  answerTokens: 1600, // 300 + 250 + 400 + 500 + 150
  wouldRead: 18_500, // 4000 + 1500 + 9000 + 0 + 4000
  saved: 16_900, // 18,500 would have been read, less 1,600 for the answers (the search answer spared nothing and costs its 500)
  filesSkipped: 3, // a.ts, c.ts, d.ts
}
/** Another chat of the same day, as the store keeps it. */
const OTHER_CHAT = { lookups: 2, byTool: { find: 2, trace: 0, file: 0, overview: 0, search: 0, other: 0 }, answerTokens: 400, wouldRead: 10_000, saved: 9600, filesSkipped: 2 }

// ------------------------------------------------------------------ pure rules

test('model families and versions are read from ids and aliases, new releases included', async () => {
  expect(familyOf('claude-opus-5-5')).toBe('opus')
  expect(familyOf('claude-sonnet-6-0')).toBe('sonnet')
  expect(familyOf('haiku')).toBe('haiku')
  expect(familyOf('claude-fable-5-2')).toBe('fable')
  expect(familyOf('gpt-x')).toBeUndefined()
  expect(effortKeepsCache('claude-opus-5-5')).toBe(true)
  expect(effortKeepsCache('claude-opus-4-8')).toBe(false)
  expect(effortKeepsCache('claude-fable-5-1')).toBe(true)
})

test('scoring: small, standard, deep and risky prompts', async () => {
  expect(scorePrompt('what does this function do?').tier).toBe('trivial')
  expect(scorePrompt('fix the typo in README.md').tier).toBe('trivial')
  expect(scorePrompt('add a unit test for parseDate in src/date.ts').tier).toBe('routine')
  const deep = scorePrompt('Refactor the auth module to fix an intermittent race condition in src/auth.ts and src/session.ts, then migrate the schema.')
  expect(deep.tier === 'complex' || deep.tier === 'critical').toBe(true)
  const risky = scorePrompt('fix the login bug and deploy to production')
  expect(risky.risk).toBe(true)
  expect(risky.tier).not.toBe('trivial')
  expect(scorePrompt('yes go ahead').followUp).toBe(true)
  expect(scorePrompt('yes and also add a retry to the client').followUp).toBe(false)
  expect(scorePrompt('no that is wrong, still failing').correction).toBe(true)
})

test('overrides: prefixes, natural [model:x] [effort:x] and ~ skip', async () => {
  expect(parseOverride('++ rewrite the parser').force?.effort).toBe('max')
  expect(parseOverride('++ rewrite the parser').text).toBe('rewrite the parser')
  expect(parseOverride('-- rename x').force?.tier).toBe('trivial')
  expect(parseOverride('@sonnet !high do it').force?.family).toBe('sonnet')
  expect(parseOverride('@sonnet !high do it').force?.effort).toBe('high')
  const nat = parseOverride('please refactor this [model:opus] [effort:xhigh] now')
  expect(nat.force?.family).toBe('opus')
  expect(nat.force?.effort).toBe('xhigh')
  expect(nat.text).toBe('please refactor this now')
  expect(parseOverride('~ just answer').force?.skip).toBe(true)
  expect(parseOverride('keep [model:gpt] as text').force).toBeUndefined()
  expect(parseOverride('plain prompt').force).toBeUndefined()
})

test('the smart check can only raise a level', async () => {
  expect(mergeClassifier('routine', 'deep')).toBe('critical')
  expect(mergeClassifier('complex', 'light')).toBe('complex')
  expect(mergeClassifier('routine', 'garbage')).toBe('routine')
})

test('policy: a big warm context never downgrades; effort adapts for free', async () => {
  const p = decide({ ...base, tier: 'trivial', edits: false, ledger: warmOpus })
  expect(p.model).toBeUndefined()
  expect(p.switched).toBe(false)
  expect(p.effort).toBe('low')
})

test('policy: a small cold context may downgrade a quick, safe turn after two votes', async () => {
  const p = decide({ ...base, tier: 'trivial', ctxTokens: 5_000, edits: false })
  expect(p.model).toBe('haiku')
  expect(p.switched).toBe(true)
  const firstVote = decide({ ...base, tier: 'trivial', ctxTokens: 5_000, edits: false, lowerVotes: 0 })
  expect(firstVote.model).toBeUndefined()
  expect(firstVote.wantedLower).toBe(true)
})

test('policy: risk, trouble, quality mode, recent switches and the switch-off all block a downgrade', async () => {
  const small = { ...base, tier: 'trivial' as const, ctxTokens: 5_000, edits: false }
  expect(decide({ ...small, risk: true }).model).toBeUndefined()
  expect(decide({ ...small, struggle: 1 }).model).toBeUndefined()
  expect(decide({ ...small, cfg: { ...DEFAULT_CFG, mode: 'quality' } }).model).toBeUndefined()
  expect(decide({ ...small, turnsSinceSwitch: 1 }).model).toBeUndefined()
  expect(decide({ ...small, switchesRecent: 3 }).model).toBeUndefined()
  expect(decide({ ...small, cfg: { ...DEFAULT_CFG, allowDowngrade: false } }).model).toBeUndefined()
})

test('policy: a needed upgrade on a modest context goes through', async () => {
  const p = decide({ ...base, model: 'claude-sonnet-5-5', tier: 'critical', risk: true })
  expect(p.model).toBe('opus')
  expect(p.switched).toBe(true)
})

test('policy: an upgrade of a huge cached conversation is priced, recommended and replaced by more effort', async () => {
  const ledger = { sonnet: { at: NOW - 60_000, tokens: 370_000 } }
  const p = decide({ ...base, model: 'claude-sonnet-5-5', effort: 'high', tier: 'critical', risk: true, ctxTokens: 370_000, ledger })
  expect(p.model).toBeUndefined()
  expect(p.switched).toBe(false)
  expect(p.suggest?.family).toBe('opus')
  expect((p.suggest?.usd ?? 0) > 1).toBe(true)
  expect(p.effort === 'max' || p.effort === 'xhigh').toBe(true)
  // Quality mode's bigger budget lets the same upgrade through
  const q = decide({ ...base, cfg: { ...DEFAULT_CFG, mode: 'quality', maxSwitchUsd: 1 }, model: 'claude-sonnet-5-5', tier: 'critical', risk: true, ctxTokens: 370_000, ledger })
  expect(q.model).toBe('opus')
})

test('policy: upgrades are sticky; the next small turn does not bounce back to the session model', async () => {
  const ledger = { opus: { at: NOW - 30_000, tokens: 120_000 }, sonnet: { at: NOW - 600_000, tokens: 90_000 } }
  const p = decide({ ...base, model: 'claude-sonnet-5-5', current: 'opus', tier: 'routine', ctxTokens: 120_000, ledger })
  expect(p.family).toBe('opus')
  expect(p.model).toBe('opus') // keeps sending Opus although the app is set to Sonnet
  expect(p.switched).toBe(false)
})

test('policy: returning to a model whose cache is still warm is allowed for small turns', async () => {
  const ledger = { opus: { at: NOW - 30_000, tokens: 200_000 }, sonnet: { at: NOW - 120_000, tokens: 195_000 } }
  const p = decide({ ...base, model: 'claude-sonnet-5-5', current: 'opus', tier: 'routine', edits: false, ctxTokens: 200_000, ledger, cfg: { ...DEFAULT_CFG, respectAppEffort: false } })
  expect(p.family).toBe('sonnet')
  expect(p.model).toBeUndefined() // back on the app's own model
  const cold = decide({ ...base, model: 'claude-sonnet-5-5', current: 'opus', tier: 'routine', edits: false, ctxTokens: 200_000, ledger: { opus: ledger.opus } })
  expect(cold.family).toBe('opus') // Sonnet's cache is gone: stay
})

test('policy: real work never thinks less than the effort set in the app', async () => {
  const p = decide({ ...base, effort: 'high', tier: 'routine', edits: true, ledger: warmOpus })
  expect(p.effort).toBeUndefined() // stays at the app's High
  const quick = decide({ ...base, effort: 'high', tier: 'trivial', edits: false, ledger: warmOpus })
  expect(quick.effort).toBe('low') // a quick read-only question may use less
  const off = decide({ ...base, cfg: { ...DEFAULT_CFG, respectAppEffort: false }, effort: 'high', tier: 'routine', ledger: warmOpus })
  expect(off.effort).toBe('medium')
})

test('policy: complex work on the session model raises effort only', async () => {
  const p = decide({ ...base, tier: 'complex' })
  expect(p.model).toBeUndefined()
  expect(p.effort).toBe('high')
})

test('policy: escalation after trouble raises the level and effort', async () => {
  const hot = decide({ ...base, tier: 'routine', struggle: 2 })
  expect(hot.tier).toBe('critical')
  expect(hot.effort === 'xhigh' || hot.effort === 'high').toBe(true)
  expect(escalateEffort('medium', 2)).toBe('medium')
  expect(escalateEffort('medium', 3)).toBe('high')
  expect(escalateEffort('medium', 6)).toBe('xhigh')
})

test('policy: manual, forced and off', async () => {
  const manual = decide({ ...base, cfg: { ...DEFAULT_CFG, mode: 'manual', lockModel: 'sonnet', lockEffort: 'high' } })
  expect(manual.model).toBe('sonnet')
  expect(manual.effort).toBe('high')
  expect(decide({ ...base, force: { family: 'haiku', effort: 'low' } }).model).toBe('haiku')
  const off = decide({ ...base, cfg: { ...DEFAULT_CFG, mode: 'off' } })
  expect(off.model).toBeUndefined()
  expect(off.effort).toBeUndefined()
})

test('policy: an unknown model passes through untouched', async () => {
  const p = decide({ ...base, model: 'some-new-model-v9', tier: 'critical' })
  expect(p.model).toBeUndefined()
  expect(p.effort).toBeUndefined()
})

test('economics: a cold context makes the cheaper model pay at once; a warm one less so', async () => {
  const args = {
    stay: { family: 'opus' as const, effort: 'medium' as const },
    to: { family: 'sonnet' as const, effort: 'medium' as const },
    ctx: 40_000,
    now: NOW,
    ttlMin: 60 as const,
    outTok: 1200,
    horizon: 3,
    prices: PRICES,
  }
  const cold = economics(args)
  expect(cold.firstDelta > 0).toBe(true)
  const warm = economics({ ...args, stay: { ...args.stay, entry: { at: NOW - 1000, tokens: 40_000 } } })
  expect(warm.firstDelta < cold.firstDelta).toBe(true)
})

test('limits: names, instant pace from the share of the window gone, and burn rate', async () => {
  expect(windowName('seven_day')).toBe('Weekly')
  expect(windowName('five_hour')).toBe('5-hour')
  expect(windowName('seven_day_opus')).toBe('Weekly · Opus')
  const day = 24 * 3_600_000
  // 3.5 of 7 days gone, 93% used: on pace for ~186%, runs out before the reset
  const w = windowPace('seven_day', 93, NOW + 3.5 * day, NOW)
  expect(Math.round((w.elapsed ?? 0) * 100)).toBe(50)
  expect(Math.round(w.projected ?? 0)).toBe(186)
  expect(w.hitsAt !== null && w.hitsAt < NOW + 3.5 * day).toBe(true)
  // 20% used with half the week gone: fine
  const ok = windowPace('seven_day', 20, NOW + 3.5 * day, NOW)
  expect(ok.hitsAt).toBeNull()
  const b = pace([{ at: NOW - 2 * 3_600_000, pct: 10 }, { at: NOW, pct: 14 }], NOW + 10 * 3_600_000, NOW)
  expect(Math.round(b.perHour ?? 0)).toBe(2)
})

test('helpers: Haiku for lookups, Sonnet for analysis and edits, Opus for hard or risky work, Fable only when allowed', async () => {
  const h = (description: string, prompt: string, extra: any = {}, cfg: any = DEFAULT_CFG) =>
    subagentModel(cfg, { subagentType: 'general-purpose', description, prompt, parentModel: 'claude-opus-5-5', builtIn: true, ...extra })
  expect(h('find files', 'search the repo and list where the config is loaded')).toBe('haiku')
  expect(h('find files', 'search the repo and list where the config is loaded', {}, { ...DEFAULT_CFG, mode: 'quality' })).toBe('sonnet')
  expect(h('review module', 'review the parser module and summarize its weak spots')).toBe('sonnet')
  expect(h('small change', 'update the button label in src/ui/button.tsx')).toBe('sonnet')
  expect(h('small change', 'update the button label in src/ui/button.tsx', {}, { ...DEFAULT_CFG, mode: 'quality' })).toBeUndefined()
  expect(subagentModel(DEFAULT_CFG, { subagentType: 'general-purpose', description: 'auth fix', prompt: 'fix the login session handling', parentModel: 'claude-sonnet-5-5', builtIn: true })).toBe('opus')
  expect(subagentModel(DEFAULT_CFG, { subagentType: 'Plan', description: 'plan', prompt: 'outline the steps', parentModel: 'claude-sonnet-5-5', builtIn: true })).toBe('opus')
  const critical = 'Rewrite the payment ledger reconciliation from scratch, fix the race condition and migrate the schema across services end to end'
  expect(h('big job', critical)).toBeUndefined() // Opus, same as the chat
  expect(h('big job', critical, {}, { ...DEFAULT_CFG, allowFable: true })).toBe('fable')
  expect(subagentModel(DEFAULT_CFG, { subagentType: 'general-purpose', description: 'big job', prompt: critical, parentModel: 'claude-fable-5-2', builtIn: true })).toBeUndefined() // app on Fable: allowed, same as chat
  // never touched
  expect(h('find files', 'search the repo', { model: 'opus' })).toBeUndefined()
  expect(h('find files', 'search the repo', { builtIn: false })).toBeUndefined()
  expect(h('find files', 'search the repo', { subagentType: 'fork' })).toBeUndefined()
  expect(h('find files', 'search the repo', {}, { ...DEFAULT_CFG, mode: 'off' })).toBeUndefined()
})

test('Fable: off by default, used for critical work when allowed, implied when the app is on Fable', async () => {
  const crit = { ...base, tier: 'critical' as const, ctxTokens: 20_000, ledger: warmOpus }
  expect(decide(crit).family).toBe('opus')
  expect(decide({ ...crit, cfg: { ...DEFAULT_CFG, allowFable: true } }).family).toBe('fable')
  const onFable = decide({ ...crit, model: 'claude-fable-5-2', ledger: { fable: { at: NOW - 1000, tokens: 20_000 } } })
  expect(onFable.family).toBe('fable')
  expect(onFable.model).toBeUndefined() // stays on the app's Fable
  const smallOnFable = decide({ ...base, model: 'claude-fable-5-2', tier: 'trivial', edits: false, ctxTokens: 5_000, ledger: {} })
  expect(smallOnFable.family).toBe('haiku') // a quick, safe question may still go cheaper
  expect(decide({ ...crit, cfg: { ...DEFAULT_CFG, allowFable: true, mode: 'saver' } }).family).toBe('opus')
})

test('Ultracode: a special app effort is left exactly as set, and is never sent by Mapshift', async () => {
  const p = decide({ ...base, effort: 'ultracode', tier: 'critical', ledger: warmOpus })
  expect(p.model).toBeUndefined()
  expect(p.effort).toBeUndefined()
  expect(p.reason).toContain('special effort mode')
  expect(decide({ ...base, effort: 40000 as any, tier: 'critical' }).effort).toBeUndefined()
})

test('typing "ultracode" yourself keeps Mapshift out of that turn', async ($, on) => {
  const { seen } = engine(on)
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'ultracode refactor the whole billing service end to end', turnId: 'u1' })
  await step($, 'u1', 0, { model: 'claude-sonnet-5-5', effort: 'high' })
  expect(seen[0]!.model).toBe('claude-sonnet-5-5')
  expect(seen[0]!.effort).toBe('high')
})

test('a v1 ledger without a cache holder resolves to the most recent model', async ($, on) => {
  const { seen } = engine(on, { store: { ledger: { sid: 'sess-1', entries: { sonnet: { at: NOW - 600_000, tokens: 300_000 }, opus: { at: NOW - 60_000, tokens: 370_000 } } } } })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'thanks, now explain what this function returns', turnId: 'v1' })
  await step($, 'v1', 0, { model: 'claude-sonnet-5-5' })
  expect(seen[0]!.model).toBe('opus') // stays on Opus, which holds 370k cached tokens
})

test('verify: a consistent log passes; tampered money and model swaps are caught', async () => {
  const mk = (turn: number, i: number, answered: string, read: number, wrote: number, effort: string, ts: number) => {
    const fam = familyOf(answered)!
    const u = { fresh: 20, read, wrote, out: 800 }
    return {
      k: 'step', ts, turn, i, sent: fam, sentEffort: effort, answered, ...u, ttlMin: 60 as const, baseFamily: 'sonnet',
      usd: stepCost(PRICES[fam], u, 60), baseUsd: stepCost(PRICES.sonnet, u, 60), cacheSaved: (read * (PRICES[fam].in - PRICES[fam].read)) / 1e6,
    }
  }
  const s1 = mk(1, 0, 'claude-opus-5-5', 90_000, 500, 'medium', NOW)
  const s2 = mk(1, 1, 'claude-opus-5-5', 95_000, 300, 'high', NOW + 5_000)
  const turn = { k: 'turn', ts: NOW + 6_000, turn: 1, steps: 2, usd: s1.usd + s2.usd, baseUsd: s1.baseUsd + s2.baseUsd, cacheSaved: s1.cacheSaved + s2.cacheSaved }
  const good = verifyAudit([s1, s2, turn] as any, PRICES)
  expect(good.ok).toBe(true)
  expect(good.lines.some(l => l.includes('1 of 1 effort-only changes'))).toBe(true)
  const tampered = verifyAudit([{ ...s1, usd: s1.usd * 2 }, s2, turn] as any, PRICES)
  expect(tampered.ok).toBe(false)
  const swapped = verifyAudit([{ ...s1, sent: 'opus', answered: 'claude-sonnet-5-5' }] as any, PRICES)
  expect(swapped.ok).toBe(false)
  const over = verifyAudit([s1, s2, turn, { k: 'totals', ts: NOW + 7000, sessionUsd: 5, engineUsd: 1 }] as any, PRICES)
  expect(over.ok).toBe(false)
})

test('a store briefly locked by another chat is retried, not logged as an error', async ($, on) => {
  const { clock, captured, setBusy } = engine(on)
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Explain what the cart total function returns', turnId: 'b1' })
  setBusy(2) // the next two saves find the store locked by another chat
  let done = false
  const running = step($, 'b1', 0).then(() => void (done = true))
  for (let i = 0; i < 40 && !done; i++) await clock.advance(200) // let the retry waits pass
  await running
  const stored = (captured['audit:sess-1'] as any[]) ?? []
  expect(stored.some(e => e.k === 'error')).toBe(false) // an error would have been flushed at once
  expect(Array.isArray(captured['steps'])).toBe(true) // the step's save got through after the retries
})

test('the real hooks write a log that verifies', async ($, on) => {
  const { captured } = await fill($, on)
  const stored = captured['audit:sess-1'] as any[]
  expect(Array.isArray(stored) && stored.some(e => e.k === 'step') && stored.some(e => e.k === 'decision') && stored.some(e => e.k === 'turn')).toBe(true)
  const v = verifyAudit(stored, PRICES)
  expect(v.lines.join(' | ')).toContain('every cost')
  expect(v.ok).toBe(true)
})

test('policy: an expired cache does not hold the routing; the app model anchors again', async () => {
  const ledger = { opus: { at: NOW - 7 * 3_600_000, tokens: 500_000 } }
  const p = decide({ ...base, model: 'claude-sonnet-5-5', current: 'opus', tier: 'routine', ctxTokens: 500_000, ledger })
  expect(p.family).toBe('sonnet')
  expect(p.model).toBeUndefined()
})

test('risky domains get the extended effort budget; ordinary work does not', async () => {
  expect(riskDomain('fix the login redirect')).toBe('auth')
  expect(riskDomain('fix the race condition in the queue')).toBe('concurrency')
  expect(riskDomain('migrate the users table')).toBe('data loss')
  expect(riskDomain('sanitize this input against xss')).toBe('security')
  expect(riskDomain('rename the button label')).toBeNull()
  const auth = decide({ ...base, model: 'claude-sonnet-5-5', tier: 'routine', edits: true, domain: 'auth', ctxTokens: 20_000 })
  expect(auth.effort).toBe('high') // Standard + risky = one step more
  const authHard = decide({ ...base, tier: 'complex', edits: true, domain: 'auth', ledger: warmOpus })
  expect(authHard.effort).toBe('xhigh') // Complex + risky = Extra high
  expect(auth.family).toBe('sonnet') // no model upgrade for a standard job
  const plain = decide({ ...base, tier: 'routine', edits: true, domain: null, ledger: warmOpus })
  expect(plain.effort).toBeUndefined()
})

test('fail closed: a model the account did not serve is never asked for again', async () => {
  const p = decide({ ...base, model: 'claude-sonnet-5-5', tier: 'critical', risk: true, ctxTokens: 20_000, unavailable: ['opus'] })
  expect(p.model).toBeUndefined()
  expect(p.family).toBe('sonnet')
  expect(p.reason).toContain('not being served')
})

test('limit alerts fire once when a line is crossed, not on every reading', async () => {
  expect(crossedLine(70, 76)).toBe(75)
  expect(crossedLine(76, 80)).toBeNull()
  expect(crossedLine(88, 93)).toBe(90)
  expect(crossedLine(null, 95)).toBe(90)
  expect(crossedLine(99, 100)).toBe(100)
})

test('the substitution guard pauses a model after two swapped answers', async ($, on) => {
  // the account "serves" Sonnet whatever is asked
  const { seen, toasts } = engine(on, { answer: () => 'claude-sonnet-5-5' })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  for (const id of ['s1', 's2', 's3']) {
    await $.turn.start({ text: 'Refactor the auth module to fix an intermittent race condition in src/auth.ts and migrate the schema end to end', turnId: id })
    await step($, id, 0, { model: 'claude-sonnet-5-5' })
    await $.turn.complete({ turnId: id, answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  }
  expect(seen[0]!.model).toBe('opus') // asked for Opus
  expect(seen[1]!.model).toBe('opus') // asked again
  expect(toasts.some(t => t.includes('paused'))).toBe(true)
  expect(seen[2]!.model).toBe('claude-sonnet-5-5') // third turn: fails closed to the app model
})

test('the effort ladder: Quick low, Standard medium, Complex high, Critical extra high, Max only on request', async () => {
  const c = { ...DEFAULT_CFG, respectAppEffort: false }
  const at = (tier: any, extra: any = {}) => decide({ ...base, cfg: c, effort: 'low', tier, ledger: warmOpus, ...extra })
  expect(at('trivial', { edits: false }).effort).toBe(undefined) // already low
  expect(at('routine').effort).toBe('medium')
  expect(at('complex').effort).toBe('high')
  expect(at('critical').effort).toBe('xhigh')
  expect(at('critical', { force: { effort: 'max' } }).effort).toBe('max')
  expect(decide({ ...base, cfg: { ...c, mode: 'quality' }, effort: 'low', tier: 'critical', ledger: warmOpus }).effort).toBe('max')
})

test('complex work outside code is recognised too', async () => {
  const data = scorePrompt('Analyze our Q3 sales dataset, compare the three pricing strategies and write a detailed report with a forecast')
  expect(data.tier === 'complex' || data.tier === 'critical').toBe(true)
  const plan = scorePrompt('Create a comprehensive business plan and roadmap for the product launch')
  expect(plan.tier === 'complex' || plan.tier === 'critical').toBe(true)
  const list = scorePrompt(['Build the settings page:', '- dark mode toggle', '- profile photo upload', '- email preferences', '- delete account flow'].join(String.fromCharCode(10)))
  expect(list.tier).not.toBe('trivial')
  expect(scorePrompt('what time zone does the server use?').tier).toBe('trivial')
})

test('asking for top quality never gets a quick job', async () => {
  expect(scorePrompt('make sure the onboarding copy is perfect').tier).not.toBe('trivial') // everyday wording: a nudge
  expect(scorePrompt('make the checkout flow production-ready').tier).toBe('complex') // a strong ask
  expect(scorePrompt('this is mission-critical, no mistakes: fix the typo in the footer').tier).toBe('complex')
})

test('money, legal, health and privacy count as risky in any product', async () => {
  expect(riskDomain('update the checkout pricing for subscriptions')).toBe('money & legal')
  expect(riskDomain('store patient health records')).toBe('health & privacy')
})

test('growth: a turn that turns out big gets more effort, capped at extra high', async () => {
  expect(growth({ editedFiles: 1, tools: 5, steps: 3 })).toBe(0)
  expect(growth({ editedFiles: 3, tools: 5, steps: 3 })).toBe(1)
  expect(growth({ editedFiles: 2, tools: 16, steps: 3 })).toBe(1)
  expect(growth({ editedFiles: 9, tools: 10, steps: 3 })).toBe(2)
  expect(growEffort('medium', 1)).toBe('high')
  expect(growEffort('high', 2)).toBe('xhigh')
  expect(growEffort('xhigh', 2)).toBe('xhigh')
})

test('the real hooks raise effort mid-turn once the work grows', async ($, on) => {
  const { seen } = engine(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'add a unit test for parseDate in src/date.ts', turnId: 'g1' })
  await step($, 'g1', 0)
  for (const f of ['a.ts', 'b.ts', 'c.ts']) await $.tool.call({ tool: 'Edit', file_path: `C:/work/alpha/${f}`, old_string: 'x', new_string: 'y' } as any)
  await step($, 'g1', 1)
  const order = ['low', 'medium', 'high', 'xhigh', 'max']
  expect(order.indexOf(String(seen[1]!.effort)) > order.indexOf(String(seen[0]!.effort))).toBe(true)
})

test('regression: an everyday design fix stays on Sonnet at Medium (the Resend email case)', async () => {
  const resend = ['My automatic email system using Resend: the design has a few things to correct.', '- the logo is too big', '- the button should use our brand blue', '- footer links are misaligned', '```html', '<table><tr><td>template</td></tr></table>', '```'].join(String.fromCharCode(10))
  const sc = scorePrompt(resend)
  expect(sc.tier).toBe('routine')
  const p = decide({ ...base, model: 'claude-sonnet-5-5', effort: 'medium', tier: sc.tier, edits: sc.edits, risk: sc.risk, domain: sc.domain, ctxTokens: 120_000, ledger: { sonnet: { at: NOW - 60_000, tokens: 120_000 } } })
  expect(p.model).toBeUndefined() // stays on the app's Sonnet
  expect(p.effort).toBeUndefined() // stays at Medium
})

test('regression: ordinary words are not mistaken for risky areas', async () => {
  expect(riskDomain('The Gmail thread view shows replies out of order')).toBeNull()
  expect(riskDomain('count the tokens in the prompt')).toBeNull()
  expect(riskDomain('lock the header to the top of the page')).toBeNull()
  expect(riskDomain('show the session timer on the dashboard')).toBeNull()
  expect(riskDomain('fix the deadlock in the job queue')).toBe('concurrency')
})

test('regression: pasted material is not scored as the request', async () => {
  const NL = String.fromCharCode(10)
  const pastedList = ['Please fix the button color.', '```', ...Array.from({ length: 128 }, (_, i) => `- requirement ${i} in src/file${i}.ts`), '```'].join(NL)
  expect(scorePrompt(pastedList).tier).toBe('routine')
  const logs = ['Users get logged out randomly, here are the logs:', ...Array.from({ length: 60 }, (_, i) => `2026-11-16 06:5${i % 10}:01 ERROR session expired user=${i} at handler (src/a.ts:${i}:3)`)].join(NL)
  expect(scorePrompt(logs).tier).toBe('complex') // an unknown-cause bug with evidence is real debugging
})

test('verify: turn numbers shared by different sessions are not a false alarm', async () => {
  const mk = (sid: string | undefined, turn: number, ts: number) => {
    const u = { fresh: 20, read: 90_000, wrote: 500, out: 800 }
    const usd = stepCost(PRICES.opus, u, 60)
    const step = { k: 'step', ts, sid, turn, i: 0, sent: 'opus', sentEffort: 'medium', answered: 'claude-opus-5-5', ...u, ttlMin: 60 as const, baseFamily: 'opus', usd, baseUsd: usd, cacheSaved: (90_000 * (PRICES.opus.in - PRICES.opus.read)) / 1e6 }
    const turnEv = { k: 'turn', ts: ts + 1000, sid, turn, steps: 1, usd, baseUsd: usd, cacheSaved: step.cacheSaved }
    return [step, turnEv]
  }
  // two sessions, both with a "turn #1"
  const both = verifyAudit([...mk('A', 1, NOW), ...mk('B', 1, NOW + 5_000)] as any, PRICES)
  expect(both.ok).toBe(true)
  // older rows with no session id and a repeated number are skipped, not flagged
  const legacy = verifyAudit([...mk(undefined, 1, NOW), ...mk(undefined, 1, NOW + 5_000)] as any, PRICES)
  expect(legacy.ok).toBe(true)
  expect(legacy.lines.join(' ')).toContain('skipped')
  // a real mismatch inside one session is still caught, and reported in words
  const [step, turnEv] = mk('A', 1, NOW)
  const wrong = verifyAudit([step, { ...turnEv, usd: 99 }] as any, PRICES)
  expect(wrong.ok).toBe(false)
  expect(wrong.problemLines.length).toBe(1)
  // old internal errors do not count forever
  const old = verifyAudit([{ k: 'error', ts: NOW - 10 * 3_600_000, where: 'x', msg: 'old' }, ...mk('A', 1, NOW)] as any, PRICES)
  expect(old.ok).toBe(true)
})

// ------------------------------------------------------------------ the map

test('map helpers: launchers, status and route answers, safe request text', async () => {
  expect(launchers(undefined)).toEqual([['mapshift'], ['cmd', '/c', 'mapshift']])
  expect(launchers('C:/m/src/cli/main.ts')).toEqual([['node', 'C:/m/src/cli/main.ts']])
  expect(launchers('/usr/local/bin/mapshift')).toEqual([['/usr/local/bin/mapshift']])
  expect(parseStatus(statusJson('ready'))?.symbols).toBe(3120)
  expect(parseStatus('{"state":"lost"}')).toBeNull()
  expect(parseStatus('Map: ready')).toBeNull()
  expect(parseRoute('{"tier":"complex","reasons":["The map shows 14 callers"]}')).toEqual({ tier: 'complex', reason: 'The map shows 14 callers' })
  expect(parseRoute('{"tier":"huge"}')).toBeNull()
  expect(raises('routine', 'complex')).toBe(true)
  expect(raises('complex', 'routine')).toBe(false)
  // nothing a Windows shell would act on reaches the command line, and long pastes are cut
  const safe = routeText('fix "a" & del x | y > z %PATH% ^ ! `id` in src/a.ts')
  expect(/["&|<>%^!`]/.test(safe)).toBe(false)
  expect(safe).toContain('src/a.ts')
  expect(routeText('x '.repeat(5000)).length <= 1500).toBe(true)
})

test('map savings: files the map pointed to and that were not read anyway, less what the answers cost', async () => {
  const ev = (o: any) => JSON.stringify({ kind: 'map', ts: NOW, agent: 'claude-code', repo: 'C:/work/alpha', tool: 'map_find', answerTokens: 300, files: [], ...o })
  const log = [
    ev({ files: [{ path: 'src/a.ts', tokens: 2000 }, { path: 'src/b.ts', tokens: 1000 }] }),
    ev({ ts: NOW - 60_000, files: [{ path: 'src/c.ts', tokens: 9000 }] }), // before this session
    ev({ repo: 'C:/work/beta', files: [{ path: 'src/d.ts', tokens: 9000 }] }), // another project
    'not json',
  ].join('\n')
  expect(mapSavings(log, { root: 'c:\\work\\alpha', since: NOW - 1000, reads: [] }).saved).toBe(2700)
  expect(mapSavings(log, { root: 'C:/work/alpha', since: NOW - 1000, reads: ['C:\\work\\alpha\\src\\a.ts'] }).saved).toBe(700)
  expect(mapSavings(ev({ files: [] }), { root: 'C:/work/alpha', since: 0, reads: [] }).saved).toBe(-300) // an answer that spared nothing costs its own size
})

test('map numbers: three answers, one pointed file read afterwards (the worked example)', async () => {
  const ev = (o: any) => JSON.stringify({ kind: 'map', ts: NOW, agent: 'claude-code', repo: 'C:/work/alpha', ...o })
  const log = [
    ev({ tool: 'map_find', answerTokens: 300, files: [{ path: 'src/a.ts', tokens: 4000 }, { path: 'src/b.ts', tokens: 2000 }] }),
    ev({ tool: 'map_trace', answerTokens: 250, files: [{ path: 'src/c.ts', tokens: 1500 }] }),
    ev({ tool: 'map_file', answerTokens: 400, files: [{ path: 'src/d.ts', tokens: 9000 }] }),
  ].join('\n')
  const s = mapSavings(log, { root: 'C:/work/alpha', since: NOW - 1000, reads: ['C:/work/alpha/src/b.ts'] })
  expect(s).toEqual({
    lookups: 3,
    byTool: { find: 1, trace: 1, file: 1, overview: 0, search: 0, other: 0 },
    answerTokens: 950, // 300 + 250 + 400
    wouldRead: 14500, // 4000 + 1500 + 9000 (b.ts was read, so not counted)
    saved: 13550, // (4000 − 300) + (1500 − 250) + (9000 − 400)
    filesSkipped: 3, // a, c, d
  })
  expect(savedPct(s)).toBe(93) // 13550 / 14500 = 93.4%
  expect(mapStatsLine(s)).toBe('🔍 3 lookups · 📄 3 files not opened · 💚 13.6k tokens saved (93%)')
  expect(toolLine(s)).toBe('Find 1 · Trace 1 · File outline 1')
})

test('map numbers: an answer that spared nothing counts against the savings, a file pointed at twice is one file, other chats and projects stay out', async () => {
  const s = mapSavings(LEDGER.map(x => JSON.stringify(x)).join('\n') + '\nnot json', { root: 'C:/work/alpha', since: NOW, reads: ['C:/work/alpha/src/b.ts'] })
  expect(s).toEqual(LEDGER_STATS)
  expect(savedPct(s)).toBe(91) // 16900 / 18500 = 91.4%
  // today: chats add field by field, and the percent comes from the sums
  const both = addStats([s, OTHER_CHAT])
  expect(both).toEqual({
    lookups: 7,
    byTool: { find: 3, trace: 1, file: 1, overview: 1, search: 1, other: 0 },
    answerTokens: 2000,
    wouldRead: 28500,
    saved: 26500,
    filesSkipped: 5,
  })
  expect(savedPct(both)).toBe(93) // 26500 / 28500 = 93.0%
  expect(mapToolOf('mcp__mapshift__map_overview')).toBe('overview')
  expect(mapToolOf('map_rename')).toBe('other')
})

test('with and without Mapshift, in money and tokens, to the cent', async () => {
  // this chat: routing saved money, the map saved tokens; priced on Opus input ($4 per million)
  const m = { usd: 1.2, baseUsd: 1.5, cacheSavedUsd: 0.4, turns: 3, tokens: 250_000, cacheRead: 200_000 }
  const s = savingsFor(m, LEDGER_STATS, mapUsd(LEDGER_STATS.saved, PRICES.opus.in))
  const cents = (v: number) => Math.round(v * 100)
  const micro = (v: number) => Math.round(v * 1e6) // millionths of a dollar: exact for these figures
  expect(cents(s.with.usd)).toBe(120)
  expect(s.with.tokens).toBe(250_000)
  expect(micro(s.without.usd)).toBe(1_567_600) // $1.50 + 16,900 × $4 / 1M = $1.5676
  expect(cents(s.without.usd)).toBe(157)
  expect(s.without.tokens).toBe(266_900)
  expect(micro(s.saved.usd)).toBe(367_600) // $0.30 switching + $0.0676 map
  expect(cents(s.saved.usd)).toBe(37)
  expect(s.saved.tokens).toBe(16_900)
  expect(cents(s.routingUsd)).toBe(30)
  expect(micro(s.map.usd!)).toBe(67_600)
  expect(cents(s.cache.usd)).toBe(40) // shown, not added
  expect(s.cache.tokens).toBe(200_000)
  expect(micro(s.map.usd! + s.routingUsd)).toBe(micro(s.saved.usd)) // the rows add up to the total
  expect(moneyVerdict(s)).toBe('Saved $0.368 (23%)') // 0.3676 / 1.5676 = 23.4%
  expect(tokenVerdict(s)).toBe('16.9k tokens saved (6%)') // 16,900 / 266,900 = 6.3%
  expect(savingsLines('This chat', s, 'Opus 5.5')).toEqual([
    'This chat with Mapshift: $1.20 · 250.0k tokens',
    'This chat without Mapshift: $1.57 · 266.9k tokens (every request on Opus 5.5, no map)',
    'This chat difference: Saved $0.368 (23%) · 16.9k tokens saved (6%)',
  ])
  // stronger models for harder work cost more than the map saved: said plainly, never hidden
  const more = savingsFor({ ...m, usd: 2, baseUsd: 1.5 }, LEDGER_STATS, mapUsd(LEDGER_STATS.saved, PRICES.opus.in))
  expect(micro(more.saved.usd)).toBe(-432_400) // $1.5676 − $2.00
  expect(moneyVerdict(more)).toBe('$0.432 more, spent on stronger models for harder work')
  expect(signedUsd(more.routingUsd)).toBe('$0.500 more')
  // an app model with no known price: the map's tokens still count, its dollars are not guessed
  const unpriced = savingsFor(m, LEDGER_STATS, mapUsd(LEDGER_STATS.saved, null))
  expect(unpriced.map.usd).toBe(null)
  expect(unpriced.without.tokens).toBe(266_900)
  expect(cents(unpriced.saved.usd)).toBe(30)
  // no map log: nothing is added for the map, and nothing is invented for switching
  const noMap = savingsFor(m, null, null)
  expect(noMap.without.tokens).toBe(250_000)
  expect(cents(noMap.saved.usd)).toBe(30)
  expect(tokenVerdict(noMap)).toBe('No tokens saved')
})

test('time and status words: fixed limit colours at 64, 65 and 85 percent; plain durations', async () => {
  expect(statusColor(64)).toBe('#3fb950')
  expect(statusColor(65)).toBe('#e3b341')
  expect(statusColor(84)).toBe('#e3b341')
  expect(statusColor(85)).toBe('#f85149')
  expect(inText(2 * 3_600_000 + 10 * 60_000)).toBe('2 h 10 min')
  expect(inText(45 * 60_000)).toBe('45 min')
  expect(inText(36 * 3_600_000)).toBe('36 h')
  expect(inText(3 * 86_400_000 + 4 * 3_600_000)).toBe('3 d 4 h')
  expect(bandText({ tier: 'routine', model: 'claude-sonnet-5-5', effort: 'medium', map: { ...MAP_READY } })).toBe('Standard · Sonnet 5.5 · Medium effort · Map ready')
})

test('map lookups and file reads are counted, and the map reminder is added once while a map exists', async ($, on) => {
  const { captured, clock } = engine(on, { run: mapCli('ready') })
  on('tool.call', () => ({ result: {} }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(clock)
  await $.turn.start({ text: 'where is the login handler defined in this repo', turnId: 'm1' })
  await $.tool.call({ tool: 'mcp__mapshift__map_find', query: 'login' } as any)
  await $.tool.call({ tool: 'Read', file_path: 'C:/work/alpha/a.ts' } as any)
  await $.tool.call({ tool: 'Grep', pattern: 'login' } as any)
  await step($, 'm1', 0)
  await $.turn.complete({ turnId: 'm1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  await settle(clock)
  const stored = captured['audit:sess-1'] as any[]
  expect(stored.find(e => e.k === 'tools').map).toBe(1)
  const compose = () => $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  const ids = ((await compose()) as any).sections.map((x: any) => x.id)
  expect(ids.filter((x: string) => x === 'mapshift:map').length).toBe(1)
  const text = ((await compose()) as any).sections.find((x: any) => x.id === 'mapshift:map').text
  expect(text).toContain('map_find')
  expect(text).toContain('"impact"')
  const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 map lookup · 2 file reads/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /33% via the map/ })).toBeTruthy()
  await ui.unmount()
})

test('no map reminder when the map is not available, and the card says how to set it up', async ($, on) => {
  const { clock } = engine(on) // every command line call fails
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const composed: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)
  expect(composed.sections.some((x: any) => x.id === 'mapshift:map')).toBe(false)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui: any = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^⚪ Not available yet$/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('the Map card shows Ready, Building 40% and Not built yet', async ($, on) => {
  const answers: [string, RegExp][] = [
    ['ready', /Ready$/],
    ['building', /Building 40%$/],
    ['empty', /Not built yet$/],
  ]
  let state = 'ready'
  const { clock } = engine(on, { run: argv => mapCli(state)(argv) })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  for (const [s, mark] of answers) {
    state = s
    await $.turn.start({ text: 'what does this do', turnId: `ms-${s}` })
    await step($, `ms-${s}`, 0)
    await $.turn.complete({ turnId: `ms-${s}`, answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
    await settle(clock)
    const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: mark })).toBeTruthy()
    if (s === 'ready') expect(await ui.find({ type: 'Text', text: /412 files · 3,120 definitions · 8,450 call links/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('programs never start inside the project, so a project cannot plant its own git or mapshift', async ($, on) => {
  const { clock, runs } = engine(on, { run: mapCli('ready', { tier: 'complex', reasons: ['x'] }) })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(clock)
  await $.turn.start({ text: 'add a unit test for parseDate in src/date.ts', turnId: 'p1' })
  await step($, 'p1', 0)
  expect(runs.length > 0).toBe(true)
  for (const r of runs) {
    expect(String(r.init.cwd ?? '').toLowerCase().startsWith('c:/work/alpha')).toBe(false)
    expect(r.init.cwd === undefined).toBe(false)
  }
  const git = runs.find(r => r.argv[0] === 'git')
  if (git) expect(git.argv.slice(1, 3)).toEqual(['-C', 'C:/work/alpha'])
  for (const r of runs.filter(x => x.argv.includes('route') || x.argv.includes('status'))) {
    expect(r.argv[r.argv.indexOf('--project') + 1]).toBe('C:/work/alpha')
  }
})

test('limit stretch: where a limit would be without Mapshift, and how much longer it lasts at this pace', async () => {
  const H = 3_600_000
  // 5-hour window, 2 h gone, 40% used, today cost 0.6 of what it would have: without, 66.7% at the same work
  const s = stretch({ pct: 40, resetsAt: NOW + 3 * H }, 5 * H, 0.6, NOW)!
  expect(Math.round(s.withoutPct * 10) / 10).toBe(66.7)
  expect(Math.round(s.kept * 10) / 10).toBe(26.7)
  // with Mapshift: 20%/h, lasts 3 h (past the reset, so capped at the 3 h left); without: 33.3%/h, lasts 1 h
  expect(Math.round(s.extraMs! / 60_000)).toBe(120)
  // neither runs out before the reset: only the share kept free counts
  const calm = stretch({ pct: 10, resetsAt: NOW + 3 * H }, 5 * H, 0.6, NOW)!
  expect(calm.extraMs).toBe(null)
  // nothing saved, or more spent on stronger models: nothing to claim
  expect(stretch({ pct: 40, resetsAt: NOW + 3 * H }, 5 * H, 1, NOW)).toBe(null)
  expect(stretch({ pct: 40, resetsAt: NOW + 3 * H }, 5 * H, 1.2, NOW)).toBe(null)
  expect(stretch({ pct: 40, resetsAt: NOW + 3 * H }, 5 * H, 0, NOW)).toBe(null)
})

test('starting points from the map are attached to a prompt, quietly, and only when there are some', async ($, on) => {
  let hint = 'Mapshift code map: likely starting points for this request.\n- saveOrder · function · src/orders.ts:3-9'
  const { clock, runs } = engine(on, { run: argv => (argv[1] === 'hint' ? { exitCode: 0, stdout: hint } : mapCli('ready')(argv)) })
  const got: any[] = []
  on('prompt.submit', (_: unknown, e: any) => {
    got.push(e)
    return { text: e.text, context: e.context }
  })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(clock)
  await $.prompt.submit({ text: 'make saveOrder reject empty carts' } as any)
  expect((got[0].context ?? []).some((c: string) => c.startsWith('Mapshift code map:'))).toBe(true)
  const asked = runs.find(r => r.argv.includes('hint'))!
  expect(asked.argv.slice(-2)).toEqual(['--', 'make saveOrder reject empty carts'])
  expect(asked.init.timeoutMs).toBe(1500)
  expect(String(asked.init.cwd).toLowerCase().startsWith('c:/work/alpha')).toBe(false)
  hint = '' // the map has nothing clear to say: nothing is attached
  await $.prompt.submit({ text: 'thanks, that looks good now' } as any)
  expect(got[1].context ?? []).toEqual([])
  // model switching Off: the map is its own feature and keeps working
  hint = 'Mapshift code map: likely starting points for this request.\n- saveOrder · function · src/orders.ts:3-9'
  await $.command.run({ command: 'mapshift', args: 'off' } as any)
  await $.prompt.submit({ text: 'make saveOrder reject empty carts' } as any)
  expect((got[2].context ?? []).some((c: string) => c.startsWith('Mapshift code map:'))).toBe(true)
  // the map turned off on its own: nothing attached
  await $.command.run({ command: 'mapshift', args: 'map off' } as any)
  await $.prompt.submit({ text: 'make saveOrder reject empty carts' } as any)
  expect(got[3].context ?? []).toEqual([])
})

test('a map signal raises the level: more thinking effort, and the reason is logged', async ($, on) => {
  const { seen, captured, clock, runs } = engine(on, { run: mapCli('ready', { tier: 'complex', reasons: ['The map shows the change reaches 14 callers in 6 files'] }) })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(clock)
  await $.turn.start({ text: 'add a unit test for parseDate in src/date.ts', turnId: 'r1' })
  await step($, 'r1', 0)
  const route = runs.find(r => r.argv.includes('route'))!
  expect(route.init.timeoutMs).toBe(1500)
  expect(route.argv[route.argv.length - 2]).toBe('--')
  await $.turn.complete({ turnId: 'r1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  const ev = (captured['audit:sess-1'] as any[]).find(e => e.k === 'prompt')
  expect(ev.scored).toBe('routine')
  expect(ev.tier).toBe('complex')
  expect(ev.map.raised).toBe(true)
  expect(ev.reasons).toContain('The map shows')
  expect(seen[0]!.effort).toBe('high') // Complex work thinks harder than the Medium it would have had
})

test('a map signal never lowers the level, and a failed or timed-out check leaves routing unchanged', async ($, on) => {
  let mode: 'lower' | 'timeout' | 'garbage' = 'lower'
  const { seen, captured, clock } = engine(on, {
    run: argv => {
      if (argv.includes('route')) {
        if (mode === 'timeout') return { deny: 'process timed out after 1500 ms' }
        if (mode === 'garbage') return { exitCode: 0, stdout: 'Routing advice: Quick' }
        return { exitCode: 0, stdout: JSON.stringify({ tier: 'trivial', reasons: ['looks small'] }) }
      }
      return mapCli('ready')(argv)
    },
  })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const modes = ['lower', 'timeout', 'garbage'] as const
  for (const [i, m] of modes.entries()) {
    mode = m
    await $.turn.start({ text: 'Refactor the auth module to fix an intermittent race condition in src/auth.ts and migrate the schema', turnId: `n${i}` })
    await step($, `n${i}`, 0)
    await $.turn.complete({ turnId: `n${i}`, answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  }
  const prompts = (captured['audit:sess-1'] as any[]).filter(e => e.k === 'prompt')
  expect(prompts.length).toBe(3)
  for (const p of prompts) expect(p.tier).toBe(p.scored) // the local score stands every time
  expect(prompts[0].map.raised).toBe(false)
  expect(prompts[1].map.failed).toBe('timeout')
  expect(prompts[2].map.failed).toBe('unreadable answer')
  expect(seen[0]!.effort).toBe(seen[1]!.effort)
  expect(seen[1]!.effort).toBe(seen[2]!.effort)
})

test('limit bars use the fixed colours at 64%, 65% and 85% on the terminal and on graphical surfaces', async ($, on) => {
  const { clock } = engine(on)
  void clock
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { tokens: 1000, window: 1_000_000, percent: 1 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 64, resetsAt: new Date(NOW + 2 * 3_600_000 + 10 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 65, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
      { kind: 'seven_day_opus', percentUsed: 85, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
    ],
    changed: ['rateLimits'],
  } as any)
  const term: any = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 80 } })
  expect((await term.find({ type: 'Text', text: /^\s*64%$/ }))?.props.color).toBe(STATUS.ok)
  expect((await term.find({ type: 'Text', text: /^\s*65%$/ }))?.props.color).toBe(STATUS.warn)
  expect((await term.find({ type: 'Text', text: /^\s*85%$/ }))?.props.color).toBe(STATUS.bad)
  expect(await term.find({ type: 'Text', text: /resets in 2 h 10 min/ })).toBeTruthy()
  await term.unmount()
  const desk: any = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const drawn = JSON.stringify(await desk.drawn())
  expect(drawn.includes('fill=\\"#3fb950\\">64%')).toBe(true)
  expect(drawn.includes('fill=\\"#e3b341\\">65%')).toBe(true)
  expect(drawn.includes('fill=\\"#f85149\\">85%')).toBe(true)
  await desk.unmount()
})

test('the Health card appears only when something is wrong', async ($, on) => {
  await fill($, on)
  const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Health$/ })).toBeUndefined()
  await ui.unmount()
})

test('projects: one folder is one key whatever the slashes or case', async () => {
  expect(projectKey('C:\\Users\\Me\\Proj\\')).toBe(projectKey('c:/users/me/proj'))
})

// ------------------------------------------------------------------ the real hooks, the engine mocked beneath

type RunAnswer = { exitCode: number; stdout: string } | { deny: string } | undefined
type Run = (argv: string[]) => RunAnswer

const MAP_READY: MapInfo = { available: true, state: 'ready', percent: 100, files: 412, symbols: 3120, links: 8450, languages: [], builtAt: NOW, checkedAt: NOW, lookups: 0, fileReads: 0, statsSession: null, statsToday: null, usdSession: null, usdToday: null }

function statusJson(state: string) {
  return JSON.stringify({
    root: 'C:/work/alpha',
    state,
    percent: state === 'building' ? 40 : state === 'ready' ? 100 : 0,
    files: state === 'empty' ? 0 : 412,
    symbols: state === 'empty' ? 0 : 3120,
    links: state === 'empty' ? 0 : 8450,
    skipped: 0,
    builtAt: state === 'empty' ? null : NOW - 5 * 60_000,
    languages: state === 'empty' ? [] : [{ label: 'TypeScript', n: 380 }, { label: 'Python', n: 32 }],
  })
}

/** A fake mapshift command line: `map status` answers with the given state, `route` with the given advice. */
function mapCli(state: string, route?: { tier: string; reasons: string[] }): Run {
  return argv => {
    if (argv[0] !== 'mapshift') return { exitCode: 1, stdout: '' }
    if (argv[1] === 'map' && argv[2] === 'status') return { exitCode: 0, stdout: statusJson(state) }
    if (argv[1] === 'route') return { exitCode: 0, stdout: JSON.stringify({ tier: 'routine', model: 'claude-sonnet-5-5', effort: 'medium', change: 'none', helper: 'claude-haiku-5-5', map: null, ...(route ?? { reasons: ['An everyday request'] }) }) }
    return { exitCode: 1, stdout: '' }
  }
}

/** Lets work the hooks started without awaiting (the map check at session start) finish. */
async function settle(clock: { advance: (ms: number) => Promise<void> }) {
  for (let i = 0; i < 40; i++) await clock.advance(1)
}

function engine(on: any, opts: { root?: string; store?: Record<string, unknown>; answer?: (sent: string) => string; fsList?: unknown[]; busy?: number; run?: Run; env?: Record<string, string>; files?: Record<string, string> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  // an in-memory store the test can read back
  const captured: Record<string, unknown> = { ...(opts.store ?? {}) }
  let busy = opts.busy ?? 0 // how many saves find the store locked by another chat first
  on('store.get', (_: unknown, e: any) => ({ value: captured[e.key] }))
  on('store.set', (_: unknown, e: any) => {
    if (busy > 0) {
      busy--
      return { deny: 'Lock file is already being held' }
    }
    captured[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: any) => {
    delete captured[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(captured) }))
  on('env.get', (_: unknown, e: any) => ({ value: opts.env?.[e.name] }))
  const seen: { model: string; effort?: unknown; agent?: string }[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: opts.root ?? 'C:/work/alpha' }))
  on('session.version', () => ({ value: { version: '2.1.325', base: '2.1.325' } }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.notify', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mapshift' } }))
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { plugin: 'engine', tier: 'core' } }] }))
  const runs: { argv: string[]; init: any }[] = []
  on('process.run', (_: unknown, e: any) => {
    runs.push({ argv: [...e.argv], init: e.init ?? {} })
    const r = opts.run?.([...e.argv])
    if (r && 'deny' in r) return { deny: r.deny }
    return { value: { exitCode: r?.exitCode ?? 1, stdout: r?.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', () => ({ value: opts.fsList ?? [] }))
  const reads: string[] = []
  // the engine hands hooks the resolved path (backslashes on Windows): compare one spelling
  const norm = (x: string) => x.split(String.fromCharCode(92)).join('/').toLowerCase()
  on('fs.read', (_: unknown, e: any) => {
    reads.push(e.path)
    const hit = Object.entries(opts.files ?? {}).find(([k]) => norm(k) === norm(e.path))
    return hit ? { value: hit[1] } : { deny: 'ENOENT: no such file' }
  })
  on('fs.write', () => ({ value: undefined }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'aborted' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('turn.step', async function* (_: unknown, e: any) {
    seen.push({ model: e.model, effort: e.effort, agent: e.agentId })
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 500, model: opts.answer ? opts.answer(e.model) : e.model === 'opus' ? 'claude-opus-5-5' : e.model },
    }
  })
  return { clock, seen, captured, toasts, runs, reads, setBusy: (n: number) => void (busy = n) }
}

async function step($: any, turnId: string, index: number, extra: Record<string, unknown> = {}) {
  const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'medium', messageCount: 3 + index, ...extra })
  for await (const _ of s) void _
  return s.result
}

test('one plan is applied identically on every step of a turn; subagent steps are untouched', async ($, on) => {
  const { seen } = engine(on)
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Refactor the auth module to fix an intermittent race condition in src/auth.ts and migrate the schema', turnId: 't1' })
  for (const i of [0, 1, 2]) await step($, 't1', i)
  expect(seen.length).toBe(3)
  for (const s of seen) {
    expect(s.model).toBe('claude-opus-5-5')
    expect(s.effort === 'high' || s.effort === 'xhigh').toBe(true)
  }
  expect(seen[0]!.effort).toBe(seen[2]!.effort)
  await step($, 'tsub', 0, { agentId: 'a1' })
  expect(seen[3]!.effort).toBe('medium')
})

test('with no plan the engine request passes through unchanged', async ($, on) => {
  const { seen } = engine(on)
  await step($, 'unplanned', 0)
  expect(seen[0]!.model).toBe('claude-opus-5-5')
  expect(seen[0]!.effort).toBe('medium')
})

test('Off in one project leaves the request untouched; another project still starts on Auto', async ($, on) => {
  const { seen } = engine(on, { store: { projects: { [projectKey('C:/work/alpha')]: { mode: 'off', lockModel: 'opus', lockEffort: 'medium', at: 1 } } } })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Refactor the auth module and migrate the schema across services', turnId: 'p1' })
  await step($, 'p1', 0)
  expect(seen[0]!.effort).toBe('medium') // Off: the app's own settings
})

// ------------------------------------------------------------------ the pane and band, filled through the real hooks

const PANE = {
  plugin: 'mapshift',
  component: 'Pane',
  requestId: 'mapshift',
  props: { title: 'Mapshift', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

async function fill($: any, on: any) {
  const env = engine(on, { run: mapCli('ready') })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(env.clock)
  const day = 24 * 3_600_000
  await $.session.measure({
    context: { tokens: 120_000, window: 1_000_000, percent: 12 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 22, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 93, resetsAt: new Date(NOW + 1.5 * day).toISOString() },
    ],
    cost: { usd: 1.25 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  await $.turn.start({ text: 'Refactor the payments module and deploy to production', turnId: 'f1' })
  await step($, 'f1', 0)
  await step($, 'f1', 1)
  await $.turn.complete({ turnId: 'f1', answer: 'done', durationMs: 4000, isAborted: false, reason: 'answer' })
  await settle(env.clock)
  return env
}

test('the pane draws every tab on every surface, clean Overview first', async ($, on) => {
  await fill($, on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui: any = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^🗺️ Mapshift$/ }))?.text).toBeTruthy()
    for (const title of [/^🎯 Right now$/, /^⏱️ Limits$/, /^💸 Savings$/, /^🗺️ Map$/]) expect(await ui.find({ type: 'Text', text: title })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^(Quick|Standard|Complex|Critical)$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^💭 Thinking$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Estimates$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^♻️ Cache$/ })).toBeTruthy()
    // the detail lives on Activity, not on the Overview
    expect(await ui.find({ type: 'Text', text: /^Steps$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Health$/ })).toBeUndefined()
    const expectations: [string, RegExp][] = [
      ['tab-activity', /Requests/],
      ['tab-settings', /Separate from model switching/],
      ['tab-help', /30 seconds/],
      ['tab-overview', /💭 Thinking/],
    ]
    for (const [tab, mark] of expectations) {
      await ui.press({ key: tab })
      const drawn = JSON.stringify(await ui.drawn())
      expect(mark.test(drawn)).toBe(true)
    }
    await ui.unmount()
  }
})

test('terminal shows limits as text bars; graphical surfaces draw them', async ($, on) => {
  await fill($, on)
  const term: any = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /Weekly/ })).toBeTruthy()
  expect(await term.find({ type: 'Text', text: /resets in/ })).toBeTruthy()
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  await term.unmount()
  const desk: any = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Svg' })).toBeTruthy()
  await desk.unmount()
})

test('a narrow pane stacks labels above values instead of squeezing them', async ($, on) => {
  await fill($, on)
  const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 34 } })
  expect(await ui.find({ type: 'Text', text: /^💭 Thinking$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^🗺️ Map$/ })).toBeTruthy()
  await ui.unmount()
})

test('the band is one short line and fits narrow windows', async ($, on) => {
  await fill($, on)
  for (const bodyColumns of [160, 60, 30]) {
    const ui: any = await $.ui.mount({ plugin: 'mapshift', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 1, bodyColumns, scroll: { offset: 0, bodyRows: 1 }, view: {} }, surface: 'desktop' })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.includes('Mapshift')).toBe(true)
    if (bodyColumns >= 160) {
      expect(/"(Quick|Standard|Complex|Critical)"/.test(drawn)).toBe(true)
      expect(drawn.includes('effort')).toBe(true)
      expect(drawn.includes('Map ready')).toBe(true)
      expect(drawn.includes('Weekly 93%')).toBe(true) // a limit that needs attention
      expect(drawn.includes('5-hour')).toBe(false) // one that does not stays out
    }
    await ui.unmount()
  }
})

test('the map reminder stays put once added, even if a later status check fails', async ($, on) => {
  let up = true
  const { clock } = engine(on, { run: argv => (up ? mapCli('ready')(argv) : { exitCode: 1, stdout: '' }) })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const compose = async () => ((await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any)) as any).sections.filter((x: any) => x.id === 'mapshift:map').length
  expect(await compose()).toBe(1)
  up = false
  await $.turn.start({ text: 'what does this do', turnId: 'st1' })
  await step($, 'st1', 0)
  await $.turn.complete({ turnId: 'st1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  await settle(clock)
  expect(await compose()).toBe(1)
  const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Ready$/ })).toBeTruthy() // the last good picture stays
  await ui.unmount()
})

test('MAPSHIFT_BIN pointing at a script runs it with node', async ($, on) => {
  const bin = 'C:/dev/mapshift/src/cli/main.ts'
  const { clock, runs } = engine(on, { env: { MAPSHIFT_BIN: bin }, run: argv => (argv[0] === 'node' && argv[1] === bin ? mapCli('ready')(['mapshift', ...argv.slice(2)]) : { exitCode: 1, stdout: '' }) })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(clock)
  expect(runs.some(r => r.argv.join(' ') === `node ${bin} map status --json --project C:/work/alpha`)).toBe(true)
  expect(runs.find(r => r.argv.includes('status'))!.init.cwd).toBe('C:/') // never the project folder
  const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Ready$/ })).toBeTruthy()
  await ui.unmount()
})

test('map savings come from the map log for this project and session, and show on the Savings card', async ($, on) => {
  const day = new Date(NOW).toISOString().slice(0, 10)
  const ledger = [
    { kind: 'map', ts: NOW + 1000, agent: 'claude-code', repo: 'C:/work/alpha', tool: 'map_find', answerTokens: 300, files: [{ path: 'src/a.ts', tokens: 2000 }, { path: 'src/b.ts', tokens: 1000 }] },
    { kind: 'map', ts: NOW + 1000, agent: 'claude-code', repo: 'C:/work/beta', tool: 'map_find', answerTokens: 300, files: [{ path: 'src/z.ts', tokens: 9000 }] },
  ]
  const { clock } = engine(on, {
    run: mapCli('ready'),
    env: { USERPROFILE: ['C:', 'Users', 'me'].join(String.fromCharCode(92)) }, // a Windows home: C:\Users\me
    files: { [`C:/Users/me/.mapshift/logs/${day}.jsonl`]: ledger.map(x => JSON.stringify(x)).join('\n') },
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(clock)
  await $.turn.start({ text: 'where is the cart total computed', turnId: 'sv1' })
  await $.tool.call({ tool: 'mcp__mapshift__map_find', query: 'cart total' } as any)
  await $.tool.call({ tool: 'Read', file_path: 'C:/work/alpha/src/b.ts' } as any) // read anyway: no credit for b.ts
  await step($, 'sv1', 0)
  await $.turn.complete({ turnId: 'sv1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  await settle(clock)
  const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1\.7k tokens/ })).toBeTruthy()
  await ui.unmount()
})

// ------------------------------------------------------------------ every displayed number, from fixture logs

const LOCAL_DAY = new Date(NOW).toLocaleDateString('en-CA') // the day totals are kept under
const UTC_DAY = new Date(NOW).toISOString().slice(0, 10) // the day the map names its log after
const HOME = ['C:', 'Users', 'me'].join(String.fromCharCode(92)) // a Windows home: C:\Users\me
/** Earlier today, before this chat: 4 requests, routing spent $0.50 more than Opus alone would have. */
const EARLIER_TODAY = { usd: 2, baseUsd: 1.5, cacheSavedUsd: 0.5, turns: 4, tokens: 400_000, cacheRead: 300_000 }

/**
 * One chat in C:/work/alpha: five map lookups (the LEDGER), then src/b.ts read, then one request on Opus
 * (the test engine's step: 10 new, 90,000 cache read, 500 cache write, 50 out = 90,560 tokens,
 * $0.02304 at Opus list prices with a 60-minute cache, $0.342 saved by the cache).
 */
async function mapChat($: any, on: any, store: Record<string, unknown>) {
  const env = engine(on, {
    run: mapCli('ready'),
    env: { USERPROFILE: HOME },
    files: { [`C:/Users/me/.mapshift/logs/${UTC_DAY}.jsonl`]: LEDGER.map(x => JSON.stringify(x)).join('\n') },
    store,
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(env.clock)
  await $.turn.start({ text: 'where is the cart total computed', turnId: 'mc1' })
  for (const tool of ['map_find', 'map_trace', 'map_file', 'map_search', 'map_overview']) await $.tool.call({ tool: `mcp__mapshift__${tool}`, query: 'cart' } as any)
  await $.tool.call({ tool: 'Read', file_path: 'C:/work/alpha/src/b.ts' } as any)
  await step($, 'mc1', 0)
  await $.turn.complete({ turnId: 'mc1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  await settle(env.clock)
  return env
}

const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

test('the Map and Savings cards show every figure, exactly, on the terminal and on graphical surfaces', async ($, on) => {
  const { captured } = await mapChat($, on, {
    totals2: { all: EARLIER_TODAY, today: EARLIER_TODAY, day: LOCAL_DAY },
    mapStats: { day: LOCAL_DAY, bySid: { 'sess-0': { stats: OTHER_CHAT, price: PRICES.opus.in } } },
  })
  // what the store keeps for today: one entry per chat
  expect(Object.keys((captured.mapStats as any).bySid).sort()).toEqual(['sess-0', 'sess-1'])
  expect((captured.mapStats as any).bySid['sess-1'].stats).toEqual(LEDGER_STATS)
  const texts = [
    '🔍 5 lookups · 📄 3 files not opened · 💚 16.9k tokens saved (91%)',
    'Find 1 · Trace 1 · File outline 1 · Overview 1 · Search 1',
    // Map card, today: this chat + the other chat (2 lookups, 9,600 saved of 10,000)
    '🔍 7 lookups · 📄 5 files not opened · 💚 26.5k tokens saved (93%)',
    'Find 3 · Trace 1 · File outline 1 · Overview 1 · Search 1 · with the map 2.0k tokens, without 28.5k tokens',
    // Savings card: with $0.02304 / 90,560 tokens; without $0.02304 + 16,900 × $4/M = $0.09064 / 107,460 tokens
    'This chat: Saved $0.068 (75%) · 16.9k tokens saved (16%)',
    // today: with $2.02304 / 490,560; without $1.52304 + 26,500 × $4/M = $1.62904 / 517,060
    'Today: $0.394 more, spent on stronger models for harder work · 26.5k tokens saved (5%)',
    'This chat',
    'Today',
    '$0.023', // with, this chat
    '90.6k tokens',
    '$0.091', // without, this chat
    '107.5k tokens',
    '$2.02', // with, today
    '490.6k tokens',
    '$1.63', // without, today
    '517.1k tokens',
    '$0.068', // map this chat (also the total)
    '16.9k tokens',
    '$0.106', // map today: (16,900 + 9,600) × $4/M
    '26.5k tokens',
    '$0', // model switching this chat: same model
    '$0.500 more', // model switching today
    'same tokens',
    '$0.342', // cache this chat
    '90.0k from cache',
    '$0.842', // cache today
    '390.0k from cache',
    '$0.394 more', // total today
  ]
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui: any = await $.ui.mount({ ...PANE, surface })
    for (const s of texts) {
      const hit = await ui.find({ type: 'Text', text: exact(s) })
      if (!hit) throw new Error(`${surface}: no text "${s}"`)
    }
    // the hook's own count in this chat: 5 map lookups, 1 Read, so 5 of 6 (83%) went through the map
    expect(await ui.find({ type: 'Text', text: /^5 map lookups · 1 file read.*83% via the map$/ })).toBeTruthy()
    const drawn = JSON.stringify(await ui.drawn())
    // the bars: with the map 1,600 tokens, without 18,500 tokens (this chat); today's money with and without
    expect(drawn.includes('With the map')).toBe(true)
    expect(drawn.includes(' 1.6k tokens')).toBe(true)
    expect(drawn.includes('18.5k tokens')).toBe(true)
    if (surface === 'desktop') {
      expect(await ui.find({ type: 'Svg', alt: 'With the map 1.6k tokens, without 18.5k tokens' })).toBeTruthy()
      expect(await ui.find({ type: 'Svg', alt: 'Today: $2.02 with Mapshift, $1.63 without' })).toBeTruthy()
    } else expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    // red is for warnings only: the cost-more line is never red
    expect(drawn.includes(STATUS.bad)).toBe(false)
    await ui.unmount()
  }
  // the terminal-only view: /mapshift status
  const out: any = await $.command.run({ command: 'mapshift', args: 'status' } as any)
  for (const line of [
    'This chat with Mapshift: $0.023 · 90.6k tokens',
    'This chat without Mapshift: $0.091 · 107.5k tokens (every request on Opus 5.5, no map)',
    'This chat difference: Saved $0.068 (75%) · 16.9k tokens saved (16%)',
    'Today with Mapshift: $2.02 · 490.6k tokens',
    'Today without Mapshift: $1.63 · 517.1k tokens (every request on Opus 5.5, no map)',
    'Today difference: $0.394 more, spent on stronger models for harder work · 26.5k tokens saved (5%)',
    'Cache (in both figures, not added): $0.342 this chat · $0.842 today',
    'Map this chat: 🔍 5 lookups · 📄 3 files not opened · 💚 16.9k tokens saved (91%)',
    '  Find 1 · Trace 1 · File outline 1 · Overview 1 · Search 1 · answers 1.6k tokens, without the map 18.5k tokens',
    'Map today: 🔍 7 lookups · 📄 5 files not opened · 💚 26.5k tokens saved (93%)',
  ])
    if (!String(out.text).split('\n').includes(line)) throw new Error(`status has no line "${line}"\n${out.text}`)
})

test('today never counts a chat twice, and a stored day that is over is dropped', async ($, on) => {
  const { clock, captured } = await mapChat($, on, { mapStats: { day: '2000-01-01', bySid: { 'sess-old': { stats: OTHER_CHAT, price: 4 } } } })
  // two more requests: each refreshes the map figures again
  for (const id of ['mc2', 'mc3']) {
    await $.turn.start({ text: 'and where is it rendered', turnId: id })
    await step($, id, 0)
    await $.turn.complete({ turnId: id, answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
    await settle(clock)
  }
  expect(Object.keys((captured.mapStats as any).bySid)).toEqual(['sess-1'])
  expect((captured.mapStats as any).day).toBe(LOCAL_DAY)
  const out: any = await $.command.run({ command: 'mapshift', args: 'status' } as any)
  const lines = String(out.text).split('\n')
  expect(lines.includes('Map this chat: 🔍 5 lookups · 📄 3 files not opened · 💚 16.9k tokens saved (91%)')).toBe(true)
  expect(lines.includes('Map today: 🔍 5 lookups · 📄 3 files not opened · 💚 16.9k tokens saved (91%)')).toBe(true)
  // three requests of 90,560 tokens; the map's 16,900 tokens are added once, not three times
  expect(lines.includes('Today with Mapshift: $0.069 · 271.7k tokens')).toBe(true)
  expect(lines.includes('Today without Mapshift: $0.137 · 288.6k tokens (every request on Opus 5.5, no map)')).toBe(true)
})

test('Help says how the numbers are counted, on every surface', async ($, on) => {
  await fill($, on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui: any = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-help' })
    const drawn = JSON.stringify(await ui.drawn())
    for (const words of ['How the numbers are counted', 'characters / 4', 'did not read it anywhere in the same chat', 'An answer that spared nothing counts against it', 'plus the map', 'list prices', 'adds each chat of the day once'])
      if (!drawn.includes(words)) throw new Error(`${surface}: Help lacks "${words}"`)
    await ui.unmount()
  }
})

test('a today saved by an older version, with money but no token counts, starts afresh', async ($, on) => {
  const { clock } = engine(on, { run: mapCli('ready'), store: { totals2: { all: { usd: 9, baseUsd: 9, cacheSavedUsd: 1, turns: 9 }, today: { usd: 5, baseUsd: 5, cacheSavedUsd: 1, turns: 5 }, day: LOCAL_DAY } } })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const out: any = await $.command.run({ command: 'mapshift', args: 'status' } as any)
  expect(String(out.text).split('\n').includes('Today with Mapshift: $0.0000 · 0 tokens')).toBe(true)
  expect(String(out.text).includes('NaN')).toBe(false)
})

test('the Health card appears when the account did not serve the model that was asked for', async ($, on) => {
  const { clock } = engine(on, { answer: () => 'claude-sonnet-5-5' })
  await $.session.start({ cwd: 'C:/work/alpha', surface: 'desktop', isInteractive: true })
  for (const id of ['h1', 'h2']) {
    await $.turn.start({ text: 'Refactor the auth module to fix an intermittent race condition in src/auth.ts and migrate the schema end to end', turnId: id })
    await step($, id, 0, { model: 'claude-sonnet-5-5' })
    await $.turn.complete({ turnId: id, answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
  }
  await settle(clock)
  const ui: any = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Health$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Opus is not served on your account/ })).toBeTruthy()
  await ui.unmount()
})

test('the reason line reads as plain words', async () => {
  expect(shortWhy(['1 file'], 'no change needed')).toBe('Touches 1 file')
  expect(shortWhy(['The map shows the change reaches 7 definitions in 5 files', 'looks small'], '')).toBe('The map shows the change reaches 7 definitions in 5 files · Looks like a small request')
  expect(shortWhy([], 'no change needed')).toBe('An everyday request')
})
