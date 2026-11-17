// The routing brain: pure functions only (no `$`, no I/O), so every rule is unit-testable.
//
// Design rules (quality first, savings second):
//  1. Never degrade on uncertainty: unknown model, failed classifier, odd input => pass through.
//  2. Effort is the free lever on current-generation models (it keeps the prompt cache);
//     a model switch costs a full cache rewrite and a downgrade drops the earlier reasoning.
//  3. Upgrade whenever the task needs it. Downgrade only for small, safe, low-context turns
//     where the switch pays back, and never right after trouble.
//  4. Failures (tool errors, user corrections) escalate and hold for a few turns.
import type { Cfg, Effort, Family, Mode, Price, Tier } from '../types'

export const FAMILIES: Family[] = ['haiku', 'sonnet', 'opus', 'fable']
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const TIERS: Tier[] = ['trivial', 'routine', 'complex', 'critical']
export const RANK: Record<Family, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 }

export const DEFAULT_CFG: Cfg = {
  mode: 'auto',
  lockModel: 'opus',
  lockEffort: 'medium',
  classifier: true,
  allowDowngrade: true,
  subagents: true,
  allowFable: false,
  ttlMin: 60,
  band: true,
  maxSwitchUsd: 1,
  notifyLongTurns: true,
  mapReminder: true,
  respectAppEffort: true,
  view: 'overview',
}

/** List prices in USD per million tokens. ESTIMATES (from public articles, 2026-11): editable, never a bill. */
export const PRICES: Record<Family, Price> = {
  haiku: { in: 0.1, out: 0.5, read: 0.01 },
  sonnet: { in: 2, out: 10, read: 0.1 },
  opus: { in: 4, out: 20, read: 0.2 },
  fable: { in: 8, out: 40, read: 0.2 },
}

/** Rough multiplier on output (thinking) tokens per effort level; used only for estimates. */
export const EFFORT_OUT: Record<Effort, number> = { low: 0.5, medium: 1, high: 1.6, xhigh: 2.4, max: 3.4 }

export function familyOf(model: string | undefined): Family | undefined {
  const m = (model ?? '').toLowerCase()
  for (const f of FAMILIES) if (m.includes(f)) return f
  if (m.includes('mythos')) return 'fable'
  return undefined
}

export function versionOf(model: string): number | undefined {
  const m = /(?:haiku|sonnet|opus|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model)
  if (!m) return undefined
  return Number(m[1]) * 100 + Number(m[2] ?? 0)
}

/** Per the docs, changing effort keeps the prompt cache only on current-generation models. */
export function effortKeepsCache(model: string): boolean {
  const f = familyOf(model)
  const v = versionOf(model)
  if (!f || v === undefined) return false
  return f === 'fable' ? v >= 501 : v >= 505
}

export const asEffort = (x: unknown): Effort | undefined =>
  typeof x === 'string' && (EFFORTS as string[]).includes(x) ? (x as Effort) : undefined

export const bumpEffort = (e: Effort, by: number): Effort =>
  EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, EFFORTS.indexOf(e) + by))]!

export const maxEffort = (a: Effort, b: Effort): Effort => (EFFORTS.indexOf(a) >= EFFORTS.indexOf(b) ? a : b)
export const maxTier = (a: Tier, b: Tier): Tier => (TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b)

// ---------------------------------------------------------------- prompt scoring

export type RiskDomain = 'security' | 'auth' | 'data loss' | 'concurrency' | 'money & legal' | 'health & privacy'
// Risky areas are matched in context: "race condition" is concurrency, "Gmail thread" is not.
const DOMAINS: [RiskDomain, RegExp][] = [
  ['security', /\b(security (hole|issue|bug|fix|review|audit|flaw)|vulnerab\w*|exploit\w*|sql injection|injection attack|xss|csrf|sanitiz\w*|encrypt\w*|decrypt\w*|cve-\d+|leak(ed|ing)? (a |the )?(key|secret|token|credential)s?)\b/i],
  ['auth', /\b(authenticat\w*|authoriz\w*|log-?in|sign-?in|oauth|jwt|password (reset|hash\w*|storage|policy)|2fa|mfa|sso|access control|role[- ]based|permission (model|check|system)s?)\b/i],
  ['data loss', /\b(drop (table|database|column)|truncate table|data ?migration|migrat(e|ion|ing) (the |our |all )?(data|database|db|schema|tables?|users|records)|delete (all|every|the (table|database|records|users|accounts?))|delete (my |the |a |user )?accounts?|rm -rf|wipe|purge|backfill|irreversibl\w*|data loss|restore (from )?backups?)\b/i],
  ['concurrency', /\b(race conditions?|deadlocks?|concurren(t|cy) (bug|issue|access|writes?|requests?|updates?)|thread[- ]?safe\w*|multi-?thread\w*|thread pools?|mutex\w*|semaphores?|atomic (write|update|operation)s?|lock contention|parallel writes?)\b/i],
  ['money & legal', /\b(payments?|billing|invoic\w*|tax(es)?|payroll|refunds?|checkout|pricing|legal|contracts?|compliance|terms of (service|use)|licen[cs]e (key|agreement|terms)|accounting|ledger|wallet|crypto(currency)?|smart contracts?|on-?chain|trad(e|ing) (execution|orders?))\b/i],
  ['health & privacy', /\b(medical|health ?(data|records?)|patients?|diagnos\w*|privacy|pii|personal data|gdpr|hipaa|ssn)\b/i],
]
export function riskDomain(text: string): RiskDomain | null {
  for (const [d, re] of DOMAINS) if (re.test(text)) return d
  return null
}

export type Score = {
  /** A risky area the work touches. */
  domain: RiskDomain | null
  score: number
  tier: Tier
  edits: boolean
  risk: boolean
  followUp: boolean
  correction: boolean
  ambiguous: boolean
  reasons: string[]
}

const DEEP =
  /\b(architect\w*|design (a|the|an) (system|architecture|schema|api|protocol)|refactor\w*|migrat\w*|root.?cause|race condition|deadlock|memory leak|intermittent|flaky|security|vulnerab\w*|authenticat\w*|authoriz\w*|oauth|encrypt\w*|concurren\w*|performance|optimi[sz]\w*|scal(ing|ability)|threat model|schema|rollback|data loss|backward.?compat\w*|rewrite|from scratch|end.?to.?end|trade-?offs?|algorithm\w*)\b/gi
const DEEP_ANY = new RegExp(DEEP.source, 'i')
/** Hard work outside code too: analysis, research, planning, writing, design, data. */
const BROAD =
  /\b(analy[sz]\w*|evaluat\w*|research\w*|investigat\w*|business plan|financial model\w*|forecast\w*|dataset|statistic\w*|simulat\w*|roadmap|proposal|full (app|website|site|product)|curriculum|whitepaper|pitch deck|user flow|comprehensive|in-?depth|multi-?step|across (the )?(whole|entire)|every (file|page|screen)|whole (app|project|codebase))\b/gi
/** Strong asks for top quality raise the job to Complex; everyday "make sure" only nudges it. */
const QUALITY_STRONG = /\b(best of the best|production[- ]ready|bullet-?proof|enterprise[- ]grade|no mistakes|it'?s critical|mission[- ]critical|zero (bugs|downtime))\b/i
const QUALITY_SOFT = /\b(make sure|carefully|double[- ]check|thorough(ly)?|perfect(ly)?|robust|high[- ]quality|best (possible|quality|way))\b/i
const TRIVIAL =
  /\b(typo|rename|format|lint|prettier|commit message|what does|what is|what's|explain (this|the) (line|function|error)|add (a )?comment|bump|where is|which file|show me|list (the|all)|summari[sz]e)\b/i
/** Wording that signals real-world stakes, in context. */
const RISK =
  /\b((in|to|on) production|prod (db|database|data|server)|production (db|database|data|server|deploy\w*)|deploy\w* to (prod|production|live)|force[- ]?push|drop (table|database|column)|rm -rf|api[- ]?keys?|access tokens?|auth tokens?|secret keys?|private keys?|credentials?|real money|live (users|customers|data|trading))\b/i
const EDITS = /\b(implement|add|fix|change|update|create|write|build|remove|delete|refactor|migrate|rename|replace|install|configure|set up|wire|integrate|correct|adjust|tweak|style|redesign)\b/i
const UNKNOWN_CAUSE = /\b(why|not working|broken|fails?|failing|crash\w*|exception|intermittent|randomly|sometimes)\b/i
const FOLLOW_UP = /^\s*(yes|yep|yeah|ok(ay)?|go ahead|do it|continue|proceed|sure|thanks?|thank you|looks good|lgtm|next|please do|sounds good)\b/i
const CORRECTION =
  /^\s*(no\b|nope|wrong|that'?s (not|wrong)|still (not|fail|broken|doesn'?t)|doesn'?t work|didn'?t work|not working|try again|not what i|you (missed|broke|forgot))/i
const FILE = /[\w./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|json|ya?ml|toml|sql|md|css|scss|html|sh|ps1)\b/g

/** A line that looks pasted (log, stack frame, code, diff, table, JSON, path dump), not written as an ask. */
const PASTED_LINE =
  /^\s*(at\s+\S|\s{4,}\S|\t|>|[{}[\]]|"[\w$-]+"\s*:|[A-Z_]{3,}=|[-+](?![-+\s])|diff\s|@@|\$\s|PS\s|\d{1,2}:\d{2}(:\d{2})?\s|\[?\d{4}-\d{2}-\d{2}|\||<\/?[a-z][\w-]*[\s>]|(import|export|const|let|var|function|class|def|return|if|for|while)\b.*[;{(:=]\s*$|[\w./\\-]+\.(tsx?|jsx?|py|go|rs|java|json|ya?ml|css|html|md):\d+)/i

/**
 * The part of a prompt that is the actual request: code blocks and pasted lines (logs, stack traces, diffs, JSON,
 * code, tables) are set aside, and in a very long message the opening and closing (where asks live) weigh most.
 */
export function askText(text: string): { ask: string; pastedChars: number; hadTrace: boolean } {
  const t = text.trim()
  const hadTrace = /\bat .+\(.+:\d+:\d+\)|Traceback \(most recent|Exception in thread|^\s*at \S+ \(/m.test(t)
  const noBlocks = t.replace(/```[\s\S]*?```/g, ' ').replace(/<pre>[\s\S]*?<\/pre>/gi, ' ')
  const lines = noBlocks.split(/\r?\n/)
  const kept = lines.filter(l => !PASTED_LINE.test(l) && !(l.length > 400 && (l.match(/\s/g)?.length ?? 0) < l.length / 12))
  let ask = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (ask.length > 2400) ask = `${ask.slice(0, 1600)}\n${ask.slice(-700)}`
  return { ask, pastedChars: Math.max(0, t.length - ask.length), hadTrace }
}

export function scorePrompt(text: string, o: { bigRepo?: boolean } = {}): Score {
  const full = text.trim()
  const { ask: t, pastedChars, hadTrace } = askText(full)
  const reasons: string[] = []
  if (pastedChars > 400) reasons.push(`${fmtTok(pastedChars)} chars of pasted material not scored`)
  // A short "yes, go ahead" continues the current task; a "yes, and also add X" is a new request.
  const followUp = t.length < 48 && FOLLOW_UP.test(t) && !EDITS.test(t) && !DEEP_ANY.test(t)
  const correction = CORRECTION.test(t)
  const edits = EDITS.test(t)
  const domain = riskDomain(t)
  const risk = RISK.test(t) || (domain !== null && edits)
  let s = 0

  s += Math.min(1.5, t.length / 600)
  const deep = [...new Set((t.match(DEEP) ?? []).map(x => x.toLowerCase()))]
  if (deep.length) {
    s += Math.min(4, deep.length * 1.2)
    reasons.push(`hard: ${deep.slice(0, 3).join(', ')}`)
  }
  const broad = [...new Set((t.match(BROAD) ?? []).map(x => x.toLowerCase()))].filter(x => !deep.includes(x))
  if (broad.length) {
    s += Math.min(3.2, broad.length * 0.8)
    reasons.push(`substantial: ${broad.slice(0, 3).join(', ')}`)
  }
  const strongQuality = QUALITY_STRONG.test(t)
  const softQuality = !strongQuality && QUALITY_SOFT.test(t)
  if (strongQuality) {
    s += 1.2
    reasons.push('you asked for top quality')
  } else if (softQuality) s += 0.4
  const listed = (t.match(/^\s*([-*•]|\d+[.)])\s+\S/gm) ?? []).length
  if (listed >= 3) {
    s += Math.min(1.6, listed * 0.3)
    reasons.push(`${listed} points listed`)
  }
  const files = new Set(t.match(FILE) ?? [])
  if (files.size) {
    s += Math.min(1.5, files.size * 0.3)
    reasons.push(`${files.size} file${files.size > 1 ? 's' : ''}`)
  }
  const unknownCause = UNKNOWN_CAUSE.test(t)
  const evidence = hadTrace || (pastedChars > 1500 && /\b(error|exception|fail\w*|warn\w*|crash\w*)\b/i.test(full))
  if (evidence && (edits || unknownCause)) {
    s += 1.2
    reasons.push('debugging with logs or a stack trace')
  }
  if (unknownCause && (edits || evidence)) {
    s += 0.8
    reasons.push('unknown cause')
  }
  const steps = (t.match(/\b(then|after that|and also|next,|finally|first,)\b/gi) ?? []).length
  if (steps) s += Math.min(1, steps * 0.3)
  if (o.bigRepo && edits && deep.length) {
    s += 0.6
    reasons.push('large repo')
  }
  const looksSmall = TRIVIAL.test(t) && !deep.length && !broad.length && !strongQuality
  if (looksSmall) {
    s -= 1.5
    reasons.push('looks small')
  }
  if (!edits && t.length < 140 && /^(what|why|how|where|which|can|does|is)\b/i.test(t) && !deep.length && !broad.length) s -= 0.8
  if (risk) reasons.push(domain ? `${domain} area` : 'real-world stakes')
  s = Math.max(0, s)

  // Critical needs both size and genuinely hard or risky substance; volume alone tops out at Complex.
  let tier: Tier = s < 1.5 ? 'trivial' : s < 4.5 ? 'routine' : s < 8 ? 'complex' : deep.length >= 2 || domain ? 'critical' : 'complex'
  // Changing something is never "trivial" unless the wording says it is small (typo, rename, comment...).
  if (edits && tier === 'trivial' && (!looksSmall || t.length > 200 || risk)) tier = 'routine'
  if (strongQuality) tier = maxTier(tier, 'complex')
  // a bug whose cause is unknown, with logs or a trace to dig through, is real debugging work
  if (unknownCause && evidence) {
    tier = maxTier(tier, 'complex')
    reasons.push('unknown-cause bug with evidence')
  } else if (evidence) tier = maxTier(tier, 'routine')
  if (softQuality && tier === 'trivial') tier = 'routine'
  if (deep.length + broad.length >= 3 && tier !== 'critical') {
    tier = maxTier(tier, 'complex')
    reasons.push('several signs of a big job')
  }
  // a big change that also touches a risky area is critical
  if (tier === 'complex' && domain && edits && deep.length >= 2) {
    tier = 'critical'
    reasons.push('big change in a risky area')
  }
  const ambiguous = !followUp && !correction && ((s >= 3 && s <= 6) || (tier === 'trivial' && t.length > 160))
  return { score: Number(s.toFixed(2)), tier, edits, risk, followUp, correction, ambiguous, reasons, domain }
}

/** Parse "++ ", "-- ", "@opus", "!high" prefixes; returns the text with the prefix removed. */
export type Force = { tier?: Tier; family?: Family; effort?: Effort; skip?: boolean }
export function parseOverride(text: string): { text: string; force?: Force } {
  let rest = text
  const force: Force = {}
  let hit = false
  // natural overrides anywhere in the prompt: [model:opus] [effort:high]
  rest = rest.replace(/\[\s*(model|effort)\s*:\s*([a-z]+)\s*\]/gi, (all: string, k: string, v: string) => {
    const val = v.toLowerCase()
    if (k.toLowerCase() === 'model' && (FAMILIES as string[]).includes(val)) {
      force.family = val as Family
      hit = true
      return ''
    }
    if (k.toLowerCase() === 'effort' && (EFFORTS as string[]).includes(val)) {
      force.effort = val as Effort
      hit = true
      return ''
    }
    return all
  })
  if (/^\s*~\s/.test(rest)) {
    force.skip = true
    hit = true
    rest = rest.replace(/^\s*~\s*/, '')
  }
  for (let i = 0; i < 3; i++) {
    const m = /^\s*(\+\+|--|@(?:haiku|sonnet|opus|fable)|!(?:low|medium|high|xhigh|max))(?=\s|$)\s*/i.exec(rest)
    if (!m) break
    hit = true
    const tok = m[1]!.toLowerCase()
    if (tok === '++') {
      force.tier = 'critical'
      force.effort = 'max'
    } else if (tok === '--') force.tier = 'trivial'
    else if (tok.startsWith('@')) force.family = tok.slice(1) as Family
    else force.effort = tok.slice(1) as Effort
    rest = rest.slice(m[0].length)
  }
  return hit ? { text: rest.replace(/[ \t]{2,}/g, ' ').trim(), force } : { text }
}

/** Combine a heuristic tier with a classifier label. The label can only raise the tier. */
export function mergeClassifier(h: Tier, label: string | undefined): Tier {
  const l = (label ?? '').toLowerCase()
  const c: Tier | undefined = /critical|deep|hard/.test(l)
    ? 'critical'
    : /complex/.test(l)
      ? 'complex'
      : /standard|routine|medium/.test(l)
        ? 'routine'
        : /light|trivial|quick/.test(l)
          ? 'trivial'
          : undefined
  return c ? maxTier(h, c) : h
}

// ---------------------------------------------------------------- cost model

export type LedgerEntry = { at: number; tokens: number }
export type Ledger = Record<string, LedgerEntry>
export type Prices = Record<Family, Price>

const writeMult = (ttlMin: 5 | 60) => (ttlMin === 60 ? 2 : 1.25)

export function stepCost(p: Price, u: { fresh: number; read: number; wrote: number; out: number }, ttlMin: 5 | 60): number {
  return (u.fresh * p.in + u.read * p.read + u.wrote * p.in * writeMult(ttlMin) + u.out * p.out) / 1e6
}

export function isWarm(l: LedgerEntry | undefined, now: number, ttlMin: 5 | 60): boolean {
  return !!l && now - l.at < ttlMin * 60_000 * 0.9
}

/** Estimated cost of the next request on `family` with `ctx` tokens of history. */
export function nextRequestCost(a: {
  family: Family
  ctx: number
  entry?: LedgerEntry
  now: number
  ttlMin: 5 | 60
  outTok: number
  effort: Effort
  prices: Prices
}): number {
  const warm = isWarm(a.entry, a.now, a.ttlMin)
  const cached = warm ? Math.min(a.entry!.tokens, a.ctx) : 0
  return stepCost(a.prices[a.family], { fresh: 0, read: cached, wrote: a.ctx - cached, out: a.outTok * EFFORT_OUT[a.effort] }, a.ttlMin)
}

/** Steady state: the cache is warm, only a small delta is written each request. */
export function steadyCost(family: Family, ctx: number, outTok: number, effort: Effort, prices: Prices, ttlMin: 5 | 60): number {
  return stepCost(prices[family], { fresh: 0, read: ctx, wrote: 1500, out: outTok * EFFORT_OUT[effort] }, ttlMin)
}

export type Economics = { firstDelta: number; steadyDelta: number; total: number; payback: number | null }

/** delta = cost(stay) - cost(switch); positive means the switch saves money. */
export function economics(a: {
  stay: { family: Family; effort: Effort; entry?: LedgerEntry }
  to: { family: Family; effort: Effort; entry?: LedgerEntry }
  ctx: number
  now: number
  ttlMin: 5 | 60
  outTok: number
  horizon: number
  prices: Prices
}): Economics {
  const base = { ctx: a.ctx, now: a.now, ttlMin: a.ttlMin, outTok: a.outTok, prices: a.prices }
  const firstDelta =
    nextRequestCost({ ...base, ...a.stay }) - nextRequestCost({ ...base, ...a.to })
  const steadyDelta =
    steadyCost(a.stay.family, a.ctx, a.outTok, a.stay.effort, a.prices, a.ttlMin) -
    steadyCost(a.to.family, a.ctx, a.outTok, a.to.effort, a.prices, a.ttlMin)
  const total = firstDelta + Math.max(0, a.horizon - 1) * steadyDelta
  const payback = firstDelta >= 0 ? 1 : steadyDelta > 0 ? Math.ceil(-firstDelta / steadyDelta) + 1 : null
  return { firstDelta, steadyDelta, total, payback }
}

// ---------------------------------------------------------------- the decision

type Target = { family: Family; effort: Effort }

export function targetFor(tier: Tier, mode: Mode): Target {
  if (mode === 'quality') {
    return {
      trivial: { family: 'sonnet', effort: 'medium' },
      routine: { family: 'sonnet', effort: 'high' },
      complex: { family: 'opus', effort: 'xhigh' },
      critical: { family: 'opus', effort: 'max' },
    }[tier] as Target
  }
  if (mode === 'saver') {
    return {
      trivial: { family: 'haiku', effort: 'low' },
      routine: { family: 'sonnet', effort: 'medium' },
      complex: { family: 'opus', effort: 'medium' },
      critical: { family: 'opus', effort: 'high' },
    }[tier] as Target
  }
  return {
    trivial: { family: 'haiku', effort: 'low' },
    routine: { family: 'sonnet', effort: 'medium' },
    complex: { family: 'opus', effort: 'high' },
    critical: { family: 'opus', effort: 'xhigh' },
  }[tier] as Target
}

export type DecideInput = {
  cfg: Cfg
  /** The model id the engine resolved for this request (the session's own). */
  model: string
  /** The family that served the last main request (it holds the warm cache). Defaults to the session's. */
  current?: Family
  /** The effort the engine would send now, if any. */
  effort?: string | number
  tier: Tier
  edits: boolean
  risk: boolean
  force?: Force
  /** 0 normal, 1 recent trouble, 2 repeated trouble (decays over turns). */
  struggle: number
  ctxTokens: number
  ledger: Ledger
  now: number
  turnsSinceSwitch: number
  switchesRecent: number
  /** How many turns in a row (before this one) also wanted a cheaper model. */
  lowerVotes: number
  outTokAvg: number
  prices: Prices
  /** Risky domain of the prompt: gets the extended effort budget. */
  domain?: RiskDomain | null
  /** Families that were asked for but answered by another model this session: never routed to again. */
  unavailable?: Family[]
}

export type Plan = {
  /** Alias to send instead of the session's model; undefined keeps the session's model untouched. */
  model?: string
  family?: Family
  effort?: Effort
  tier: Tier
  /** True when this turn runs on a different model than the one holding the warm cache. */
  switched: boolean
  /** Estimated one-time cost (list price) of the cache rewrite this switch causes. */
  switchUsd?: number
  /** A stronger model the task deserves but which was held back by its switch price. */
  suggest?: { family: Family; usd: number }
  /** The turn wanted a cheaper model but stayed (counts toward the two-vote rule). */
  wantedLower: boolean
  reason: string
}

const HORIZON: Record<Tier, number> = { trivial: 1, routine: 3, complex: 6, critical: 8 }
const SMALL_CTX = 30_000
const COLD_CTX = 60_000
const FREE_UPGRADE_CTX = 60_000

export const switchBudget = (cfg: Cfg): number =>
  cfg.mode === 'quality' ? cfg.maxSwitchUsd * 4 : cfg.mode === 'saver' ? cfg.maxSwitchUsd / 3 : cfg.maxSwitchUsd

/** Premium of the first request on `to` over staying on `from` (what a switch costs once). */
export function switchPremium(i: { from: Family; to: Family; ctx: number; ledger: Ledger; now: number; ttlMin: 5 | 60; prices: Prices }): number {
  const base = { ctx: i.ctx, now: i.now, ttlMin: i.ttlMin, outTok: 0, effort: 'medium' as Effort, prices: i.prices }
  const toCost = nextRequestCost({ ...base, family: i.to, entry: i.ledger[i.to] })
  const stayCost = nextRequestCost({ ...base, family: i.from, entry: i.ledger[i.from] })
  return Math.max(0, toCost - stayCost)
}

export function decide(i: DecideInput): Plan {
  const session = familyOf(i.model)
  const cur = asEffort(i.effort)
  const pass = (reason: string): Plan => ({ tier: i.tier, switched: false, wantedLower: false, reason })
  if (!session || i.cfg.mode === 'off') return pass(i.cfg.mode === 'off' ? 'Routing is off' : 'Unknown model: passed through untouched')
  // A special effort mode chosen in the app (anything but the five levels, e.g. Ultracode) is the user's: hands off.
  if (typeof i.effort === 'string' && !cur) return pass(`Your app is in a special effort mode (${i.effort}): left exactly as set`)
  if (typeof i.effort === 'number') return pass('Your app sets a numeric effort budget: left exactly as set')
  // The model holding a WARM cache anchors the choice; an expired cache holds nothing, so the app's own model does.
  const anchor: Family = i.current && isWarm(i.ledger[i.current], i.now, i.cfg.ttlMin) ? i.current : session

  const why: string[] = []
  let tier = i.tier
  if (i.force?.tier) {
    tier = i.force.tier
    why.push(`you asked for ${tier === 'critical' ? 'maximum' : 'quick'}`)
  }
  const hold = i.struggle > 0
  if (hold) {
    tier = TIERS[Math.min(3, TIERS.indexOf(tier) + (i.struggle >= 2 ? 2 : 1))]!
    why.push('raised after recent trouble')
  }

  let want: Target
  const manual = i.cfg.mode === 'manual'
  if (manual) {
    want = { family: i.cfg.lockModel, effort: i.cfg.lockEffort }
    why.length = 0
    why.push('manual choice')
  } else {
    want = { ...targetFor(tier, i.cfg.mode) }
    if (i.edits && tier !== 'trivial') want.effort = maxEffort(want.effort, 'medium')
    if (i.edits && i.risk && tier !== 'trivial') {
      want.effort = maxEffort(want.effort, 'high')
      if ((tier === 'complex' || tier === 'critical') && RANK[want.family] < RANK.opus) want.family = 'opus'
      why.push('real-world stakes: at least High effort')
    }
    if (tier === 'critical' && RANK[want.family] < RANK.opus) want.family = 'opus'
    // Fable only when allowed: the setting, or the app itself set to Fable (choosing it is permission).
    const fableOk = i.cfg.allowFable || session === 'fable'
    if (fableOk && i.cfg.mode !== 'saver' && (tier === 'critical' || (i.struggle >= 2 && EFFORTS.indexOf(want.effort) >= EFFORTS.indexOf('xhigh')))) {
      want.family = 'fable'
      why.push('critical work: Fable is allowed')
    }
  }
  // Risky areas (security, auth, data loss, concurrency, money & legal, health & privacy) add one step of effort,
  // up to Extra high: Standard -> High, Complex -> Extra high. Hard work gets more effort from its level anyway.
  if (!manual && i.domain && i.edits && tier !== 'trivial') {
    const stepped = bumpEffort(want.effort, 1)
    want.effort = maxEffort(want.effort, EFFORTS.indexOf(stepped) > EFFORTS.indexOf('xhigh') ? 'xhigh' : stepped)
    if ((tier === 'complex' || tier === 'critical') && RANK[want.family] < RANK.opus) want.family = 'opus'
    why.push(`${i.domain} change: one step more effort`)
  }
  if (i.force?.family) want.family = i.force.family
  // Fail closed: a model the account did not serve is never asked for again; the app's own model stands in.
  if (i.unavailable?.includes(want.family) && want.family !== session) {
    why.push(`${cap(want.family)} is not being served on this account, so ${cap(session)} stays`)
    want.family = session
  }
  if (i.force?.effort) want.effort = i.force.effort
  const forcedModel = !!i.force?.family || manual

  let family: Family = anchor
  let effort: Effort = want.effort
  let suggest: Plan['suggest']
  let switchUsd: number | undefined
  let wantedLower = false
  const premiumTo = (to: Family) =>
    switchPremium({ from: anchor, to, ctx: i.ctxTokens, ledger: i.ledger, now: i.now, ttlMin: i.cfg.ttlMin, prices: i.prices })

  if (RANK[want.family] > RANK[anchor]) {
    // upgrade: free when small or forced; priced when the context is large
    const premium = premiumTo(want.family)
    if (forcedModel || i.ctxTokens < FREE_UPGRADE_CTX || premium <= switchBudget(i.cfg) || (hold && tier === 'critical')) {
      family = want.family
      switchUsd = premium
      why.push(`needs ${cap(want.family)}`)
    } else {
      suggest = { family: want.family, usd: premium }
      effort = bumpEffort(maxEffort(want.effort, 'high'), 1)
      why.push(`${cap(want.family)} recommended; switching now rewrites ${Math.round(i.ctxTokens / 1000)}k cached tokens (about ${fmtUsd(premium)}), so effort was raised instead`)
    }
  } else if (RANK[want.family] < RANK[anchor]) {
    // downgrade, including a return to the session model: every gate must pass
    wantedLower = true
    if (forcedModel) {
      family = want.family
      switchUsd = premiumTo(want.family)
    } else {
      const anchorWarm = isWarm(i.ledger[anchor], i.now, i.cfg.ttlMin)
      // Going back to a model whose own cache still holds most of this conversation costs almost nothing.
      const target = i.ledger[want.family]
      const targetWarm = isWarm(target, i.now, i.cfg.ttlMin) && !!target && target.tokens >= 0.8 * i.ctxTokens
      const roomy = targetWarm || i.ctxTokens < (anchorWarm ? SMALL_CTX : COLD_CTX)
      const eco = economics({
        stay: { family: anchor, effort: cur ?? 'medium', entry: i.ledger[anchor] },
        to: { family: want.family, effort: want.effort, entry: i.ledger[want.family] },
        ctx: i.ctxTokens,
        now: i.now,
        ttlMin: i.cfg.ttlMin,
        outTok: i.outTokAvg,
        horizon: HORIZON[tier],
        prices: i.prices,
      })
      const blockers: string[] = []
      if (!i.cfg.allowDowngrade) blockers.push('cheaper models are turned off')
      if (i.cfg.mode === 'quality') blockers.push('Quality mode')
      if (!(tier === 'trivial' || tier === 'routine')) blockers.push('the task is not small')
      if (i.risk) blockers.push('risky wording')
      if (hold) blockers.push('recent trouble')
      if (i.turnsSinceSwitch < 2 || i.switchesRecent >= 3) blockers.push('switched recently')
      if (i.lowerVotes < 1) blockers.push('waiting for a second small turn')
      if (!roomy) blockers.push(`${Math.round(i.ctxTokens / 1000)}k tokens are cached on ${cap(anchor)}`)
      if (!(eco.total > 0.01 && eco.payback !== null && eco.payback <= HORIZON[tier])) blockers.push('the switch would not pay back')
      if (blockers.length === 0) {
        family = want.family
        switchUsd = Math.max(0, -eco.firstDelta)
        why.push(`cheaper ${cap(want.family)} pays back`)
      } else {
        why.push(`stayed on ${cap(anchor)}: ${blockers[0]}`)
      }
    }
  }

  // Quality first: in Auto and Quality, real work never thinks less than the effort you chose in the app.
  if (i.cfg.respectAppEffort && cur && !manual && !i.force?.effort && i.cfg.mode !== 'saver' && !(tier === 'trivial' && !i.edits)) {
    if (EFFORTS.indexOf(effort) < EFFORTS.indexOf(cur)) {
      effort = cur
      why.push('kept your app effort as the minimum')
    }
  }
  const switched = family !== anchor
  if (!switched && cur && effort !== cur && !effortKeepsCache(i.model)) {
    const warm = isWarm(i.ledger[anchor], i.now, i.cfg.ttlMin)
    const raising = EFFORTS.indexOf(effort) > EFFORTS.indexOf(cur)
    if (warm && i.ctxTokens > 20_000 && !raising && !i.force?.effort && !manual) {
      effort = cur
      why.push('kept effort: lowering it would drop the cache on this older model')
    }
  }
  return {
    model: family !== session ? family : undefined,
    family,
    effort: cur === effort ? undefined : effort,
    tier,
    switched,
    switchUsd,
    suggest,
    wantedLower,
    reason: why.join('; ') || 'no change needed',
  }
}

/**
 * How much bigger the turn turned out than its prompt suggested: 1 for a real job, 2 for a large one.
 * Measured from what actually happened (files edited, tool calls, model requests), not from the wording.
 */
export function growth(w: { editedFiles: number; tools: number; steps: number }): 0 | 1 | 2 {
  if (w.editedFiles >= 8 || w.tools >= 40 || w.steps >= 30) return 2
  if (w.editedFiles >= 3 || w.tools >= 15 || w.steps >= 12) return 1
  return 0
}

/** Raise effort by `by` steps, never past Extra high (Max stays for explicit asks and repeated trouble). */
export function growEffort(e: Effort | undefined, by: number): Effort | undefined {
  if (!e || by <= 0 || EFFORTS.indexOf(e) >= EFFORTS.indexOf('xhigh')) return e
  const up = bumpEffort(e, by)
  return EFFORTS.indexOf(up) > EFFORTS.indexOf('xhigh') ? 'xhigh' : up
}

/** In-turn escalation: repeated tool errors raise effort one rung (free on current models). */
export function escalateEffort(e: Effort | undefined, errors: number): Effort | undefined {
  if (!e || errors < 3) return e
  return bumpEffort(e, errors >= 6 ? 2 : 1)
}

/**
 * Model for a helper (subagent). Helpers start with their own small context, so any model costs no cache rewrite:
 * this is where cheaper models are used freely, and where hard work gets a stronger model than the chat.
 *   lookups and searches            -> Haiku   (Sonnet in Quality mode)
 *   read-only analysis and reviews  -> Sonnet
 *   ordinary edits                  -> Sonnet  (left to the chat's model in Quality mode)
 *   planning, complex or risky work -> Opus
 *   critical work                   -> Fable when allowed, else Opus
 * Never overrides a model Claude named, a custom agent's own pick, forks, Manual or Off.
 */
export function subagentModel(
  cfg: Cfg,
  s: { subagentType: string; description: string; prompt: string; model?: string; parentModel: string; builtIn?: boolean },
): string | undefined {
  return subagentPlan(cfg, s).model
}

export function subagentPlan(
  cfg: Cfg,
  s: { subagentType: string; description: string; prompt: string; model?: string; parentModel: string; builtIn?: boolean },
): { model?: string; why: string } {
  if (!cfg.subagents) return { why: 'helper routing is off' }
  if (cfg.mode === 'manual' || cfg.mode === 'off') return { why: `mode ${cfg.mode}` }
  if (s.model) return { why: 'Claude named a model' }
  if (s.builtIn === false) return { why: 'custom agent keeps its own model' }
  if (/^fork$/i.test(s.subagentType)) return { why: 'forks share the chat' }
  const parent = familyOf(s.parentModel)
  const text = `${s.description}\n${s.prompt}`
  const sc = scorePrompt(text)
  const fableOk = cfg.allowFable || parent === 'fable'
  const readOnly = !sc.edits && (/^(explore|search|research)$/i.test(s.subagentType) || /\b(find|search|locate|list|look ?up|grep|where|which files?)\b/i.test(text))
  const analysis = !sc.edits && /\b(review|analy[sz]\w*|summari[sz]\w*|compare|explain|audit|assess|evaluate|read)\b/i.test(text)
  let fam: Family
  let why: string
  if (sc.tier === 'critical') {
    fam = fableOk && cfg.mode !== 'saver' ? 'fable' : 'opus'
    why = 'critical helper task'
  } else if (/^plan$/i.test(s.subagentType) || sc.tier === 'complex' || sc.risk || sc.domain) {
    fam = 'opus'
    why = sc.domain ? `${sc.domain} work` : /^plan$/i.test(s.subagentType) ? 'planning' : 'complex helper task'
  } else if (readOnly && !analysis && sc.tier === 'trivial') {
    fam = cfg.mode === 'quality' ? 'sonnet' : 'haiku'
    why = 'lookup or search'
  } else if (readOnly || analysis) {
    fam = 'sonnet'
    why = 'read-only analysis'
  } else {
    if (cfg.mode === 'quality') return { why: 'Quality mode: ordinary edits keep the chat model' }
    fam = 'sonnet'
    why = 'ordinary edits'
  }
  if ((readOnly || analysis) && !/^plan$/i.test(s.subagentType) && RANK[fam] > RANK.sonnet) {
    fam = 'sonnet'
    why = 'read-only research (the chat judges the result)'
  }
  if (cfg.mode === 'quality' && parent && RANK[fam] < RANK[parent] && fam !== 'sonnet') fam = 'sonnet'
  if (parent && fam === parent) return { why: `${why}: same as the chat` }
  return { model: fam, why }
}

export const fmtUsd = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`)
export const fmtTok = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)))
export const hitPct = (read: number, fresh: number, wrote: number): number => {
  const t = read + fresh + wrote
  return t > 0 ? Math.round((read / t) * 100) : 0
}

// ---------------------------------------------------------------- usage limits: names, resets, pace

export type RateSample = { at: number; pct: number }

export function windowName(kind: string): string {
  const k = kind.toLowerCase()
  if (k === 'five_hour') return '5-hour'
  if (k === 'seven_day') return 'Weekly'
  if (k.startsWith('seven_day_')) return `Weekly · ${cap(k.slice(10).replace(/_/g, ' '))}`
  if (k === 'spend_limit') return 'Spend limit'
  return cap(k.replace(/_/g, ' '))
}

export const cap = (s: string) => s.replace(/\b\w/g, c => c.toUpperCase())

export function durationText(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return 'now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Keep only samples of the current window (a drop in percent means the window reset). */
export function trimWindow(samples: RateSample[]): RateSample[] {
  let start = 0
  for (let i = 1; i < samples.length; i++) if (samples[i]!.pct + 0.5 < samples[i - 1]!.pct) start = i
  return samples.slice(start)
}

/** Burn rate (points per hour) over the recent samples, and where that pace lands at reset. */
export function pace(samples: RateSample[], resetsAt: number | null, now: number, lookbackMs = 6 * 3_600_000) {
  const s = trimWindow(samples).filter(x => now - x.at <= lookbackMs)
  if (s.length < 2) return { perHour: null as number | null, projected: null as number | null, hitsAt: null as number | null }
  const first = s[0]!
  const last = s[s.length - 1]!
  const hours = (last.at - first.at) / 3_600_000
  if (hours < 0.15) return { perHour: null, projected: null, hitsAt: null }
  const perHour = Math.max(0, (last.pct - first.pct) / hours)
  const left = resetsAt !== null ? Math.max(0, (resetsAt - now) / 3_600_000) : null
  const projected = left !== null ? Math.min(999, last.pct + perHour * left) : null
  const hitsAt = perHour > 0 && last.pct < 100 ? now + ((100 - last.pct) / perHour) * 3_600_000 : null
  return { perHour, projected, hitsAt: hitsAt !== null && resetsAt !== null && hitsAt > resetsAt ? null : hitsAt }
}

/** Length of a usage window, when its kind says it. */
export function windowLengthMs(kind: string): number | null {
  const k = kind.toLowerCase()
  if (k === 'five_hour') return 5 * 3_600_000
  if (k.startsWith('seven_day')) return 7 * 24 * 3_600_000
  return null
}

/**
 * Instant pace: what share of the window has passed vs. what share of the limit is used.
 * projected = used / elapsed share (linear), so it works from the first reading.
 */
export function windowPace(kind: string, pct: number, resetsAt: number | null, now: number) {
  const len = windowLengthMs(kind)
  if (len === null || resetsAt === null) return { elapsed: null as number | null, projected: null as number | null, hitsAt: null as number | null }
  const left = Math.max(0, resetsAt - now)
  const elapsed = Math.max(0, Math.min(1, 1 - left / len))
  if (elapsed < 0.04) return { elapsed, projected: null, hitsAt: null }
  const projected = Math.min(999, pct / elapsed)
  const perMs = pct / (elapsed * len)
  const hitsAt = perMs > 0 && pct < 100 ? now + (100 - pct) / perMs : null
  return { elapsed, projected, hitsAt: hitsAt !== null && hitsAt < resetsAt ? hitsAt : null }
}

/** The highest alert line a usage window just crossed (75, 90 or 100), or null. */
export function crossedLine(before: number | null, after: number): 75 | 90 | 100 | null {
  const lines = [100, 90, 75] as const
  for (const l of lines) if (after >= l && (before === null || before < l)) return l
  return null
}

/** 0 relaxed, 1 watch, 2 tight: weekly pace that would run out before the reset. */
export function limitPressure(weekly: { pct: number | null; projected: number | null }): 0 | 1 | 2 {
  if (weekly.pct === null) return 0
  if (weekly.pct >= 90 || (weekly.projected ?? 0) >= 115) return 2
  if (weekly.pct >= 75 || (weekly.projected ?? 0) >= 100) return 1
  return 0
}

// ---------------------------------------------------------------- audit: recompute everything from raw tokens

export type AuditEvent = { k: string; ts: number; [x: string]: unknown }
type StepEv = AuditEvent & { sid?: string; turn: number; i: number; sent: string; sentEffort: string; answered: string; fresh: number; read: number; wrote: number; out: number; usd: number; baseUsd: number; baseFamily: string | null; cacheSaved: number; ttlMin: 5 | 60 }
type TurnEv = AuditEvent & { sid?: string; turn: number; usd: number; baseUsd: number; cacheSaved: number; steps: number }

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 + Math.abs(b) * 1e-9

/** Check the log against itself: every dollar is recomputed from token counts and list prices. */
export type AuditStats = { requests: number; turns: number; effortChanges: number; effortKept: number; mismatches: number; errors: number; problems: number }
export function verifyAudit(events: AuditEvent[], prices: Prices): { ok: boolean; lines: string[]; problemLines: string[]; stats: AuditStats } {
  const lines: string[] = []
  let problems = 0
  const bad = (s: string) => {
    problems += 1
    lines.push(`✗ ${s}`)
  }
  const steps = events.filter(e => e.k === 'step') as StepEv[]
  const turnsEv = events.filter(e => e.k === 'turn') as TurnEv[]
  const errors = events.filter(e => e.k === 'error')

  // 1. every request's cost, base cost and cache saving, recomputed
  let stepBad = 0
  for (const s of steps) {
    const fam = familyOf(s.answered)
    const p = prices[fam ?? 'opus']
    const u = { fresh: s.fresh, read: s.read, wrote: s.wrote, out: s.out }
    const usd = stepCost(p, u, s.ttlMin)
    const base = stepCost(prices[(s.baseFamily as Family | null) ?? fam ?? 'opus'], u, s.ttlMin)
    const saved = (s.read * (p.in - p.read)) / 1e6
    if (!close(usd, s.usd) || !close(base, s.baseUsd) || !close(saved, s.cacheSaved)) {
      stepBad += 1
      if (stepBad <= 3) bad(`request #${s.turn}.${s.i}: logged ${fmtUsd(s.usd)} but tokens give ${fmtUsd(usd)}`)
    }
  }
  if (steps.length && !stepBad) lines.push(`✓ ${steps.length} requests: every cost, baseline and cache saving matches its token counts`)

  // 2. every turn equals the sum of its requests. Matched by session and turn number; rows logged before
  //    sessions were tracked (no `sid`) are only checked when their turn number is unique.
  let turnBad = 0
  let turnChecked = 0
  let turnSkipped = 0
  const legacy: Record<number, number> = {}
  for (const t of turnsEv) if (t.sid === undefined) legacy[t.turn] = (legacy[t.turn] ?? 0) + 1
  for (const t of turnsEv) {
    if (t.sid === undefined && (legacy[t.turn] ?? 0) > 1) {
      turnSkipped += 1
      continue
    }
    const mine = steps.filter(s => s.turn === t.turn && s.sid === t.sid && s.ts <= t.ts && s.ts >= t.ts - 6 * 3_600_000)
    const sum = (f: (s: StepEv) => number) => mine.reduce((a, s) => a + f(s), 0)
    if (!mine.length) continue
    turnChecked += 1
    if (!close(sum(s => s.usd), t.usd) || !close(sum(s => s.baseUsd), t.baseUsd) || !close(sum(s => s.cacheSaved), t.cacheSaved)) {
      turnBad += 1
      if (turnBad <= 3) bad(`turn #${t.turn}: total ${fmtUsd(t.usd)} differs from its requests ${fmtUsd(sum(s => s.usd))}`)
    }
  }
  if (turnSkipped && !turnChecked) lines.push(`· ${turnSkipped} older turns skipped: logged before sessions were tracked (turn numbers repeat across sessions)`)
  if (turnChecked && !turnBad) lines.push(`✓ ${turnChecked} turns: each total equals the sum of its requests${turnSkipped ? ` (${turnSkipped} older turns skipped: logged before sessions were tracked)` : ''}`)

  // 3. asked vs answered
  const mism = steps.filter(s => familyOf(s.sent) && familyOf(s.answered) && familyOf(s.sent) !== familyOf(s.answered))
  if (mism.length) bad(`${mism.length} requests were answered by a different model than requested (first: asked ${mism[0]!.sent}, got ${mism[0]!.answered})`)
  else if (steps.length) lines.push('✓ every request was answered by the model Mapshift sent')

  // 4. evidence that an effort-only change keeps the cache
  let effortChanges = 0
  let kept = 0
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1]!
    const b = steps[i]!
    if (familyOf(a.answered) === familyOf(b.answered) && a.sentEffort !== b.sentEffort && b.ts - a.ts < 50 * 60_000) {
      effortChanges += 1
      if (b.read >= 0.8 * (b.read + b.fresh + b.wrote)) kept += 1
    }
  }
  if (effortChanges) {
    const line = `${kept} of ${effortChanges} effort-only changes still read ≥80% from cache`
    if (kept === effortChanges) lines.push(`✓ ${line}`)
    else bad(line)
  } else lines.push('· no effort-only change observed yet (cache-keeping claim not yet proven)')

  // 5. model switches and their real cost
  const switches = steps.filter((s, i) => i > 0 && familyOf(s.answered) !== familyOf(steps[i - 1]!.answered) && s.i === 0)
  if (switches.length) {
    const rewrite = switches.reduce((a, s) => a + s.wrote, 0)
    lines.push(`· ${switches.length} model switches wrote ${fmtTok(rewrite)} tokens to a new cache`)
  }

  // 6. our estimate vs Claude Code's own ledger (it also counts subagents and side calls, so it should be higher)
  const lastTotals = [...events].reverse().find(e => e.k === 'totals') as (AuditEvent & { sessionUsd?: number; engineUsd?: number | null }) | undefined
  if (lastTotals && typeof lastTotals.engineUsd === 'number' && typeof lastTotals.sessionUsd === 'number' && lastTotals.engineUsd > 0) {
    const ratio = lastTotals.sessionUsd / lastTotals.engineUsd
    const line = `main-chat estimate ${fmtUsd(lastTotals.sessionUsd)} vs Claude Code's session total ${fmtUsd(lastTotals.engineUsd)} (${Math.round(ratio * 100)}%)`
    if (ratio > 1.1) bad(`${line}: ours is higher than the engine's, so prices or counting are off`)
    else lines.push(`✓ ${line}; the engine's figure also includes subagents and side calls`)
  }

  const newest = events.reduce((m, e) => Math.max(m, e.ts), 0)
  const recentErrors = errors.filter(e => e.ts > newest - 6 * 3_600_000)
  if (recentErrors.length) bad(`${recentErrors.length} internal errors in the last hours (latest: ${String(recentErrors[recentErrors.length - 1]!.where)}: ${String(recentErrors[recentErrors.length - 1]!.msg)})`)
  else lines.push(errors.length ? `✓ no recent internal errors (${errors.length} older ones ignored)` : '✓ no internal errors logged')
  return {
    ok: problems === 0,
    lines,
    problemLines: lines.filter(l => l.startsWith('✗')).map(l => l.slice(2)),
    stats: { requests: steps.length, turns: turnsEv.length, effortChanges, effortKept: kept, mismatches: mism.length, errors: recentErrors.length, problems },
  }
}

/** One readable line per event for /mapshift log. */
export function formatEvent(e: AuditEvent): string {
  const t = new Date(e.ts).toISOString().slice(11, 19)
  const n = (x: unknown) => (typeof x === 'number' ? fmtTok(x) : String(x))
  switch (e.k) {
    case 'prompt':
      return `${t} prompt #${e.turn}  ${e.chars} chars  level ${e.tier} (rules said ${e.scored}, score ${e.score})  ${e.reasons ? `· ${e.reasons}` : ''}`
    case 'decision':
      return `${t} decide #${e.turn}  app ${e.appModel}/${e.appEffort} → send ${e.sendFamily}/${e.sendEffort}${e.switched ? ' (switch)' : ''}  ctx ${n(e.ctx)}  · ${e.reason}`
    case 'step':
      return `${t} request #${e.turn}.${e.i}  ${e.answered}/${e.sentEffort}  read ${n(e.read)} wrote ${n(e.wrote)} new ${n(e.fresh)} out ${n(e.out)}  ${fmtUsd(e.usd as number)}`
    case 'turn':
      return `${t} turn #${e.turn} done  ${e.steps} requests  ${fmtUsd(e.usd as number)} (session model ${fmtUsd(e.baseUsd as number)}, cache saved ${fmtUsd(e.cacheSaved as number)})  ${e.seconds}s`
    case 'limits':
      return `${t} limits  ${(e.windows as { name: string; pct: number }[]).map(w => `${w.name} ${w.pct}%`).join(' · ')}  ctx ${e.ctxPct ?? '?'}%`
    case 'subagent':
      return `${t} helper ${e.type} "${e.description}" → ${e.model}${e.routed ? ' (routed)' : ''}`
    case 'error':
      return `${t} ERROR in ${e.where}: ${e.msg}`
    default:
      return `${t} ${e.k} ${JSON.stringify({ ...e, k: undefined, ts: undefined }).slice(0, 160)}`
  }
}
