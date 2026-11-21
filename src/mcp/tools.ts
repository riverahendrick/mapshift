import { existsSync, statSync } from 'node:fs'
import { tokensOf, record } from '../core/ledger.ts'
import { findRepoRoot } from '../core/paths.ts'
import { ensureFresh, openMap } from '../map/indexer.ts'
import { fileApi, find, overview, search, trace, type Answer } from '../map/query.ts'

type Schema = { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false }
export type ToolDef = { name: string; title: string; description: string; inputSchema: Schema }

const str = (description: string) => ({ type: 'string', description })
const projectProp = str('Optional project folder path when the MCP host does not pass workspace roots (defaults to server root)')

export const TOOLS: ToolDef[] = [
  {
    name: 'map_find',
    title: 'Find code',
    description:
      'Find where something is implemented. Give a question in plain words or names (functions, classes, files). Returns the best matching definitions with their code, who calls them and what they call. Use this before searching or opening files. Several things to find? Pass them all in "queries" and get every answer in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('What to find, e.g. "where are payments refunded" or "CartService.total"'),
        queries: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Several things to find at once, instead of "query"' },
        limit: { type: 'number', description: 'How many results each, 1-15 (default 6; 3 with "queries")' },
        project: projectProp,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'map_trace',
    title: 'Trace calls',
    description:
      'Follow the call links of a definition: who calls it ("in"), what it calls ("out"), or everything a change to it can reach ("impact"). Run "impact" before changing or renaming something. Pass several names in "symbols" to trace them all in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: str('A name like "save", "Cart.total", or a "path:line"'),
        symbols: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Several names at once, instead of "symbol"' },
        direction: { type: 'string', enum: ['in', 'out', 'impact'], description: 'Default "in"' },
        depth: { type: 'number', description: 'How many steps to follow, 1-6' },
        project: projectProp,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'map_file',
    title: 'File outline',
    description: "A file's whole API in a few lines: every class, function and method with its line range and signature. Far cheaper than reading the file. Pass several in \"paths\" for all of them in one call.",
    inputSchema: {
      type: 'object',
      properties: {
        path: str('The file, relative to the project, or its end like "cart.ts"'),
        paths: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Several files at once, instead of "path"' },
        project: projectProp,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'map_overview',
    title: 'Project overview',
    description: 'A first look at the project: languages, main folders, likely entry points and the most used definitions. Use once at the start of unfamiliar work.',
    inputSchema: { type: 'object', properties: { project: projectProp }, additionalProperties: false },
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
        project: projectProp,
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
]

export const INSTRUCTIONS =
  'Mapshift keeps a map of this project, built and refreshed automatically. Before grepping or opening files to find code, call map_find; ' +
  'for a file\'s API use map_file; before changing a function use map_trace with direction "impact". When you need several things, ask for them ' +
  'in one call ("queries", "symbols" or "paths") instead of one call each. Answers include exact file:line ranges ' +
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

/** At most this many items in one call; more are left out and said so. */
export const MAX_BATCH = 8

/** The one value (`query`) or the list (`queries`) a call names, trimmed, without empties or repeats. */
function items(args: unknown, one: string, many: string): { list: string[]; dropped: number } {
  const raw = (args as Record<string, unknown>)?.[many]
  const all = [...new Set([...(Array.isArray(raw) ? raw : []), text(args, one)].filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean))]
  return { list: all.slice(0, MAX_BATCH), dropped: Math.max(0, all.length - MAX_BATCH) }
}

/** Several answers as one: each under its own heading, the files they point at put together. */
function joined(parts: { label: string; answer: Answer }[], dropped: number): Answer {
  if (parts.length === 1 && !dropped) return parts[0]!.answer
  const text = parts.map(p => `## ${p.label}\n${p.answer.text}`).join('\n\n')
  return { text: dropped ? `${text}\n\n(${dropped} more left out: at most ${MAX_BATCH} in one call.)` : text, files: [...new Set(parts.flatMap(p => p.answer.files))] }
}

/** Runs one tool against the project's map, fresh to the second, and records what it cost and pointed at. */
export async function callTool(root: string, name: string, args: unknown, agent: string): Promise<{ text: string; isError: boolean }> {
  const projectArg = text(args, 'project').trim()
  if (projectArg) {
    if (!existsSync(projectArg) || !statSync(projectArg).isDirectory()) {
      return { text: `Project folder not found: ${projectArg}`, isError: true }
    }
    root = findRepoRoot(projectArg)
  }
  await ensureFresh(root, 2000)
  const store = openMap(root)
  let answer: Answer
  switch (name) {
    case 'map_find': {
      const { list, dropped } = items(args, 'query', 'queries')
      if (!list.length) return { text: 'map_find needs a "query" (or a list in "queries").', isError: true }
      // several questions at once: fewer results each, so the whole answer stays about one answer's size
      const limit = num(args, 'limit') ?? (list.length > 1 ? 3 : undefined)
      answer = joined(list.map(q => ({ label: q, answer: find(store, root, q, { limit }) })), dropped)
      break
    }
    case 'map_trace': {
      const { list, dropped } = items(args, 'symbol', 'symbols')
      if (!list.length) return { text: 'map_trace needs a "symbol" (or a list in "symbols").', isError: true }
      const d = text(args, 'direction')
      const direction = d === 'out' || d === 'impact' ? d : 'in'
      answer = joined(list.map(s => ({ label: s, answer: trace(store, root, s, { direction, depth: num(args, 'depth') }) })), dropped)
      break
    }
    case 'map_file': {
      const { list, dropped } = items(args, 'path', 'paths')
      if (!list.length) return { text: 'map_file needs a "path" (or a list in "paths").', isError: true }
      answer = joined(list.map(p => ({ label: p, answer: fileApi(store, root, p) })), dropped)
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
  const files = answer.files.map(path => ({ path, tokens: tokensOf((sizes.get(path) as { size: number } | undefined)?.size ?? 0) }))
  const out = withSavings(answer.text, files, tallies.get(root))
  tallies.set(root, out.tally)
  record({ kind: 'map', ts: Date.now(), agent, repo: root, tool: name, answerTokens: tokensOf(out.text.length), files })
  return { text: out.text, isError: false }
}

/** Every answer this server gave for a project so far: their tokens, and what reading their files whole would cost. */
export type Tally = { here: number; whole: number; answers: number }
const tallies = new Map<string, Tally>()

/**
 * One line at the top of an answer, so the person can see what the map spared: this answer's size against
 * reading in full only the files it points at (never the whole project). From the second answer on, the line
 * also carries the session's totals, which count every answer (an overview points at no file, so it only adds
 * cost), so an agent asked to report them can copy one line instead of adding numbers up. Shown only when
 * this answer's difference is real.
 */
export function withSavings(text: string, files: { tokens: number }[], prior: Tally = { here: 0, whole: 0, answers: 0 }): { text: string; tally: Tally } {
  const whole = files.reduce((s, f) => s + f.tokens, 0)
  const later = prior.answers > 0
  const here = tokensOf(text.length) + (later ? 35 : 25) // the line itself: about 25 tokens, 35 with the totals
  const shown = whole - here >= 500
  const tally = { here: prior.here + (shown ? here : tokensOf(text.length)), whole: prior.whole + whole, answers: prior.answers + 1 }
  if (!shown) return { text, tally }
  const n = (x: number) => x.toLocaleString('en-US')
  const totals = later ? ` · this session: ${n(tally.here)} instead of ${n(tally.whole)}` : ''
  return { text: `🗺️ Mapshift: ${n(here)} tokens here instead of ${n(whole)} to read ${files.length === 1 ? 'that file' : `those ${files.length} files`} whole${totals}\n${text}`, tally }
}
