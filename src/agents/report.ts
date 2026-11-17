// `mapshift report`: a compact text dashboard for chats that cannot draw panels (the `/mapshift` command
// in each agent runs it). Plain words, honest labels: an estimate is called an estimate.
import { ago, bold, dim, n, rows } from '../cli/ui.ts'
import type { Advice } from '../router/route.ts'
import { AGENT_LABEL, type AgentKey, type Snapshot } from '../dashboard/snapshot.ts'
import type { Limit } from './codex-usage.ts'

export const REPORT_AGENTS = ['codex', 'gemini', 'agy', 'grok', 'cursor', 'claude'] as const

/** A ten-cell bar for a percentage. */
export const bar = (pct: number): string => {
  const fill = Math.round(Math.max(0, Math.min(100, pct)) / 10)
  return '█'.repeat(fill) + '░'.repeat(10 - fill)
}

/** "3:40 PM (in 2 h 10 min)", or a weekday for resets more than a day away. */
export function resetText(at: number, now: number): string {
  const d = new Date(at)
  const mins = Math.max(0, Math.round((at - now) / 60_000))
  const clock = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const when = mins >= 24 * 60 ? `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${clock}` : clock
  const h = Math.floor(mins / 60)
  const m = mins % 60
  const left = mins >= 48 * 60 ? `${Math.round(mins / 1440)} days` : h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`
  return `${when} (in ${left})`
}

export function limitRow(l: Limit, now: number): [string, string] {
  const icon = l.minutes <= 300 ? '⏱️ ' : '📅'
  if (l.reset) return [`${icon} ${l.label}`, `reset since Codex last reported ${dim('(fresh window)')}`]
  return [`${icon} ${l.label}`, `${bar(l.usedPercent)} ${Math.round(l.usedPercent)}% used${l.resetsAt ? ` · resets ${resetText(l.resetsAt, now)}` : ''}`]
}

const TIER: Record<string, string> = { trivial: 'Quick', routine: 'Standard', complex: 'Complex', critical: 'Critical' }

export function adviceText(a: Advice): string {
  const effort = a.effort === 'xhigh' ? 'extra high' : a.effort
  const now = a.current && a.change !== 'none' ? `  ${dim(`(now on ${a.current.label}: ${a.change === 'down' ? 'a lighter model would do' : 'this one needs more'})`)}` : ''
  return `${TIER[a.tier] ?? a.tier} → ${a.model.label} at ${effort} effort${now}`
}

export function renderReport(s: Snapshot, o: { agent?: AgentKey; advice?: Advice | null; now?: number }): string {
  const now = o.now ?? s.generatedAt
  const who = o.agent && o.agent !== 'other' ? ` (${AGENT_LABEL[o.agent]})` : ''
  const out: string[] = [`\n${bold('◆ Mapshift')}  ${dim(`report · ${s.project.name}${who}`)}\n`]
  const pairs: [string, string][] = []

  const m = s.map
  pairs.push([
    '🗺️  Map',
    m.state === 'ready'
      ? `Ready · ${n(m.files)} files · ${n(m.symbols)} definitions · updated ${ago(m.builtAt)}`
      : m.state === 'building'
        ? `Building · ${m.percent}%`
        : 'Not built yet · it builds the first time an agent asks the map something here',
  ])

  const t = s.today
  const mineN = o.agent ? t.byAgent.find(b => b.agent === o.agent)?.n ?? 0 : 0
  const split = t.byAgent.length > 1 || (o.agent && t.lookups) ? ` ${dim(`· ${t.byAgent.map(b => `${b.label} ${n(b.n)}`).join(' · ')}`)}` : ''
  pairs.push(['🔎 Lookups', t.lookups ? `${n(t.lookups)} today${split}` : `none today${s.week.lookups ? dim(` · ${n(s.week.lookups)} this week`) : ''}`])
  if (t.lookups) {
    const note =
      o.agent === 'claude'
        ? "upper bound; Claude Code's own dashboard shows the exact figure"
        : 'upper bound: the whole files the map pointed to, minus its answers. Mapshift cannot see which of them were read anyway'
    pairs.push(['💾 Saved', `up to ${n(t.savedUpperBound)} tokens today ${dim(`(${note})`)}`])
    pairs.push(['', dim(`${n(t.withMap)} tokens in map answers vs ${n(t.withoutMap)} to read those files whole`)])
  }
  if (o.agent && t.lookups && !mineN) pairs.push(['', dim(`None of today's lookups came from ${AGENT_LABEL[o.agent]} yet.`)])

  const c = s.codex
  if (c && (o.agent === 'codex' || !o.agent)) {
    for (const l of c.limits) pairs.push(limitRow(l, now))
    if (c.at && c.limits.length) pairs.push(['', dim(`Codex limits as of ${ago(c.at)}${c.plan ? ` · ${c.plan} plan` : ''}`)])
    if (c.today.sessions) {
      const total = c.today.input + c.today.output
      pairs.push(['🧮 Codex today', `${n(total)} tokens (${n(c.today.cached)} of them cached) in ${n(c.today.sessions)} session${c.today.sessions === 1 ? '' : 's'}`])
    }
    if (c.model) pairs.push(['🤖 Model', `${c.model}${c.effort ? ` · ${c.effort} effort` : ''}`])
  }
  if (o.advice) pairs.push(['💡 Last request', adviceText(o.advice)])

  out.push(rows(pairs))
  out.push(`\n  ${dim('Everything here is read on this computer. Nothing is sent anywhere.')}\n`)
  return out.join('\n')
}
