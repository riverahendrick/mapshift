// How many terminal cells text takes, and how to cut or pad it to an exact width.
// Escape codes take no cells. Emoji take two (also text symbols turned into emoji with U+FE0F, like 🗺️),
// as do East Asian wide characters; combining marks take none.

const ANSI = /\x1b\[[0-9;?<>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/y
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' })
const EMOJI = /\p{Emoji_Presentation}|\p{Regional_Indicator}/u
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u

/** Cells one grapheme takes. */
function cells(g: string): number {
  const c = g.codePointAt(0) ?? 0
  if (c < 0x7f) return c < 0x20 ? 0 : 1
  if (ZERO.test(g)) return 0
  if (g.includes('️') || EMOJI.test(g)) return 2
  if (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )
    return 2
  return 1
}

/** Splits text into escape codes and graphemes, in order. */
function* pieces(s: string): Generator<{ esc: boolean; text: string }> {
  let i = 0
  let plain = ''
  const flushPlain = function* (): Generator<{ esc: boolean; text: string }> {
    if (!plain) return
    for (const { segment } of SEGMENTER.segment(plain)) yield { esc: false, text: segment }
    plain = ''
  }
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      ANSI.lastIndex = i
      const m = ANSI.exec(s)
      if (m) {
        yield* flushPlain()
        yield { esc: true, text: m[0] }
        i += m[0].length
        continue
      }
    }
    plain += s[i]
    i++
  }
  yield* flushPlain()
}

/** Text without escape codes. */
export const strip = (s: string): string => {
  let out = ''
  for (const p of pieces(s)) if (!p.esc) out += p.text
  return out
}

/** Terminal cells the text takes. */
export function width(s: string): number {
  // the common case: plain ASCII
  if (/^[\x20-\x7e]*$/.test(s)) return s.length
  let w = 0
  for (const p of pieces(s)) if (!p.esc) w += cells(p.text)
  return w
}

/**
 * The text cut to at most `w` cells, ending in `…` when something was cut. Escape codes are kept, never split,
 * and colours are reset at the end when any were used.
 */
export function fit(s: string, w: number, ellipsis = '…'): string {
  if (w <= 0) return ''
  if (width(s) <= w) return s
  const room = w - width(ellipsis)
  let out = ''
  let used = 0
  let styled = false
  for (const p of pieces(s)) {
    if (p.esc) {
      out += p.text
      styled = true
      continue
    }
    const c = cells(p.text)
    if (used + c > room) break
    out += p.text
    used += c
  }
  out += ellipsis.slice(0, Math.max(0, w - used))
  return styled ? `${out}\x1b[0m` : out
}

/** The text cut or padded with spaces to exactly `w` cells. */
export function pad(s: string, w: number, align: 'left' | 'right' = 'left'): string {
  const t = fit(s, w)
  const gap = ' '.repeat(Math.max(0, w - width(t)))
  return align === 'left' ? t + gap : gap + t
}
