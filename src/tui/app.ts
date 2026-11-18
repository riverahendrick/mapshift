// The live terminal dashboard: full screen, keys and mouse clicks, refreshed every 5 seconds.
// The terminal is always put back as it was (main screen, cursor, mouse, line mode): on quit, on Ctrl+C,
// on a crash and when the process exits.
import { writeSync } from 'node:fs'
import type { Snapshot } from '../dashboard/snapshot.ts'
import { decodeChunk, tabAt, type TabRegion } from './input.ts'
import { renderFrame, TABS, type Tab } from './render.ts'
import { colorDepth, makeStyle, type Depth } from './style.ts'

/** Alternate screen, hidden cursor, mouse clicks reported in the SGR form. */
export const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h'
/** Everything ENTER turned on, turned off again. */
export const LEAVE = '\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l'

type Input = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }
type Output = NodeJS.WritableStream & { columns?: number; rows?: number; isTTY?: boolean; getColorDepth?: () => number }

export type UiOptions = {
  data: () => Snapshot
  input?: Input
  output?: Output
  depth?: Depth
  refreshMs?: number
  version?: string
  /** Start on this tab. */
  tab?: Tab
}

export function parseTab(name: string | undefined): Tab | null {
  if (!name) return null
  const t = name.toLowerCase()
  return (TABS as readonly string[]).includes(t) ? (t as Tab) : null
}

/** One frame as text, for `mapshift ui --once`: no screen switching, colours only when the output takes them. */
export function renderOnce(o: { data: Snapshot; width: number; tab?: Tab; version?: string; depth?: Depth }): string {
  const style = makeStyle(o.depth ?? colorDepth(process.stdout), false)
  return `${renderFrame(o.data, { tab: o.tab ?? 'overview', width: o.width, style, version: o.version, now: o.data.generatedAt }).lines.join('\n')}\n`
}

/** Runs until the person quits; resolves with the exit code. */
export function runUi(o: UiOptions): Promise<number> {
  const input = o.input ?? (process.stdin as Input)
  const output = o.output ?? (process.stdout as Output)
  const ownsProcess = output === process.stdout
  const style = makeStyle(o.depth ?? colorDepth(output), true)
  let tab: Tab = o.tab ?? 'overview'
  let scroll = 0
  let maxScroll = 0
  let regions: TabRegion<Tab>[] = []
  let snap: Snapshot | null = null
  let note = ''

  const load = () => {
    try {
      snap = o.data()
      note = ''
    } catch (err) {
      note = `Could not refresh: ${String((err as Error)?.message ?? err).slice(0, 80)}`
    }
  }
  const draw = () => {
    if (!snap) return
    const f = renderFrame(snap, { tab, width: output.columns ?? 80, height: output.rows ?? 24, scroll, style, version: o.version, note, now: Date.now() })
    regions = f.tabs
    scroll = f.scroll
    maxScroll = f.maxScroll
    // one write per frame, inside a synchronized update where the terminal supports it: no flicker
    let out = '\x1b[?2026h'
    f.lines.forEach((l, i) => (out += `\x1b[${i + 1};1H\x1b[2K${l}\x1b[0m`))
    output.write(`${out}\x1b[J\x1b[?2026l`)
  }

  return new Promise<number>(resolve => {
    let restored = false
    let timer: ReturnType<typeof setInterval> | undefined
    const pageRows = () => Math.max(1, (output.rows ?? 24) - 5)
    const restore = (atExit = false) => {
      if (restored) return
      restored = true
      clearInterval(timer)
      input.off('data', onData)
      output.off('resize', onResize)
      if (ownsProcess) {
        process.off('exit', onExit)
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
        process.off('uncaughtException', onCrash)
        process.off('unhandledRejection', onCrash)
      }
      try {
        input.setRawMode?.(false)
      } catch {
        /* already closed */
      }
      input.pause()
      // at exit the event loop is gone, so write directly
      if (atExit && ownsProcess) writeSync(1, LEAVE)
      else output.write(LEAVE)
    }
    const quit = (code: number) => {
      restore()
      resolve(code)
    }
    const move = (to: Tab) => {
      if (to !== tab) scroll = 0
      tab = to
    }
    const step = (by: number) => move(TABS[(TABS.indexOf(tab) + by + TABS.length) % TABS.length]!)
    let pending = ''
    const onData = (chunk: Buffer | string) => {
      const { events, rest } = decodeChunk(pending + String(chunk))
      pending = rest
      for (const ev of events) {
        if (ev.type === 'click') {
          const t = tabAt(regions, ev.x, ev.y)
          if (t) move(t)
        } else if (ev.type === 'wheel') {
          scroll = Math.max(0, Math.min(maxScroll, scroll + (ev.dir === 'up' ? -3 : 3)))
        } else if (ev.type === 'char') {
          const c = ev.char.toLowerCase()
          if (c === 'q') return quit(0)
          if (c === 'r') load()
          else if (c >= '1' && c <= String(TABS.length)) move(TABS[Number(c) - 1]!)
          else if (c === 'h' || c === '?') move('help')
        } else {
          switch (ev.key) {
            case 'ctrl-c':
            case 'esc':
              return quit(0)
            case 'left':
            case 'backtab':
              step(-1)
              break
            case 'right':
            case 'tab':
              step(1)
              break
            case 'up':
              scroll = Math.max(0, scroll - 1)
              break
            case 'down':
              scroll = Math.min(maxScroll, scroll + 1)
              break
            case 'pageup':
              scroll = Math.max(0, scroll - pageRows())
              break
            case 'pagedown':
              scroll = Math.min(maxScroll, scroll + pageRows())
              break
            case 'home':
              scroll = 0
              break
            case 'end':
              scroll = maxScroll
              break
            default:
              break
          }
        }
      }
      draw()
    }
    const onResize = () => draw()
    const onExit = () => restore(true)
    const onSignal = () => {
      restore()
      resolve(130)
    }
    const onCrash = (err: unknown) => {
      // the process ends right after, so write directly: a queued write could be lost
      restore(true)
      writeSync(2, `Mapshift dashboard stopped: ${String((err as Error)?.stack ?? err)}\n`)
      process.exit(1)
    }

    if (ownsProcess) {
      process.on('exit', onExit)
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
      process.on('uncaughtException', onCrash)
      process.on('unhandledRejection', onCrash)
    }
    output.write(ENTER)
    try {
      input.setRawMode?.(true)
    } catch {
      /* not a terminal: keys still arrive a line at a time */
    }
    ;(input as NodeJS.ReadableStream & { setEncoding?: (e: BufferEncoding) => unknown }).setEncoding?.('utf8')
    input.on('data', onData)
    input.resume()
    output.on('resize', onResize)
    timer = setInterval(() => {
      load()
      draw()
    }, o.refreshMs ?? 5000)
    load()
    draw()
  })
}
