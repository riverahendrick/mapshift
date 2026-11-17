import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Language, Parser, Query, type Tree } from 'web-tree-sitter'
import { LANGS, type LangId } from './languages.ts'

const require = createRequire(import.meta.url)
let grammarsDir: string | null = null

/** The `out` folder of the grammar package, wherever npm put it. */
function grammars(): string {
  if (!grammarsDir) grammarsDir = join(dirname(require.resolve('tree-sitter-wasm/manifest.json')), 'out')
  return grammarsDir
}

let ready: Promise<void> | null = null
const languages = new Map<string, Promise<Language>>()
const parsers = new Map<string, Parser>()

function init(): Promise<void> {
  if (!ready) ready = Parser.init()
  return ready
}

/** Loads a grammar once and keeps it for the life of the process. */
export async function grammarFor(lang: LangId): Promise<Language> {
  const name = LANGS[lang].grammar
  let loading = languages.get(name)
  if (!loading) {
    loading = init().then(() => Language.load(readFileSync(join(grammars(), name, `tree-sitter-${name}.wasm`))))
    languages.set(name, loading)
  }
  return loading
}

/** Parses source code. The caller must call `tree.delete()` when done, to free the memory. */
export async function parse(lang: LangId, source: string): Promise<Tree> {
  const language = await grammarFor(lang)
  const name = LANGS[lang].grammar
  let parser = parsers.get(name)
  if (!parser) {
    parser = new Parser()
    parser.setLanguage(language)
    parsers.set(name, parser)
  }
  const tree = parser.parse(source)
  if (!tree) throw new Error(`the ${LANGS[lang].label} parser returned nothing`)
  return tree
}

/** Reads one of the grammar package's query files, or '' when it has none. */
export function grammarQuery(grammar: string, kind: 'tags' | 'locals'): string {
  try {
    return readFileSync(join(grammars(), grammar, `${kind}.scm`), 'utf8')
  } catch {
    return ''
  }
}

const queries = new Map<string, Query>()

/** Compiles a query once per grammar and keeps it. */
export async function queryFor(lang: LangId, key: string, source: () => string): Promise<Query> {
  const cacheKey = `${LANGS[lang].grammar}:${key}`
  let q = queries.get(cacheKey)
  if (!q) {
    q = new Query(await grammarFor(lang), source())
    queries.set(cacheKey, q)
  }
  return q
}
