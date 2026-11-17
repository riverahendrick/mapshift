import type { Node, Query } from 'web-tree-sitter'
import { extractImports } from './imports.ts'
import { LANGS, type LangId } from './languages.ts'
import { grammarQuery, parse, queryFor } from './parser.ts'
import { EXTRA_TAGS, stripDirectives } from './queries.ts'
import type { Facts, Ref, Sym, SymKind } from './types.ts'

const KIND: Record<string, SymKind> = {
  class: 'class', struct: 'class', object: 'class', mixin: 'class', extension: 'class', trait: 'interface',
  interface: 'interface', protocol: 'interface',
  function: 'function', macro: 'function',
  method: 'method',
  module: 'module', namespace: 'module',
  type: 'type',
  enum: 'enum',
  constant: 'variable', variable: 'variable', field: 'variable', property: 'variable',
}
const CONTAINERS = new Set<SymKind>(['class', 'interface', 'module', 'enum'])
const JS_FAMILY = new Set<LangId>(['typescript', 'tsx', 'javascript', 'vue', 'svelte'])
const REF_KINDS: Record<string, Ref['kind']> = { call: 'call', send: 'call', class: 'new' }

/** Builds the tag query for a language, dropping any single pattern its grammar cannot compile. */
async function tagsQuery(lang: LangId): Promise<Query | null> {
  const info = LANGS[lang]
  const grammar = info.scriptsAs ? LANGS[info.scriptsAs].grammar : info.grammar
  const target = info.scriptsAs ?? lang
  const parts = [
    ...(LANGS[target].extraTags ?? []).map(g => grammarQuery(g, 'tags')),
    grammarQuery(grammar, 'tags'),
    ...(EXTRA_TAGS[target] ?? []),
  ].map(stripDirectives).filter(s => s.trim())
  if (parts.length === 0) return null
  try {
    return await queryFor(target, 'tags', () => parts.join('\n\n'))
  } catch {
    // one pattern does not fit this grammar version: keep every pattern that does
    const good: string[] = []
    for (const p of parts.flatMap(splitPatterns)) {
      try {
        await queryFor(target, `probe:${p}`, () => p)
        good.push(p)
      } catch {
        /* skip this pattern */
      }
    }
    return good.length ? queryFor(target, 'tags:filtered', () => good.join('\n\n')) : null
  }
}

/** Splits a query file into its top-level patterns by tracking parentheses outside strings and comments. */
function splitPatterns(scm: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  for (let i = 0; i < scm.length; i++) {
    const c = scm[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === ';') {
      while (i < scm.length && scm[i] !== '\n') i++
      continue
    }
    if (c === '"') inString = true
    else if (c === '(' || c === '[') {
      if (depth === 0) start = i
      depth++
    } else if (c === ')' || c === ']') {
      depth--
      if (depth === 0 && start >= 0) {
        // a pattern may end with captures after the closing paren: `(...) @definition.class`
        let end = i + 1
        const tail = /^(\s*@[\w.]+)+/.exec(scm.slice(end))
        if (tail) end += tail[0].length
        out.push(scm.slice(start, end))
        i = end - 1
        start = -1
      }
    }
  }
  return out
}

/** Keeps line numbers by blanking everything outside `<script>` blocks (Vue, Svelte). */
function scriptsOnly(source: string): string {
  // one linear pass with indexOf: no regular expression can be made to backtrack on a hostile file
  const lower = source.toLowerCase()
  const keep = new Uint8Array(source.length)
  let at = 0
  for (;;) {
    const open = lower.indexOf('<script', at)
    if (open < 0) break
    const bodyStart = lower.indexOf('>', open)
    if (bodyStart < 0) break
    const close = lower.indexOf('</script', bodyStart)
    if (close < 0) break
    keep.fill(1, bodyStart + 1, close)
    at = close + 8
  }
  const out = new Array<string>(source.length)
  for (let i = 0; i < source.length; i++) out[i] = keep[i] || source[i] === '\n' ? source[i]! : ' '
  return out.join('')
}

const oneLine = (s: string, max = 200): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function signatureOf(def: Node, source: string): string {
  const body =
    def.childForFieldName('body') ??
    def.childForFieldName('value')?.childForFieldName('body') ??
    def.namedChildren.find(c => c && /^(block|class_body|declaration_list|field_declaration_list|statement_block|function_body|compound_statement|enum_body|interface_body|object_type)$/.test(c.type)) ??
    null
  const end = body && body.startIndex > def.startIndex ? body.startIndex : Math.min(def.endIndex, def.startIndex + 240)
  return oneLine(source.slice(def.startIndex, end).replace(/[\s{:=]+$/, ''))
}

function isExported(lang: LangId, def: Node, name: string, signature: string): boolean {
  switch (lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'vue':
    case 'svelte': {
      for (let n: Node | null = def, i = 0; n && i < 3; n = n.parent, i++) if (n.type === 'export_statement') return true
      return false
    }
    case 'python':
      return !name.startsWith('_')
    case 'go':
      return /^[A-Z]/.test(name)
    case 'rust':
      return /^pub\b/.test(signature)
    default:
      return !/\b(private|fileprivate|internal)\b/.test(signature)
  }
}

/** Text before the name inside its parent node: `this.repo` for `this.repo.save`. */
function receiverOf(name: Node, source: string): string | null {
  let p = name.parent
  if (p?.type === 'navigation_suffix') p = p.parent // Kotlin: a.b() keeps the receiver one level up
  if (!p || p.startIndex >= name.startIndex) return null
  const text = source
    .slice(p.startIndex, name.startIndex)
    .replace(/^new\b\s*/, '') // `new Repo()` is built, not called on anything
    .replace(/(\?\.|!\.|\.|->|::|\?)\s*$/, '')
    .trim()
  if (!text || /[=;{}]/.test(text)) return null
  return oneLine(text, 80)
}

type RawDef = { node: Node; name: string; kind: SymKind }

/**
 * Reads one file: what it defines, what it calls and what it imports. Line numbers count from 1.
 * A file that does not parse cleanly still gives everything the parser could recover.
 */
export async function extract(lang: LangId, source: string): Promise<Facts> {
  const info = LANGS[lang]
  const target = info.scriptsAs ?? lang
  const text = info.scriptsAs ? scriptsOnly(source) : source
  const tree = await parse(target, text)
  try {
    const query = await tagsQuery(lang)
    const defs: RawDef[] = []
    const rawRefs: { name: Node; kind: Ref['kind'] }[] = []
    const seen = new Set<string>()
    for (const match of query?.matches(tree.rootNode) ?? []) {
      const nameCap = match.captures.find(c => c.name === 'name')
      const role = match.captures.find(c => c.name.startsWith('definition.') || c.name.startsWith('reference.'))
      if (!nameCap || !role) continue
      const [group, sub] = role.name.split('.') as [string, string]
      if (group === 'definition') {
        const kind = KIND[sub]
        const key = `${nameCap.node.startIndex}`
        if (!kind || seen.has(key)) continue
        seen.add(key)
        defs.push({ node: role.node, name: nameCap.node.text, kind })
      } else {
        const kind = REF_KINDS[sub]
        // a "class reference" is only a use when something is built (`new X`), not a base class or a type
        if (kind === 'new' && !/new_expression|object_creation|instance_creation|constructor_invocation/.test(role.node.type)) continue
        if (kind) rawRefs.push({ name: nameCap.node, kind })
      }
    }

    // outermost first, so each definition's container is already named when it is reached
    defs.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex)
    const syms: Sym[] = []
    const stack: { end: number; qualified: string; kind: SymKind; exported: boolean }[] = []
    const ranges: { start: number; end: number; qualified: string }[] = []
    for (const d of defs) {
      while (stack.length && stack[stack.length - 1]!.end <= d.node.startIndex) stack.pop()
      const parent = stack[stack.length - 1]
      const kind: SymKind = d.kind === 'function' && parent && CONTAINERS.has(parent.kind) ? 'method' : d.kind
      const qualified = parent ? `${parent.qualified}.${d.name}` : d.name
      const signature = signatureOf(d.node, text)
      // a member is public when its container is and its own modifiers or naming allow it
      const own = parent && JS_FAMILY.has(lang) ? true : isExported(lang, d.node, d.name, signature)
      const exported = parent ? parent.exported && own : own
      syms.push({ name: d.name, qualified, kind, start: d.node.startPosition.row + 1, end: d.node.endPosition.row + 1, signature, exported })
      stack.push({ end: d.node.endIndex, qualified, kind, exported })
      ranges.push({ start: d.node.startIndex, end: d.node.endIndex, qualified })
    }

    const refs: Ref[] = []
    const once = new Set<number>()
    for (const r of rawRefs) {
      const at = r.name.startIndex
      if (once.has(at)) continue // two tag patterns can see the same call
      once.add(at)
      let from: string | null = null
      let best = Infinity
      for (const g of ranges) {
        if (g.start <= at && at < g.end && g.end - g.start < best) {
          best = g.end - g.start
          from = g.qualified
        }
      }
      refs.push({ name: r.name.text, receiver: receiverOf(r.name, text), line: r.name.startPosition.row + 1, from, kind: r.kind })
    }

    return { syms, refs, imps: extractImports(lang, tree.rootNode) }
  } finally {
    tree.delete()
  }
}
