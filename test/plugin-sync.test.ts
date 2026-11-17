import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// Read as text on purpose: the plugin's files are typed against the plugin engine, not this package.
const root = join(import.meta.dirname, '..')
const text = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')

test('the Claude Code plugin runs the same routing brain (run `node scripts/sync-plugin.mjs` after changing it)', () => {
  const source = text('src', 'router', 'brain.ts')
  const copy = text('plugins', 'claude-code', 'hooks', 'brain.ts')
  assert.ok(source.includes("from './types.ts'"), 'the brain imports its types from ./types.ts')
  assert.ok(copy.includes("from '../types'"), "the plugin copy imports its types from '../types'")
  const a = source.split('\n')
  const b = copy.split('\n')
  assert.equal(b.length, a.length, 'the plugin brain has a different number of lines')
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    assert.equal(b[i], a[i]!.replace("from './types.ts'", "from '../types'"), `plugin brain differs at line ${i + 1}`)
  }
})

/** `export type Name = ...` declarations of a file, comments dropped and whitespace collapsed. */
function typeDecls(src: string): Map<string, string> {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out = new Map<string, string>()
  const re = /export type (\w+)\s*=\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean))) {
    let i = re.lastIndex
    let depth = 0
    for (; i < clean.length; i++) {
      const c = clean[i]
      if (c === '{' || c === '(' || c === '[') depth++
      else if (c === '}' || c === ')' || c === ']') depth--
      else if (c === '\n' && depth === 0 && !/^\s*\|/.test(clean.slice(i + 1))) break
    }
    out.set(m[1]!, clean.slice(re.lastIndex, i).replace(/\s+/g, ' ').trim())
  }
  return out
}

const fields = (body: string) =>
  new Map(
    body
      .replace(/^\{|\}$/g, '')
      .split(/[;\n]| (?=\w+\??:)/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => [s.slice(0, s.indexOf(':')).trim(), s.slice(s.indexOf(':') + 1).trim()] as const),
  )

test('every type the brain uses has the same shape in the plugin contract', () => {
  const brain = text('src', 'router', 'brain.ts')
  const used = /import type \{([^}]+)\} from '\.\/types\.ts'/.exec(brain)![1]!.split(',').map(s => s.trim())
  const core = typeDecls(text('src', 'router', 'types.ts'))
  const plugin = typeDecls(text('plugins', 'claude-code', 'types', 'index.d.ts'))
  // the types those types refer to must match too
  const names = new Set([...used, 'View'])
  for (const name of names) {
    const a = core.get(name)
    const b = plugin.get(name)
    assert.ok(a, `src/router/types.ts exports ${name}`)
    assert.ok(b, `plugins/claude-code/types/index.d.ts declares ${name}`)
    if (name === 'Cfg') {
      // the plugin may hold more settings; every core setting must be there with the same type
      const pa = fields(a)
      const pb = fields(b)
      for (const [k, t] of pa) assert.equal(pb.get(k), t, `Cfg.${k} has the same type in the plugin`)
    } else assert.equal(b, a, `${name} has the same shape in the plugin`)
  }
})
