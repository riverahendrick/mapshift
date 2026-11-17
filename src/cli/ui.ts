import { styleText } from 'node:util'

type Style = Parameters<typeof styleText>[0]

/** Colours on a terminal unless NO_COLOR is set; FORCE_COLOR turns them on anywhere (or off with 0). */
const colorOn = (): boolean => {
  const force = process.env.FORCE_COLOR
  if (force !== undefined && force !== '') return force !== '0'
  return !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
}
export const paint = (style: Style, s: string): string => (colorOn() ? styleText(style, s) : s)

export const brand = (s: string) => paint(['bold', 'cyan'], s)
export const dim = (s: string) => paint('dim', s)
export const bold = (s: string) => paint('bold', s)
export const good = (s: string) => paint('green', s)
export const warn = (s: string) => paint('yellow', s)
export const bad = (s: string) => paint('red', s)

export const LOGO = '◆'

export function header(subtitle?: string): string {
  return `\n${brand(`${LOGO} Mapshift`)}${subtitle ? `  ${dim(subtitle)}` : ''}\n`
}

/** `1234567` → `1,234,567`. */
export const n = (x: number): string => x.toLocaleString('en-US')

/** A labelled row, the labels lined up. */
export function rows(pairs: [string, string][], indent = 2): string {
  const width = Math.max(...pairs.map(([k]) => k.length))
  return pairs.map(([k, v]) => `${' '.repeat(indent)}${dim(k.padEnd(width))}  ${v}`).join('\n')
}

/** A progress bar that redraws one line in place on a terminal. */
export function progress(label: string): { update: (done: number, total: number) => void; done: (message: string) => void } {
  const tty = !!process.stderr.isTTY
  let last = -1
  return {
    update(done, total) {
      if (!tty) return
      const pct = total ? Math.floor((done / total) * 100) : 100
      if (pct === last) return
      last = pct
      const width = 24
      const fill = Math.round((pct / 100) * width)
      const bar = paint('cyan', '█'.repeat(fill)) + dim('░'.repeat(width - fill))
      process.stderr.write(`\r  ${label}  ${bar}  ${String(pct).padStart(3)}%  ${dim(`${n(done)} of ${n(total)} files`)}  `)
    },
    done(message) {
      if (tty) process.stderr.write('\r\x1b[2K')
      process.stderr.write(`  ${good('✓')} ${message}\n`)
    },
  }
}

export function ago(ts: number | null): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return `${d} days ago`
}
