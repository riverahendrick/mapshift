// Everything Mapshift draws: the dashboard pane (four tabs), its small widget form, and the band above the prompt.

import type { AgentRow, Cfg, Effort, Family, Health, Last, LimitWindow, Live, LogRow, MapInfo, MapStats, Mode, Snap, StepRow, Tier, Totals, View } from '../types'
import { EFFORTS, FAMILIES, cap, familyOf, fmtTok, fmtUsd, hitPct, isWarm, limitPressure, windowLengthMs } from './brain'
import { mapStatsLine, moneyVerdict, savingsFor, signedUsd, stretch, tokenVerdict, toolLine } from './savings'
import type { Savings, Stretch } from './savings'
import type { Ledger } from './brain'
import { ACCENT, STATUS, compareBars, familyColor, levelMeter, ringGauge, sparkBars, statusColor } from './charts'
import { project } from './state'
import type { NextForce } from './state'

export type Data = {
  cfg: Cfg
  last: Last | null
  log: LogRow[]
  steps: StepRow[]
  snap: Snap
  totals: Totals
  map: MapInfo
  seen: string[]
  live: Live
  agents: AgentRow[]
  dark: boolean
  health: Health
  ledger: Ledger
  current: Family | null
  /** Real clock time at this draw. */
  now: number
}

/** What the pane can ask for; register.tsx supplies these (it alone talks to the engine). */
export type Act = {
  setCfg: (patch: Partial<Cfg>) => void
  useNext: (force: NextForce, message: string) => void
  flag: () => void
  reset: () => void
  openPane: () => void
}

// ------------------------------------------------------------------ words

export const MODE_INFO: Record<Mode, { label: string; color: string; text: string }> = {
  auto: { label: 'Auto', color: ACCENT.blue, text: 'Picks the model and thinking effort for each request. Quality first; cheaper only when it is safe and pays back.' },
  quality: { label: 'Quality', color: ACCENT.purple, text: 'Never goes cheaper and thinks harder. Moving up to a stronger model is allowed even when it costs more.' },
  saver: { label: 'Saver', color: ACCENT.teal, text: 'Goes cheaper more often for small, safe requests. Risky or complex work still gets the strong model.' },
  manual: { label: 'Manual', color: ACCENT.slate, text: 'You pick one model and thinking effort below; Mapshift only tracks and reports.' },
  off: { label: 'Off', color: ACCENT.gray, text: 'No model switching: Claude Code uses your own model picker as set. The map keeps saving tokens, and tracking still works.' },
}

export const TIER_LABEL: Record<Tier, string> = { trivial: 'Quick', routine: 'Standard', complex: 'Complex', critical: 'Critical' }
const famName = (f: string | null | undefined) => (f ? cap(f) : 'Session model')
export const modelName = (id: string) => {
  const f = familyOf(id)
  const v = /(\d+)-(\d{1,2})(?!\d)/.exec(id)
  return f ? `${cap(f)}${v ? ` ${v[1]}.${v[2]}` : ''}` : id.replace(/^claude-/, '')
}
export const effortName = (e: string) => (e === 'xhigh' ? 'Extra high' : e === 'default' ? 'Default' : cap(e))
/** The family name with its version when an id carries one: 'Opus 5.5'. */
const famVer = (fam: Family | null | undefined, id?: string | null) => (id && familyOf(id) === fam ? modelName(id) : famName(fam))
const num = (n: number) => Math.round(n).toLocaleString('en-US')
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`

/** A time span as people say it: "45 min", "2 h 10 min", "3 d 4 h". */
export function inText(ms: number): string {
  if (!isFinite(ms) || ms < 60_000) return 'less than a minute'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return mins % 60 ? `${hours} h ${mins % 60} min` : `${hours} h`
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${Math.floor(hours / 24)} d`
}
const ago = (ms: number) => (ms < 60_000 ? 'just now' : `${inText(ms)} ago`)

export function when(ms: number | null): string {
  if (ms === null) return 'unknown'
  try {
    return new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  } catch {
    return new Date(ms).toISOString().slice(5, 16).replace('T', ' ')
  }
}

/** The scoring's short notes, in words a person reads easily. */
function plainReason(r: string): string {
  const s = r.trim()
  let m: RegExpExecArray | null
  if ((m = /^(\d+) files?$/.exec(s))) return `Touches ${plural(Number(m[1]), 'file')}`
  if ((m = /^hard: (.+)$/.exec(s))) return `Hard work (${m[1]})`
  if ((m = /^substantial: (.+)$/.exec(s))) return `A sizeable job (${m[1]})`
  if ((m = /^(\d+) points listed$/.exec(s))) return `Lists ${m[1]} things to do`
  if ((m = /^(.+) area$/.exec(s))) return `A risky area (${m[1]})`
  if ((m = /^smart check raised it to (\w+)$/.exec(s))) return `A quick check rated it ${TIER_LABEL[m[1] as Tier] ?? m[1]}`
  const words: Record<string, string> = {
    'looks small': 'Looks like a small request',
    'large repo': 'A large project',
    'unknown cause': 'The cause is not known yet',
    'real-world stakes': 'Real-world stakes',
    'follow-up keeps the level': 'A follow-up, so the level stays',
    'your correction raised the level': 'You corrected the last answer, so the level went up',
    'you asked for top quality': 'You asked for top quality',
    'several signs of a big job': 'Several signs of a big job',
    'big change in a risky area': 'A big change in a risky area',
    'debugging with logs or a stack trace': 'Debugging with logs or a stack trace',
    'unknown-cause bug with evidence': 'A bug with an unknown cause',
  }
  return words[s] ?? s.charAt(0).toUpperCase() + s.slice(1)
}

/** One short line saying why a request got its level: the request's own signs first, else the routing note. */
export function shortWhy(reasons: string[], plan: string): string {
  const parts = reasons.filter(r => r && !/pasted material/.test(r)).slice(0, 2).map(plainReason)
  const raw = parts.length ? parts.join(' · ') : plan && plan !== 'no change needed' ? plan : 'An everyday request'
  const line = raw.charAt(0).toUpperCase() + raw.slice(1)
  if (line.length <= 110) return line
  const cut = line.slice(0, 108)
  return `${cut.slice(0, Math.max(60, cut.lastIndexOf(' ')))}…`
}

/** The map in a few words, for the command line answers. */
export function mapLine(m: MapInfo): string {
  if (m.available === null) return 'not checked yet'
  if (!m.available || !m.state) return 'not available (run `npx mapshift setup`)'
  if (m.state === 'empty') return 'not built yet'
  if (m.state === 'building') return `building ${m.percent}%`
  return `ready (${plural(m.files, 'file')}, ${plural(m.symbols, 'definition')})`
}

const mapWord = (m: MapInfo) => (m.available && m.state === 'ready' ? 'Map ready' : m.available && m.state === 'building' ? `Map ${m.percent}%` : m.available && m.state === 'empty' ? 'No map yet' : null)

/** The status line: "Standard · Sonnet 5.5 · Medium effort · Map ready". */
export function bandText(o: { tier: Tier; model: string; effort: string; map: MapInfo }): string {
  return [TIER_LABEL[o.tier], modelName(o.model), `${effortName(o.effort)} effort`, mapWord(o.map)].filter(Boolean).join(' · ')
}

// ------------------------------------------------------------------ building blocks

type T = any // the surface's element table: Svg exists on desktop, VS Code and mobile only
type Ctx = { t: T; d: Data; graphical: boolean; cols: number; wide: boolean }
const LABEL_W = 16

/** A small coloured label. */
function Pill(t: T, text: string, color: string) {
  const { Text } = t
  return (
    <Text size="caption" weight="bold" backgroundColor={color} color="#ffffff">
      {` ${text} `}
    </Text>
  )
}

/** Every card looks the same: a quiet border, the title in bold, an optional note on the right. */
function Card(c: Ctx, p: { title: string; aside?: string; border?: string; children?: unknown }) {
  const { Box, Text } = c.t
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={p.border ?? 'subtle'} paddingX={1}>
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
        <Text weight="bold">{p.title}</Text>
        {p.aside ? (
          <Text dimColor size="caption">
            {p.aside}
          </Text>
        ) : null}
      </Box>
      {p.children}
    </Box>
  )
}

/** A label and its value side by side; stacked when the pane is narrow. */
function Row(c: Ctx, label: string, value: unknown) {
  const { Box, Text } = c.t
  const v = typeof value === 'string' ? <Text wrap="wrap">{value}</Text> : value
  if (!c.wide)
    return (
      <Box flexDirection="column">
        <Text dimColor size="footnote">
          {label}
        </Text>
        {v}
      </Box>
    )
  return (
    <Box flexDirection="row">
      <Box width={LABEL_W} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {v}
      </Box>
    </Box>
  )
}

const Muted = (t: T, text: string) => {
  const { Text } = t
  return (
    <Text dimColor wrap="wrap">
      {text}
    </Text>
  )
}

// ------------------------------------------------------------------ the pane

export function Pane(t: T, e: any, d: Data, act: Act) {
  const { Box, Button } = t
  if (e.props?.placement === 'widget') return Glance(t, d)
  const cols: number = e.props?.bodyColumns ?? 60
  const c: Ctx = { t, d, graphical: e.surface !== 'terminal' && typeof t.Svg === 'function', cols, wide: cols >= 46 }
  const tabs: [View, string, string][] = [
    ['overview', '📊 Overview', 'o'],
    ['activity', '📜 Activity', 'a'],
    ['settings', '⚙️ Settings', 's'],
    ['help', '❓ Help', 'h'],
  ]
  const view: View = d.cfg.view ?? 'overview'
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      {Header(c)}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {tabs.map(([v, label, key]) => (
          <Button key={`tab-${v}`} label={label} hotkey={key} variant={view === v ? 'primary' : 'secondary'} onPress={() => act.setCfg({ view: v })} />
        ))}
      </Box>
      {view === 'overview' && Overview(c, act)}
      {view === 'activity' && Activity(c)}
      {view === 'settings' && Settings(c, act)}
      {view === 'help' && Help(c)}
    </Box>
  )
}

function Header(c: Ctx) {
  const { Box, Text } = c.t
  const mi = MODE_INFO[c.d.cfg.mode]
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
      <Text size="title" weight="bold">
        🗺️ Mapshift
      </Text>
      {Pill(c.t, `${MODE_ICON[c.d.cfg.mode]} ${mi.label}`, mi.color)}
      {project.name ? <Text dimColor>{project.name}</Text> : null}
    </Box>
  )
}

// ------------------------------------------------------------------ Overview

export const MODE_ICON: Record<Mode, string> = { auto: '⚡', quality: '💎', saver: '🪙', manual: '🎛️', off: '⏸️' }
const TIER_INDEX: Record<Tier, number> = { trivial: 0, routine: 1, complex: 2, critical: 3 }

function Overview(c: Ctx, act: Act) {
  const { Box } = c.t
  return (
    <Box flexDirection="column" gap={1}>
      {ModeBar(c, act)}
      {NowCard(c, act)}
      {LimitsCard(c, act)}
      {SavingsCard(c)}
      {MapCard(c)}
      {HealthCard(c)}
    </Box>
  )
}

/** The five modes, always one press away, with one line on what the chosen one does. */
function ModeBar(c: Ctx, act: Act) {
  const { Box, Text, Button } = c.t
  const modes: Mode[] = ['auto', 'quality', 'saver', 'manual', 'off']
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {modes.map((m, i) => (
          <Button
            key={`ov-mode-${m}`}
            label={`${MODE_ICON[m]} ${MODE_INFO[m].label}`}
            hotkey={String(i + 1)}
            variant={c.d.cfg.mode === m ? 'primary' : 'secondary'}
            onPress={() => act.setCfg({ mode: m })}
          />
        ))}
      </Box>
      <Text dimColor wrap="wrap">
        {MODE_INFO[c.d.cfg.mode].text}
      </Text>
    </Box>
  )
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A bar of block characters for the terminal. */
function blocks(c: Ctx, pct: number, width: number, color: string) {
  const { Text } = c.t
  const v = Math.max(0, Math.min(100, pct))
  const fill = Math.round((v / 100) * width)
  return (
    <Text>
      <Text color={color}>{'█'.repeat(fill)}</Text>
      <Text dimColor>{'░'.repeat(width - fill)}</Text>
    </Text>
  )
}

function NowCard(c: Ctx, act: Act) {
  const { Box, Text, Button } = c.t
  const Svg = c.t.Svg
  const { last, live, cfg } = c.d
  const aside = live.busy ? `⏳ Working · ${clock(live.now - live.startedAt)}` : live.lastSeconds !== null ? `Last request took ${live.lastSeconds} s` : undefined
  if (!last)
    return Card(c, {
      title: '🎯 Right now',
      aside,
      children: Muted(c.t, cfg.mode === 'off' ? 'Model switching is off for this project: your own model picker is used. The map still works.' : 'Send a prompt and what it runs on shows here.'),
    })
  const shown = famVer(last.family, last.answeredBy ?? last.appModel)
  const differs = !!last.family && last.family !== familyOf(last.appModel)
  const level = TIER_INDEX[last.tier] ?? 1
  const meterWidth = Math.max(220, Math.min(460, c.cols * 7 - 40))
  return Card(c, {
    title: '🎯 Right now',
    aside,
    children: (
      <Box flexDirection="column">
        {c.graphical && Svg ? <Svg key="level-meter" source={levelMeter({ level, width: meterWidth, dark: c.d.dark })} alt={`Level: ${TIER_LABEL[last.tier]}`} /> : null}
        {Row(
          c,
          '📶 Level',
          <Text>
            <Text weight="bold">{TIER_LABEL[last.tier] ?? cap(last.tier)}</Text>
            {c.graphical ? null : <Text color={ACCENT.blue}>{`  ${'●'.repeat(level + 1)}${'○'.repeat(3 - level)}`}</Text>}
          </Text>,
        )}
        {Row(
          c,
          '🧠 Model',
          <Text wrap="wrap">
            <Text weight="bold" color={familyColor(last.family ?? undefined)}>
              {shown}
            </Text>
            {differs ? <Text dimColor>{`  (your pick: ${modelName(last.appModel)})`}</Text> : null}
          </Text>,
        )}
        {Row(c, '💭 Thinking', <Text weight="bold">{`${effortName(last.effort)} effort`}</Text>)}
        {Row(
          c,
          '💡 Why',
          <Text dimColor wrap="wrap">
            {last.why ?? shortWhy([], last.reason)}
          </Text>,
        )}
        {live.busy && live.tool ? Row(c, '🔧 Doing', <Text wrap="truncate-end">{`${live.tool}${live.detail ? ` · ${live.detail}` : ''}`}</Text>) : null}
        {last.mismatch && last.answeredBy ? <Text color={STATUS.warn} wrap="wrap">{`⚠️ ${modelName(last.answeredBy)} answered instead of the model Mapshift asked for.`}</Text> : null}
        {last.suggest ? (
          <Box flexDirection="column" marginTop={1}>
            <Text wrap="wrap">{`💡 ${cap(last.suggest.family)} is recommended for this task. Moving now rewrites the conversation cache once (about ${fmtUsd(last.suggest.usd)}).`}</Text>
            <Button key="use-suggest" label={`Use ${cap(last.suggest.family)} next`} variant="primary" onPress={() => act.useNext({ family: last.suggest!.family }, `Mapshift: your next prompt runs on ${cap(last.suggest!.family)}.`)} />
          </Box>
        ) : null}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          <Button key="flag" label="🔼 Wrong pick? Think harder" onPress={() => act.flag()} />
        </Box>
      </Box>
    ),
  })
}

function LimitsCard(c: Ctx, act: Act) {
  const { Box, Text, Button } = c.t
  const Svg = c.t.Svg
  const { snap, now, cfg } = c.d
  const windows = snap.windows.slice(0, 3)
  const weekly = snap.windows.find(w => w.kind === 'seven_day') ?? null
  const pressure = limitPressure({ pct: weekly?.pct ?? null, projected: weekly?.projected ?? null })
  const runsOut = windows.filter(w => w.hitsAt !== null)
  const ctx = snap.ctxPct
  if (!windows.length && ctx === null) return Card(c, { title: '⏱️ Limits', children: Muted(c.t, 'Shows after the first reply.') })
  const resetText = (w: LimitWindow) => (w.resetsAt ? `resets in ${inText(w.resetsAt - now)}` : 'reset time not known yet')
  const gaugeSize = c.cols >= 70 ? 92 : 80
  // 🔋 how much each limit was stretched, from today's with/without (an estimate, labelled as one)
  const today = savingsFor(c.d.totals.today, c.d.map.available ? c.d.map.statsToday : null, c.d.map.available ? c.d.map.usdToday : null)
  const ratio = today.without.usd > 0 ? today.with.usd / today.without.usd : 0
  const stretched = windows
    .map(w => ({ w, s: stretch(w, windowLengthMs(w.kind), ratio, now) }))
    .filter((x): x is { w: LimitWindow; s: Stretch } => x.s !== null && x.s.kept >= 0.5)
  const stretchLines = stretched.length ? (
    <Box flexDirection="column" marginTop={1}>
      {stretched.map(({ w, s }) => (
        <Text key={`stretch-${w.kind}`} wrap="wrap">
          <Text color={STATUS.ok}>{`🔋 ${w.name}: `}</Text>
          {`you'd be at ${Math.round(Math.min(s.withoutPct, 999))}% without Mapshift, not ${Math.round(w.pct)}%`}
          {s.extraMs !== null && s.extraMs >= 60_000 ? <Text color={STATUS.ok}>{` · about ${inText(s.extraMs)} more before it runs out`}</Text> : null}
        </Text>
      ))}
      <Text dimColor size="footnote" wrap="wrap">
        Estimate from today's savings and your pace since each limit reset.
      </Text>
    </Box>
  ) : null
  const warning =
    runsOut.length || pressure > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color={pressure === 2 || runsOut.some(w => w.pct >= 85) ? STATUS.bad : STATUS.warn} wrap="wrap">
          {runsOut.length
            ? `⚠️ At this pace the ${runsOut[0]!.name.toLowerCase()} limit runs out before it resets (${when(runsOut[0]!.hitsAt)}).`
            : '⚠️ Your weekly limit is on a fast pace.'}
        </Text>
        {cfg.mode !== 'saver' && cfg.mode !== 'off' ? <Button key="to-saver" label="🪙 Switch to Saver" onPress={() => act.setCfg({ mode: 'saver' })} /> : null}
      </Box>
    ) : null
  if (c.graphical && Svg) {
    return Card(c, {
      title: '⏱️ Limits',
      aside: windows.length ? `Updated ${ago(now - snap.at)}` : undefined,
      children: (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
            {windows.map(w => (
              <Svg
                key={`gauge-${w.kind}`}
                source={ringGauge({ pct: w.pct, label: w.name, sub: w.resetsAt ? `Resets in ${inText(w.resetsAt - now)}` : 'Reset not known', size: gaugeSize, dark: c.d.dark })}
                alt={`${w.name} limit ${Math.round(w.pct)}% used, ${resetText(w)}`}
              />
            ))}
            {ctx !== null ? (
              <Svg key="gauge-context" source={ringGauge({ pct: ctx, label: 'Context', sub: 'Of this chat', size: gaugeSize, dark: c.d.dark })} alt={`Context ${Math.round(ctx)}% full`} />
            ) : null}
          </Box>
          {stretchLines}
          {warning}
        </Box>
      ),
    })
  }
  const width = Math.max(8, Math.min(24, c.cols - 36))
  const line = (key: string, name: string, pct: number, note: string) => (
    <Box key={key} flexDirection="column">
      <Text>
        <Text weight="bold">{name.padEnd(9)}</Text>
        {blocks(c, pct, width, statusColor(pct))}
        <Text weight="bold" color={statusColor(pct)}>{` ${String(Math.round(pct)).padStart(3)}%`}</Text>
        {c.cols >= 64 ? <Text dimColor>{`  ${note}`}</Text> : null}
      </Text>
      {c.cols < 64 ? <Text dimColor>{`         ${note}`}</Text> : null}
    </Box>
  )
  return Card(c, {
    title: '⏱️ Limits',
    aside: windows.length ? `Updated ${ago(now - snap.at)}` : undefined,
    children: (
      <Box flexDirection="column">
        {windows.map(w => line(`limit-${w.kind}`, w.name, w.pct, resetText(w)))}
        {ctx !== null ? line('limit-context', 'Context', ctx, 'of this chat') : null}
        {stretchLines}
        {warning}
      </Box>
    ),
  })
}

const tok = (n: number) => `${fmtTok(n)} tokens`

/**
 * Without Mapshift next to with it, in money and tokens, for this chat and today. Every figure comes from
 * savings.ts (the same rules `/mapshift status` prints), so the rows add up: 💚 Total = 🗺️ Map + 🔀 Model
 * switching = without − with. ♻️ Cache is Claude Code's own and inside both sides, so it is shown, not added.
 */
function SavingsCard(c: Ctx) {
  const { Box, Text } = c.t
  const Svg = c.t.Svg
  const { totals, map } = c.d
  if (totals.session.turns === 0 && totals.today.turns === 0) return Card(c, { title: '💸 Savings', aside: 'Estimates', children: Muted(c.t, 'Shows after your first request.') })
  const ss = map.available ? map.statsSession : null
  const st = map.available ? map.statsToday : null
  const s = savingsFor(totals.session, ss, map.available ? map.usdSession : null)
  const t = savingsFor(totals.today, st, map.available ? map.usdToday : null)
  const appModel = c.d.last?.appModel ? modelName(c.d.last.appModel) : 'your model'
  const width = Math.max(220, Math.min(460, c.cols * 7 - 40))
  const labelW = c.wide ? 20 : 15
  const colW = c.wide ? 22 : 14
  const mapMoney = (x: Savings, known: boolean) => (!known ? 'not available' : x.map.usd === null ? 'price unknown' : fmtUsd(x.map.usd))
  type Cell = [string, string]
  const rows: [string, Cell, Cell][] = [
    ['With Mapshift', [fmtUsd(s.with.usd), tok(s.with.tokens)], [fmtUsd(t.with.usd), tok(t.with.tokens)]],
    ['Without', [fmtUsd(s.without.usd), tok(s.without.tokens)], [fmtUsd(t.without.usd), tok(t.without.tokens)]],
    ['🗺️ Map', [mapMoney(s, !!ss), ss ? tok(s.map.tokens) : ''], [mapMoney(t, !!st), st ? tok(t.map.tokens) : '']],
    ['🔀 Model switching', [signedUsd(s.routingUsd), 'same tokens'], [signedUsd(t.routingUsd), 'same tokens']],
    ['♻️ Cache', [fmtUsd(s.cache.usd), `${fmtTok(s.cache.tokens)} from cache`], [fmtUsd(t.cache.usd), `${fmtTok(t.cache.tokens)} from cache`]],
    ['💚 Total saved', [signedUsd(s.saved.usd), tok(s.saved.tokens)], [signedUsd(t.saved.usd), tok(t.saved.tokens)]],
  ]
  const TOTAL = rows.length - 1
  const totalColor = (x: Savings) => (x.saved.usd > -0.00005 ? STATUS.ok : undefined)
  const cell = (key: string, v: Cell, i: number, x: Savings, last: boolean) => (
    <Box key={key} flexDirection="column" width={last ? undefined : colW} flexShrink={last ? 1 : 0}>
      <Text weight={i === TOTAL ? 'bold' : undefined} color={i === TOTAL ? totalColor(x) : undefined} wrap="wrap">
        {v[0]}
      </Text>
      {v[1] ? (
        <Text dimColor size="footnote" wrap="wrap">
          {v[1]}
        </Text>
      ) : null}
    </Box>
  )
  const table = (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={labelW} flexShrink={0}>
          <Text dimColor> </Text>
        </Box>
        <Box width={colW} flexShrink={0}>
          <Text dimColor weight="bold">
            This chat
          </Text>
        </Box>
        <Text dimColor weight="bold">
          Today
        </Text>
      </Box>
      {rows.map(([label, a, b], i) => (
        <Box key={`saving-${i}`} flexDirection="row">
          <Box width={labelW} flexShrink={0}>
            <Text weight={i === TOTAL ? 'bold' : undefined} dimColor={i < 2 ? true : undefined}>
              {label}
            </Text>
          </Box>
          {cell(`saving-${i}-chat`, a, i, s, false)}
          {cell(`saving-${i}-today`, b, i, t, true)}
        </Box>
      ))}
    </Box>
  )
  const verdict = (key: string, label: string, x: Savings) => (
    <Text key={key} wrap="wrap" color={x.saved.usd >= 0.00005 ? STATUS.ok : undefined} dimColor={x.saved.usd <= -0.00005 ? true : undefined}>
      {`${label}: ${moneyVerdict(x)} · ${tokenVerdict(x)}`}
    </Text>
  )

  return Card(c, {
    title: '💸 Savings',
    aside: 'Estimates',
    children: (
      <Box flexDirection="column" gap={1}>
        {c.graphical && Svg ? (
          <Svg
            key="compare"
            source={compareBars({
              withValue: t.with.usd,
              withoutValue: t.without.usd,
              withLabel: 'Today with Mapshift',
              withoutLabel: `Without: all on ${appModel}, no map`,
              width,
              fmt: fmtUsd,
              dark: c.d.dark,
            })}
            alt={`Today: ${fmtUsd(t.with.usd)} with Mapshift, ${fmtUsd(t.without.usd)} without`}
          />
        ) : null}
        <Box flexDirection="column">
          {verdict('verdict-chat', 'This chat', s)}
          {verdict('verdict-today', 'Today', t)}
        </Box>
        {table}
        <Text dimColor size="footnote" wrap="wrap">
          {`Without Mapshift: every request on ${appModel}, the model you picked, plus the map's saved tokens priced at its input price. Switching models does not change token counts. Cache is Claude Code's own, in both figures, so it is not added to the total.`}
        </Text>
      </Box>
    ),
  })
}

/** "With the map" next to "Without" in tokens: an SVG on graphical surfaces, block bars on the terminal. */
function MapBars(c: Ctx, x: MapStats) {
  const { Box, Text } = c.t
  const Svg = c.t.Svg
  if (c.graphical && Svg)
    return (
      <Svg
        key="map-bars"
        source={compareBars({
          withValue: x.answerTokens,
          withoutValue: x.wouldRead,
          withLabel: 'With the map',
          withoutLabel: 'Without',
          width: Math.max(200, Math.min(420, c.cols * 7 - 160)),
          fmt: tok,
          dark: c.d.dark,
        })}
        alt={`With the map ${tok(x.answerTokens)}, without ${tok(x.wouldRead)}`}
      />
    )
  const width = Math.max(6, Math.min(18, c.cols - 44))
  const max = Math.max(1, x.answerTokens, x.wouldRead)
  const line = (key: string, label: string, v: number, color: string) => (
    <Text key={key}>
      <Text dimColor>{label.padEnd(13)}</Text>
      {blocks(c, (v / max) * 100, width, color)}
      <Text>{` ${tok(v)}`}</Text>
    </Text>
  )
  return (
    <Box flexDirection="column">
      {line('map-with', 'With the map', x.answerTokens, ACCENT.teal)}
      {line('map-without', 'Without', x.wouldRead, ACCENT.slate)}
    </Box>
  )
}

function MapCard(c: Ctx) {
  const { Box, Text } = c.t
  const m = c.d.map
  if (m.available === null) return Card(c, { title: '🗺️ Map', children: Muted(c.t, '⏳ Checking the map…') })
  if (!m.available || !m.state)
    return Card(c, {
      title: '🗺️ Map',
      children: (
        <Box flexDirection="column">
          <Text wrap="wrap">⚪ Not available yet</Text>
          {Muted(c.t, 'Install the map with `npx mapshift setup`, then open a new chat.')}
        </Box>
      ),
    })
  if (m.state === 'empty')
    return Card(c, {
      title: '🗺️ Map',
      children: (
        <Box flexDirection="column">
          {Row(c, 'Status', <Text weight="bold">⚪ Not built yet</Text>)}
          {Muted(c.t, 'It builds by itself the first time the map tools are used, or run `npx mapshift map build`.')}
        </Box>
      ),
    })
  const total = m.lookups + m.fileReads
  const share = total > 0 ? Math.round((m.lookups / total) * 100) : null
  const langs = m.languages.slice(0, 4).map(l => `${l.label} ${num(l.n)}`).join(' · ')
  const barWidth = Math.max(8, Math.min(20, c.cols - 40))
  const ss = m.statsSession
  const st = m.statsToday
  return Card(c, {
    title: '🗺️ Map',
    aside: m.builtAt ? `Updated ${ago(c.d.now - m.builtAt)}` : undefined,
    children: (
      <Box flexDirection="column">
        {Row(
          c,
          'Status',
          m.state === 'building' ? (
            <Text weight="bold" color={ACCENT.blue}>{`⏳ Building ${m.percent}%`}</Text>
          ) : (
            <Text weight="bold" color={STATUS.ok}>
              ✅ Ready
            </Text>
          ),
        )}
        {Row(c, '📦 Holds', `${plural(m.files, 'file')} · ${plural(m.symbols, 'definition')} · ${plural(m.links, 'call link')}`)}
        {langs ? Row(c, '🔤 Languages', langs) : null}
        {Row(
          c,
          '🔍 This chat',
          <Text wrap="wrap">
            {`${plural(m.lookups, 'map lookup')} · ${plural(m.fileReads, 'file read')}`}
            {share !== null ? <Text dimColor>{'  '}</Text> : null}
            {share !== null ? blocks(c, share, barWidth, ACCENT.teal) : null}
            {share !== null ? <Text color={ACCENT.teal}>{` ${share}% via the map`}</Text> : null}
          </Text>,
        )}
        {ss && ss.lookups > 0
          ? Row(
              c,
              '💚 Saved here',
              <Box flexDirection="column">
                <Text wrap="wrap">{mapStatsLine(ss)}</Text>
                <Text dimColor wrap="wrap">
                  {toolLine(ss)}
                </Text>
                {MapBars(c, ss)}
              </Box>,
            )
          : !ss && m.lookups > 0
            ? Row(c, '💚 Saved here', Muted(c.t, "The map's log could not be read, so its savings are not shown."))
            : null}
        {st && st.lookups > 0
          ? Row(
              c,
              '📅 Today',
              <Box flexDirection="column">
                <Text wrap="wrap">{mapStatsLine(st)}</Text>
                <Text dimColor wrap="wrap">
                  {`${toolLine(st)} · with the map ${tok(st.answerTokens)}, without ${tok(st.wouldRead)}`}
                </Text>
              </Box>,
            )
          : null}
        {(ss && ss.lookups > 0) || (st && st.lookups > 0) ? (
          <Text dimColor size="footnote" wrap="wrap">
            Estimates: tokens are characters / 4. A file counts as not opened only if Claude did not read it anywhere in this chat.
          </Text>
        ) : null}
      </Box>
    ),
  })
}

/** Shown only when something is wrong. */
function HealthCard(c: Ctx) {
  const { Box, Text } = c.t
  const hc = c.d.health
  if (!hc.checkedAt || (hc.ok && hc.unavailable.length === 0)) return null
  return Card(c, {
    title: 'Health',
    aside: `Checked ${ago(c.d.now - hc.checkedAt)}`,
    border: STATUS.warn,
    children: (
      <Box flexDirection="column">
        {hc.problems ? <Text color={STATUS.warn}>{`${plural(hc.problems, 'problem')} found by the self-check:`}</Text> : null}
        {hc.problemLines.map((line, i) => (
          <Text key={`problem-${i}`} wrap="wrap">{`• ${line}`}</Text>
        ))}
        {hc.unavailable.length ? (
          <Text wrap="wrap">{`• ${hc.unavailable.map(cap).join(', ')} is not served on your account right now, so Mapshift stopped asking for it this session.`}</Text>
        ) : null}
        {hc.errors ? <Text wrap="wrap">{`• ${plural(hc.errors, 'internal error')} logged; Mapshift kept working (details: /mapshift log).`}</Text> : null}
      </Box>
    ),
  })
}

export function adviceFor(d: Data, pressure: number): string[] {
  const out: string[] = []
  if (d.snap.ctxTokens >= 300_000 && (d.snap.ctxPct ?? 0) < 70)
    out.push(`The conversation is ${fmtTok(d.snap.ctxTokens)} tokens. Every request re-reads all of it, so /compact (or /clear between tasks) saves more than any model choice.`)
  if (d.health.unavailable.length) out.push(`${d.health.unavailable.map(cap).join(', ')} is not being served right now; check /model or your plan.`)
  const big = d.log.slice(-3).find(r => r.tools >= 40 || (r.tier === 'critical' && r.steps >= 30))
  if (big) out.push('That was a very large job. Mapshift never turns Ultracode on; if you want it, type "ultracode" in your prompt yourself.')
  if ((d.snap.ctxPct ?? 0) >= 70) out.push(`Context is ${d.snap.ctxPct}% full. A /compact with a short focus keeps answers sharp and cheaper.`)
  if (d.map.state === 'ready' && d.map.lookups === 0 && d.map.fileReads >= 30)
    out.push(`The map is ready but unused so far (${d.map.fileReads} file reads, no lookups). Ask Claude to "use the map first", or check that the map reminder is on.`)
  if (d.log.slice(-4).filter(r => r.misroute).length >= 2) out.push('Two corrections in a row: consider /clear and restating the goal, or Quality mode for this task.')
  if (d.last?.suggest) out.push(`This task looks like ${cap(d.last.suggest.family)} work. Use the button on Overview if the answer is not good enough.`)
  if (pressure === 2) out.push('Your weekly limit is tight: Saver mode or shorter sessions stretch it further.')
  const cold = d.current && !isWarm(d.ledger[d.current], d.now, d.cfg.ttlMin)
  if (cold && d.snap.ctxTokens > 50_000) out.push(`The conversation cache has probably expired. Your next message re-reads ${fmtTok(d.snap.ctxTokens)} tokens; /compact first is cheaper.`)
  return out
}

// ------------------------------------------------------------------ Activity: the detail behind the Overview

function Activity(c: Ctx) {
  const { t, d } = c
  const { Box, Text } = t
  const Svg = t.Svg
  const rows = d.log.slice(-30)
  const width = Math.max(220, Math.min(460, c.cols * 7))
  const weekly = d.snap.windows.find(w => w.kind === 'seven_day') ?? null
  const tips = adviceFor(d, limitPressure({ pct: weekly?.pct ?? null, projected: weekly?.projected ?? null }))
  const warmFam = d.current
  const warm = warmFam ? isWarm(d.ledger[warmFam], d.now, d.cfg.ttlMin) : false
  const leftMs = warmFam && d.ledger[warmFam] ? d.cfg.ttlMin * 60_000 - (d.now - d.ledger[warmFam]!.at) : 0
  const lastStep = d.steps[d.steps.length - 1]
  return (
    <Box flexDirection="column" gap={1}>
      {tips.length
        ? Card(c, {
            title: 'Tips',
            children: (
              <Box flexDirection="column">
                {tips.map((a, i) => (
                  <Text key={`tip-${i}`} wrap="wrap">{`• ${a}`}</Text>
                ))}
              </Box>
            ),
          })
        : null}

      {Card(c, {
        title: 'Requests',
        aside: `${plural(d.totals.session.turns, 'request')} this session`,
        children: (
          <Box flexDirection="column">
            {c.graphical && Svg && rows.length ? (
              <Svg
                source={sparkBars({ values: rows.map(r => ({ v: r.usd, family: r.family ?? undefined, flag: r.misroute })), width, caption: 'Estimated cost per request · colour = model · dot = you corrected it', dark: d.dark })}
                alt="Estimated cost per request, coloured by model"
              />
            ) : null}
            {rows.length === 0 ? Muted(t, 'No requests yet.') : null}
            {rows
              .slice(-12)
              .reverse()
              .map(r => (
                <Text key={`req-${r.n}`} wrap="truncate-end">
                  <Text dimColor>{`#${String(r.n).padEnd(4)}`}</Text>
                  <Text color={familyColor(r.family ?? undefined)} weight="semibold">
                    {famName(r.family).padEnd(8)}
                  </Text>
                  <Text>{effortName(r.effort).padEnd(11)}</Text>
                  <Text>{(TIER_LABEL[r.tier] ?? r.tier).padEnd(9)}</Text>
                  <Text>{fmtUsd(r.usd).padStart(8)}</Text>
                  <Text dimColor>{`  ${r.seconds} s`}</Text>
                  {r.switched ? <Text dimColor> · moved model</Text> : null}
                  {r.misroute ? <Text color={STATUS.warn}> · corrected</Text> : null}
                </Text>
              ))}
          </Box>
        ),
      })}

      {Card(c, {
        title: 'Conversation',
        children: (
          <Box flexDirection="column">
            {Row(c, 'Context', d.snap.ctxPct !== null ? <Text color={statusColor(d.snap.ctxPct)}>{`${d.snap.ctxPct}% full · ${fmtTok(d.snap.ctxTokens)} tokens`}</Text> : 'Not measured yet')}
            {Row(c, 'Cache', warm ? `Warm on ${cap(warmFam!)} · about ${inText(leftMs)} left` : 'Cold or unknown: the next message re-reads the conversation')}
            {lastStep ? Row(c, 'Last request', `${hitPct(lastStep.read, lastStep.fresh, lastStep.wrote)}% read from cache`) : null}
            {d.snap.sessionUsd !== null ? Row(c, "Claude Code's total", fmtUsd(d.snap.sessionUsd)) : null}
          </Box>
        ),
      })}

      {Card(c, {
        title: 'Steps',
        aside: 'Each call to the model',
        children: (
          <Box flexDirection="column">
            {d.steps.length === 0 ? Muted(t, 'No steps yet.') : null}
            {d.steps
              .slice(-8)
              .reverse()
              .map(s => (
                <Text key={`step-${s.n}-${s.step}`} wrap="truncate-end">
                  <Text dimColor>{`#${s.n}.${s.step} `}</Text>
                  <Text color={familyColor(familyOf(s.model))}>{cap(s.model).padEnd(8)}</Text>
                  <Text>{effortName(s.effort).padEnd(11)}</Text>
                  <Text>{`${hitPct(s.read, s.fresh, s.wrote)}% from cache`}</Text>
                  <Text dimColor>{` · ${fmtTok(s.read)} cached · ${fmtTok(s.wrote)} newly cached`}</Text>
                </Text>
              ))}
          </Box>
        ),
      })}

      {Card(c, {
        title: 'Helpers',
        aside: 'Subagents Claude started',
        children: (
          <Box flexDirection="column">
            {d.agents.length === 0 ? Muted(t, 'None yet.') : null}
            {d.agents
              .slice(-8)
              .reverse()
              .map((a, i) => (
                <Text key={`agent-${i}`} wrap="truncate-end">
                  <Text weight="semibold">{a.type}</Text> <Text dimColor>{a.description}</Text>{' '}
                  <Text color={familyColor(familyOf(a.model))}>{a.model ? modelName(a.model) : 'same as chat'}</Text>
                  {a.routed ? <Text dimColor> · picked by Mapshift</Text> : null}
                </Text>
              ))}
          </Box>
        ),
      })}

      {Card(c, {
        title: 'Models Seen',
        aside: 'From real answers',
        children: (
          <Box flexDirection="column">
            {d.seen.length === 0 ? Muted(t, 'None yet.') : null}
            {d.seen.map(m => (
              <Text key={`seen-${m}`}>
                <Text color={familyColor(familyOf(m))}>●</Text> {modelName(m)} <Text dimColor>{m}</Text>
              </Text>
            ))}
          </Box>
        ),
      })}
    </Box>
  )
}

// ------------------------------------------------------------------ Settings

function ModeSwitch(c: Ctx, act: Act) {
  const { Box, Text, Button } = c.t
  const modes: Mode[] = ['auto', 'quality', 'saver', 'manual', 'off']
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {modes.map((m, i) => (
          <Button key={`mode-${m}`} label={MODE_INFO[m].label} hotkey={String(i + 1)} variant={c.d.cfg.mode === m ? 'primary' : 'secondary'} onPress={() => act.setCfg({ mode: m })} />
        ))}
      </Box>
      <Text dimColor wrap="wrap">
        {MODE_INFO[c.d.cfg.mode].text}
      </Text>
    </Box>
  )
}

function Settings(c: Ctx, act: Act) {
  const { t, d } = c
  const { Box, Text, Button } = t
  const Select = t.Select
  type Toggle = 'classifier' | 'allowDowngrade' | 'subagents' | 'allowFable' | 'band' | 'notifyLongTurns' | 'respectAppEffort' | 'mapReminder'
  const row = (key: Toggle, title: string, text: string) => (
    <Box key={`row-${key}`} flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Button key={`set-${key}`} label={d.cfg[key] ? 'On' : 'Off'} variant={d.cfg[key] ? 'primary' : 'secondary'} onPress={() => act.setCfg({ [key]: !d.cfg[key] } as Partial<Cfg>)} />
        <Text weight="semibold">{title}</Text>
      </Box>
      <Text dimColor size="footnote" wrap="wrap">
        {text}
      </Text>
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1}>
      {Card(c, {
        title: 'Mode',
        aside: project.name ? `For ${project.name}` : undefined,
        children: (
          <Box flexDirection="column">
            {ModeSwitch(c, act)}
            <Text dimColor size="footnote" wrap="wrap">
              Each project remembers its own mode; new projects start on Auto.
            </Text>
            {d.cfg.mode === 'manual' && Select ? (
              <Box flexDirection="column" marginTop={1}>
                <Select key="lock-model" label="Model" value={d.cfg.lockModel} options={FAMILIES.map(f => ({ value: f, label: cap(f) }))} onSelect={(v: string) => act.setCfg({ lockModel: v as Family })} />
                <Select key="lock-effort" label="Thinking effort" value={d.cfg.lockEffort} options={EFFORTS.map(x => ({ value: x, label: effortName(x) }))} onSelect={(v: string) => act.setCfg({ lockEffort: v as Effort })} />
              </Box>
            ) : null}
          </Box>
        ),
      })}
      {Card(c, {
        title: 'Options',
        children: (
          <Box flexDirection="column" gap={1}>
            {row('mapReminder', '🗺️ Map', "Hands Claude the map's starting points with each prompt, and adds one short line to its instructions to look code up in the map before grepping or reading files. Separate from model switching: it keeps saving tokens even when the mode is Off.")}
            {row('classifier', 'Smart check for unclear prompts', 'When the rules cannot tell how hard a prompt is, a tiny Haiku call rates it. It can only raise the level, never lower it.')}
            {row('allowDowngrade', 'Cheaper model for small tasks', 'Small, safe requests may run on a cheaper model, but only with a small conversation and only if the switch pays back. Off: never go below your current model.')}
            {row('subagents', 'Pick the model for each helper', 'Helpers (subagents) start fresh, so their model costs no cache. Lookups go to Haiku, analysis and ordinary edits to Sonnet, planning and risky work to Opus. A model Claude names itself, custom agents and forks are never changed.')}
            {row('allowFable', 'Allow Fable for critical work', 'Fable is the top model and costs about twice as much as Opus. Off by default. If your app itself is set to Fable, it counts as allowed.')}
            {row('respectAppEffort', 'Keep my app effort as the minimum', 'Real work never thinks less than the effort you picked in the app (quick read-only questions may use less). Saver mode ignores this.')}
            {row('band', 'Status line above the prompt', 'One short line: level, model, thinking effort and the map.')}
            {row('notifyLongTurns', 'Notify when a long request finishes', 'A desktop notification when a request ran for more than a minute.')}
          </Box>
        ),
      })}
      {Card(c, {
        title: 'Upgrade Budget',
        aside: `Now ${fmtUsd(d.cfg.maxSwitchUsd)}`,
        children: (
          <Box flexDirection="column">
            <Text dimColor size="footnote" wrap="wrap">
              Moving a long conversation to a stronger model rewrites its cache once. Below this amount Mapshift moves up on its own; above it, it raises thinking effort and offers a one-press button instead.
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {[0.25, 1, 3, 10].map(v => (
                <Button key={`budget-${v}`} label={fmtUsd(v)} variant={d.cfg.maxSwitchUsd === v ? 'primary' : 'secondary'} onPress={() => act.setCfg({ maxSwitchUsd: v })} />
              ))}
            </Box>
          </Box>
        ),
      })}
      {Card(c, {
        title: 'Cache Lifetime',
        children: (
          <Box flexDirection="column">
            <Text dimColor size="footnote" wrap="wrap">
              How long Claude keeps your conversation cached: about 60 minutes on a subscription, 5 minutes on an API key. Used for estimates only.
            </Text>
            <Box flexDirection="row" columnGap={1}>
              <Button key="ttl-60" label="60 minutes" variant={d.cfg.ttlMin === 60 ? 'primary' : 'secondary'} onPress={() => act.setCfg({ ttlMin: 60 })} />
              <Button key="ttl-5" label="5 minutes" variant={d.cfg.ttlMin === 5 ? 'primary' : 'secondary'} onPress={() => act.setCfg({ ttlMin: 5 })} />
            </Box>
          </Box>
        ),
      })}
      {Card(c, {
        title: 'Reset',
        children: (
          <Box flexDirection="column">
            <Text dimColor size="footnote" wrap="wrap">
              Clears this session's numbers. Today's and all-time totals stay.
            </Text>
            <Button key="reset-stats" label="Reset session numbers" onPress={() => act.reset()} />
          </Box>
        ),
      })}
    </Box>
  )
}

// ------------------------------------------------------------------ Help

function Help(c: Ctx) {
  const { Markdown, Text } = c.t
  const md = [
    '### Mapshift in 30 seconds',
    'Mapshift does two things. It picks the **model** and **thinking effort** for each request, quality first, and it keeps a **map** of your code that Claude can look things up in instead of reading whole files.',
    '',
    '**Modes** (keys 1 to 5 in Settings): **Auto** · **Quality** · **Saver** · **Manual** · **Off**. Each project remembers its own mode; new projects start on **Auto**. **Off** uses your own model picker exactly as set.',
    '',
    '**Levels and thinking effort** (Auto)',
    '- Quick question: Low · Standard work: Medium (never below your app setting) · Complex: High · Critical: Extra high',
    '- Risky areas (security, logins, data loss, concurrency, money and legal, health and privacy) add one step',
    '- When the map shows a change reaches many places, the level goes up (never down)',
    '- A request that grows while working (3+ files edited, 15+ tool calls) gets more effort part way through',
    '- Max effort only when you ask (`++`), after repeated trouble, or Critical in Quality mode',
    '',
    '**The map**: run `npx mapshift setup` once in a project. Claude then finds code with the map tools (map_find, map_file, map_trace) for far fewer tokens. The Map card shows whether it is ready and how often Claude used it.',
    '',
    '**Steer one prompt** by starting it with:',
    '- `++ ` maximum effort  ·  `-- ` quick and cheap  ·  `~ ` skip routing',
    '- `@opus` `@sonnet` `@haiku` `@fable` pick the model  ·  `!low` to `!max` pick the effort',
    '- or anywhere: `[model:opus]`  `[effort:high]`',
    '',
    '**Commands**',
    '- `/mapshift` open this dashboard  ·  `/mapshift auto|quality|saver|manual|off` model switching',
    '- `/mapshift map on|off` the map on its own: it keeps saving tokens even when model switching is Off',
    '- `/mapshift use opus high` one model for everything  ·  `/mapshift flag` the last pick was wrong',
    '- `/mapshift status`  ·  `/mapshift trace`  ·  `/mapshift doctor`',
    '',
    '**How the numbers are counted**',
    '- *Map*: each map answer logs its own size and the files it pointed at, both in tokens estimated as characters / 4. A file counts as not opened only if Claude did not read it anywhere in the same chat.',
    '- *Map saved*: the files the answers pointed at that Claude did not open, less what all the answers cost, exactly. An answer that spared nothing counts against it. The percent is saved out of what Claude would have read without the map.',
    '- *With Mapshift*: what the requests cost on the models used, and the tokens they processed as logged (new input, cache reads, cache writes and output).',
    "- *Without Mapshift*: every request on the model you picked in the app, plus the map's saved tokens at that model's input price; tokens are the same plus the map's saved tokens. Switching models does not change token counts.",
    "- *Saved* = without − with. When stronger models for harder work cost more than was saved, it says so. *Cache* is Claude Code's own prompt cache: it is in both figures, so it is shown but not added.",
    '- *Today* adds each chat of the day once. Dollar values use list prices: estimates, not a bill. On a subscription they map to your usage limits.',
  ].join('\n')
  return Markdown ? <Markdown text={md} /> : <Text>{md}</Text>
}

// ------------------------------------------------------------------ widget glance and the band

function Glance(t: T, d: Data) {
  const { Box, Text } = t
  const weekly = d.snap.windows.find(w => w.kind === 'seven_day')
  return (
    <Box flexDirection="column">
      <Text weight="bold">{d.last ? `${TIER_LABEL[d.last.tier]} · ${famVer(d.last.family, d.last.answeredBy ?? d.last.appModel)} · ${effortName(d.last.effort)}` : 'Mapshift'}</Text>
      <Text dimColor>
        {MODE_INFO[d.cfg.mode].label}
        {weekly ? <Text color={statusColor(weekly.pct)}>{` · Weekly ${weekly.pct}%`}</Text> : null}
      </Text>
    </Box>
  )
}

/** One short line above the prompt: "Mapshift · Standard · Sonnet 5.5 · Medium effort · Map ready". */
export function Band(t: T, e: any, d: Data, act: Act) {
  const { Box, Text, Button } = t
  const cols: number = e.props?.bodyColumns ?? 80
  const weekly = d.snap.windows.find(w => w.kind === 'seven_day')
  const five = d.snap.windows.find(w => w.kind === 'five_hour')
  const parts: { pri: number; w: number; el: unknown }[] = []
  const add = (pri: number, label: string, el?: unknown) => parts.push({ pri, w: label.length, el: el ?? <Text>{label}</Text> })
  add(0, 'Mapshift', <Text weight="bold">Mapshift</Text>)
  if (d.cfg.mode !== 'auto') add(0, MODE_INFO[d.cfg.mode].label, <Text color={MODE_INFO[d.cfg.mode].color}>{MODE_INFO[d.cfg.mode].label}</Text>)
  if (d.last && d.cfg.mode !== 'off') {
    add(1, TIER_LABEL[d.last.tier])
    const model = famVer(d.last.family, d.last.answeredBy ?? d.last.appModel)
    add(0, model, <Text color={familyColor(d.last.family ?? undefined)}>{model}</Text>)
    add(2, `${effortName(d.last.effort)} effort`)
  }
  const mw = mapWord(d.map)
  if (mw) add(3, mw)
  // limits only when they need attention
  for (const w of [five, weekly]) if (w && w.pct >= 65) add(1, `${w.kind === 'five_hour' ? '5-hour' : 'Weekly'} ${w.pct}%`, <Text color={statusColor(w.pct)}>{`${w.kind === 'five_hour' ? '5-hour' : 'Weekly'} ${w.pct}%`}</Text>)
  if (!d.health.ok || d.health.unavailable.length) add(0, 'Check the dashboard', <Text color={STATUS.warn}>Check the dashboard</Text>)
  let room = cols - 8
  const keep = new Set([...parts].sort((a, b) => a.pri - b.pri).filter(x => (room -= x.w + 3) >= 0))
  const row: unknown[] = []
  parts
    .filter(x => keep.has(x))
    .forEach((x, i) => {
      if (i > 0) row.push(<Text dimColor>{' · '}</Text>)
      row.push(x.el)
    })
  return (
    <Box flexDirection="row">
      <Text wrap="truncate-end">{row}</Text>
      <Text> </Text>
      <Button key="open-pane" label="Open" plain dimColor onPress={() => act.openPane()} />
    </Box>
  )
}
