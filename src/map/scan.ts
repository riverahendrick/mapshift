import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { git, slash } from '../core/paths.ts'
import { langOf, type LangId } from './languages.ts'

export type FileEntry = { path: string; abs: string; size: number; mtimeMs: number; lang: LangId }
export type SkipReason = 'too large' | 'generated' | 'parse error' | 'unreadable' | 'terminal output' | 'too slow to read'
export type Skipped = { path: string; reason: SkipReason }

export const MAX_FILE_BYTES = 1_000_000

/** Folders that never hold the project's own source. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo',
  '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', 'vendor', 'target', 'bin', 'obj',
  'coverage', '.dart_tool', 'Pods', '.gradle', '.idea', '.vscode', '.cache', '.expo', 'DerivedData',
])

const GENERATED_NAME = /(\.min\.(js|mjs|cjs|css)|\.bundle\.js|\.chunk\.js|\.g\.dart|\.freezed\.dart|\.pb\.go|_pb2\.pyi?|\.generated\.\w+|\.designer\.cs)$/i

const isIgnoredPath = (path: string): boolean => path.split('/').some(part => IGNORED_DIRS.has(part))

/** True when a file looks machine-written: very long lines, as in minified or bundled code. */
function looksGenerated(abs: string, size: number): boolean {
  if (size < 20_000) return false
  const buf = Buffer.alloc(16_384)
  let fd: number | null = null
  try {
    fd = openSync(abs, 'r')
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const lines = text.split('\n').length
    return text.length / lines > 300
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function walk(root: string, rel: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const path = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) walk(root, path, out)
    } else if (e.isFile()) {
      out.push(path)
    }
  }
}

/**
 * Every source file of the project the map should read. Inside git this is what git tracks plus new
 * files it does not ignore; elsewhere it is a walk of the folder. Files the map passes over on purpose
 * are returned in `skipped` with the reason, so an answer can say so instead of missing them silently.
 */
export function listFiles(root: string): { files: FileEntry[]; skipped: Skipped[] } {
  const listed = git(['ls-files', '-co', '--exclude-standard', '-z'], root, 30_000)
  const paths = listed !== null ? listed.split('\0').filter(Boolean).map(slash) : (() => {
    const out: string[] = []
    walk(root, '', out)
    return out
  })()

  const files: FileEntry[] = []
  const skipped: Skipped[] = []
  for (const path of paths) {
    const lang = langOf(path)
    if (!lang || isIgnoredPath(path)) continue
    const abs = join(root, path)
    let st
    try {
      st = lstatSync(abs) // a symbolic link is never followed: it could point outside the project
    } catch {
      continue // listed by git but deleted on disk
    }
    if (!st.isFile()) continue
    if (st.size > MAX_FILE_BYTES) {
      skipped.push({ path, reason: 'too large' })
      continue
    }
    if (GENERATED_NAME.test(path) || looksGenerated(abs, st.size)) {
      skipped.push({ path, reason: 'generated' })
      continue
    }
    files.push({ path, abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs), lang })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  return { files, skipped }
}
