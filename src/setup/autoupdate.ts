// Mapshift keeps itself up to date. When a coding agent starts Mapshift's tool server and the last check is
// more than three days old, a background process runs the same steps as `mapshift update`: it asks npm for
// the newest version and, when there is one, installs it (and the Claude Code add-on with it). The request to
// npm carries nothing about the person or their code. `mapshift auto-update off` turns it off; so does
// MAPSHIFT_AUTO_UPDATE=0 (and a CI environment).
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { homeDir, logsDir } from '../core/paths.ts'
import { isTemporaryCopy } from './persist.ts'

/** How often the background check runs at most. */
export const AUTO_UPDATE_EVERY_MS = 3 * 86_400_000
/** A check that left its lock behind (a crash, a shut-down computer) no longer blocks the next one after this. */
const STALE_LOCK_MS = 30 * 60_000

export type AutoUpdateState = { enabled: boolean; lastCheck: string | null; lastResult?: string }

const stateFile = (home: string) => join(home, 'auto-update.json')
const lockFile = (home: string) => join(home, 'auto-update.lock')

export function readAutoUpdate(home = homeDir()): AutoUpdateState {
  try {
    const j = JSON.parse(readFileSync(stateFile(home), 'utf8')) as Partial<AutoUpdateState>
    return { enabled: j.enabled !== false, lastCheck: typeof j.lastCheck === 'string' ? j.lastCheck : null, ...(typeof j.lastResult === 'string' ? { lastResult: j.lastResult } : {}) }
  } catch {
    return { enabled: true, lastCheck: null }
  }
}

export function writeAutoUpdate(state: AutoUpdateState, home = homeDir()): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(stateFile(home), `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Why this copy of Mapshift does not update itself, or null when it can: a development checkout (its own
 * git folder: updating would replace the developer's code) or npm's temporary npx copy.
 */
export function cannotSelfUpdate(script: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pkg = resolve(dirname(script), '..', '..')
  if (existsSync(join(pkg, '.git'))) return 'a development checkout'
  if (isTemporaryCopy(script, env)) return 'a temporary npx copy'
  return null
}

/** Takes the lock, or says another check holds it. A lock older than STALE_LOCK_MS (real time) is taken over. */
function takeLock(home: string, now = Date.now()): boolean {
  const lock = lockFile(home)
  try {
    mkdirSync(home, { recursive: true }) // a new install has no Mapshift folder yet
    writeFileSync(lock, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    try {
      if (now - statSync(lock).mtimeMs < STALE_LOCK_MS) return false
      writeFileSync(lock, String(process.pid))
      return true
    } catch {
      return false
    }
  }
}

export function releaseAutoUpdateLock(home = homeDir()): void {
  try {
    unlinkSync(lockFile(home))
  } catch {
    /* already gone */
  }
}

type Start = (exe: string, args: string[]) => void
const startDetached: Start = (exe, args) => {
  // started from the home folder, never a project folder, and left to run on its own
  const child = spawn(exe, args, { cwd: homedir(), detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

/**
 * Starts a background update when one is due. Fast and silent: it never waits for npm, and it never throws.
 * Returns what it did, for tests and the status command.
 */
export function maybeAutoUpdate(o: { script: string; now?: number; env?: NodeJS.ProcessEnv; home?: string; start?: Start }): 'off' | 'not-due' | 'unsupported' | 'busy' | 'started' {
  try {
    const env = o.env ?? process.env
    if (env.MAPSHIFT_AUTO_UPDATE === '0' || env.CI) return 'off'
    const home = o.home ?? homeDir()
    const st = readAutoUpdate(home)
    if (!st.enabled) return 'off'
    const now = o.now ?? Date.now()
    if (st.lastCheck && now - Date.parse(st.lastCheck) < AUTO_UPDATE_EVERY_MS) return 'not-due'
    if (cannotSelfUpdate(o.script, env)) return 'unsupported'
    // several agents can start Mapshift at the same moment: only one of them checks
    if (!takeLock(home)) return 'busy'
    writeAutoUpdate({ ...st, lastCheck: new Date(now).toISOString() }, home)
    ;(o.start ?? startDetached)(process.execPath, [o.script, 'update', '--auto'])
    return 'started'
  } catch {
    return 'off'
  }
}

/** One line in the update log (`~/.mapshift/logs/update.log`), colour codes removed. */
export function logUpdate(line: string, now = new Date()): void {
  try {
    mkdirSync(logsDir(), { recursive: true })
    appendFileSync(join(logsDir(), 'update.log'), `${now.toISOString()}  ${line.replace(/\x1b\[[\d;]*m/g, '')}\n`)
  } catch {
    /* only a log */
  }
}
