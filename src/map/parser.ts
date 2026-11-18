import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Language, Parser, Query, type Tree } from 'web-tree-sitter'
import { LANGS, type LangId } from './languages.ts'

const require = createRequire(import.meta.url)
let grammarsDir: string | null = null

/**
 * Where the language grammars are: bundled next to the compiled code in an installed copy
 * (`dist/grammars`), or in the grammar package during development.
 */
function grammars(): string {
  if (!grammarsDir) {
    const bundled = fileURLToPath(new URL('../grammars', import.meta.url))
    grammarsDir = existsSync(join(bundled, 'typescript')) ? bundled : join(dirname(require.resolve('tree-sitter-wasm/manifest.json')), 'out')
  }
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

/** A file the parser could not finish in its time budget (see parseBudgetMs): listed as not mapped, never waited on. */
export class ParseTooSlow extends Error {}

/**
 * How long one file may take to parse: 2 seconds, plus 4 ms per kilobyte. A normal file takes a small part of
 * this (a 265 KB library about half a second); text that only looks like code can send a parser into error
 * recovery for many seconds, and one such file must not hold up the whole map.
 */
export const parseBudgetMs = (chars: number): number => 2000 + (4 * chars) / 1024

/** Parses source code. The caller must call `tree.delete()` when done, to free the memory. */
export async function parse(lang: LangId, source: string, budgetMs = parseBudgetMs(source.length)): Promise<Tree> {
  const language = await grammarFor(lang)
  const name = LANGS[lang].grammar
  let parser = parsers.get(name)
  if (!parser) {
    parser = new Parser()
    parser.setLanguage(language)
    parsers.set(name, parser)
  }
  const started = performance.now()
  let late = false
  // returning true from the progress callback cancels the parse
  const tree = parser.parse(source, null, { progressCallback: (() => (late = performance.now() - started > budgetMs)) as () => void })
  if (late || !tree) {
    tree?.delete()
    parser.reset() // a cancelled parse would otherwise resume on the next file
    if (late) throw new ParseTooSlow(`the ${LANGS[lang].label} parser took over ${Math.round(budgetMs)} ms`)
    throw new Error(`the ${LANGS[lang].label} parser returned nothing`)
  }
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
