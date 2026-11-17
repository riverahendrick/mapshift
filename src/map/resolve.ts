import { posix } from 'node:path'
import type { Confidence, Store } from './store.ts'
import type { SymKind } from './types.ts'

type S = { id: number; file_id: number; name: string; qualified: string; kind: SymKind; exported: number }
type R = { id: number; file_id: number; name: string; receiver: string | null; line: number; from_qualified: string | null; kind: 'call' | 'new' }
type I = { file_id: number; source: string; local: string; imported: string }

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.d.ts', '.mts', '.cts']
const SELF = /^(this|self|cls|@|Self|super)$/
const BUILDS = new Set<SymKind>(['class', 'type', 'interface', 'enum'])

/**
 * Languages where a plain call can only reach the same file or an import: `helper()` in one module
 * never means a `helper` defined in another module that was not imported.
 */
const MODULE_SCOPED = new Set(['typescript', 'tsx', 'javascript', 'vue', 'svelte', 'python'])
/** Languages where a plain call also reaches the rest of the same folder (package or namespace). */
const PACKAGE_SCOPED = new Set(['go', 'java', 'kotlin', 'csharp', 'swift', 'dart', 'scala'])

/**
 * Method names every standard library has. A call like `items.find()` or `name.trim()` on an object of
 * unknown type is almost always the built-in, so it is never guessed onto a project definition.
 */
const COMMON = new Set(
  `find findIndex findLast filter map reduce forEach some every includes indexOf lastIndexOf push pop shift unshift slice splice
  concat join split trim trimStart trimEnd replace replaceAll toLowerCase toUpperCase startsWith endsWith match matchAll test exec
  keys values entries items get set has add delete remove clear then catch finally toString valueOf toFixed toISOString toJSON
  getTime log warn error info debug trace parse stringify assign freeze from of isArray sort reverse fill flat flatMap at call apply
  bind emit on off once append extend update copy format strip lower upper insert count index next pipe subscribe unsubscribe
  resolve reject all race length size charAt charCodeAt padStart padEnd substring substr encode decode toList toArray iterator
  getItem setItem removeItem addEventListener removeEventListener querySelector setTimeout clearTimeout setState dispatch
  write read close open flush end json text status`.split(/\s+/),
)

/** Everything the matcher needs, loaded once per pass. */
class Index {
  pathOf = new Map<number, string>()
  idOf = new Map<string, number>()
  langOf = new Map<number, string>()
  byName = new Map<string, S[]>()
  byFileQualified = new Map<string, number>()
  imports = new Map<number, I[]>()
  private targetCache = new Map<string, number[]>()
  private filesByDir = new Map<string, number[]>()

  constructor(store: Store) {
    for (const f of store.sql('SELECT id, path, lang FROM files').all() as { id: number; path: string; lang: string }[]) {
      this.pathOf.set(f.id, f.path)
      this.idOf.set(f.path, f.id)
      this.langOf.set(f.id, f.lang)
      const dir = posix.dirname(f.path)
      const list = this.filesByDir.get(dir)
      if (list) list.push(f.id)
      else this.filesByDir.set(dir, [f.id])
    }
    for (const s of store.sql('SELECT id, file_id, name, qualified, kind, exported FROM symbols').all() as S[]) {
      const list = this.byName.get(s.name)
      if (list) list.push(s)
      else this.byName.set(s.name, [s])
      this.byFileQualified.set(`${s.file_id}:${s.qualified}`, s.id)
    }
    for (const i of store.sql('SELECT file_id, source, local, imported FROM imports').all() as I[]) {
      const list = this.imports.get(i.file_id)
      if (list) list.push(i)
      else this.imports.set(i.file_id, [i])
    }
  }

  private firstExisting(candidates: string[]): number[] {
    for (const c of candidates) {
      const id = this.idOf.get(posix.normalize(c))
      if (id !== undefined) return [id]
    }
    return []
  }

  /** The files an import points at, inside this repository. Packages from outside give none. */
  targets(fileId: number, imp: I): number[] {
    const key = `${fileId}|${imp.source}|${imp.imported}`
    const hit = this.targetCache.get(key)
    if (hit) return hit
    const out = this.findTargets(fileId, imp)
    this.targetCache.set(key, out)
    return out
  }

  private findTargets(fileId: number, imp: I): number[] {
    const path = this.pathOf.get(fileId) ?? ''
    const dir = posix.dirname(path)
    const lang = this.langOf.get(fileId)
    const src = imp.source
    if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript' || lang === 'vue' || lang === 'svelte') {
      const bases: string[] = []
      if (src.startsWith('.')) bases.push(posix.join(dir, src))
      else if (src.startsWith('@/') || src.startsWith('~/')) bases.push(`src/${src.slice(2)}`, src.slice(2))
      else if (!src.startsWith('@') && src.includes('/')) bases.push(src, `src/${src}`)
      else return []
      const cands: string[] = []
      for (const b of bases) {
        const noJs = b.replace(/\.(m|c)?js$/, '')
        cands.push(b, ...JS_EXTS.map(e => noJs + e), ...JS_EXTS.map(e => `${b}/index${e}`))
      }
      return this.firstExisting(cands)
    }
    if (lang === 'python') {
      const dots = /^\.*/.exec(src)![0].length
      const rest = src.slice(dots).replace(/\./g, '/')
      let base = dots ? dir : ''
      for (let i = 1; i < dots; i++) base = posix.dirname(base)
      const mod = rest ? posix.join(base || '.', rest) : base
      const asModule = this.firstExisting([`${mod}.py`, `${mod}/__init__.py`, `${mod}.pyi`])
      // `from . import helpers` imports a module file, not a name
      const sub = this.firstExisting([`${posix.join(mod || '.', imp.imported)}.py`, `${posix.join(mod || '.', imp.imported)}/__init__.py`])
      if (sub.length) return sub
      if (asModule.length || dots) return asModule
      return this.bySuffix([`/${rest}.py`, `/${rest}/__init__.py`])
    }
    if (lang === 'go') {
      // the package's folder: the longest folder whose path ends the import path
      let best: string | null = null
      for (const d of this.filesByDir.keys()) {
        if ((src === d || src.endsWith(`/${d}`)) && (!best || d.length > best.length)) best = d
      }
      return best ? (this.filesByDir.get(best) ?? []) : []
    }
    if (lang === 'java' || lang === 'kotlin') {
      if (imp.imported === '*') return []
      const rel = `${src.replace(/\./g, '/')}/${imp.imported}`
      return this.bySuffix([`${rel}.java`, `${rel}.kt`, `/${imp.imported}.java`, `/${imp.imported}.kt`])
    }
    return []
  }

  /** A file whose path ends with one of the suffixes, when exactly one does. */
  private bySuffix(suffixes: string[]): number[] {
    for (const suffix of suffixes) {
      const hits: number[] = []
      for (const [p, id] of this.idOf) if (p.endsWith(suffix) || `/${p}` === suffix) hits.push(id)
      if (hits.length === 1) return hits
    }
    return []
  }
}

type Hit = { dst: number; confidence: Confidence }

const containerOf = (q: string | null): string => (q && q.includes('.') ? q.slice(0, q.lastIndexOf('.')) : '')

/** Decides what one call or `new` points at. The first rule that matches wins. */
function match(ix: Index, r: R): Hit[] {
  const recv = r.receiver
  const imports = ix.imports.get(r.file_id) ?? []
  // `import { save as persist }`: a call to persist() is a call to save()
  const alias = !recv ? imports.find(i => i.local === r.name && i.imported !== '*' && i.imported !== 'default' && i.imported !== r.name) : undefined
  const name = alias ? alias.imported : r.name
  const all = ix.byName.get(name)
  if (!all?.length) return []
  const defs = r.kind === 'new' ? all.filter(d => BUILDS.has(d.kind)) : all
  if (!defs.length) return []

  // 1. the same file: a plain call, or one on this/self
  if (!alias && (!recv || SELF.test(recv))) {
    const same = defs.filter(d => d.file_id === r.file_id)
    if (same.length) {
      const home = containerOf(r.from_qualified)
      const inClass = same.filter(d => containerOf(d.qualified) === home || r.from_qualified?.startsWith(`${containerOf(d.qualified)}.`))
      const pick = (inClass.length ? inClass : same).slice(0, 1)
      return pick.map(d => ({ dst: d.id, confidence: 'resolved' }))
    }
  }

  // 2. through an import: `persist()` imported as an alias, or `store.save()` on an imported module or class
  const head = recv ? recv.split(/[.[(]/)[0]! : r.name
  const imp = imports.find(i => i.local === head)
  if (imp) {
    const targets = new Set(ix.targets(r.file_id, imp))
    if (targets.size) {
      let hits: S[]
      if (!recv) {
        hits = defs.filter(d => targets.has(d.file_id))
      } else {
        const cls = imp.imported !== '*' && imp.imported !== 'default' ? imp.imported : null
        hits = defs.filter(d => targets.has(d.file_id) && (!cls || d.qualified === `${cls}.${r.name}` || d.qualified.endsWith(`.${cls}.${r.name}`)))
        if (!hits.length) hits = defs.filter(d => targets.has(d.file_id))
      }
      if (hits.length) return hits.slice(0, 3).map(d => ({ dst: d.id, confidence: hits.length === 1 ? 'resolved' : 'ambiguous' }))
    }
  }

  // 3. called on a class by name: `Util.round()`
  if (recv) {
    const cls = recv.split('.').pop()!
    if (/^[A-Z]/.test(cls)) {
      const hits = defs.filter(d => d.qualified === `${cls}.${r.name}` || d.qualified.endsWith(`.${cls}.${r.name}`))
      if (hits.length >= 1 && hits.length <= 3) return hits.map(d => ({ dst: d.id, confidence: hits.length === 1 ? 'resolved' : 'ambiguous' }))
    }
  }

  const lang = ix.langOf.get(r.file_id) ?? ''
  const viaObject = !!recv && !SELF.test(recv)
  let pool: S[]
  if (viaObject) {
    // 4a. a method on an object of unknown type: only methods qualify, never the names every library has
    if (COMMON.has(name)) return []
    pool = defs.filter(d => d.kind === 'method' || (r.kind === 'new' && BUILDS.has(d.kind)))
  } else if (MODULE_SCOPED.has(lang)) {
    // 4b. a plain call that is neither in this file nor imported is a built-in or a global, not project code
    return []
  } else if (PACKAGE_SCOPED.has(lang)) {
    // 4c. the same package: other files in the same folder
    const dir = posix.dirname(ix.pathOf.get(r.file_id) ?? '')
    const near = defs.filter(d => posix.dirname(ix.pathOf.get(d.file_id) ?? '') === dir)
    pool = near.length ? near : defs
  } else {
    pool = defs
  }
  // 5. one candidate is a fair guess; two or three are listed as ambiguous; more is noise
  if (pool.length === 1) return [{ dst: pool[0]!.id, confidence: 'inferred' }]
  if (pool.length <= 3) return pool.map(d => ({ dst: d.id, confidence: 'ambiguous' }))
  return []
}

/**
 * Rebuilds the call links. With `files: 'all'` every call is matched again; otherwise only calls in
 * the changed files, plus calls anywhere to a name the changed files define (or used to define).
 */
export function resolve(store: Store, scope: { files: number[] | 'all'; names: Set<string> }): number {
  const ix = new Index(store)
  let refs: R[]
  if (scope.files === 'all') {
    store.sql('DELETE FROM edges').run()
    refs = store.sql('SELECT id, file_id, name, receiver, line, from_qualified, kind FROM refs').all() as R[]
  } else {
    const fileSet = new Set(scope.files)
    const picked = new Map<number, R>()
    const byFile = store.sql('SELECT id, file_id, name, receiver, line, from_qualified, kind FROM refs WHERE file_id = ?')
    for (const f of fileSet) for (const r of byFile.all(f) as R[]) picked.set(r.id, r)
    const byName = store.sql('SELECT id, file_id, name, receiver, line, from_qualified, kind FROM refs WHERE name = ?')
    for (const n of scope.names) for (const r of byName.all(n) as R[]) picked.set(r.id, r)
    refs = [...picked.values()]
    const drop = store.sql('DELETE FROM edges WHERE ref_id = ?')
    for (const r of refs) drop.run(r.id)
  }
  const add = store.sql('INSERT INTO edges(ref_id, src, src_file, dst, confidence, line) VALUES(?, ?, ?, ?, ?, ?)')
  let count = 0
  for (const r of refs) {
    const src = r.from_qualified ? (ix.byFileQualified.get(`${r.file_id}:${r.from_qualified}`) ?? null) : null
    for (const h of match(ix, r)) {
      if (h.dst === src) continue // a function naming itself, e.g. recursion, adds nothing to the map
      add.run(r.id, src, r.file_id, h.dst, h.confidence, r.line)
      count++
    }
  }
  return count
}

/**
 * Importance of every definition: PageRank over the call links, scaled so the average is 1.
 * Often-used code ranks higher in answers, which is what an agent usually needs first.
 */
export function rank(store: Store, iterations = 20, damping = 0.85): void {
  const ids = (store.sql('SELECT id FROM symbols').all() as { id: number }[]).map(r => r.id)
  const n = ids.length
  if (n === 0) return
  const pos = new Map(ids.map((id, i) => [id, i]))
  const out = new Map<number, number[]>()
  for (const e of store.sql('SELECT src, dst FROM edges WHERE src IS NOT NULL').all() as { src: number; dst: number }[]) {
    const a = pos.get(e.src)
    const b = pos.get(e.dst)
    if (a === undefined || b === undefined) continue
    const list = out.get(a)
    if (list) list.push(b)
    else out.set(a, [b])
  }
  let pr = new Float64Array(n).fill(1 / n)
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(n).fill((1 - damping) / n)
    let dangling = 0
    for (let i = 0; i < n; i++) {
      const targets = out.get(i)
      if (!targets?.length) dangling += pr[i]!
      else for (const t of targets) next[t]! += (damping * pr[i]!) / targets.length
    }
    const share = (damping * dangling) / n
    for (let i = 0; i < n; i++) next[i]! += share
    pr = next
  }
  // test code is used a lot by other test code; it should not outrank the code it tests
  const testy = new Set(
    (store.sql('SELECT s.id, f.path FROM symbols s JOIN files f ON f.id = s.file_id').all() as { id: number; path: string }[])
      .filter(r => TEST_PATH.test(r.path))
      .map(r => r.id),
  )
  const set = store.sql('UPDATE symbols SET rank = ? WHERE id = ?')
  store.tx(() => {
    for (let i = 0; i < n; i++) set.run(pr[i]! * n * (testy.has(ids[i]!) ? 0.25 : 1), ids[i]!)
  })
}

export const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|specs|fixtures?|mocks?|e2e|testdata)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/i
