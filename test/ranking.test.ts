import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoId } from '../src/core/paths.ts'
import { buildNow, openMap } from '../src/map/indexer.ts'
import { coverage, distinctFirst, find, LIMITS, nameFit, queryTerms, stemWord, type QueryTerm } from '../src/map/query.ts'
import { makeRepo } from './helpers.ts'

const top = (text: string): string[] => [...text.matchAll(/^### \d+\. (\S+) ·/gm)].map(m => m[1]!)
const forms = (t: QueryTerm | undefined) => Object.fromEntries((t?.forms ?? []).map(f => [f.prefix, f]))

test('stemWord makes plurals singular and leaves everything else alone', () => {
  assert.equal(stemWord('headers'), 'header')
  assert.equal(stemWord('retries'), 'retry')
  assert.equal(stemWord('matches'), 'match')
  assert.equal(stemWord('processes'), 'process')
  for (const same of ['status', 'class', 'analysis', 'combined', 'running', 'flag', 'args', 'speed']) assert.equal(stemWord(same), same)
})

test('queryTerms: filler leaves sentences but stays in keyword bags, and never leaves nothing', () => {
  const sentence = queryTerms(['two', 'sets', 'headers', 'combined'], [], '', true).map(t => t.word)
  assert.deepEqual(sentence, ['sets', 'headers', 'combined'])
  const bag = queryTerms(['has', 'all', 'flags'], [], '', false).map(t => t.word)
  assert.deepEqual(bag, ['has', 'all', 'flags'])
  assert.deepEqual(queryTerms(['all', 'some'], [], '', true).map(t => t.word), ['all', 'some'], 'only filler: keep it rather than search for nothing')
})

test('queryTerms: abbreviations and synonyms are added with less weight, short forms as whole words', () => {
  const [env] = queryTerms(['environment'], [])
  assert.equal(forms(env)['environment']?.weight, 1)
  assert.deepEqual(forms(env)['env'], { prefix: 'env', weight: 0.9, whole: true }, 'a short form of a long word: whole word only')
  const [opts] = queryTerms(['opts'], [])
  assert.equal(forms(opts)['option']?.weight, 0.9)
  assert.equal(forms(opts)['option']?.whole, false, 'the longer spelling is still a prefix search')
  const [widget] = queryTerms(['widgets'], [])
  assert.deepEqual(widget?.forms, [{ prefix: 'widget', weight: 1, whole: false }], 'no other spelling for a word that is not listed')
  const [comb] = queryTerms(['combined'], [])
  assert.equal(forms(comb)['merge']?.weight, 0.5, 'a listed word is found under its plain form too')
})

test('queryTerms: the project name counts for little', () => {
  const qt = queryTerms(['cobra', 'suggestions'], [], 'cobra')
  assert.equal(qt.find(t => t.word === 'cobra')?.weight, 0.25)
  assert.equal(qt.find(t => t.word === 'suggestions')?.weight, 1)
})

test('coverage: a definition with most of the question beats one with a single word', () => {
  const qt = queryTerms(['merge', 'request', 'headers'], [])
  const both = coverage(qt, ' merge headers source request ')
  const one = coverage(qt, ' request body stream ')
  assert.ok(both > one && one > 0)
  assert.equal(coverage(qt, ' unrelated words '), 0)
  // a rare term counts for more than a common one
  qt[0]!.idf = 4
  qt[1]!.idf = 1
  qt[2]!.idf = 1
  assert.ok(coverage(qt, ' merge ') > coverage(qt, ' request '))
  // whole-word forms do not match longer words
  const [res] = queryTerms(['response'], [])
  assert.equal(coverage([res!], ' result value '), 0)
  assert.equal(coverage([res!], ' res value '), 0.9)
})

test('nameFit: a near-miss name fits the real one best, and small words in names are ignored', () => {
  const qt = queryTerms([], ['normalize', 'retry', 'opts'])
  assert.ok(nameFit(qt, 'normalizeRetryOptions') > nameFit(qt, 'normalizeRetryMethod'))
  assert.equal(nameFit(queryTerms(['retry', 'error'], []), 'Ky.#retryFromError'.split('.').pop()!), 1)
  const withProject = queryTerms(['ky', 'error'], [], 'ky')
  assert.ok(nameFit(withProject, 'KyError') < nameFit(withProject, 'error'), 'the project name barely helps a name fit')
  assert.equal(nameFit(qt, ''), 0)
})

test('distinctFirst puts one entry per definition first, the longest of a group, and drops nothing', () => {
  const h = (q: string, start: number, end: number) => ({ path: 'a.py', qualified: q, start, end })
  const ranked = [h('invoke', 1, 2), h('invoke', 4, 4), h('forward', 10, 20), h('invoke', 6, 40), h('other', 50, 51)]
  const out = distinctFirst(ranked)
  assert.equal(out.length, ranked.length)
  assert.deepEqual(
    out.map(x => `${x.qualified}@${x.start}`),
    ['invoke@6', 'forward@10', 'other@50', 'invoke@1', 'invoke@4'],
  )
})

const FILES = {
  'src/merge.ts': `export function mergeHeaders(source1: Headers, source2: Headers) {
  const result = new Headers(source1)
  for (const [key, value] of new Headers(source2)) result.set(key, value)
  return result
}
`,
  'src/headers.ts': `/** Headers that every request sends. */
export function defaultRequestHeaders() { return { accept: 'application/json' } }
export function toHeaderObject(source: Headers) { return Object.fromEntries(source) }
`,
  'src/retry.ts': `export function normalizeRetryOptions(retry: number | object) { return typeof retry === 'number' ? { limit: retry } : retry }
export function normalizeRetryMethod(method: string) { return method.toLowerCase() }
export function normalizeRequestMethod(method: string) { return method.toUpperCase() }
`,
  'src/flags.ts': `export function hasAllFlags(names: string[]) { return names.length > 0 }
export function localFlags() { return [] }
export function persistentFlags() { return [] }
export function inheritedFlags() { return [] }
`,
}

test('find: plain words, synonyms, near-miss names and keyword bags reach the right definition', async () => {
  const r = makeRepo(FILES)
  try {
    await buildNow(r.root)
    const store = openMap(r.root)
    assert.equal(top(find(store, r.root, 'Where are two sets of headers combined into one?', { limit: 3 }).text)[0], 'mergeHeaders')
    assert.equal(top(find(store, r.root, 'normalizeRetryOpts()', { limit: 3 }).text)[0], 'normalizeRetryOptions')
    assert.equal(top(find(store, r.root, 'has all flags', { limit: 3 }).text)[0], 'hasAllFlags')
    // reranking reorders, it never filters: the result count is the same as the limit allows
    assert.equal(top(find(store, r.root, 'flags', { limit: 4 }).text).length, 4)
  } finally {
    r.cleanup()
  }
})

test('find shows the most code for the best match and the start of the others', async () => {
  const long = (name: string) => `export function ${name}() {\n${'  step()\n'.repeat(20)}}\nfunction step() {}\n`
  const r = makeRepo({ 'src/a.ts': long('saveOrderNow'), 'src/b.ts': long('saveOrderLater') })
  try {
    await buildNow(r.root)
    const blocks = find(openMap(r.root), r.root, 'save order', { limit: 2 }).text.split(/^### /m).slice(1)
    const shown = (b: string) => (b.match(/^\s*\d+ {2}/gm) ?? []).length
    assert.equal(blocks.length, 2)
    assert.equal(shown(blocks[0]!), LIMITS.codeLines)
    assert.equal(shown(blocks[1]!), LIMITS.otherCodeLines)
    assert.match(blocks[1]!, /… 16 more lines/)
  } finally {
    r.cleanup()
  }
})

test('repoId remembers a repository for the life of the process, but asks again for a folder that is not one yet', () => {
  const r = makeRepo({ 'a.ts': 'export const a = 1\n' })
  const plain = makeRepo({ 'b.ts': 'export const b = 1\n' }, { git: false })
  try {
    const id = repoId(r.root)
    renameSync(join(r.root, '.git'), join(r.root, 'moved.git'))
    assert.equal(repoId(r.root), id, 'remembered: no second git call')
    renameSync(join(r.root, 'moved.git'), join(r.root, '.git'))

    const before = repoId(plain.root)
    execFileSync('git', ['init', '-q'], { cwd: plain.root, stdio: 'ignore', windowsHide: true })
    assert.notEqual(repoId(plain.root), before, 'a folder that became a repository gets its repository id')
  } finally {
    r.cleanup()
    plain.cleanup()
  }
})
