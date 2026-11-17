import type { Node } from 'web-tree-sitter'
import type { LangId } from './languages.ts'
import type { Imp } from './types.ts'

const unquote = (s: string): string => s.replace(/^['"`]|['"`]$/g, '')
const last = (dotted: string): string => dotted.split(/[.:\\/]+/).filter(Boolean).pop() ?? dotted

function jsImports(root: Node): Imp[] {
  const out: Imp[] = []
  for (const st of root.descendantsOfType('import_statement')) {
    if (!st) continue
    const srcNode = st.childForFieldName('source')
    if (!srcNode) continue
    const source = unquote(srcNode.text)
    const clause = st.namedChildren.find(c => c?.type === 'import_clause')
    if (!clause) continue
    for (const part of clause.namedChildren) {
      if (!part) continue
      if (part.type === 'identifier') out.push({ source, local: part.text, imported: 'default' })
      else if (part.type === 'namespace_import') {
        const id = part.namedChildren.find(c => c?.type === 'identifier')
        if (id) out.push({ source, local: id.text, imported: '*' })
      } else if (part.type === 'named_imports') {
        for (const spec of part.namedChildren) {
          if (spec?.type !== 'import_specifier') continue
          const name = spec.childForFieldName('name')?.text
          const alias = spec.childForFieldName('alias')?.text
          if (name) out.push({ source, local: alias ?? name, imported: name })
        }
      }
    }
  }
  // const x = require('./x')   and   const { a, b: c } = require('./x')
  for (const decl of root.descendantsOfType('variable_declarator')) {
    const value = decl?.childForFieldName('value')
    if (!decl || value?.type !== 'call_expression' || value.childForFieldName('function')?.text !== 'require') continue
    const arg = value.childForFieldName('arguments')?.namedChildren[0]
    if (!arg || arg.type !== 'string') continue
    const source = unquote(arg.text)
    const name = decl.childForFieldName('name')
    if (name?.type === 'identifier') out.push({ source, local: name.text, imported: '*' })
    else if (name?.type === 'object_pattern') {
      for (const p of name.namedChildren) {
        if (p?.type === 'shorthand_property_identifier_pattern') out.push({ source, local: p.text, imported: p.text })
        else if (p?.type === 'pair_pattern') {
          const key = p.childForFieldName('key')?.text
          const val = p.childForFieldName('value')?.text
          if (key && val) out.push({ source, local: val, imported: key })
        }
      }
    }
  }
  return out
}

function pythonImports(root: Node): Imp[] {
  const out: Imp[] = []
  for (const st of root.descendantsOfType('import_from_statement')) {
    if (!st) continue
    const mod = st.childForFieldName('module_name')?.text
    if (!mod) continue
    for (const n of st.childrenForFieldName('name')) {
      if (!n) continue
      if (n.type === 'aliased_import') {
        const name = n.childForFieldName('name')?.text
        const alias = n.childForFieldName('alias')?.text
        if (name) out.push({ source: mod, local: alias ?? name, imported: name })
      } else out.push({ source: mod, local: n.text, imported: n.text })
    }
    if (st.namedChildren.some(c => c?.type === 'wildcard_import')) out.push({ source: mod, local: '*', imported: '*' })
  }
  for (const st of root.descendantsOfType('import_statement')) {
    if (!st) continue
    for (const n of st.childrenForFieldName('name')) {
      if (!n) continue
      if (n.type === 'aliased_import') {
        const name = n.childForFieldName('name')?.text
        const alias = n.childForFieldName('alias')?.text
        if (name) out.push({ source: name, local: alias ?? name, imported: '*' })
      } else out.push({ source: n.text, local: n.text.split('.')[0]!, imported: '*' })
    }
  }
  return out
}

function goImports(root: Node): Imp[] {
  const out: Imp[] = []
  for (const spec of root.descendantsOfType('import_spec')) {
    const path = spec?.childForFieldName('path')?.text
    if (!spec || !path) continue
    const source = unquote(path)
    const name = spec.childForFieldName('name')?.text
    out.push({ source, local: name && name !== '_' && name !== '.' ? name : last(source), imported: '*' })
  }
  return out
}

/** Java, Kotlin and C# import whole qualified names: the last part is the name used in the file. */
function qualifiedImports(root: Node, types: string[]): Imp[] {
  const out: Imp[] = []
  for (const st of root.descendantsOfType(types)) {
    if (!st) continue
    const text = st.text.replace(/^(import|using)\s+(static\s+|global\s+)?/, '').replace(/[;\s]+$/, '')
    const alias = /\s+as\s+(\w+)$/.exec(text)?.[1] ?? /^(\w+)\s*=\s*/.exec(text)?.[1]
    const target = text.replace(/\s+as\s+\w+$/, '').replace(/^\w+\s*=\s*/, '')
    if (target.endsWith('.*')) {
      out.push({ source: target.slice(0, -2), local: '*', imported: '*' })
    } else if (st.type === 'using_directive' && !alias) {
      out.push({ source: target, local: '*', imported: '*' }) // C# `using X.Y;` brings a namespace in
    } else {
      const name = last(target)
      out.push({ source: target.slice(0, Math.max(0, target.length - name.length - 1)), local: alias ?? name, imported: name })
    }
  }
  return out
}

/** The names a file imports. Languages without a reader return none; their calls still match by name. */
export function extractImports(lang: LangId, root: Node): Imp[] {
  switch (lang) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'vue':
    case 'svelte':
      return jsImports(root)
    case 'python':
      return pythonImports(root)
    case 'go':
      return goImports(root)
    case 'java':
      return qualifiedImports(root, ['import_declaration'])
    case 'kotlin':
      return qualifiedImports(root, ['import_header'])
    case 'csharp':
      return qualifiedImports(root, ['using_directive'])
    default:
      return []
  }
}
