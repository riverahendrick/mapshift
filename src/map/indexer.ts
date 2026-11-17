import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { mapDbPath, repoDir } from '../core/paths.ts'
import { MAP_FORMAT } from '../version.ts'
import { extract } from './extract.ts'
import { rank, resolve } from './resolve.ts'
import { listFiles, type Skipped } from './scan.ts'
import { Store } from './store.ts'

export type MapState = 'empty' | 'building' | 'ready'
export type MapStatus = {
  root: string
  state: MapState
  /** 0-100 while building. */
  percent: number
  files: number
  symbols: number
  links: number
  skipped: Skipped[]
  builtAt: number | null
}
export type RefreshResult = { changed: number; removed: number; total: number; ms: number }

const LOCK_STALE_MS = 10 * 60_000
const stores = new Map<string, Store>()

/** The map of a repository, opened once per process. A map in an older format is emptied and built again. */
export function openMap(root: string): Store {
  let store = stores.get(root)
  if (!store) {
    store = new Store(mapDbPath(root))
    if (store.meta('format') !== String(MAP_FORMAT)) {
      store.wipe()
      store.setMeta('format', String(MAP_FORMAT))
    }
    stores.set(root, store)
  }
  return store
}

export function closeMaps(): void {
  for (const s of stores.values()) s.close()
  stores.clear()
}

// ---- one builder at a time per repository, even across processes
const lockPath = (root: string): string => join(repoDir(root), 'map.lock')

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Takes the build lock. A lock left by a process that died, or older than 10 minutes, is taken over. */
export function acquireLock(root: string): boolean {
  mkdirSync(repoDir(root), { recursive: true })
  const path = lockPath(root)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      closeSync(fd)
      return true
    } catch {
      try {
        const held = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; at: number }
        const stale = !pidAlive(held.pid) || Date.now() - held.at > LOCK_STALE_MS
        if (!stale) return false
      } catch {
        // unreadable lock: treat as stale
      }
      try {
        unlinkSync(path)
      } catch {
        return false
      }
    }
  }
  return false
}

export function releaseLock(root: string): void {
  try {
    const held = JSON.parse(readFileSync(lockPath(root), 'utf8')) as { pid: number }
    if (held.pid === process.pid) unlinkSync(lockPath(root))
  } catch {
    /* already gone */
  }
}

export function lockHeld(root: string): boolean {
  try {
    const held = JSON.parse(readFileSync(lockPath(root), 'utf8')) as { pid: number; at: number }
    return pidAlive(held.pid) && Date.now() - held.at < LOCK_STALE_MS
  } catch {
    return false
  }
}

const sha1 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex')

/**
 * Brings the map up to date with the files on disk. Only files whose size or time changed are read;
 * of those, only files whose content really changed are parsed again. The caller holds the lock.
 */
export async function refresh(root: string, store: Store, onProgress?: (done: number, total: number) => void): Promise<RefreshResult> {
  const t0 = Date.now()
  const { files, skipped } = listFiles(root)
  const known = store.files()
  const firstBuild = known.size === 0
  const todo = files.filter(f => {
    const k = known.get(f.path)
    return !k || k.size !== f.size || k.mtime !== f.mtimeMs
  })
  const seen = new Set(files.map(f => f.path))
  const removed = [...known.keys()].filter(p => !seen.has(p))
  const total = todo.length + removed.length
  const errors: Skipped[] = []
  const names = new Set<string>()
  const fileIds: number[] = []
  let changed = 0

  const BATCH = 40
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const parsed: { f: (typeof batch)[number]; hash: string; text: string; facts: Awaited<ReturnType<typeof extract>> | null }[] = []
    for (const f of batch) {
      let buf: Buffer
      try {
        buf = readFileSync(f.abs)
      } catch {
        errors.push({ path: f.path, reason: 'unreadable' })
        continue
      }
      const hash = sha1(buf)
      const k = known.get(f.path)
      if (k && k.hash === hash) {
        parsed.push({ f, hash, text: '', facts: null }) // same content, newer time
        continue
      }
      const text = buf.toString('utf8')
      if (text.includes('\u0000')) {
        errors.push({ path: f.path, reason: 'unreadable' })
        continue
      }
      try {
        parsed.push({ f, hash, text, facts: await extract(f.lang, text) })
      } catch {
        errors.push({ path: f.path, reason: 'parse error' })
      }
    }
    store.tx(() => {
      for (const p of parsed) {
        const k = known.get(p.f.path)
        if (!p.facts) {
          store.touchFile(p.f.path, p.f.size, p.f.mtimeMs)
          continue
        }
        if (k) for (const n of store.namesIn(k.id)) names.add(n)
        for (const s of p.facts.syms) names.add(s.name)
        const lines = p.text.split('\n').length
        fileIds.push(store.putFile({ path: p.f.path, lang: p.f.lang, size: p.f.size, mtime: p.f.mtimeMs, hash: p.hash, lines }, p.facts))
        changed++
      }
      // a file that used to parse and now fails is dropped, not left answering with old content
      for (const e of errors) if (known.has(e.path)) store.removeFile(e.path)
    })
    onProgress?.(Math.min(i + BATCH, todo.length), total)
  }

  if (removed.length) {
    store.tx(() => {
      for (const path of removed) {
        const k = known.get(path)
        if (k) for (const n of store.namesIn(k.id)) names.add(n)
        store.removeFile(path)
      }
    })
  }

  if (changed || removed.length || firstBuild) {
    store.tx(() => resolve(store, firstBuild ? { files: 'all', names } : { files: fileIds, names }))
    rank(store)
  }
  store.setSkipped([...skipped, ...errors])
  store.setMeta('builtAt', String(Date.now()))
  store.setMeta('state', 'ready')
  store.setMeta('progress', '100')
  onProgress?.(total, total)
  return { changed, removed: removed.length, total, ms: Date.now() - t0 }
}

export function status(root: string, store: Store = openMap(root)): MapStatus {
  const c = store.counts()
  const building = lockHeld(root) && store.meta('state') === 'building'
  const builtAt = store.meta('builtAt')
  return {
    root,
    state: building ? 'building' : c.files === 0 && !builtAt ? 'empty' : 'ready',
    percent: building ? Number(store.meta('progress') ?? 0) : builtAt ? 100 : 0,
    files: c.files,
    symbols: c.symbols,
    links: c.edges,
    skipped: store.skipped(),
    builtAt: builtAt ? Number(builtAt) : null,
  }
}

/** Builds or updates the map right here, holding the lock. Used by the command line and the worker. */
export async function buildNow(root: string, onProgress?: (done: number, total: number) => void): Promise<RefreshResult | null> {
  if (!acquireLock(root)) return null
  const store = openMap(root)
  try {
    store.setMeta('state', 'building')
    store.setMeta('progress', '0')
    return await refresh(root, store, (done, total) => {
      store.setMeta('progress', String(total ? Math.floor((done / total) * 100) : 100))
      onProgress?.(done, total)
    })
  } finally {
    if (store.meta('state') === 'building') store.setMeta('state', 'ready')
    releaseLock(root)
  }
}

const running = new Map<string, Promise<void>>()

/** Builds the map in a background thread, so answers keep flowing while a big repository is read. */
export function startBackgroundBuild(root: string): Promise<void> {
  const existing = running.get(root)
  if (existing) return existing
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  const job = new Promise<void>(done => {
    const worker = new Worker(new URL(`./build-worker${ext}`, import.meta.url), { workerData: { root } })
    worker.once('exit', () => done())
    worker.once('error', () => done())
  }).finally(() => running.delete(root))
  running.set(root, job)
  return job
}

/**
 * Makes the map fresh enough to answer. A new or outdated map starts building in the background and the
 * answer comes from what is ready within the time budget. A built map is updated in place first.
 */
export async function ensureFresh(root: string, budgetMs = 2000): Promise<MapStatus> {
  const store = openMap(root)
  const st = status(root, store)
  if (st.state === 'building') return st
  if (st.state === 'empty') {
    const job = startBackgroundBuild(root)
    await Promise.race([job, new Promise(r => setTimeout(r, budgetMs))])
    return status(root, store)
  }
  if (acquireLock(root)) {
    try {
      await refresh(root, store)
    } finally {
      releaseLock(root)
    }
  }
  return status(root, store)
}

/** True when the path still exists, for answers that read code lines from disk. */
export function exists(abs: string): boolean {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}
