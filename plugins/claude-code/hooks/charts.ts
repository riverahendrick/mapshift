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
