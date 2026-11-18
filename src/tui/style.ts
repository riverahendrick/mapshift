// Colours for the terminal dashboard: true colour where the terminal has it, else the nearest of 256 or 16.
// Red is kept for limits at 85% and above, so it always means "almost out" and nothing else.

/** 0 = no colour, 4 = 16 colours, 8 = 256 colours, 24 = true colour. */
export type Depth = 0 | 4 | 8 | 24

/** Each colour with its hex value and the 16-colour code that stands in for it. */
export const PALETTE = {
  teal: { hex: '#5eead4', c16: 96 }, // bright cyan
  violet: { hex: '#a78bfa', c16: 94 }, // bright blue: magenta reads as pink, and pink belongs to "almost out"
  ok: { hex: '#3fb950', c16: 32 },
  mid: { hex: '#e3b341', c16: 33 },
  high: { hex: '#f85149', c16: 31 },
  ink: { hex: '#e6edf3', c16: 97 },
  muted: { hex: '#8b98b5', c16: 90 },
  line: { hex: '#3b4a6b', c16: 90 },
  track: { hex: '#2a3550', c16: 90 },
  dark: { hex: '#0b1530', c16: 30 },
} as const
export type Tone = keyof typeof PALETTE

/** Colour depth, by the same rules as the rest of Mapshift: NO_COLOR turns it off, FORCE_COLOR turns it on (0 off). */
export function colorDepth(stream: { isTTY?: boolean; getColorDepth?: () => number } = process.stdout, env: NodeJS.ProcessEnv = process.env): Depth {
  const force = env.FORCE_COLOR
  const forced = force !== undefined && force !== ''
  if (forced && force === '0') return 0
  if (!forced && (!stream.isTTY || env.NO_COLOR || env.TERM === 'dumb')) return 0
  if (forced && ['1', '2', '3'].includes(force!)) return ({ '1': 4, '2': 8, '3': 24 } as const)[force as '1' | '2' | '3']
  const ct = (env.COLORTERM ?? '').toLowerCase()
  if (ct === 'truecolor' || ct === '24bit' || env.WT_SESSION || /^(iTerm\.app|WezTerm|vscode|ghostty)$/.test(env.TERM_PROGRAM ?? '')) return 24
  if (stream.isTTY && typeof stream.getColorDepth === 'function') {
    const d = stream.getColorDepth()
    return d >= 24 ? 24 : d >= 8 ? 8 : d >= 4 ? 4 : forced ? 4 : 0
  }
  return /256/.test(env.TERM ?? '') ? 8 : 4
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]

/** The nearest of the 256 xterm colours (the 6×6×6 cube or the grey ramp). */
export function to256(hex: string): number {
  const [r, g, b] = rgb(hex)
  const steps = [0, 95, 135, 175, 215, 255]
  const near = (v: number) => steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best]! - v) ? i : best), 0)
  const [ri, gi, bi] = [near(r), near(g), near(b)]
  const cube = 16 + 36 * ri + 6 * gi + bi
  const dc = (steps[ri]! - r) ** 2 + (steps[gi]! - g) ** 2 + (steps[bi]! - b) ** 2
  const avg = Math.round((r + g + b) / 3)
  const gi2 = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)))
  const gv = 8 + gi2 * 10
  const dg = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2
  return dg < dc ? 232 + gi2 : cube
}

export type Style = {
  depth: Depth
  /** A live screen: cells are placed by absolute column, so an emoji drawn wider or narrower can never push a border. */
  live: boolean
  fg: (tone: Tone, s: string, o?: { bold?: boolean }) => string
  /** Text on a coloured background (the active tab). */
  pill: (s: string) => string
  bold: (s: string) => string
  dim: (s: string) => string
  /** Moves to a 1-based column on a live screen; nothing otherwise. */
  col: (n: number) => string
}

export function makeStyle(depth: Depth, live = false): Style {
  const code = (tone: Tone, bg: boolean): string => {
    const p = PALETTE[tone]
    if (depth === 24) return `${bg ? 48 : 38};2;${rgb(p.hex).join(';')}`
    if (depth === 8) return `${bg ? 48 : 38};5;${to256(p.hex)}`
    return String(bg ? p.c16 + 10 : p.c16)
  }
  const sgr = (codes: string, s: string) => (depth === 0 || !s ? s : `\x1b[${codes}m${s}\x1b[0m`)
  return {
    depth,
    live,
    fg: (tone, s, o) => sgr(`${o?.bold ? '1;' : ''}${code(tone, false)}`, s),
    pill: s => (depth === 0 ? `[${s}]` : sgr(`1;${code('dark', false)};${code('teal', true)}`, ` ${s} `)),
    bold: s => sgr('1', s),
    dim: s => sgr(code('muted', false), s),
    col: n => (live ? `\x1b[${n}G` : ''),
  }
}
