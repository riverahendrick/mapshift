import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { foreignTomlLines, outside, removeBlock, upsertBlock, yamlBlockForeign, type Fence } from './blocks.ts'
import type { Targets } from './env.ts'
import { getAt, isStrictJson, removeMember, setMember } from './json-edit.ts'

export type AgentId =
  | 'codex'
  | 'gemini'
  | 'agy'
  | 'grok'
  | 'cursor'
  | 'claude'
  | 'windsurf'
  | 'vscode'
  | 'copilot'
  | 'opencode'
  | 'kiro'
  | 'qwen'
  | 'claude-desktop'
  | 'hermes'
  | 'droid'
  | 'kimi'
  | 'qoder'
  | 'pi'

/** Files Mapshift creates whole carry this word, so it never deletes or overwrites a file it did not write. */
export const MANAGED = 'mapshift:managed'

/** One change setup makes in one file. */
export type Piece = { agent: AgentId; label: string; path: string } & (
  | { kind: 'block'; format: 'md' | 'toml' | 'yaml'; fence: Fence; lines: string[]; own?: string[]; guard?: string; conflicts?: { re: RegExp; why: string }[] }
  | { kind: 'json'; key: string[]; value: unknown; replaceIf?: (old: unknown) => boolean; refuseIf?: { test: (whole: unknown) => boolean; why: string } }
  | { kind: 'file'; content: string }
)

/** What the setup record keeps about one change, so it can be taken away exactly. */
export type Rec = {
  id: string
  kind: Piece['kind']
  path: string
  agents: AgentId[]
  label: string
  format?: 'md' | 'toml' | 'yaml'
  fence?: Fence
  own?: string[]
  /** For YAML blocks: a pattern (source text) every line inside the block must match; see yamlBlockForeign. */
  guard?: string
  key?: string[]
  /** What was put before an appended block. */
  sep?: string
  createdAt?: number
  emptyInner?: string
  /** The value a JSON setting had before Mapshift replaced it (only ever an empty one). */
  prior?: string
  /** The file did not exist before. */
  created?: boolean
  /** Folders created for it, deepest first. */
  dirs?: string[]
}

export const recId = (p: { kind: string; path: string; key?: string[]; fence?: Fence }): string =>
  [p.kind, resolve(p.path).toLowerCase(), p.key?.join('.') ?? p.fence?.start ?? ''].join('|')

export type Outcome = { piece: Piece; action: 'add' | 'update' | 'same' | 'skip'; reason?: string }

type Step = { text: string | null; action: Outcome['action']; reason?: string; rec?: Partial<Rec> }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Applies one piece to a file's text in memory. Nothing is written here. */
export function applyPiece(p: Piece, text: string | null, prev: Rec | undefined): Step {
  if (p.kind === 'block') {
    if (text !== null && p.conflicts) {
      const rest = outside(text, p.fence)
      const hit = p.conflicts.find(c => c.re.test(rest))
      if (hit) return { text, action: 'skip', reason: hit.why }
    }
    if (text !== null && p.guard && yamlBlockForeign(text, p.fence, new RegExp(p.guard))) {
      return { text, action: 'skip', reason: "lines were added inside or right after Mapshift's block; left as is (edit that part by hand)" }
    }
    const r = upsertBlock(text, p.fence, p.lines, p.format === 'toml' ? foreignTomlLines(p.own ?? []) : undefined)
    if (r.text === text) return { text, action: 'same' }
    return { text: r.text, action: r.existed ? 'update' : 'add', rec: { sep: r.existed ? (prev?.sep ?? '') : r.sep, created: prev?.created ?? text === null } }
  }
  if (p.kind === 'json') {
    if (text !== null && text.trim() !== '' && !isStrictJson(text)) {
      return { text, action: 'skip', reason: 'this file is not plain JSON (it may hold comments), so Mapshift left it alone' }
    }
    // a layout the agent version on this computer may not read the way the entry is written: left alone
    if (text !== null && text.trim() && p.refuseIf?.test(getAt(text, []))) return { text, action: 'skip', reason: p.refuseIf.why }
    const cur = text && text.trim() ? getAt(text, p.key) : undefined
    let replaced = false
    if (cur !== undefined && !prev) {
      if (p.replaceIf?.(cur)) replaced = true
      else return { text, action: 'skip', reason: same(cur, p.value) ? 'already there (added before, outside this setup); left as is' : `you already have "${p.key.join('.')}" here; left as is` }
    }
    if (cur !== undefined && same(cur, p.value)) return { text, action: 'same' }
    const r = setMember(text, p.key, p.value)
    if (!r) return { text, action: 'skip', reason: `"${p.key.slice(0, -1).join('.')}" is not an object in this file; left as is` }
    if (cur === undefined) {
      return { text: r.text, action: 'add', rec: { createdAt: r.createdAt, emptyInner: r.emptyInner, prior: undefined, created: (prev?.created ?? false) || text === null } }
    }
    return { text: r.text, action: 'update', rec: replaced ? { prior: r.prior } : {} }
  }
  if (text !== null && !text.includes(MANAGED)) return { text, action: 'skip', reason: 'a file you made already has this name; left as is' }
  if (text === p.content) return { text, action: 'same' }
  return { text: p.content, action: text === null ? 'add' : 'update', rec: { created: prev?.created ?? text === null } }
}

/** Takes one recorded change out of a file's text. Returns null when the file should be deleted. */
export function removeRec(r: Rec, text: string): { text: string | null; note?: string } {
  if (r.kind === 'block') {
    if (r.guard && yamlBlockForeign(text, r.fence!, new RegExp(r.guard))) {
      return { text, note: `${r.path} has lines next to Mapshift's block, so it was left in place; remove the marked block by hand` }
    }
    const out = removeBlock(text, r.fence!, r.sep, r.format === 'toml' ? foreignTomlLines(r.own ?? []) : undefined)
    return { text: r.created && out.trim() === '' ? null : out }
  }
  if (r.kind === 'json') {
    if (!isStrictJson(text)) return { text, note: `${r.path} is no longer plain JSON; remove "${r.key!.join('.')}" by hand` }
    if (getAt(text, r.key!) === undefined) return { text }
    const out = removeMember(text, r.key!, { createdAt: r.createdAt, emptyInner: r.emptyInner, prior: r.prior })
    const left = getAt(out, [])
    return { text: r.created && left && typeof left === 'object' && Object.keys(left).length === 0 ? null : out }
  }
  if (!text.includes(MANAGED)) return { text, note: `${r.path} was changed to no longer be Mapshift's; left in place` }
  return { text: null }
}

// ---- files on disk

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Writes through a temporary file and a rename, so a crash never leaves half a config file. A config that is
 * a link (a dotfiles manager) is written where it points, so the link stays a link, and an existing file keeps
 * its permissions (a config holding a token stays readable by its owner only).
 */
export function writeText(path: string, text: string): void {
  let target = path
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path)
  } catch {
    /* a new file */
  }
  let mode: number | undefined
  try {
    mode = statSync(target).mode & 0o777
  } catch {
    /* a new file: the usual permissions */
  }
  const tmp = `${target}.mapshift-tmp`
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode) // the mode given when writing is narrowed by the process umask; this sets it exactly
    } catch {
      /* a file system without modes */
    }
  }
  try {
    renameSync(tmp, target)
  } catch {
    writeFileSync(target, text) // a file held open by a running program on Windows
    try {
      unlinkSync(tmp)
    } catch {
      /* gone */
    }
  }
}

/** Folders that would have to be created for `path`, deepest first. */
export function missingDirs(path: string): string[] {
  const out: string[] = []
  let d = dirname(resolve(path))
  while (!existsSync(d)) {
    out.push(d)
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return out
}

/** Removes folders Mapshift created, only while they are empty. */
export function removeEmptyDirs(dirs: string[] = []): void {
  for (const d of dirs) {
    try {
      if (readdirSync(d).length === 0) rmdirSync(d)
    } catch {
      /* not there or not empty */
    }
  }
}

/** Copies a file into this run's backup folder, mirroring its path under the home folder. Returns the copy's path. */
export function backup(path: string, t: Targets, stamp: string): string | null {
  if (!existsSync(path)) return null
  const rel = relative(t.home, resolve(path))
  const mirror = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : join('_outside-home', resolve(path).replace(/^([A-Za-z]):/, '$1'))
  const dest = join(t.mapshift, 'backups', stamp, mirror)
  if (existsSync(dest)) return dest // already backed up in this run
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(path, dest)
  return dest
}

export const stampNow = (d = new Date()): string => d.toISOString().replace(/[:.]/g, '-')

// ---- the setup record

export type HomeRecord = {
  home: string
  state: 'on' | 'off'
  agents: AgentId[]
  records: Rec[]
  /** Claude Code's own setup commands were run (so uninstall may run their undo). */
  claude?: boolean
  updatedAt: string
}
type Manifest = { version: 1; homes: Record<string, HomeRecord> }

const manifestPath = (t: Targets) => join(t.mapshift, 'setup.json')
const homeKey = (t: Targets) => resolve(t.home).toLowerCase()

function loadManifest(t: Targets): Manifest {
  try {
    const m = JSON.parse(readFileSync(manifestPath(t), 'utf8')) as Manifest
    if (m && m.version === 1 && m.homes) return m
  } catch {
    /* none yet */
  }
  return { version: 1, homes: {} }
}

export function loadHome(t: Targets): HomeRecord | null {
  return loadManifest(t).homes[homeKey(t)] ?? null
}

export function saveHome(t: Targets, rec: HomeRecord | null): void {
  const m = loadManifest(t)
  if (rec) m.homes[homeKey(t)] = rec
  else delete m.homes[homeKey(t)]
  mkdirSync(t.mapshift, { recursive: true })
  if (!Object.keys(m.homes).length) {
    try {
      unlinkSync(manifestPath(t))
    } catch {
      /* already gone */
    }
    return
  }
  writeText(manifestPath(t), `${JSON.stringify(m, null, 2)}\n`)
}
