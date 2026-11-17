// Colours and SVG drawings for the graphical surfaces (desktop, VS Code, mobile). Pure string builders.

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * Status colours. Fixed on purpose, never taken from a theme: green is fine, amber is getting close,
 * red is a real warning. Red is used for nothing else anywhere in the dashboard.
 */
export const STATUS = { ok: '#3fb950', warn: '#e3b341', bad: '#f85149' } as const
/** Below 65% green, from 65% amber, from 85% red. */
export const statusColor = (pct: number) => (pct >= 85 ? STATUS.bad : pct >= 65 ? STATUS.warn : STATUS.ok)

/** Calm accents for everything that is not a status: blues, purples and teal, never red or pink. */
export const ACCENT = {
  blue: '#388bfd',
  purple: '#a371f7',
  indigo: '#6e7ff3',
  teal: '#26a69a',
  slate: '#57606a',
  gray: '#6e7681',
} as const

export const familyColor = (f: string | undefined) =>
  f === 'opus' ? ACCENT.purple : f === 'sonnet' ? ACCENT.blue : f === 'haiku' ? ACCENT.teal : f === 'fable' ? ACCENT.indigo : ACCENT.gray

const TRACK = '#8884'
const ink = (dark?: boolean) => (dark ? '#e6edf3' : '#1f2328')
const mut = (dark?: boolean) => (dark ? '#9198a1' : '#59636e')
const FONT = 'font-family="Segoe UI, -apple-system, Inter, Roboto, sans-serif"'

/** One usage limit: name on the left, percent on the right in its status colour, the bar, and when it resets. */
export function limitBar(o: { dark?: boolean; pct: number; label: string; sub?: string; width?: number }): string {
  const w = Math.round(o.width ?? 320)
  const ht = o.sub ? 44 : 30
  const pct = Math.max(0, Math.min(100, o.pct))
  const color = statusColor(o.pct)
  const fill = Math.max(pct > 0 ? 8 : 0, (pct / 100) * w)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${FONT} width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}">` +
    `<text x="0" y="12" font-size="12.5" font-weight="600" fill="${ink(o.dark)}">${esc(o.label)}</text>` +
    `<text x="${w}" y="12" text-anchor="end" font-size="12.5" font-weight="600" fill="${color}">${Math.round(o.pct)}%</text>` +
    `<rect x="0" y="18" width="${w}" height="8" rx="4" fill="${TRACK}"/>` +
    `<rect x="0" y="18" width="${fill.toFixed(1)}" height="8" rx="4" fill="${color}"/>` +
    (o.sub ? `<text x="0" y="${ht - 3}" font-size="11" fill="${mut(o.dark)}">${esc(o.sub)}</text>` : '') +
    `</svg>`
  )
}

/** A ring gauge in the fixed status colours: the percent in the middle, the name and a note under it. */
export function ringGauge(o: { dark?: boolean; pct: number | null; label: string; sub?: string; size?: number }): string {
  const size = Math.round(o.size ?? 96)
  const r = size / 2 - 7
  const c = 2 * Math.PI * r
  const known = o.pct !== null && Number.isFinite(o.pct)
  const pct = known ? Math.max(0, Math.min(100, o.pct as number)) : 0
  const color = known ? statusColor(pct) : ACCENT.gray
  const cx = size / 2
  const w = Math.max(size, 120)
  const x0 = (w - size) / 2
  const ht = size + 34
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${FONT} width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}">` +
    `<g transform="translate(${x0} 0)">` +
    `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${TRACK}" stroke-width="8"/>` +
    (known && pct > 0
      ? `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${((pct / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cx})"/>`
      : '') +
    `<text x="${cx}" y="${cx + 6}" text-anchor="middle" font-size="${Math.round(size / 4.8)}" font-weight="700" fill="${known ? color : mut(o.dark)}">${known ? `${Math.round(pct)}%` : '–'}</text>` +
    `</g>` +
    `<text x="${w / 2}" y="${size + 14}" text-anchor="middle" font-size="12.5" font-weight="600" fill="${ink(o.dark)}">${esc(o.label)}</text>` +
    (o.sub ? `<text x="${w / 2}" y="${size + 29}" text-anchor="middle" font-size="10.5" fill="${mut(o.dark)}">${esc(o.sub)}</text>` : '') +
    `</svg>`
  )
}

/** The four levels as steps, the current one lit: Quick, Standard, Complex, Critical. */
export function levelMeter(o: { dark?: boolean; level: number; width?: number }): string {
  const w = Math.round(o.width ?? 300)
  const names = ['Quick', 'Standard', 'Complex', 'Critical']
  const colors = [ACCENT.teal, ACCENT.blue, ACCENT.purple, ACCENT.indigo]
  const gap = 6
  const seg = (w - gap * 3) / 4
  let out = `<svg xmlns="http://www.w3.org/2000/svg" ${FONT} width="${w}" height="34" viewBox="0 0 ${w} 34">`
  names.forEach((name, i) => {
    const x = i * (seg + gap)
    const on = i <= o.level
    const current = i === o.level
    out +=
      `<rect x="${x.toFixed(1)}" y="${current ? 0 : 3}" width="${seg.toFixed(1)}" height="${current ? 12 : 6}" rx="${current ? 6 : 3}" fill="${on ? colors[i] : TRACK}" opacity="${on && !current ? 0.55 : 1}"/>` +
      `<text x="${(x + seg / 2).toFixed(1)}" y="29" text-anchor="middle" font-size="11" font-weight="${current ? 700 : 400}" fill="${current ? ink(o.dark) : mut(o.dark)}">${name}</text>`
  })
  return `${out}</svg>`
}

/**
 * Two bars, "with" next to "without", each with its label and value, and an optional note under them
 * (green when it reports a saving, muted otherwise). The numbers and the note come from the caller,
 * already worked out by one rule, so the drawing never recomputes them.
 */
export function compareBars(o: {
  dark?: boolean
  withValue: number
  withoutValue: number
  withLabel: string
  withoutLabel: string
  note?: string
  good?: boolean
  width?: number
  fmt: (n: number) => string
}): string {
  const w = Math.round(o.width ?? 320)
  const max = Math.max(1e-9, o.withValue, o.withoutValue)
  const len = (v: number) => Math.max(v > 0 ? 6 : 0, (Math.max(0, v) / max) * (w - 4))
  const row = (y: number, label: string, v: number, color: string) =>
    `<text x="0" y="${y}" font-size="11.5" fill="${mut(o.dark)}">${esc(label)}</text>` +
    `<text x="${w}" y="${y}" text-anchor="end" font-size="11.5" font-weight="600" fill="${ink(o.dark)}">${esc(o.fmt(v))}</text>` +
    `<rect x="0" y="${y + 5}" width="${w}" height="10" rx="5" fill="${TRACK}"/>` +
    `<rect x="0" y="${y + 5}" width="${len(v).toFixed(1)}" height="10" rx="5" fill="${color}"/>`
  const ht = o.note ? 82 : 66
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${FONT} width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}">` +
    row(12, o.withLabel, o.withValue, ACCENT.teal) +
    row(44, o.withoutLabel, o.withoutValue, ACCENT.slate) +
    (o.note
      ? o.good
        ? `<text x="0" y="78" font-size="11.5" font-weight="600" fill="${STATUS.ok}">${esc(o.note)}</text>`
        : `<text x="0" y="78" font-size="11.5" fill="${mut(o.dark)}">${esc(o.note)}</text>`
      : '') +
    `</svg>`
  )
}

/** Bars, one per request, coloured by model; height = estimated cost. */
export function sparkBars(o: { dark?: boolean; values: { v: number; family?: string; flag?: boolean }[]; width?: number; height?: number; caption?: string }): string {
  const w = o.width ?? 300
  const ht = o.height ?? 64
  const n = Math.max(1, o.values.length)
  const max = Math.max(1e-9, ...o.values.map(x => x.v))
  const gap = 2
  const bw = Math.max(2, (w - gap * (n - 1)) / n)
  const bars = o.values
    .map((x, i) => {
      const bh = Math.max(2, (x.v / max) * (ht - 22))
      const xPos = i * (bw + gap)
      return (
        `<rect x="${xPos.toFixed(1)}" y="${(ht - 12 - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${familyColor(x.family)}"/>` +
        (x.flag ? `<circle cx="${(xPos + bw / 2).toFixed(1)}" cy="${(ht - 16 - bh).toFixed(1)}" r="2.5" fill="${STATUS.warn}"/>` : '')
      )
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${FONT} width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}">${bars}` +
    (o.caption ? `<text x="0" y="${ht - 1}" font-size="10" fill="${mut(o.dark)}">${esc(o.caption)}</text>` : '') +
    `</svg>`
  )
}
