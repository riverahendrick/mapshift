import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Forward slashes everywhere, so one file has one name on every platform. */
export const slash = (p: string): string => p.replace(/\\/g, '/')

/** Where Mapshift keeps everything: maps, logs and settings. Never inside the user's repository. */
export function homeDir(): string {
  const custom = process.env.MAPSHIFT_HOME?.trim()
  return custom ? resolve(custom) : join(homedir(), '.mapshift')
}

/** Runs git quietly. Returns null when git is missing or the folder is not a repository. */
export function git(args: string[], cwd: string, timeoutMs = 5000): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/** The top folder of the project that holds `cwd`: the git root, or the nearest folder with `.git`, or `cwd`. */
export function findRepoRoot(cwd: string): string {
  const top = git(['rev-parse', '--show-toplevel'], cwd)?.trim()
  if (top) return slash(resolve(top))
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return slash(dir)
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return slash(resolve(cwd))
}

/** One spelling per folder: forward slashes, no trailing slash, and lower case where the file system ignores case. */
export function normalizeKey(p: string): string {
  let s = slash(resolve(p)).replace(/\/+$/, '')
  if (process.platform === 'win32' || process.platform === 'darwin' || /^[a-zA-Z]:\//.test(s)) s = s.toLowerCase()
  return s
}

/**
 * A short id for a project. Every git worktree of one repository shares the same git common folder,
 * so they share one map instead of building the same one again.
 */
export function repoId(root: string): string {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)?.trim()
  const key = normalizeKey(common ? resolve(root, common) : root)
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}

export const repoDir = (root: string): string => join(homeDir(), 'repos', repoId(root))
export const mapDbPath = (root: string): string => join(repoDir(root), 'map.db')
export const logsDir = (): string => join(homeDir(), 'logs')
