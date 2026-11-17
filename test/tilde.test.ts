import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tildePath } from '../src/dashboard/snapshot.ts'
import { plainReason, pretty } from '../src/cli/format.ts'

test('the dashboard writes the home folder as ~, so no user name shows', () => {
  assert.equal(tildePath('C:\\Users\\Ana\\code\\app', 'C:\\Users\\Ana'), '~/code/app')
  assert.equal(tildePath('c:/users/ana/code/app', 'C:\\Users\\Ana'), '~/code/app')
  assert.equal(tildePath('/home/ana/app', '/home/ana'), '~/app')
  assert.equal(tildePath('/srv/app', '/home/ana'), '/srv/app')
  assert.equal(tildePath('/home/anabel/app', '/home/ana'), '/home/anabel/app', 'a longer name is not a match')
})

test('the command line reads answers and reasons as plain text', () => {
  const out = pretty('Map · 1 result for "x"\n\n### 1. save · function · a.ts:1-3\nCalled by: run (b.ts:2)\n```ts\n1  function save() {}\n```')
  assert.ok(!out.includes('```') && !out.includes('### '))
  assert.match(out, /save · function · a\.ts:1-3/)
  assert.equal(plainReason('hard: refactor'), 'Hard work (refactor)')
  assert.equal(plainReason('3 files'), 'Touches 3 files')
})
