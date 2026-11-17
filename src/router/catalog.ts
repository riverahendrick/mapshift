import type { Effort, Family, Price } from './types.ts'

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'xai'
/** Strength ranks shared by every provider: light < standard < strong < frontier. */
export type Rank = 'light' | 'standard' | 'strong' | 'frontier'

export type ModelEntry = {
  id: string
  label: string
  provider: ProviderId
  rank: Rank
  /** List price per million tokens. */
  price: Price
  efforts: Effort[]
  /** When the price was checked against the provider's own pricing page, and where. */
  checked: string
  source: string
  /** True when the rank is a judgement call rather than the provider's own positioning. */
  rankJudged?: boolean
}

export const RANKS: Rank[] = ['light', 'standard', 'strong', 'frontier']
export const RANK_OF_FAMILY: Record<Family, Rank> = { haiku: 'light', sonnet: 'standard', opus: 'strong', fable: 'frontier' }

const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/pricing'
const OPENAI = 'https://developers.openai.com/api/docs/pricing'
const GOOGLE = 'https://aistudio.google.com/docs/pricing'
const XAI = 'https://docs.x.ai/developers/models'
const DAY = '2026-11-17'

/**
 * The models Mapshift routes between, per provider. Prices are list prices for standard requests; plans
 * and discounts change what a person actually pays, so every figure built on them is shown as an estimate.
 */
export const CATALOG: ModelEntry[] = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', provider: 'anthropic', rank: 'light', price: { in: 0.1, out: 0.5, read: 0.01 }, efforts: ALL, checked: DAY, source: ANTHROPIC },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', provider: 'anthropic', rank: 'standard', price: { in: 2, out: 10, read: 0.1 }, efforts: ALL, checked: DAY, source: ANTHROPIC },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'anthropic', rank: 'strong', price: { in: 4, out: 20, read: 0.2 }, efforts: ALL, checked: DAY, source: ANTHROPIC },
  { id: 'claude-fable-5-2', label: 'Fable 5.2', provider: 'anthropic', rank: 'frontier', price: { in: 8, out: 40, read: 0.2 }, efforts: ALL, checked: DAY, source: ANTHROPIC },

  { id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', rank: 'light', price: { in: 0.1, out: 0.5, read: 0.01 }, efforts: ALL, checked: DAY, source: OPENAI },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', provider: 'openai', rank: 'standard', price: { in: 1, out: 5, read: 0.05 }, efforts: ALL, checked: DAY, source: OPENAI },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', rank: 'strong', price: { in: 2, out: 10, read: 0.1 }, efforts: ALL, checked: DAY, source: OPENAI },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', rank: 'frontier', price: { in: 10, out: 50, read: 1 }, efforts: ALL, checked: DAY, source: OPENAI },

  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', provider: 'google', rank: 'light', price: { in: 0.3, out: 2.5, read: 0.03 }, efforts: ALL, checked: DAY, source: GOOGLE },
  { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', provider: 'google', rank: 'standard', price: { in: 1.5, out: 7.5, read: 0.075 }, efforts: ALL, checked: DAY, source: GOOGLE },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', provider: 'google', rank: 'strong', price: { in: 2, out: 10, read: 0.1 }, efforts: ALL, checked: DAY, source: GOOGLE },
  { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', provider: 'google', rank: 'frontier', price: { in: 2, out: 10, read: 0.1 }, efforts: ALL, checked: DAY, source: GOOGLE, rankJudged: true },

  { id: 'grok-4.3', label: 'Grok 4.3', provider: 'xai', rank: 'light', price: { in: 1.25, out: 2.5, read: 0.2 }, efforts: ['low', 'medium', 'high', 'xhigh'], checked: DAY, source: XAI, rankJudged: true },
  { id: 'grok-build-0.1', label: 'Grok Build', provider: 'xai', rank: 'standard', price: { in: 1, out: 2, read: 0.2 }, efforts: ['low', 'medium', 'high', 'xhigh'], checked: DAY, source: XAI, rankJudged: true },
  { id: 'grok-4.7', label: 'Grok 4.7', provider: 'xai', rank: 'strong', price: { in: 2, out: 6, read: 0.5 }, efforts: ['low', 'medium', 'high', 'xhigh'], checked: DAY, source: XAI },
]

/** Which provider serves a model, from its id. */
export function providerOf(model: string): ProviderId | null {
  const m = model.toLowerCase()
  if (/claude|haiku|sonnet|opus|fable/.test(m)) return 'anthropic'
  if (/^(gpt|o\d|codex|chatgpt)/.test(m)) return 'openai'
  if (/gemini|gemma/.test(m)) return 'google'
  if (/grok/.test(m)) return 'xai'
  return null
}

/**
 * A model the catalog does not know yet (a new release) is placed by its name, and flagged so the
 * dashboard can show it as new. Nothing is ever routed to a model the person has not used.
 */
export function guessRank(model: string): Rank {
  // whole words only: "gemini" must not read as "mini"
  const parts = new Set(model.toLowerCase().split(/[-_.\s/:[\]]+/))
  const has = (...w: string[]) => w.some(x => parts.has(x))
  if (has('nano', 'mini', 'lite', 'haiku', 'luna', 'small', 'tiny')) return 'light'
  if (has('fable', 'astra', 'ultra', 'carbon')) return 'frontier'
  if (has('opus', 'sol', 'pro', 'argon', 'large')) return 'strong'
  return 'standard'
}

export function modelInfo(model: string): (ModelEntry & { known: boolean }) | null {
  const id = model.toLowerCase().replace(/\[.*\]$/, '')
  const exact = CATALOG.find(e => e.id === id)
  if (exact) return { ...exact, known: true }
  const prefix = CATALOG.filter(e => id.startsWith(e.id)).sort((a, b) => b.id.length - a.id.length)[0]
  if (prefix) return { ...prefix, id: model, known: true }
  const provider = providerOf(model)
  if (!provider) return null
  const rank = guessRank(model)
  const sameRank = CATALOG.find(e => e.provider === provider && e.rank === rank)
  return {
    id: model,
    label: model,
    provider,
    rank,
    price: sameRank?.price ?? { in: 0, out: 0, read: 0 },
    efforts: ALL,
    checked: '',
    source: '',
    rankJudged: true,
    known: false,
  }
}

/**
 * The provider's model for a strength rank. Frontier models are only chosen when the person allows them;
 * a provider without one at a rank gets the closest rank below it.
 */
export function pick(provider: ProviderId, rank: Rank, opts: { allowFrontier?: boolean } = {}): ModelEntry {
  const wanted = rank === 'frontier' && !opts.allowFrontier ? 'strong' : rank
  for (let i = RANKS.indexOf(wanted); i >= 0; i--) {
    const hit = CATALOG.find(e => e.provider === provider && e.rank === RANKS[i])
    if (hit) return hit
  }
  return CATALOG.find(e => e.provider === provider)!
}
