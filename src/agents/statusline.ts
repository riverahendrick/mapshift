// `mapshift statusline --agent agy|grok`: one short line under the agent's prompt. It reads the JSON the
// agent sends on stdin, looks at the map without building anything, and never fails: on any problem it
// prints just the model's name.
import { join } from 'node:path'
import { homeDir, normalizeKey } from '../core/paths.ts'
import { quickMap } from '../dashboard/map-status.ts'
import { readMapEvents } from '../dashboard/snapshot.ts'

export const MAX_WIDTH = 70

type Obj = Record<string, unknown>
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {})
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null)
const pct = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : null)

/** The visible width, counting each character (an emoji with its variation mark counts once). */
export const width = (s: string): number => [...s.replace(/️/g, '')].length

export function modelName(input: unknown): string {
  const m = obj(obj(input).model)
  return str(m.display_name) ?? str(m.id) ?? ''
}

/** Builds the line. Segments are dropped from the end until it fits. */
export function statusLine(input: unknown, o: { agent: string; home?: string; cwd?: string; now?: number }): string {
  const j = obj(input)
  const ws = obj(j.workspace)
  const dir = str(ws.repo_root) ?? str(ws.current_dir) ?? str(j.cwd) ?? o.cwd ?? process.cwd()
  const home = o.home ?? homeDir()
  const map = quickMap(dir, home)
  const parts: string[] = []
  parts.push(map.state === 'ready' ? '🗺️ Map ready' : map.state === 'building' ? `🗺️ Mapping ${map.percent}%` : '🗺️ No map yet')

  const now = o.now ?? Date.now()
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const key = normalizeKey(map.root)
  const lookups = readMapEvents(midnight, now, join(home, 'logs')).filter(e => normalizeKey(e.repo) === key).length
  if (lookups) parts.push(`🔎 ${lookups} lookup${lookups === 1 ? '' : 's'}`)

  if (o.agent === 'grok') {
    const name = modelName(j)
    const effort = str(obj(j.effort).level)
    if (name) parts.push(effort ? `${name} ${effort}` : name)
    const cw = obj(j.context_window)
    const used = pct(cw.used_percentage)
    if (used !== null) parts.push(`ctx ${used}%`)
    const cost = obj(j.cost).total_cost_usd
    if (typeof cost === 'number' && cost >= 0.005) parts.push(`$${cost.toFixed(2)}`)
  } else {
    // Antigravity draws its own line above this one (model and context), so only the quota is added here.
    const q = obj(j.quota)
    const rf = q.remaining_fraction
    if (typeof rf === 'number' && rf >= 0 && rf <= 1) parts.push(`Quota ${Math.round(rf * 100)}% left`)
  }

  while (parts.length > 1 && width(parts.join(' · ')) > MAX_WIDTH) parts.pop()
  const line = parts.join(' · ')
  return width(line) > MAX_WIDTH ? [...line].slice(0, MAX_WIDTH - 1).join('') + '…' : line
}

const parse = (text: string): unknown => JSON.parse(text.replace(/^﻿/, ''))

/**
 * Reads the agent's JSON from stdin. It stops as soon as a whole JSON object has arrived (some callers
 * close stdin late), when stdin ends, or at the deadline, so an agent that keeps it open never stalls the line.
 */
export function readStdin(deadlineMs = 120): Promise<unknown> {
  if (process.stdin.isTTY) return Promise.resolve({})
  return new Promise(done => {
    let buf = ''
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      process.stdin.removeAllListeners('data')
      process.stdin.destroy() // do not wait for a caller that is slow to close it
      let v: unknown = {}
      try {
        v = buf.trim() ? parse(buf) : {}
      } catch {
        v = {}
      }
      done(v)
    }
    const timer = setTimeout(finish, deadlineMs)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d: string) => {
      buf += d
      try {
        parse(buf)
        finish()
      } catch {
        /* not all of it yet */
      }
    })
    process.stdin.once('end', finish)
    process.stdin.once('error', finish)
  })
}

/** The command: always prints something sensible and always exits cleanly. */
export async function runStatusline(agent: string): Promise<void> {
  let input: unknown = {}
  try {
    input = await readStdin()
  } catch {
    input = {}
  }
  let line: string
  try {
    line = statusLine(input, { agent })
  } catch {
    line = modelName(input)
  }
  process.stdout.write(`${line}\n`)
}
