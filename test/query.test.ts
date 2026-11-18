import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildNow, openMap } from '../src/map/indexer.ts'
import { fileApi, find, LIMITS, overview, personalizedRank, search, terms, trace } from '../src/map/query.ts'
import { makeRepo } from './helpers.ts'

const FILES = {
  'src/cart.ts': `import { save } from './store'
export class Cart {
  total(items: number[]) {
    const sum = items.reduce((a, b) => a + b, 0)
    save(sum)
    return sum
  }
}
`,
  'src/store.ts': `export function save(x: number) { return write(x) }
function write(x: number) { return x }
`,
  'src/checkout.ts': `import { Cart } from './cart'
export function checkout() { return new Cart().total([1, 2]) }
`,
  'test/cart.test.ts': `import { Cart } from '../src/cart'
function totalTest() { new Cart().total([]) }
`,
}

test('question words and exact names are both understood', () => {
  const t = terms('How does the getTotal function in Cart.total work?')
  assert.deepEqual(t.names, ['getTotal', 'Cart.total'])
  assert.ok(t.words.includes('total') && !t.words.includes('how'))
})

test('find: the exact name ranks first, source above tests, with callers, calls and code', async () => {
  const r = makeRepo(FILES)
  try {
    await buildNow(r.root)
    const store = openMap(r.root)
    const a = find(store, r.root, 'Cart.total')
    assert.match(a.text, /^Map · \d+ results? for "Cart.total"/)
    assert.match(a.text, /### 1\. Cart\.total · method · src\/cart\.ts:3-7/)
    assert.match(a.text, /Called by: checkout \(src\/checkout\.ts:2\)/)
    assert.match(a.text, /Calls: save \(src\/store\.ts:1\)/)
    assert.match(a.text, /\n3 {4}total\(items: number\[\]\) \{/)
    assert.equal(a.files[0], 'src/cart.ts')

    const words = find(store, r.root, 'total')
    const firstSource = words.text.indexOf('src/cart.ts')
    const firstTest = words.text.indexOf('test/cart.test.ts')
    assert.ok(firstSource >= 0 && (firstTest < 0 || firstSource < firstTest), 'source before tests')

    const none = find(store, r.root, 'zzzqqq')
    assert.match(none.text, /no matches/)
    assert.deepEqual(none.files, [])
  } finally {
    r.cleanup()
  }
})

test('the walk with restart gathers mass at the node that ties the seeds together', () => {
  // three seeds, each linked only to the hub (4); an isolated seed (5) keeps its own share only
  const adjacency = new Map<number, number[]>([
    [1, [4]],
    [2, [4]],
    [3, [4]],
    [4, [1, 2, 3]],
  ])
  const pr = personalizedRank(new Map([[1, 1], [2, 0.8], [3, 0.6], [5, 1]]), adjacency)
  assert.equal(pr.get(4), 1, 'the hub is the centre')
  assert.ok((pr.get(5) ?? 0) < 1 && (pr.get(5) ?? 0) > 0)
  assert.equal(personalizedRank(new Map(), adjacency).size, 0)
})

test('find: the function that calls every matched helper moves up to second place, the best match stays first', async () => {
  const r = makeRepo({
    // three helpers that match the question in their comments, and the entry point that calls them all,
    // which matches only two of its words itself: on words alone it ranks last
    'src/cidr.js': [
      ['splitEntry', 'cidr prefix mask bits: split one entry'],
      ['maskOf', 'cidr prefix mask bits: the mask of an entry, from its prefix length'],
      ['bitsFor', 'cidr prefix mask bits: the bits of a host address'],
    ]
      .map(([n, doc]) => `/** ${doc} */\nexport function ${n}(value) { return value.split('/') }\n`)
      .join('') + `
// checks the cidr prefix list
export function shouldSkip(host, entries) {
  return entries.some(e => splitEntry(e) && maskOf(e) && bitsFor(host))
}
`,
    // strong word matches wired to nothing: on words alone they all rank above the entry point
    'src/labels.js': ['cidrPrefixLabel', 'maskBitsText', 'prefixMaskNote', 'cidrBitsName', 'prefixBitsTitle', 'maskCidrCaption']
      .map(n => `/** cidr prefix mask bits */\nexport function ${n}(x) { return x }\n`)
      .join(''),
  })
  try {
    await buildNow(r.root)
    const store = openMap(r.root)
    const order = [...find(store, r.root, 'cidr prefix mask bits', { limit: 6 }).text.matchAll(/### \d\. (\S+)/g)].map(m => m[1])
    assert.equal(order.indexOf('shouldSkip'), 1, `entry point second: ${order.join(', ')}`)
    // an exact name is never reordered
    assert.match(find(store, r.root, 'maskBitsText').text, /### 1\. maskBitsText/)
  } finally {
    r.cleanup()
  }
})

test('trace: two definitions of one name in one file each keep their own calls', async () => {
  const r = makeRepo({
    'pkg/io.py': `import sys
if sys.platform == "win32":
    def read():
        return helper(1)
else:
    def read():
        return helper(2)

def helper(x):
    return x
`,
  })
  try {
    await buildNow(r.root)
    const text = trace(openMap(r.root), r.root, 'helper').text
    assert.match(text, /- read \(pkg\/io\.py:4\)/)
    assert.match(text, /- read \(pkg\/io\.py:7\)/)
    assert.doesNotMatch(text, /×2/)
  } finally {
    r.cleanup()
  }
})

test('a file of saved terminal colour codes is listed as not mapped, not parsed', async () => {
  const esc = '\x1b'
  const r = makeRepo({
    'src/app.swift': 'func real() { helper() }\nfunc helper() {}\n',
    'tests/highlighted/test.swift': `${esc}[38;2;1;2;3mfunc${esc}[0m ${esc}[38;2;4;5;6mshown${esc}[0m() {\n${esc}[1m}${esc}[0m\n`,
  })
  try {
    await buildNow(r.root)
    const store = openMap(r.root)
    assert.deepEqual(store.skipped(), [{ path: 'tests/highlighted/test.swift', reason: 'terminal output' }])
    assert.match(find(store, r.root, 'real').text, /### 1\. real/)
  } finally {
    r.cleanup()
  }
})

test('find keeps answers under the size limit', async () => {
  const many: Record<string, string> = {}
  for (let i = 0; i < 30; i++) many[`src/m${i}.ts`] = `export function handler${i}() {\n${'  step()\n'.repeat(40)}}\nfunction step() {}\n`
  const r = makeRepo(many)
  try {
    await buildNow(r.root)
    const a = find(openMap(r.root), r.root, 'handler', { limit: 15 })
    assert.ok(a.text.length <= LIMITS.findChars + 600, `answer was ${a.text.length} chars`)
  } finally {
    r.cleanup()
  }
})

test('trace: callers, callees and impact', async () => {
  const r = makeRepo(FILES)
  try {
    await buildNow(r.root)
    const store = openMap(r.root)
    const callers = trace(store, r.root, 'write', { direction: 'in', depth: 3 })
    assert.match(callers.text, /write · function · src\/store\.ts:2 is called by:/)
    assert.match(callers.text, /- save \(src\/store\.ts:1\)/)
    assert.match(callers.text, / {4}- Cart\.total \(src\/cart\.ts:5\)/)
    const callees = trace(store, r.root, 'Cart.total', { direction: 'out' })
    assert.match(callees.text, /- save \(src\/store\.ts:1\)/)
    const impact = trace(store, r.root, 'save', { direction: 'impact' })
    assert.match(impact.text, /Impact: \d+ definitions in \d+ files within 3 steps\./)
    assert.match(trace(store, r.root, 'nothing_here').text, /no definition named/)
    assert.match(trace(store, r.root, 'src/store.ts:2').text, /^write · function/)
  } finally {
    r.cleanup()
  }
})

test('file API lists every definition in order, nested ones indented', async () => {
  const r = makeRepo(FILES)
  try {
    await buildNow(r.root)
    const a = fileApi(openMap(r.root), r.root, 'cart.ts')
    assert.match(a.text, /^Map · src\/cart\.ts · TypeScript · \d+ lines · 2 definitions/)
    assert.match(a.text, /\n2-8 class Cart: class Cart\n {2}3-7 method total: total\(items: number\[\]\)/)
    assert.match(fileApi(openMap(r.root), r.root, 'nope.ts').text, /no mapped file/)
  } finally {
    r.cleanup()
  }
})

test('overview names languages, folders, entry points and hubs', async () => {
  const r = makeRepo({ ...FILES, 'src/index.ts': 'export * from "./cart"\n' })
  try {
    await buildNow(r.root)
    const a = overview(openMap(r.root), r.root)
    assert.match(a.text, /· 5 files ·/)
    assert.match(a.text, /Languages: TypeScript 5/)
    assert.match(a.text, /- src\/index\.ts/)
    assert.match(a.text, /Most used definitions:/)
  } finally {
    r.cleanup()
  }
})

test('search finds every matching line, grouped by definition, with a valid-pattern check', async () => {
  const r = makeRepo(FILES)
  try {
    await buildNow(r.root)
    const store = openMap(r.root)
    const a = search(store, r.root, 'total(')
    assert.match(a.text, /matching lines for "total\("/)
    assert.match(a.text, /src\/checkout\.ts · checkout\n {2}2: export function checkout/)
    assert.match(a.text, /test\/cart\.test\.ts · totalTest/)
    assert.match(search(store, r.root, 'Total', { ignoreCase: false }).text, /no lines match/)
    assert.match(search(store, r.root, 'sa+ve\\(', { regex: true }).text, /src\/cart\.ts · Cart\.total/)
    assert.match(search(store, r.root, '(', { regex: true }).text, /not a valid regular expression/)
    assert.match(search(store, r.root, 'save', { path: 'src/store' }).text, /in 1 files/)
  } finally {
    r.cleanup()
  }
})
