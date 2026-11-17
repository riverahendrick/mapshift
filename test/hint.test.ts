import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildNow, openMap } from '../src/map/indexer.ts'
import { HINT_LIMITS, startingPoints } from '../src/map/hint.ts'
import { makeRepo } from './helpers.ts'

const FILES = {
  'src/payments/refund.ts': `import { ledger } from '../ledger'
export function refundPayment(id: string, amount: number) { return ledger.write(id, -amount) }
export function refundPolicy() { return 30 }
`,
  'src/ledger.ts': 'export const ledger = { write(id: string, n: number) { return n } }\n',
  'src/orders/cancel.ts': `import { refundPayment } from '../payments/refund'
export function cancelOrder(id: string) { return refundPayment(id, 10) }
`,
  'src/payments/refund.test.ts': `import { refundPayment } from './refund'
function refundPaymentTest() { refundPayment('a', 1) }
`,
}

test('a request that names a function gets it, with its signature and a caller', async () => {
  const r = makeRepo(FILES)
  try {
    await buildNow(r.root)
    const a = startingPoints(openMap(r.root), 'make refundPayment reject negative amounts')
    assert.ok(a)
    assert.match(a.text, /^Mapshift code map: likely starting points/)
    assert.match(a.text, /- refundPayment · function · src\/payments\/refund\.ts:2/)
    assert.match(a.text, /used 2×, e\.g\. by cancelOrder/) // the code caller is named; the test call is counted, not named
    assert.deepEqual(a.files[0], 'src/payments/refund.ts')
    assert.ok(!a.text.includes('refund.test.ts'), 'tests stay out unless asked for')
  } finally {
    r.cleanup()
  }
})

test('plain words only give a hint when they all fit one definition', async () => {
  const r = makeRepo(FILES)
  try {
    await buildNow(r.root)
    const store = openMap(r.root)
    assert.match(startingPoints(store, 'where do we cancel an order?')?.text ?? '', /cancelOrder/)
    assert.equal(startingPoints(store, 'thanks, looks good'), null)
    assert.equal(startingPoints(store, 'what is the weather like'), null)
    assert.equal(startingPoints(store, 'refund'), null, 'one vague word is not enough')
  } finally {
    r.cleanup()
  }
})

test('a hint stays short', async () => {
  const many: Record<string, string> = {}
  for (let i = 0; i < 12; i++) many[`src/m${i}.ts`] = `export function saveOrderRecord${i}(${'a: string, '.repeat(30)}z: string) {}\n`
  const r = makeRepo(many)
  try {
    await buildNow(r.root)
    const a = startingPoints(openMap(r.root), 'save order record')
    assert.ok(a && a.text.length <= HINT_LIMITS.chars)
  } finally {
    r.cleanup()
  }
})
