import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildNow, openMap } from '../src/map/indexer.ts'
import { fileApi, find, LIMITS, overview, search, terms, trace } from '../src/map/query.ts'
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
