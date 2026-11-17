import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extract } from '../src/map/extract.ts'
import type { Facts } from '../src/map/types.ts'

const sym = (f: Facts, qualified: string) => f.syms.find(s => s.qualified === qualified)
const call = (f: Facts, name: string) => f.refs.find(r => r.name === name)

test('TypeScript: classes, methods, calls, receivers, imports and exports', async () => {
  const f = await extract(
    'typescript',
    `import { save as persist } from './store'
import Logger from './log'
import * as util from '../util'

export interface Priced { price: number }
export type Money = number
enum Mode { A, B }

export class Cart {
  total(items: Priced[]): Money {
    const sum = util.add(items)
    this.repo.save(sum)
    persist(sum)
    return Util.round(sum)
  }
  onClick = () => { helper() }
}

function helper() { new Logger() }
`,
  )
  assert.equal(sym(f, 'Cart')?.kind, 'class')
  assert.equal(sym(f, 'Cart')?.exported, true)
  assert.equal(sym(f, 'Cart.total')?.kind, 'method')
  assert.equal(sym(f, 'Cart.total')?.start, 10)
  assert.match(sym(f, 'Cart.total')!.signature, /^total\(items: Priced\[\]\): Money$/)
  assert.equal(sym(f, 'Cart.onClick')?.kind, 'method')
  assert.equal(sym(f, 'Priced')?.kind, 'interface')
  assert.equal(sym(f, 'Money')?.kind, 'type')
  assert.equal(sym(f, 'Mode')?.kind, 'enum')
  assert.equal(sym(f, 'helper')?.exported, false)

  assert.deepEqual(
    { ...call(f, 'save') },
    { name: 'save', receiver: 'this.repo', line: 12, from: 'Cart.total', kind: 'call' },
  )
  assert.equal(call(f, 'add')?.receiver, 'util')
  assert.equal(call(f, 'round')?.receiver, 'Util')
  assert.equal(call(f, 'persist')?.receiver, null)
  assert.equal(call(f, 'helper')?.from, 'Cart.onClick')
  assert.equal(f.refs.find(r => r.name === 'Logger')?.kind, 'new')

  assert.deepEqual(f.imps, [
    { source: './store', local: 'persist', imported: 'save' },
    { source: './log', local: 'Logger', imported: 'default' },
    { source: '../util', local: 'util', imported: '*' },
  ])
})

test('JavaScript: functions, arrow functions and require', async () => {
  const f = await extract(
    'javascript',
    `const { load, parse: readIt } = require('./io')
const fs = require('fs')
export const run = async (p) => { const d = load(p); return readIt(d) }
module.exports.go = function () { run(1) }
`,
  )
  assert.equal(sym(f, 'run')?.kind, 'function')
  assert.equal(sym(f, 'run')?.exported, true)
  assert.equal(call(f, 'load')?.from, 'run')
  assert.ok(f.imps.some(i => i.local === 'readIt' && i.imported === 'parse' && i.source === './io'))
  assert.ok(f.imps.some(i => i.local === 'fs' && i.imported === '*'))
})

test('TSX: a component and the calls in it', async () => {
  const f = await extract('tsx', `export function Button({ label }: { label: string }) { return <b onClick={() => track(label)}>{label}</b> }\n`)
  assert.equal(sym(f, 'Button')?.kind, 'function')
  assert.equal(call(f, 'track')?.from, 'Button')
})

test('Python: classes, methods, calls and relative imports', async () => {
  const f = await extract(
    'python',
    `from .store import save as persist
from ..util import add
import os.path

class Cart:
    def total(self, items):
        s = add(items)
        self.repo.save(s)
        return persist(s)

def _helper():
    Cart().total([])
`,
  )
  assert.equal(sym(f, 'Cart.total')?.kind, 'method')
  assert.equal(sym(f, '_helper')?.exported, false)
  assert.equal(call(f, 'save')?.receiver, 'self.repo')
  assert.equal(call(f, 'add')?.from, 'Cart.total')
  assert.deepEqual(f.imps, [
    { source: '.store', local: 'persist', imported: 'save' },
    { source: '..util', local: 'add', imported: 'add' },
    { source: 'os.path', local: 'os', imported: '*' },
  ])
})

test('Go: functions, methods, selector calls and imports', async () => {
  const f = await extract(
    'go',
    `package cart

import (
  "fmt"
  st "example.com/app/store"
)

type Cart struct{}

func (c *Cart) Total() int { st.Save(1); fmt.Println("x"); return helper() }

func helper() int { return 1 }
`,
  )
  assert.equal(sym(f, 'Total')?.kind, 'method')
  assert.equal(sym(f, 'Total')?.exported, true)
  assert.equal(sym(f, 'helper')?.exported, false)
  assert.equal(sym(f, 'Cart')?.kind, 'type')
  assert.equal(call(f, 'Save')?.receiver, 'st')
  assert.equal(call(f, 'helper')?.from, 'Total')
  assert.deepEqual(f.imps, [
    { source: 'fmt', local: 'fmt', imported: '*' },
    { source: 'example.com/app/store', local: 'st', imported: '*' },
  ])
})

test('Java: classes, methods, calls and imports', async () => {
  const f = await extract(
    'java',
    `package shop;
import shop.store.Repo;
import java.util.*;

public class Cart {
  private Repo repo;
  public int total() { repo.save(1); return Util.round(2); }
  private void helper() { total(); }
}
`,
  )
  assert.equal(sym(f, 'Cart.total')?.kind, 'method')
  assert.equal(sym(f, 'Cart.helper')?.exported, false)
  assert.equal(call(f, 'save')?.receiver, 'repo')
  assert.equal(call(f, 'round')?.receiver, 'Util')
  assert.equal(call(f, 'total')?.from, 'Cart.helper')
  assert.deepEqual(f.imps, [
    { source: 'shop.store', local: 'Repo', imported: 'Repo' },
    { source: 'java.util', local: '*', imported: '*' },
  ])
})

test('Kotlin: classes, functions, calls and imports', async () => {
  const f = await extract(
    'kotlin',
    `package shop
import shop.store.Repo as Store

class Cart {
  fun total(): Int { repo.save(1); return helper() }
}

fun helper(): Int = 1
`,
  )
  assert.equal(sym(f, 'Cart')?.kind, 'class')
  assert.equal(sym(f, 'Cart.total')?.kind, 'method')
  assert.equal(call(f, 'helper')?.from, 'Cart.total')
  assert.equal(call(f, 'save')?.receiver, 'repo')
  assert.deepEqual(f.imps, [{ source: 'shop.store', local: 'Store', imported: 'Repo' }])
})

test('C#: classes, methods, calls and usings', async () => {
  const f = await extract(
    'csharp',
    `using System;
using Shop.Store;

namespace Shop {
  public class Cart {
    public int Total() { repo.Save(1); return Helper(); }
    private int Helper() { return 1; }
  }
}
`,
  )
  assert.ok(f.syms.some(s => s.name === 'Cart' && s.kind === 'class'))
  assert.ok(f.syms.some(s => s.name === 'Total' && s.kind === 'method'))
  assert.equal(call(f, 'Save')?.receiver, 'repo')
  assert.match(call(f, 'Helper')?.from ?? '', /Total$/)
  assert.deepEqual(f.imps, [
    { source: 'System', local: '*', imported: '*' },
    { source: 'Shop.Store', local: '*', imported: '*' },
  ])
})

test('broad languages give definitions and calls', async () => {
  const rust = await extract('rust', 'pub fn total() -> i32 { helper() }\nfn helper() -> i32 { 1 }\n')
  assert.equal(sym(rust, 'total')?.exported, true)
  assert.equal(call(rust, 'helper')?.from, 'total')
  const php = await extract('php', '<?php\nclass Cart { function total() { return $this->helper(); } }\n')
  assert.ok(php.syms.some(s => s.name === 'total'))
  const dart = await extract('dart', 'class Cart { int total() { return helper(); } }\nint helper() => 1;\n')
  assert.ok(dart.syms.some(s => s.name === 'Cart'))
  const ps = await extract('powershell', 'function Get-Total { Write-Host "x" }\n')
  assert.ok(ps.syms.some(s => s.name === 'Get-Total'))
})

test('Vue: script blocks are read with their real line numbers', async () => {
  const f = await extract('vue', `<template>\n  <div>{{ x }}</div>\n</template>\n<script setup lang="ts">\nimport { api } from './api'\nfunction load() { api.get() }\n</script>\n`)
  assert.equal(sym(f, 'load')?.start, 6)
  assert.equal(call(f, 'get')?.receiver, 'api')
  assert.deepEqual(f.imps, [{ source: './api', local: 'api', imported: 'api' }])
})

test('a broken file still gives what can be read', async () => {
  const f = await extract('typescript', 'export function ok() { fine() }\nfunction broken( {{{\n')
  assert.ok(sym(f, 'ok'))
})
