import type { Store } from '../map/store.ts'
import { scorePrompt, targetFor } from './brain.ts'
import { modelInfo, pick, RANK_OF_FAMILY, RANKS, type ModelEntry, type ProviderId, type Rank } from './catalog.ts'
import { mapLift, mapSignals, type MapSignals } from './signals.ts'
import type { Effort, Mode, Tier } from './types.ts'

const TIERS: Tier[] = ['trivial', 'routine', 'complex', 'critical']

export type Advice = {
  provider: ProviderId
  tier: Tier
  /** The model this request should run on, and how hard it should think. */
  model: ModelEntry
  effort: Effort
  /** The model the agent is on now, and whether moving is worth suggesting. */
  current: ReturnType<typeof modelInfo>
  change: 'none' | 'up' | 'down'
  /** Plain reasons, most important first. */
  reasons: string[]
  signals: MapSignals | null
  /** A cheap model for helpers (searching, summaries, test runs), for agents that can run helpers on their own model. */
  helper: ModelEntry
}

/**
 * Advice for one request, for any provider: how demanding it is (from its wording, then from how far the
 * change spreads in the map), and the provider's model and thinking effort for that level.
 */
export function advise(o: {
  text: string
  provider: ProviderId
  currentModel?: string
  mode?: Mode
  allowFrontier?: boolean
  store?: Store | null
}): Advice {
  const score = scorePrompt(o.text)
  let tier = score.tier
  const reasons = [...score.reasons]
  let signals: MapSignals | null = null
  // how far a change spreads only matters when the request changes something; a question stays a question
  if (o.store && score.edits) {
    signals = mapSignals(o.store, o.text)
    const { lift, why } = mapLift(signals)
    if (lift && why) {
      const raised = TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(tier) + lift)]!
      if (raised !== tier) {
        tier = raised
        reasons.unshift(`The map shows ${why}`)
      }
    }
  }
  const target = targetFor(tier, o.mode ?? 'auto')
  const rank: Rank = RANK_OF_FAMILY[target.family]
  const model = pick(o.provider, rank, { allowFrontier: o.allowFrontier })
  const current = o.currentModel ? modelInfo(o.currentModel) : null
  const change =
    !current || current.provider !== o.provider || current.rank === model.rank
      ? 'none'
      : RANKS.indexOf(current.rank) < RANKS.indexOf(model.rank)
        ? 'up'
        : 'down'
  return {
    provider: o.provider,
    tier,
    model,
    effort: model.efforts.includes(target.effort) ? target.effort : model.efforts[model.efforts.length - 1]!,
    current,
    change,
    reasons: reasons.length ? reasons : ['An everyday request'],
    signals,
    helper: pick(o.provider, 'light'),
  }
}
