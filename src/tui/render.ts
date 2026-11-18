// One frame of the terminal dashboard, built as plain lines from a snapshot. Pure: the same snapshot,
// size and tab always give the same frame, so `mapshift ui --once` and the tests see exactly what the live screen shows.
import { n } from '../cli/ui.ts'
import type { Snapshot } from '../dashboard/snapshot.ts'
import type { TabRegion } from './input.ts'
import type { Style, Tone } from './style.ts'
import { fit, pad, width } from './width.ts'

export const TABS = ['overview', 'activity', 'map', 'help'] as const
export type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = { overview: '📊 Overview', activity: '📜 Activity', map: '🗺️ Map', help: '❓ Help' }

export type FrameOptions = {
  tab: Tab
  width: number
  /** Rows on screen; leave out to get every line (for `--once`). */
  height?: number
  scroll?: number
  now?: number
  style: Style
  version?: string
  /** A short notice for the footer, such as a refresh that failed. */
  note?: string
}
export type Frame = { lines: string[]; tabs: TabRegion<Tab>[]; scroll: number; maxScroll: number }

/** Marks where a card's right border goes; replaced by an absolute column on a live screen. */
const R = '\u0001'
const MIN_WIDTH = 40
const TWO_COLUMNS = 100

// ---- words

const LEVEL: Record<string, string> = { trivial: 'Quick', routine: 'Standard', complex: 'Complex', critical: 'Critical' }
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** `claude-opus-5-5` → `Opus 5.5`, `sonnet` → `Sonnet`; other names stay as they are. */
export function modelName(id: string | null): string {
  if (!id) return 'unknown model'
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(id)
  if (m) return `${cap(m[1]!)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  if (/^(haiku|sonnet|opus|fable)$/i.test(id)) return cap(id.toLowerCase())
  return id
}
const effortText = (e: string | null) => (!e || e === 'default' ? 'default effort' : `${e === 'xhigh' ? 'extra high' : e} effort`)
const money = (x: number) => `$${Math.abs(x).toFixed(2)}`

function agoText(ts: number | null, now: number): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  return `${Math.round(h / 24)} days ago`
}

/** `2 h 10 min`, `45 min`, `3 days 4 h`. */
export function inText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h < 48) return mm ? `${h} h ${mm} min` : `${h} h`
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh ? `${d} days ${hh} h` : `${d} days`
}

const timeOf = (ts: number, now: number): string => {
  const d = new Date(ts)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return (sameDay ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })).replace(/ /g, ' ')
}

/** Green below 65%, amber from 65%, red from 85%: the only use of red anywhere. */
export const statusTone = (pct: number): Tone => (pct >= 85 ? 'high' : pct >= 65 ? 'mid' : 'ok')

// ---- drawing pieces

/** A bar `w` cells wide, filled to `frac` in eighths of a cell. */
function bar(st: Style, frac: number, w: number, tone: Tone): string {
  if (w <= 0) return ''
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * w
  const full = Math.floor(f)
  const rem = Math.round((f - full) * 8)
  const part = full < w && rem > 0 ? (rem >= 8 ? '█' : ' ▏▎▍▌▋▊▉'[rem]!) : ''
  const fill = '█'.repeat(full) + part
  return st.fg(tone, fill) + st.fg('track', '░'.repeat(Math.max(0, w - full - (part ? 1 : 0))))
}

/** Parts joined with ` · `, starting a new line rather than running past `w` cells. */
function flow(st: Style, parts: string[], w: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    const next = cur ? `${cur}${st.dim(' · ')}${p}` : p
    if (cur && width(next) > w) {
      out.push(cur)
      cur = p
    } else cur = next
  }
  if (cur) out.push(cur)
  return out
}

/** A label and its value, the labels lined up. */
const kv = (st: Style, label: string, value: string, lw: number) => `${st.dim(pad(label, lw))}  ${value}`

type Card = { title: string; body: string[] }

/** Marks a quiet sentence that a card wraps onto more lines instead of cutting. */
const WRAP = ''
const note = (text: string) => WRAP + text

/** Plain words broken into lines of at most `w` cells. */
function wrapWords(text: string, w: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const word of text.split(' ')) {
    const next = cur ? `${cur} ${word}` : word
    if (cur && width(next) > w) {
      out.push(cur)
      cur = word
    } else cur = next
  }
  if (cur) out.push(cur)
  return out
}

/** A card's lines with its quiet sentences wrapped to fit. */
const expand = (st: Style, body: string[], inner: number): string[] =>
  body.flatMap(l => (l.startsWith(WRAP) ? wrapWords(l.slice(1), inner).map(x => st.dim(x)) : [l]))

/** A card with a rounded border, exactly `w` cells wide. */
function card(st: Style, c: Card, w: number, rows?: number): string[] {
  const inner = w - 4
  const body = expand(st, c.body, inner)
  rows = Math.max(rows ?? 0, body.length)
  const t = fit(c.title, Math.max(1, w - 6))
  const line = (s: string) => st.fg('line', s)
  const out = [line('╭─ ') + st.fg('ink', t, { bold: true }) + ' ' + line('─'.repeat(Math.max(0, w - 5 - width(t)))) + R + line('╮')]
  for (let i = 0; i < rows; i++) out.push(`${line('│')} ${pad(body[i] ?? '', inner)} ${R}${line('│')}`)
  out.push(line(`╰${'─'.repeat(Math.max(0, w - 2))}`) + R + line('╯'))
  return out
}

/** Places pieces of one screen row at 0-based columns. On a live screen each piece is pinned to its column. */
function place(st: Style, segs: { x: number; w: number; text: string }[]): string {
  let out = ''
  let at = 0
  for (const s of segs) {
    out += st.live ? st.col(s.x + 1) : ' '.repeat(Math.max(0, s.x - at))
    out += s.text.split(R).join(st.live ? st.col(s.x + s.w) : '')
    at = s.x + width(s.text)
  }
  return out
}

/** Cards in one column, or in two side by side on a wide screen, with a blank row between rows of cards. */
function grid(st: Style, cards: Card[], W: number, oneColumn = false): string[] {
  const out: string[] = []
  if (W >= TWO_COLUMNS && !oneColumn) {
    const cw = Math.floor((W - 4) / 2)
    for (let i = 0; i < cards.length; i += 2) {
      const pair = cards.slice(i, i + 2)
      const rows = Math.max(...pair.map(c => expand(st, c.body, cw - 4).length))
      const drawn = pair.map(c => card(st, c, cw, rows))
      for (let r = 0; r < drawn[0]!.length; r++) {
        out.push(place(st, drawn.map((d, k) => ({ x: k === 0 ? 1 : 1 + cw + 2, w: cw, text: d[r]! }))))
      }
      out.push('')
    }
  } else {
    for (const c of cards) {
      for (const l of card(st, c, W - 2)) out.push(place(st, [{ x: 1, w: W - 2, text: l }]))
      out.push('')
    }
  }
  return out
}

// ---- the cards

function rightNow(st: Style, s: Snapshot, now: number): Card {
  const body: string[] = []
  const d = s.claude?.decisions[0]
  if (d) {
    const level = d.tier ? LEVEL[d.tier] ?? cap(d.tier) : 'Not routed'
    body.push(kv(st, 'Level', st.fg(d.tier === 'complex' || d.tier === 'critical' ? 'violet' : 'teal', level, { bold: true }), 6))
    body.push(kv(st, 'Model', `${st.bold(modelName(d.model))} ${st.dim(`· ${effortText(d.effort)}`)}`, 6))
    if (d.reason) body.push(kv(st, 'Why', d.reason.charAt(0).toUpperCase() + d.reason.slice(1), 6))
    body.push(st.dim(`Claude Code · ${agoText(d.ts, now)}`))
  }
  const cx = s.codex
  if (cx?.model) {
    if (body.length) body.push('')
    body.push(kv(st, 'Codex', `${st.bold(cx.model)} ${st.dim(`· ${effortText(cx.effort)}`)}`, 6))
  }
  if (!body.length) body.push(note('Shows after your first request in Claude Code.'))
  return { title: '🎯 Right now', body }
}

type LimitRow = { label: string; pct: number; note: string }

function limitRows(st: Style, rows: LimitRow[], inner: number): string[] {
  const lw = Math.min(12, Math.max(...rows.map(r => width(r.label))))
  const nw = Math.max(...rows.map(r => width(r.note)))
  const oneLine = inner - lw - 1 - 1 - 4 - 2 - nw >= 12
  const bw = Math.min(40, oneLine ? inner - lw - 8 - nw : inner - lw - 6)
  const out: string[] = []
  for (const r of rows) {
    const p = Math.max(0, Math.min(100, Math.round(r.pct)))
    const head = `${pad(r.label, lw)} ${bar(st, p / 100, bw, statusTone(p))} ${st.fg(statusTone(p), pad(`${p}%`, 4, 'right'), { bold: true })}`
    if (oneLine) out.push(`${head}  ${st.dim(r.note)}`)
    else out.push(head, `${' '.repeat(lw + 1)}${st.dim(r.note)}`)
  }
  return out
}

function limits(st: Style, s: Snapshot, now: number, inner: number): Card {
  const body: string[] = []
  const cl = s.claude?.limits
  if (cl && (cl.windows.length || cl.ctxPct !== null)) {
    body.push(st.dim(`Claude Code · as of ${agoText(cl.at, now)}`))
    const rows: LimitRow[] = cl.windows.map(w => {
      const passed = w.resetsAt !== null && w.resetsAt <= now
      return { label: w.name, pct: passed ? 0 : w.pct, note: passed ? 'fresh window' : w.resetsAt ? `resets in ${inText(w.resetsAt - now)}` : '' }
    })
    if (cl.ctxPct !== null) rows.push({ label: 'This chat', pct: cl.ctxPct, note: 'memory used' })
    body.push(...limitRows(st, rows, inner))
  }
  const cx = s.codex
  if (cx?.limits.length) {
    if (body.length) body.push('')
    body.push(st.dim(`Codex${cx.plan ? ` · ${cx.plan} plan` : ''} · as of ${agoText(cx.at, now)}`))
    body.push(
      ...limitRows(
        st,
        cx.limits.map(l => ({ label: l.label, pct: l.reset ? 0 : l.usedPercent, note: l.reset ? 'fresh window' : l.resetsAt ? `resets in ${inText(l.resetsAt - now)}` : '' })),
        inner,
      ),
    )
  }
  if (!body.length) body.push(note(cx ? 'Codex has not reported its limits yet.' : 'Shows after your first request.'))
  return { title: '⏱️ Limits', body }
}

function savings(st: Style, s: Snapshot, inner: number): Card {
  const body: string[] = []
  const t = s.claude?.today
  if (t && t.turns > 0) {
    body.push(st.dim(`Claude Code today · ${n(t.turns)} request${t.turns === 1 ? '' : 's'}`))
    const lw = 16
    const max = Math.max(t.baseUsd, t.usd, 1e-9)
    const vw = Math.max(width(money(t.baseUsd)), width(money(t.usd)))
    const bw = Math.max(4, Math.min(40, inner - lw - 2 - 2 - vw))
    body.push(`${st.dim(pad('Without Mapshift', lw))}  ${bar(st, t.baseUsd / max, bw, 'violet')}  ${pad(money(t.baseUsd), vw, 'right')}`)
    body.push(`${st.dim(pad('With Mapshift', lw))}  ${bar(st, t.usd / max, bw, 'teal')}  ${pad(money(t.usd), vw, 'right')}`)
    const saved = t.baseUsd - t.usd
    const pct = t.baseUsd > 0 ? Math.round((Math.abs(saved) / t.baseUsd) * 100) : 0
    if (saved > 0.004) body.push(st.fg('ok', `Saved ${money(saved)} (${pct}%)`, { bold: true }))
    else if (saved < -0.004) body.push(st.fg('mid', `Cost ${money(saved)} more (${pct}%)`, { bold: true }))
    else body.push(st.dim('Saved $0.00 so far today'))
  } else {
    body.push(note('Money shows after your first request in Claude Code.'))
  }
  body.push('')
  if (s.today.lookups > 0) {
    body.push(`${st.dim('Map today')}  up to ${st.bold(n(s.today.savedUpperBound))} tokens saved ${st.dim(`· ${n(s.today.lookups)} lookup${s.today.lookups === 1 ? '' : 's'}`)}`)
  } else {
    body.push(st.dim('Map savings show after the first lookup.'))
  }
  body.push(st.dim('Estimates. Map savings are an upper bound.'))
  return { title: '💸 Savings (estimates)', body }
}

function mapCard(st: Style, s: Snapshot, now: number, inner: number, full = false): Card {
  const m = s.map
  const body: string[] = []
  const lw = full ? 10 : 8
  if (m.state === 'none') {
    body.push(st.fg('muted', '⚪ Not built yet', { bold: true }))
    body.push(note('It builds the first time an agent asks the map something here.'))
  } else {
    if (m.state === 'building') {
      body.push(`${st.fg('mid', `⏳ Building ${m.percent}%`, { bold: true })}  ${bar(st, m.percent / 100, Math.min(20, inner - 18), 'mid')}`)
    } else {
      body.push(`${st.fg('ok', '✅ Ready', { bold: true })} ${st.dim(`· updated ${agoText(m.builtAt, now)}`)}`)
    }
    const parts = [`${st.bold(n(m.files))} files`, `${st.bold(n(m.symbols))} definitions`]
    if (s.mapDetail) parts.push(`${st.bold(n(s.mapDetail.links))} call links`)
    body.push(...flow(st, parts, inner))
  }
  body.push(kv(st, 'Lookups', `${st.bold(n(s.today.lookups))} today ${st.dim('·')} ${n(s.week.lookups)} this week`, lw))
  if (s.today.byAgent.length) body.push(kv(st, 'By agent', s.today.byAgent.map(b => `${b.label} ${n(b.n)}`).join(st.dim(' · ')), lw))
  if (full && s.mapDetail) {
    const sk = s.mapDetail.skipped
    body.push(kv(st, 'Not mapped', sk.length ? sk.map(x => `${n(x.n)} ${x.reason}`).join(st.dim(' · ')) : 'none', lw))
  }
  return { title: '🗺️ Map', body }
}

/** Small bars for a list of counts. */
function countBars(st: Style, items: { label: string; n: number }[], inner: number, tone: Tone): string[] {
  const lw = Math.min(14, Math.max(...items.map(i => width(i.label))))
  const max = Math.max(...items.map(i => i.n), 1)
  const vw = Math.max(...items.map(i => width(n(i.n))))
  const bw = Math.max(4, Math.min(30, inner - lw - vw - 4))
  return items.map(i => `${pad(i.label, lw)}  ${bar(st, i.n / max, bw, tone)}  ${pad(n(i.n), vw, 'right')}`)
}

// ---- the tabs

function overviewTab(st: Style, s: Snapshot, now: number, W: number): string[] {
  const inner = (W >= TWO_COLUMNS ? Math.floor((W - 4) / 2) : W - 2) - 4
  const cards = W >= TWO_COLUMNS ? [rightNow(st, s, now), mapCard(st, s, now, inner), limits(st, s, now, inner), savings(st, s, inner)] : [rightNow(st, s, now), limits(st, s, now, inner), savings(st, s, inner), mapCard(st, s, now, inner)]
  return grid(st, cards, W)
}

function activityTab(st: Style, s: Snapshot, now: number, W: number): string[] {
  type Row = { ts: number; who: string; what: string; detail: string }
  const rows: Row[] = s.recent.map(r => ({
    ts: r.ts,
    who: r.agent,
    what: `🔎 ${cap(r.tool.replace(/^map_/, '') || 'lookup')}`,
    detail: `Pointed to ${n(r.files)} file${r.files === 1 ? '' : 's'} (${n(r.pointedTokens)} tokens) · answer ${n(r.answerTokens)} tokens`,
  }))
  for (const d of s.claude?.decisions ?? []) {
    rows.push({
      ts: d.ts,
      who: 'Claude Code',
      what: `🎯 ${d.tier ? LEVEL[d.tier] ?? cap(d.tier) : 'Not routed'}`,
      detail: `${modelName(d.model)} · ${effortText(d.effort)}${d.switched ? ' · switched model' : ''}${d.reason ? ` · ${cap(d.reason)}` : ''}`,
    })
  }
  rows.sort((a, b) => b.ts - a.ts)
  const inner = W - 6
  const body: string[] = []
  if (!rows.length) body.push(note('Shows after your first request.'))
  else {
    const cw = [9, 12, 13]
    const rest = Math.max(8, inner - cw.reduce((a, b) => a + b + 2, 0))
    body.push(st.dim([pad('When', cw[0]!), pad('Who', cw[1]!), pad('What', cw[2]!), pad('Details', rest)].join('  ')))
    body.push(st.fg('line', '─'.repeat(inner)))
    for (const r of rows.slice(0, 40)) {
      body.push([st.dim(pad(timeOf(r.ts, now), cw[0]!)), pad(r.who, cw[1]!), st.bold(pad(r.what, cw[2]!)), pad(r.detail, rest)].join('  '))
    }
  }
  return grid(st, [{ title: '📜 Recent activity', body }], W, true)
}

function mapTab(st: Style, s: Snapshot, now: number, W: number): string[] {
  const inner = (W >= TWO_COLUMNS ? Math.floor((W - 4) / 2) : W - 2) - 4
  const tools = s.tools.map(t => ({ label: cap(t.tool.replace(/^map_/, '')), n: t.n }))
  const agents = s.week.byAgent.map(b => ({ label: b.label, n: b.n }))
  const langs = (s.mapDetail?.languages ?? []).slice(0, 6)
  return grid(
    st,
    [
      mapCard(st, s, now, inner, true),
      { title: '🔎 Lookups by tool · this week', body: tools.length ? countBars(st, tools, inner, 'teal') : [note('Shows after the first map lookup here.')] },
      { title: '🧩 Languages · files', body: langs.length ? countBars(st, langs, inner, 'violet') : [note('Shows once the map is built.')] },
      { title: '🤖 Agents · this week', body: agents.length ? countBars(st, agents, inner, 'teal') : [note('Shows after the first map lookup here.')] },
    ],
    W,
  )
}

function helpTab(st: Style, W: number): string[] {
  const keys: [string, string][] = [
    ['←/→  Tab  1–4', 'Switch tabs'],
    ['Click', 'Pick a tab with the mouse'],
    ['↑/↓  PgUp/PgDn', 'Scroll, or use the wheel'],
    ['r', 'Refresh now (also every 5 s)'],
    ['q  Esc  Ctrl+C', 'Quit'],
  ]
  const cmds: [string, string][] = [
    ['mapshift setup', 'Add Mapshift to your coding agents'],
    ['mapshift report', 'Map, savings and limits as text'],
    ['mapshift dash', 'This dashboard in your browser'],
    ['mapshift map build', 'Build or update the map'],
    ['mapshift map find <words>', 'Find code by plain words or by name'],
    ['mapshift route <request>', 'Which model and effort a request needs'],
    ['mapshift ui --once', 'Print this screen once and stop'],
  ]
  const wideCmds = W >= 70
  return [
    ...grid(
      st,
      [
        { title: '🔑 Keys', body: keys.map(([k, v]) => `${st.fg('teal', pad(k, 15), { bold: true })} ${v}`) },
        { title: '🔒 Privacy', body: ['Everything here is read on this computer.', st.dim('Nothing about you or your code is sent anywhere.')] },
      ],
      W,
    ),
    ...grid(
      st,
      [{ title: '🧰 Commands', body: cmds.map(([k, v]) => (wideCmds ? `${st.fg('teal', pad(k, 26))} ${st.dim(v)}` : `${st.fg('teal', k)}  ${st.dim(v)}`)) }],
      W,
      true,
    ),
  ]
}

// ---- the frame

export function renderFrame(s: Snapshot, o: FrameOptions): Frame {
  const st = o.style
  const W = Math.max(1, Math.floor(o.width))
  const now = o.now ?? s.generatedAt
  if (W < MIN_WIDTH || (o.height !== undefined && o.height < 10)) {
    return { lines: [fit('Make the window larger to see the Mapshift dashboard. (q quits)', W - 1)], tabs: [], scroll: 0, maxScroll: 0 }
  }

  // header: brand, project and folder on the left; the time on the right
  const clock = new Date(s.generatedAt).toLocaleTimeString('en-US').replace(/ /g, ' ')
  const right = st.dim(`Updated ${clock}`)
  const rw = width(right)
  const brand = `${st.fg('teal', '🗺️ Map', { bold: true })}${st.fg('violet', 'shift', { bold: true })}`
  const left = fit(`${brand}  ${st.bold(s.project.name)}  ${st.dim(s.project.shown)}`, W - rw - 4)
  const header = place(st, [
    { x: 1, w: width(left), text: left },
    { x: W - rw - 1, w: rw, text: right },
  ])

  // tab bar: pills, each pinned to its column so a click maps to the tab drawn there
  const tabs: TabRegion<Tab>[] = []
  const segs: { x: number; w: number; text: string }[] = []
  let x = 1
  for (const t of TABS) {
    const label = ` ${TAB_LABEL[t]} `
    const text = t === o.tab ? st.pill(label) : st.fg('muted', ` ${label} `)
    const w = width(label) + 2
    segs.push({ x, w, text })
    tabs.push({ tab: t, y: 2, x0: x + 1, x1: x + w })
    x += w + 1
  }
  const tabBar = place(st, segs)
  const rule = st.fg('line', '─'.repeat(W))

  const body = [
    '',
    ...(o.tab === 'overview' ? overviewTab(st, s, now, W) : o.tab === 'activity' ? activityTab(st, s, now, W) : o.tab === 'map' ? mapTab(st, s, now, W) : helpTab(st, W)),
  ]
  while (body.length > 1 && body[body.length - 1] === '') body.pop()

  const bodyH = o.height !== undefined ? o.height - 4 : body.length
  const maxScroll = Math.max(0, body.length - bodyH)
  const scroll = Math.max(0, Math.min(o.scroll ?? 0, maxScroll))
  const shown = body.slice(scroll, scroll + bodyH)
  while (o.height !== undefined && shown.length < bodyH) shown.push('')

  const more = maxScroll > 0 ? (scroll < maxScroll ? '  ↓ more below' : '  ↑ more above') : ''
  const hints = W >= 90 ? '←/→ tabs · click a tab · ↑/↓ scroll · r refresh · q quit' : '←/→ tabs · click a tab · r refresh · q quit'
  const footLeft = o.note ? st.fg('mid', o.note) : st.dim(`${hints}${more}`)
  const footRight = st.dim(W >= 80 && o.version ? `Mapshift ${o.version}` : '')
  // the last row stops one cell short, so the terminal never scrolls the screen
  const fw = W - 1
  const footer = place(st, [
    { x: 1, w: 0, text: fit(footLeft, Math.max(1, fw - width(footRight) - 3)) },
    { x: fw - width(footRight), w: 0, text: footRight },
  ])

  const lines = [header, tabBar, rule, ...shown, footer].map((l, i, all) => fit(l, i === all.length - 1 ? fw : W))
  return { lines, tabs, scroll, maxScroll }
}
