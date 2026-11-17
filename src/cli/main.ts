#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { findRepoRoot } from '../core/paths.ts'
import { buildNow, closeMaps, ensureFresh, openMap, status } from '../map/indexer.ts'
import { fileApi, find, langCounts, overview, search, trace } from '../map/query.ts'
import { runMcp } from '../mcp/server.ts'
import { VERSION } from '../version.ts'
import { ago, bad, bold, dim, good, header, n, progress, rows, warn } from './ui.ts'

const HELP = `${header('Map your code. Shift to the right model.')}
${bold('Usage')}
  mapshift map build            Build or update the map of this project
  mapshift map status           What the map holds and how fresh it is
  mapshift map find <words>     Find code by plain words or by name
  mapshift map trace <name>     Who calls it  ${dim('(--out: what it calls · --impact: what a change reaches)')}
  mapshift map file <path>      A file's outline: every definition and its lines
  mapshift map overview         The whole project at a glance
  mapshift map search <text>    Every matching line  ${dim('(--regex · --case · --path <folder>)')}
  mapshift mcp                  Run the tool server that coding agents connect to

${bold('Options')}
  --project <folder>            Use another project folder ${dim('(default: the current one)')}
  -v, --version                 Show the version
  -h, --help                    Show this help

${dim('Everything stays on this computer. Nothing is sent anywhere.')}
`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      project: { type: 'string' },
      out: { type: 'boolean' },
      impact: { type: 'boolean' },
      depth: { type: 'string' },
      limit: { type: 'string' },
      regex: { type: 'boolean' },
      case: { type: 'boolean' },
      path: { type: 'string' },
    },
  })
  if (values.version) {
    console.log(VERSION)
    return 0
  }
  const [cmd, sub, ...rest] = positionals
  if (values.help || !cmd || cmd === 'help') {
    console.log(HELP)
    return 0
  }
  const root = findRepoRoot(typeof values.project === 'string' ? values.project : process.cwd())

  if (cmd === 'mcp') {
    await runMcp()
    return 0
  }

  if (cmd !== 'map') {
    console.error(`${bad('✗')} Unknown command "${cmd}". Run ${bold('mapshift help')} to see what is available.`)
    return 2
  }

  const words = rest.join(' ').trim()
  switch (sub) {
    case 'build': {
      console.log(header(root))
      const bar = progress('Mapping')
      const res = await buildNow(root, (d, t) => bar.update(d, t))
      if (!res) {
        console.log(`  ${warn('!')} Another program is building this map right now. Try again in a moment.`)
        return 1
      }
      const st = status(root)
      bar.done(
        res.total === 0
          ? 'The map is already up to date.'
          : `Mapped ${n(res.changed)} changed file${res.changed === 1 ? '' : 's'} in ${(res.ms / 1000).toFixed(1)} s.`,
      )
      printStatus(st)
      return 0
    }
    case 'status':
    case undefined: {
      console.log(header(root))
      printStatus(status(root))
      return 0
    }
    case 'find':
    case 'trace':
    case 'file':
    case 'overview':
    case 'search': {
      if (sub !== 'overview' && !words) {
        console.error(`${bad('✗')} Say what to ${sub}, for example: ${bold(`mapshift map ${sub} ${sub === 'file' ? 'src/app.ts' : sub === 'trace' ? 'saveOrder' : 'checkout total'}`)}`)
        return 2
      }
      await ensureFresh(root, 60_000)
      const store = openMap(root)
      const depth = typeof values.depth === 'string' ? Number(values.depth) : undefined
      const answer =
        sub === 'find'
          ? find(store, root, words, { limit: typeof values.limit === 'string' ? Number(values.limit) : undefined })
          : sub === 'trace'
            ? trace(store, root, words, { direction: values.impact ? 'impact' : values.out ? 'out' : 'in', depth })
            : sub === 'file'
              ? fileApi(store, root, words)
              : sub === 'overview'
                ? overview(store, root)
                : search(store, root, words, { regex: !!values.regex, ignoreCase: !values.case, path: typeof values.path === 'string' ? values.path : undefined })
      console.log(answer.text)
      return 0
    }
    default:
      console.error(`${bad('✗')} Unknown map command "${sub}". Run ${bold('mapshift help')}.`)
      return 2
  }
}

function printStatus(st: ReturnType<typeof status>): void {
  const state = st.state === 'ready' ? good('Ready') : st.state === 'building' ? warn(`Building · ${st.percent}%`) : dim('Not built yet')
  const langs = langCounts(openMap(st.root)).slice(0, 6)
  const pairs: [string, string][] = [
    ['Map', state],
    ['Files', n(st.files)],
    ['Definitions', n(st.symbols)],
    ['Call links', n(st.links)],
    ['Languages', langs.map(l => `${l.label} ${n(l.n)}`).join(' · ') || dim('none')],
    ['Updated', ago(st.builtAt)],
  ]
  if (st.skipped.length) {
    const by = new Map<string, number>()
    for (const s of st.skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1)
    pairs.push(['Not mapped', [...by.entries()].map(([r, c]) => `${n(c)} ${r}`).join(' · ')])
  }
  console.log(`${rows(pairs)}\n`)
}

main(process.argv.slice(2))
  .then(code => {
    closeMaps()
    process.exitCode = code
  })
  .catch(err => {
    closeMaps()
    console.error(`${bad('✗')} ${(err as Error).message}`)
    process.exitCode = 1
  })
