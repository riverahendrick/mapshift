// Keys and mouse clicks for the terminal dashboard, decoded from what the terminal sends in raw mode.
// Mouse reports use the SGR form (mode 1006): ESC [ < button ; column ; row M (press) or m (release).

export type Key = 'left' | 'right' | 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'tab' | 'backtab' | 'enter' | 'esc' | 'ctrl-c'
export type InputEvent =
  | { type: 'key'; key: Key }
  | { type: 'char'; char: string }
  | { type: 'click'; x: number; y: number }
  | { type: 'wheel'; dir: 'up' | 'down' }

const ESC = '\x1b'
const SEQ: Record<string, Key> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1bOA': 'up',
  '\x1bOB': 'down',
  '\x1bOC': 'right',
  '\x1bOD': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[Z': 'backtab',
}
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/y
const CSI = /\x1b\[[0-9;?<>]*[ -/]*[@-~]|\x1bO[@-~]/y
const UNFINISHED = /^\x1b(\[[0-9;?<>]*|O)$/

/**
 * Everything in a chunk of terminal input, in order, plus an unfinished escape sequence at its end (a mouse
 * report split across two reads), to be put in front of the next chunk. Only a lone ESC is the Esc key:
 * Alt+key and keys this dashboard does not use are skipped whole, so they can never quit by accident.
 */
export function decodeChunk(s: string): { events: InputEvent[]; rest: string } {
  const out: InputEvent[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === ESC) {
      MOUSE.lastIndex = i
      const m = MOUSE.exec(s)
      if (m) {
        i += m[0].length
        const b = Number(m[1])
        if (m[4] === 'M' && b & 64) out.push({ type: 'wheel', dir: (b & 1) === 0 ? 'up' : 'down' })
        // a plain left press: no motion (32), no wheel (64), no modifier keys needed
        else if (m[4] === 'M' && (b & 3) === 0 && !(b & 32) && !(b & 64)) out.push({ type: 'click', x: Number(m[2]), y: Number(m[3]) })
        continue
      }
      // the old mouse form (terminals without 1006): ESC [ M and three bytes, never read as keys
      if (s.startsWith(`${ESC}[M`, i)) {
        if (s.length - i < 6) return { events: out, rest: s.slice(i) }
        i += 6
        continue
      }
      const known = Object.keys(SEQ).find(k => s.startsWith(k, i))
      if (known) {
        out.push({ type: 'key', key: SEQ[known]! })
        i += known.length
        continue
      }
      CSI.lastIndex = i
      const other = CSI.exec(s)
      if (other) {
        i += other[0].length // a key this dashboard does not use
        continue
      }
      const tail = s.slice(i)
      if (tail.length > 1 && tail.length <= 32 && UNFINISHED.test(tail)) return { events: out, rest: tail }
      if (i + 1 >= s.length || s[i + 1] === ESC) {
        out.push({ type: 'key', key: 'esc' })
        i++
      } else {
        i += 2 // Alt plus a key
      }
      continue
    }
    if (ch === '\x03') out.push({ type: 'key', key: 'ctrl-c' })
    else if (ch === '\t') out.push({ type: 'key', key: 'tab' })
    else if (ch === '\r' || ch === '\n') out.push({ type: 'key', key: 'enter' })
    else if (ch >= ' ') out.push({ type: 'char', char: ch })
    i++
  }
  return { events: out, rest: '' }
}

/** Everything in one chunk of terminal input, in order (an unfinished sequence at the end is dropped). */
export const decode = (s: string): InputEvent[] => decodeChunk(s).events

export type TabRegion<T extends string = string> = { tab: T; y: number; x0: number; x1: number }

/** The tab under a click (1-based column and row, as the terminal reports them), if any. */
export function tabAt<T extends string>(regions: TabRegion<T>[], x: number, y: number): T | null {
  return regions.find(r => r.y === y && x >= r.x0 && x <= r.x1)?.tab ?? null
}
