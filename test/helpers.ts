import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { closeMaps } from '../src/map/indexer.ts'

/** A throwaway project folder (optionally a git repository) plus a private Mapshift home. */
export function makeRepo(files: Record<string, string>, opts: { git?: boolean } = {}): { root: string; home: string; write: (p: string, s: string) => void; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'mapshift-test-'))
  const root = join(base, 'repo').replace(/\\/g, '/')
  const home = join(base, 'home')
  mkdirSync(root, { recursive: true })
  process.env.MAPSHIFT_HOME = home
  const write = (p: string, s: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), s)
  }
  for (const [p, s] of Object.entries(files)) write(p, s)
  if (opts.git !== false) {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true })
    run('init', '-q')
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  }
  return {
    root,
    home,
    write,
    cleanup: () => {
      closeMaps()
      rmSync(base, { recursive: true, force: true })
    },
  }
}
