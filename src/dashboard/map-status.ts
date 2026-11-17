// A cheap, read-only look at a project's map: no git process, no map building, no new files.
// Status lines run many times a minute, so this must stay well under a tenth of a second.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { homeDir, normalizeKey, slash } from '../core/paths.ts'
import { MAP_FORMAT } from '../version.ts'

/**
 * The project folder holding `dir` and its map id, worked out from the `.git` entry the way
 * `repoId()` does with git: every worktree of a repository shares the repository's common git folder.
 */
export function quickRepo(dir: string): { root: string; id: string } {
  let d = resolve(dir)
  for (;;) {
    const dotGit = join(d, '.git')
    let st
    try {
      st = statSync(dotGit)
    } catch {
      st = null
    }
    if (st) {
      let common = dotGit
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
        const gitdir = m ? resolve(d, m[1]!.trim()) : dotGit
        common = gitdir
        try {
          common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim())
        } catch {
          /* not a linked worktree (a submodule, say): its git folder is its own */
        }
      }
      return { root: slash(d), id: idOf(common) }
    }
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  const root = slash(resolve(dir))
  return { root, id: idOf(root) }
}

const idOf = (p: string): string => createHash('sha1').update(normalizeKey(p)).digest('hex').slice(0, 16)

export type QuickMap = {
  root: string
  state: 'none' | 'building' | 'ready'
  percent: number
  files: number
  symbols: number
  builtAt: number | null
}

/** What the map of the project holding `dir` looks like right now, read without changing anything. */
export function quickMap(dir: string, home = homeDir()): QuickMap {
  const { root, id } = quickRepo(dir)
  const none: QuickMap = { root, state: 'none', percent: 0, files: 0, symbols: 0, builtAt: null }
  const db = join(home, 'repos', id, 'map.db')
  if (!existsSync(db)) return none
  let conn: DatabaseSync | null = null
  try {
    conn = new DatabaseSync(db, { readOnly: true })
    const meta = (k: string) => (conn!.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null
    if (meta('format') !== String(MAP_FORMAT)) return none // an old map: it rebuilds the next time an agent uses it
    const count = (t: string) => Number((conn!.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)
    const builtAt = meta('builtAt')
    const building = meta('state') === 'building' && lockFresh(join(home, 'repos', id, 'map.lock'))
    const files = count('files')
    return {
      root,
      state: building ? 'building' : files === 0 && !builtAt ? 'none' : 'ready',
      percent: building ? Number(meta('progress') ?? 0) : 100,
      files,
      symbols: count('symbols'),
      builtAt: builtAt ? Number(builtAt) : null,
    }
  } catch {
    return none
  } finally {
    conn?.close()
  }
}

function lockFresh(path: string): boolean {
  try {
    const held = JSON.parse(readFileSync(path, 'utf8')) as { at?: number }
    return typeof held.at === 'number' && Date.now() - held.at < 10 * 60_000
  } catch {
    return false
  }
}
