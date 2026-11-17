import { tokensOf, record } from '../core/ledger.ts'
import { ensureFresh, openMap } from '../map/indexer.ts'
import { fileApi, find, overview, search, trace, type Answer } from '../map/query.ts'

type Schema = { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false }
export type ToolDef = { name: string; title: string; description: string; inputSchema: Schema }

const str = (description: string) => ({ type: 'string', description })

export const TOOLS: ToolDef[] = [
  {
    name: 'map_find',
    title: 'Find code',
    description:
      'Find where something is implemented. Give a question in plain words or names (functions, classes, files). Returns the best matching definitions with their code, who calls them and what they call. Use this before searching or opening files.',
    inputSchema: {
      type: 'object',
      properties: { query: str('What to find, e.g. "where are payments refunded" or "CartService.total"'), limit: { type: 'number', description: 'How many results, 1-15 (default 6)' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'map_trace',
    title: 'Trace calls',
    description:
      'Follow the call links of one definition: who calls it ("in"), what it calls ("out"), or everything a change to it can reach ("impact"). Run "impact" before changing or renaming something.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: str('A name like "save", "Cart.total", or a "path:line"'),
        direction: { type: 'string', enum: ['in', 'out', 'impact'], description: 'Default "in"' },
        depth: { type: 'number', description: 'How many steps to follow, 1-6' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'map_file',
    title: 'File outline',
    description: "A file's whole API in a few lines: every class, function and method with its line range and signature. Far cheaper than reading the file.",
    inputSchema: { type: 'object', properties: { path: str('The file, relative to the project, or its end like "cart.ts"') }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'map_overview',
    title: 'Project overview',
    description: 'A first look at the project: languages, main folders, likely entry points and the most used definitions. Use once at the start of unfamiliar work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'map_search',
    title: 'Search exact text',
    description: 'Every line matching exact text or a regular expression, grouped by the definition it sits in. Use when you need all occurrences, not just the best ones.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: str('Text or a regular expression'),
        regex: { type: 'boolean', description: 'Treat the pattern as a regular expression (default false)' },
        case_sensitive: { type: 'boolean', description: 'Default false' },
        path: str('Only search under this folder or file'),
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
]

export const INSTRUCTIONS =
  'Mapshift keeps a map of this project, built and refreshed automatically. Before grepping or opening files to find code, call map_find; ' +
  'for a file\'s API use map_file; before changing a function use map_trace with direction "impact". Answers include exact file:line ranges ' +
  'and the relevant code, so read a file only when you need lines the answer did not show. When an exact detail matters ' +
  '(a condition, a value, an error message), read those lines before stating it. ' +
  'If these tools are listed but not loaded yet (deferred), load all five in one tool search: ' +
  '"select:mcp__mapshift__map_find,mcp__mapshift__map_trace,mcp__mapshift__map_file,mcp__mapshift__map_overview,mcp__mapshift__map_search".'

/** Claude Code reads this to load a tool up front instead of hiding it behind a tool search. */
export const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true }

const text = (a: unknown, k: string): string => (typeof (a as Record<string, unknown>)?.[k] === 'string' ? ((a as Record<string, string>)[k] as string) : '')
const num = (a: unknown, k: string): number | undefined => {
  const v = (a as Record<string, unknown>)?.[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Runs one tool against the project's map, fresh to the second, and records what it cost and pointed at. */
export async function callTool(root: string, name: string, args: unknown, agent: string): Promise<{ text: string; isError: boolean }> {
  await ensureFresh(root, 2000)
  const store = openMap(root)
  let answer: Answer
  switch (name) {
    case 'map_find': {
      const q = text(args, 'query').trim()
      if (!q) return { text: 'map_find needs a "query".', isError: true }
      answer = find(store, root, q, { limit: num(args, 'limit') })
      break
    }
    case 'map_trace': {
      const s = text(args, 'symbol').trim()
      if (!s) return { text: 'map_trace needs a "symbol".', isError: true }
      const d = text(args, 'direction')
      answer = trace(store, root, s, { direction: d === 'out' || d === 'impact' ? d : 'in', depth: num(args, 'depth') })
      break
    }
    case 'map_file': {
      const p = text(args, 'path').trim()
      if (!p) return { text: 'map_file needs a "path".', isError: true }
      answer = fileApi(store, root, p)
      break
    }
    case 'map_overview':
      answer = overview(store, root)
      break
    case 'map_search': {
      const p = text(args, 'pattern')
      if (!p) return { text: 'map_search needs a "pattern".', isError: true }
      const a = args as Record<string, unknown>
      answer = search(store, root, p, { regex: a.regex === true, ignoreCase: a.case_sensitive !== true, path: text(args, 'path') || undefined })
      break
    }
    default:
      return { text: `Unknown tool "${name}".`, isError: true }
  }
  const sizes = store.sql('SELECT size FROM files WHERE path = ?')
  record({
    kind: 'map',
    ts: Date.now(),
    agent,
    repo: root,
    tool: name,
    answerTokens: tokensOf(answer.text.length),
    files: answer.files.map(path => ({ path, tokens: tokensOf((sizes.get(path) as { size: number } | undefined)?.size ?? 0) })),
  })
  return { text: answer.text, isError: false }
}
