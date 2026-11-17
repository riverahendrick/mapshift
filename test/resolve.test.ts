import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildNow, openMap } from '../src/map/indexer.ts'
import { makeRepo } from './helpers.ts'

const links = (root: string) =>
  (
    openMap(root)
      .sql(
        `SELECT s.qualified AS "from", d.qualified AS "to", e.confidence FROM edges e
         JOIN symbols d ON d.id = e.dst LEFT JOIN symbols s ON s.id = e.src`,
      )
      .all() as { from: string | null; to: string; confidence: string }[]
  ).map(l => ({ from: l.from, to: l.to, confidence: l.confidence }))

test('built-in methods on unknown objects are never linked to project code', async () => {
  const r = makeRepo({
    'src/helpers.test.ts': 'export function find() {}\nexport function trim() {}\n',
    'src/app.ts': 'export function run(xs: string[], s: string) { xs.find(Boolean); s.trim() }\n',
  })
  try {
    await buildNow(r.root)
    assert.deepEqual(links(r.root).filter(l => l.from === 'run'), [])
  } finally {
    r.cleanup()
  }
})

test('a plain call is never linked to another module that was not imported', async () => {
  const r = makeRepo({
    'a.ts': 'export function helper() {}\n',
    'b.ts': 'export function run() { helper() }\n',
    'c.py': 'def go():\n    helper()\n',
  })
  try {
    await buildNow(r.root)
    assert.deepEqual(links(r.root), [])
  } finally {
    r.cleanup()
  }
})

test('a distinctive method on an object of unknown type is a fair, labelled guess', async () => {
  const r = makeRepo({
    'repo.ts': 'export class OrderRepo { persistOrder(o: unknown) {} }\n',
    'svc.ts': 'export function place(db: any) { db.orders.persistOrder({}) }\n',
  })
  try {
    await buildNow(r.root)
    assert.deepEqual(links(r.root), [{ from: 'place', to: 'OrderRepo.persistOrder', confidence: 'inferred' }])
  } finally {
    r.cleanup()
  }
})

test('Go: a plain call reaches the same package in another file', async () => {
  const r = makeRepo({
    'pkg/a.go': 'package pkg\n\nfunc Helper() int { return 1 }\n',
    'pkg/b.go': 'package pkg\n\nfunc Run() int { return Helper() }\n',
    'other/c.go': 'package other\n\nfunc Helper() int { return 2 }\n',
  })
  try {
    await buildNow(r.root)
    const l = links(r.root).filter(x => x.from === 'Run')
    assert.equal(l.length, 1)
    const target = openMap(r.root)
      .sql('SELECT f.path FROM edges e JOIN symbols d ON d.id = e.dst JOIN files f ON f.id = d.file_id')
      .get() as { path: string }
    assert.equal(target.path, 'pkg/a.go')
  } finally {
    r.cleanup()
  }
})

test('a test helper never outranks the code it tests', async () => {
  const r = makeRepo({
    'src/core.ts': 'export function compute() { return 1 }\n',
    'src/core.test.ts':
      "import { compute } from './core'\nfunction check() { compute() }\n" +
      Array.from({ length: 20 }, (_, i) => `function t${i}() { check() }`).join('\n') +
      '\n',
  })
  try {
    await buildNow(r.root)
    const top = openMap(r.root).sql('SELECT qualified FROM symbols ORDER BY rank DESC LIMIT 1').get() as { qualified: string }
    assert.equal(top.qualified, 'compute')
  } finally {
    r.cleanup()
  }
})
