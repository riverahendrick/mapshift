import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildNow, openMap } from '../src/map/indexer.ts'
import { CATALOG, guessRank, modelInfo, pick, providerOf } from '../src/router/catalog.ts'
import { advise } from '../src/router/route.ts'
import { mapLift, mapSignals } from '../src/router/signals.ts'
import { makeRepo } from './helpers.ts'

test('every provider has a light, standard and strong model with dated, sourced prices', () => {
  for (const p of ['anthropic', 'openai', 'google', 'xai'] as const) {
    for (const r of ['light', 'standard', 'strong'] as const) assert.ok(CATALOG.some(e => e.provider === p && e.rank === r), `${p} ${r}`)
  }
  for (const e of CATALOG) {
    assert.match(e.checked, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(e.source, /^https:\/\//)
    assert.ok(e.price.in > 0 && e.price.out >= e.price.in && e.price.read < e.price.in, e.id)
  }
})

test('models are recognised by provider, and new releases are placed by name', () => {
  assert.equal(providerOf('claude-opus-5-5[1m]'), 'anthropic')
  assert.equal(providerOf('gpt-6.1-sol'), 'openai')
  assert.equal(providerOf('gemini-4-argon'), 'google')
  assert.equal(providerOf('gemini-4-neon'), 'google')
  assert.equal(providerOf('grok-build-0.1'), 'xai')
  assert.equal(modelInfo('claude-opus-5-5[1m]')?.rank, 'strong')
  assert.equal(modelInfo('gemini-4-neon')?.rank, 'strong')
  assert.equal(modelInfo('gemini-4-neon')?.known, true)
  assert.ok(modelInfo('gemini-4-neon')?.efforts.includes('xhigh'))
  assert.equal(modelInfo('gemini-3.8-flash')?.rank, 'light')
  assert.equal(modelInfo('gemini-3.8-flash')?.known, true)
  assert.equal(pick('google', 'strong').id, 'gemini-4-neon')
  assert.equal(pick('google', 'frontier', { allowFrontier: true }).id, 'gemini-4-carbon')
  assert.equal(modelInfo('gpt-7-nano')?.known, false)
  assert.equal(guessRank('gpt-7-nano'), 'light')
  assert.equal(guessRank('gemini-5-pro'), 'strong')
  assert.equal(guessRank('gemini-5-neon'), 'strong')
  assert.equal(guessRank('gemini-5-flash'), 'standard')
  assert.equal(guessRank('gemini-5-flash-lite'), 'light')
  assert.equal(modelInfo('mystery-model'), null)
})

test('frontier models are only picked when allowed', () => {
  assert.equal(pick('openai', 'frontier').id, 'gpt-6.1-sol')
  assert.equal(pick('openai', 'frontier', { allowFrontier: true }).id, 'gpt-6-astra')
  assert.equal(pick('xai', 'frontier', { allowFrontier: true }).id, 'grok-4.7') // none higher: closest below
})

test('advice per provider: a quick question goes light, risky work goes strong', () => {
  const quick = advise({ text: 'what does this function return?', provider: 'openai', currentModel: 'gpt-6.1-sol' })
  assert.equal(quick.model.rank, 'light')
  assert.equal(quick.change, 'down')
  const risky = advise({ text: 'Refactor the auth module to fix a race condition and migrate the schema', provider: 'google', currentModel: 'gemini-4-hydrogen' })
  assert.equal(risky.model.rank, 'strong')
  assert.equal(risky.change, 'up')
  assert.ok(['high', 'xhigh'].includes(risky.effort))
  assert.equal(risky.helper.rank, 'light')
})

test('the map raises a request whose change spreads far, and never lowers one', async () => {
  const files: Record<string, string> = { 'core/money.ts': 'export function toCents(x: number) { return x }\n' }
  for (let i = 0; i < 26; i++) files[`feature${i}/use.ts`] = `import { toCents } from '../core/money'\nexport function use${i}() { return toCents(${i}) }\n`
  const r = makeRepo(files)
  try {
    await buildNow(r.root)
    const store = openMap(r.root)
    const s = mapSignals(store, 'change toCents to round half up')
    assert.deepEqual(s.matched, ['toCents'])
    assert.equal(s.reach, 26)
    assert.ok(mapLift(s).lift >= 1)
    const plain = advise({ text: 'change toCents to round half up', provider: 'anthropic' })
    const mapped = advise({ text: 'change toCents to round half up', provider: 'anthropic', store })
    assert.notEqual(plain.tier, mapped.tier)
    assert.match(mapped.reasons[0]!, /^The map shows the change reaches 26 definitions/)
    const unrelated = advise({ text: 'what is 2 + 2', provider: 'anthropic', store })
    assert.equal(unrelated.tier, advise({ text: 'what is 2 + 2', provider: 'anthropic' }).tier)
    // a question about widely used code is still just a question
    const question = advise({ text: 'what does toCents return?', provider: 'anthropic', store })
    assert.equal(question.tier, advise({ text: 'what does toCents return?', provider: 'anthropic' }).tier)
  } finally {
    r.cleanup()
  }
})
