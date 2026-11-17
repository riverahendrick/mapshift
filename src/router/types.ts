/** Claude Code's model families, cheapest to strongest. Other providers map their models onto the same tiers. */
export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** How demanding a request is. */
export type Tier = 'trivial' | 'routine' | 'complex' | 'critical'
export type Mode = 'auto' | 'quality' | 'saver' | 'manual' | 'off'
export type View = 'overview' | 'activity' | 'settings' | 'help'
/** List price per million tokens: fresh input, output, and input read from the prompt cache. */
export type Price = { in: number; out: number; read: number }

export type Cfg = {
  mode: Mode
  /** Model and effort used in Manual mode. */
  lockModel: Family
  lockEffort: Effort
  /** Smart check: ask the light model about prompts the free rules find unclear (it can only raise the level). */
  classifier: boolean
  /** Let small, safe turns run on a cheaper model when it pays back. */
  allowDowngrade: boolean
  /** Send read-only research helpers (subagents) to a cheaper model. */
  subagents: boolean
  /** Let escalation reach Fable, the top model. */
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
  /** Remind the agent (one short line in its instructions) to use the map. */
  graftReminder: boolean
  /** Which tab of the pane is open. */
  view: View
}
