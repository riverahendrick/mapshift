#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { VERSION } from '../version.ts'
import { plainReason, pretty } from './format.ts'
import { ago, bad, bold, dim, good, header, n, progress, rows, warn } from './ui.ts'

// The map engine, the tool server and the router load only when a command needs them, so quick commands
// (the status line runs many times a minute) start fast.

const HELP = `${header('Map your code. Shift to the right model.')}
${bold('Get started')}
  mapshift setup                Add Mapshift to every coding agent found  ${dim('(--agents codex,grok · --yes · --dry-run · --check)')}
  mapshift report               Map, savings and limits as text  ${dim('(--agent codex · --project <folder>)')}
  mapshift dash                 Open the local dashboard in your browser  ${dim('(--port <n> · --no-open)')}
  mapshift ui                   The dashboard right here in the terminal  ${dim('(--once · --width <n> · --tab map)')}
  mapshift off | on             Pause Mapshift in every agent, or bring it back
  mapshift code-mode on|off     Claude Code's experimental Code Mode, after checking it can run  ${dim('(status)')}
  mapshift update               Get the newest version now  ${dim('(--check: only look)')}
  mapshift auto-update on|off   Keep up to date by itself, every 3 days  ${dim('(on by default · status)')}
  mapshift uninstall            Take out everything setup added

${bold('The map')}
  mapshift map build            Build or update the map of this project
  mapshift map status           What the map holds and how fresh it is
  mapshift map find <words>     Find code by plain words or by name
  mapshift map trace <name>     Who calls it  ${dim('(--out: what it calls · --impact: what a change reaches)')}
  mapshift map file <path>      A file's outline: every definition and its lines
  mapshift map overview         The whole project at a glance
  mapshift map search <text>    Every matching line  ${dim('(--regex · --case · --path <folder>)')}

${bold('For agents')}
  mapshift route <request>      Which model and effort a request needs  ${dim('(--model <id> · --provider <name> · --json)')}
  mapshift mcp                  Run the tool server that coding agents connect to
  mapshift statusline --agent   One status line for agy or grok ${dim('(reads the agent\'s JSON on stdin)')}

${bold('Options')}
  --project <folder>            Use another project folder ${dim('(default: the current one)')}
  -v, --version                 Show the version
  -h, --help                    Show this help

${dim('Your code and your usage stay on this computer. The only request out is the version check for updates.')}
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
      provider: { type: 'string' },
      model: { type: 'string' },
      json: { type: 'boolean' },
      frontier: { type: 'boolean' },
      home: { type: 'string' },
      agents: { type: 'string' },
      agent: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'dry-run': { type: 'boolean' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      check: { type: 'boolean' },
      auto: { type: 'boolean' },
      once: { type: 'boolean' },
      width: { type: 'string' },
      tab: { type: 'string' },
    },
  })
  const opt = (k: string): string | undefined => (typeof values[k] === 'string' ? (values[k] as string) : undefined)
  if (values.version) {
    console.log(VERSION)
    return 0
  }
  const [cmd, sub, ...rest] = positionals
  // a mistyped --project must say so, not answer "up to date" for a folder with nothing in it
  const projectOpt = opt('project')
  if (projectOpt !== undefined && cmd !== 'statusline') {
    const { existsSync, statSync } = await import('node:fs')
    if (!existsSync(projectOpt) || !statSync(projectOpt).isDirectory()) {
      console.error(`${bad('✗')} That project folder was not found: ${projectOpt}`)
      return 2
    }
  }

  // the status line first and on its own: it must answer within a blink and never fail
  if (cmd === 'statusline') {
    const agent = opt('agent') ?? sub
    if (agent !== 'agy' && agent !== 'grok') {
      console.error(`${bad('✗')} Say which agent: ${bold('mapshift statusline --agent grok')} (or agy).`)
      return 2
    }
    const { runStatusline } = await import('../agents/statusline.ts')
    await runStatusline(agent)
    return 0
  }

  // `mapshift` alone on an interactive terminal opens the terminal dashboard; anywhere else it prints help
  if (!values.help && (cmd === 'ui' || (!cmd && process.stdout.isTTY && process.stdin.isTTY))) {
    return ui({ once: !!values.once, width: opt('width'), tab: opt('tab'), project: opt('project'), home: opt('home') })
  }

  if (values.help || !cmd || cmd === 'help') {
    console.log(HELP)
    return 0
  }

  // which agents on this computer still need Mapshift: only reads, so no lasting install is needed first
  if (cmd === 'setup' && values.check) {
    const s = await import('../setup/setup.ts')
    return s.runCheck({ home: opt('home'), json: !!values.json })
  }

  if (cmd === 'setup' || cmd === 'off' || cmd === 'on' || cmd === 'uninstall') {
    // run through npx? Make a lasting install first, so agents never point at npm's temporary cache
    if (cmd === 'setup' && !opt('home')) {
      const p = await import('../setup/persist.ts')
      const { builtEntry } = await import('../setup/env.ts')
      if (p.isTemporaryCopy(builtEntry())) {
        console.log(header('Set up Mapshift for your coding agents'))
        console.log(`  Mapshift is running from a temporary copy. Your agents need a lasting one, so it will be installed first:`)
        console.log(`  ${bold(`npm install --global mapshift@${VERSION}`)}\n`)
        if (values['dry-run']) return 0
        const { askYesNo } = await import('../setup/setup.ts')
        if (!values.yes && !(process.stdin.isTTY && (await askYesNo('  Install it now? [y/N] ')))) {
          console.log(`\n  Nothing changed. Run the line above yourself, then ${bold('mapshift setup')}.`)
          return 1
        }
        const got = p.installLasting(VERSION)
        if (!got.main) {
          console.error(`${bad('✗')} Could not install Mapshift (${got.why}). Run the line above yourself, then ${bold('mapshift setup')}.`)
          return 1
        }
        return p.continueFrom(got.main, argv)
      }
    }
    const s = await import('../setup/setup.ts')
    const o = { home: opt('home'), agents: opt('agents'), yes: !!values.yes, dryRun: !!values['dry-run'] }
    return cmd === 'setup' ? s.runSetup(o) : cmd === 'off' ? s.runOff(o) : cmd === 'on' ? s.runOn(o) : s.runUninstall(o)
  }

  // starting points for one request, for agents' prompt hooks: quiet (prints nothing) when the map has no clear answer
  if (cmd === 'hint') {
    const text = [sub, ...rest].filter(Boolean).join(' ').trim()
    if (!text) return 0
    const { findRepoRoot } = await import('../core/paths.ts')
    const root = findRepoRoot(opt('project') ?? process.cwd())
    // answered from the map as it is: the tool server keeps it fresh, and a prompt must not wait for a rescan
    const { openMap, status } = await import('../map/indexer.ts')
    if (status(root).state === 'empty') return 0
    const { startingPoints } = await import('../map/hint.ts')
    const store = openMap(root)
    const a = startingPoints(store, text)
    if (!a) {
      if (values.json) console.log(JSON.stringify({ text: '', files: [] }))
      return 0
    }
    const { record, tokensOf } = await import('../core/ledger.ts')
    const sizes = store.sql('SELECT size FROM files WHERE path = ?')
    record({
      kind: 'map',
      ts: Date.now(),
      agent: opt('agent') ?? 'unknown',
      repo: root,
      tool: 'map_hint',
      answerTokens: tokensOf(a.text.length),
      files: a.files.map(path => ({ path, tokens: tokensOf((sizes.get(path) as { size: number } | undefined)?.size ?? 0) })),
    })
    console.log(values.json ? JSON.stringify(a) : a.text)
    return 0
  }

  if (cmd === 'update') {
    const { runUpdate } = await import('../setup/update.ts')
    if (!values.auto) return runUpdate({ current: VERSION, check: !!values.check })
    // the background run started by the tool server: nothing on screen, every line in the update log
    const a = await import('../setup/autoupdate.ts')
    const lines: string[] = []
    try {
      const code = await runUpdate({ current: VERSION, out: s => lines.push(s) })
      // the heading is for a screen; the log and the status keep only what happened
      const said = lines
        .flatMap(s => s.split('\n'))
        .map(s => s.replace(/\x1b\[[\d;]*m/g, '').trim())
        .filter(s => s && !/^◆/.test(s))
      for (const l of said) a.logUpdate(l)
      a.writeAutoUpdate({ ...a.readAutoUpdate(), lastCheck: new Date().toISOString(), lastResult: said.join(' ').replace(/\s+/g, ' ').slice(0, 300) })
      return code
    } finally {
      a.releaseAutoUpdateLock()
    }
  }

  if (cmd === 'code-mode') {
    const s = await import('../setup/setup.ts')
    return s.runCodeMode({ action: sub === 'on' || sub === 'off' ? sub : 'status' })
  }

  if (cmd === 'auto-update') {
    const a = await import('../setup/autoupdate.ts')
    const st = a.readAutoUpdate()
    if (sub === 'on' || sub === 'off') {
      a.writeAutoUpdate({ ...st, enabled: sub === 'on' })
      console.log(sub === 'on' ? `${good('✓')} Mapshift keeps itself up to date again (it checks every 3 days).` : `${good('✓')} Automatic updates are off. ${bold('mapshift update')} still updates by hand.`)
      return 0
    }
    console.log(header('Automatic updates'))
    console.log(`  ${dim('State')}       ${st.enabled ? good('on') : warn('off')}${process.env.MAPSHIFT_AUTO_UPDATE === '0' ? dim(' (paused by MAPSHIFT_AUTO_UPDATE=0)') : ''}`)
    console.log(`  ${dim('Last check')}  ${st.lastCheck ? ago(Date.parse(st.lastCheck)) : 'not yet'}`)
    if (st.lastResult) console.log(`  ${dim('Result')}      ${st.lastResult}`)
    console.log(`\n  ${dim('Every 3 days, when an agent starts Mapshift, it asks npm for the newest version and installs it.')}`)
    console.log(`  ${dim(st.enabled ? 'Turn it off:' : 'Turn it on:')} ${bold(st.enabled ? 'mapshift auto-update off' : 'mapshift auto-update on')}\n`)
    return 0
  }

  if (cmd === 'report') return report(opt('agent'), opt('project'), opt('home'))
  if (cmd === 'dash') return dash(opt('port'), !values['no-open'], opt('project'))

  const { findRepoRoot } = await import('../core/paths.ts')
  const root = findRepoRoot(opt('project') ?? process.cwd())

  if (cmd === 'mcp') {
    // every few days, a quiet update in the background (see autoupdate.ts); it never delays the tools
    try {
      const { builtEntry } = await import('../setup/env.ts')
      ;(await import('../setup/autoupdate.ts')).maybeAutoUpdate({ script: builtEntry() })
    } catch {
      /* never in the way of the tools */
    }
    await indexer()
    const { runMcp } = await import('../mcp/server.ts')
    await runMcp()
    return 0
  }

  if (cmd === 'route') {
    const text = [sub, ...rest].filter(Boolean).join(' ').trim()
    if (!text) {
      console.error(`${bad('✗')} Give the request to judge, for example: ${bold('mapshift route "fix the login race condition"')}`)
      return 2
    }
    const { providerOf } = await import('../router/catalog.ts')
    const { advise } = await import('../router/route.ts')
    const { openMap, status } = await indexer()
    const model = opt('model')
    const provider = opt('provider') ?? (model ? providerOf(model) : null) ?? 'anthropic'
    if (!['anthropic', 'openai', 'google', 'xai'].includes(provider)) {
      console.error(`${bad('✗')} Unknown provider "${provider}". Use anthropic, openai, google or xai.`)
      return 2
    }
    let store = null
    try {
      if (status(root).state !== 'empty') store = openMap(root)
    } catch {
      store = null // no map here: judge by wording alone
    }
    const a = advise({ text, provider: provider as 'anthropic', currentModel: model, store, allowFrontier: !!values.frontier })
    if (values.json) {
      console.log(
        JSON.stringify({
          tier: a.tier,
          model: a.model.id,
          effort: a.effort,
          change: a.change,
          helper: a.helper.id,
          reasons: a.reasons,
          map: a.signals && !a.signals.silent ? { matched: a.signals.matched, reach: a.signals.reach, files: a.signals.files, areas: a.signals.areas } : null,
        }),
      )
      return 0
    }
    const level = { trivial: 'Quick', routine: 'Standard', complex: 'Complex', critical: 'Critical' }[a.tier]
    console.log(header('Routing advice'))
    console.log(
      rows([
        ['Level', bold(level)],
        ['Model', `${bold(a.model.label)}  ${dim(`· ${a.effort === 'xhigh' ? 'extra high' : a.effort} effort`)}`],
        ...(a.current && a.change !== 'none' ? ([['Now on', `${a.current.label}  ${a.change === 'up' ? warn('↑ step up') : good('↓ step down')}`]] as [string, string][]) : []),
        ['Helpers', `${a.helper.label} ${dim('for searching, summaries and test runs')}`],
        ['Why', a.reasons.slice(0, 3).map(plainReason).join(' · ')],
      ]),
    )
    console.log('')
    return 0
  }

  if (cmd !== 'map') {
    console.error(`${bad('✗')} Unknown command "${cmd}". Run ${bold('mapshift help')} to see what is available.`)
    return 2
  }

  const { buildNow, ensureFresh, openMap, status } = await indexer()
  const { fileApi, find, langCounts, overview, search, trace } = await import('../map/query.ts')
  const printStatus = (st: ReturnType<typeof status>): void => {
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
      if (values.json) {
        const st = status(root)
        console.log(
          JSON.stringify({
            root: st.root,
            state: st.state,
            percent: st.percent,
            files: st.files,
            symbols: st.symbols,
            links: st.links,
            skipped: st.skipped.length,
            builtAt: st.builtAt,
            languages: langCounts(openMap(root)).slice(0, 6),
          }),
        )
        return 0
      }
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
      const depth = opt('depth') !== undefined ? Number(opt('depth')) : undefined
      const answer =
        sub === 'find'
          ? find(store, root, words, { limit: opt('limit') !== undefined ? Number(opt('limit')) : undefined })
          : sub === 'trace'
            ? trace(store, root, words, { direction: values.impact ? 'impact' : values.out ? 'out' : 'in', depth })
            : sub === 'file'
              ? fileApi(store, root, words)
              : sub === 'overview'
                ? overview(store, root)
                : search(store, root, words, { regex: !!values.regex, ignoreCase: !values.case, path: opt('path') })
      // a person at a terminal gets styled text; a script or another program gets the plain answer, unchanged
      const forPerson = process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : !!process.stdout.isTTY
      console.log(forPerson ? pretty(answer.text) : answer.text)
      return 0
    }
    default:
      console.error(`${bad('✗')} Unknown map command "${sub}". Run ${bold('mapshift help')}.`)
      return 2
  }
}

/** `mapshift report`: the text dashboard the agents' `/mapshift` commands show. */
async function report(agent: string | undefined, project: string | undefined, home: string | undefined): Promise<number> {
  const { REPORT_AGENTS, renderReport } = await import('../agents/report.ts')
  if (agent && !(REPORT_AGENTS as readonly string[]).includes(agent)) {
    console.error(`${bad('✗')} Unknown agent "${agent}". Choose from: ${REPORT_AGENTS.join(', ')}.`)
    return 2
  }
  const { snapshot } = await import('../dashboard/snapshot.ts')
  const { targets } = await import('../setup/env.ts')
  const t = targets({ home })
  const s = snapshot({ root: project ?? process.cwd(), codexHome: t.codex })
  let advice = null
  const last = s.codex?.lastRequest
  if (last && (!agent || agent === 'codex')) {
    try {
      const { advise } = await import('../router/route.ts')
      let store = null
      if (s.map.state === 'ready') store = (await indexer()).openMap(s.map.root)
      advice = advise({ text: last.slice(0, 4000), provider: 'openai', currentModel: s.codex?.model ?? undefined, store })
    } catch {
      advice = null
    }
  }
  console.log(renderReport(s, { agent: agent as 'codex' | undefined, advice }))
  return 0
}

/** `mapshift dash`: the local web dashboard. Stays open until 10 idle minutes pass or Ctrl+C. */
async function dash(portText: string | undefined, open: boolean, project: string | undefined): Promise<number> {
  const port = portText === undefined ? 0 : Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`${bad('✗')} The port must be a number from 0 to 65535 (0 picks a free one).`)
    return 2
  }
  const { startDash, openBrowser, IDLE_MS } = await import('../dashboard/server.ts')
  const { snapshot } = await import('../dashboard/snapshot.ts')
  const { targets } = await import('../setup/env.ts')
  const codexHome = targets().codex
  const root = project ?? process.cwd()
  const d = await startDash({ port, data: () => snapshot({ root, codexHome }) })
  console.log(header('Dashboard'))
  console.log(`  ${good('●')} ${bold(d.url)}`)
  console.log(`  ${dim(`Only this computer can open it, and only with this address. It stops after ${IDLE_MS / 60_000} idle minutes or Ctrl+C.`)}\n`)
  if (open && !openBrowser(d.url)) console.log(`  ${warn('!')} Could not open a browser. Copy the address above into one.\n`)
  const stop = () => d.close()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await d.closed
  console.log(`  ${dim('Dashboard stopped.')}\n`)
  return 0
}

/** `mapshift ui`: the terminal dashboard. `--once` (or no interactive terminal) prints one frame and stops. */
async function ui(o: { once: boolean; width: string | undefined; tab: string | undefined; project: string | undefined; home: string | undefined }): Promise<number> {
  const { parseTab, renderOnce, runUi } = await import('../tui/app.ts')
  const tab = parseTab(o.tab)
  if (o.tab !== undefined && !tab) {
    console.error(`${bad('✗')} Unknown tab "${o.tab}". Choose from: overview, activity, map, help.`)
    return 2
  }
  const width = o.width === undefined ? undefined : Number(o.width)
  if (width !== undefined && (!Number.isInteger(width) || width < 20 || width > 1000)) {
    console.error(`${bad('✗')} The width must be a whole number from 20 to 1000.`)
    return 2
  }
  const { snapshot } = await import('../dashboard/snapshot.ts')
  const { targets } = await import('../setup/env.ts')
  const codexHome = targets({ home: o.home }).codex
  const root = o.project ?? process.cwd()
  const data = () => snapshot({ root, codexHome })
  if (o.once || !process.stdout.isTTY || !process.stdin.isTTY) {
    process.stdout.write(renderOnce({ data: data(), width: width ?? process.stdout.columns ?? 100, tab: tab ?? undefined, version: VERSION }))
    return 0
  }
  return runUi({ data, tab: tab ?? undefined, version: VERSION })
}

/** The map engine, loaded on first use; remembered so open maps can be closed on the way out. */
let engine: typeof import('../map/indexer.ts') | null = null
async function indexer(): Promise<typeof import('../map/indexer.ts')> {
  engine ??= await import('../map/indexer.ts')
  return engine
}

main(process.argv.slice(2))
  .then(code => {
    engine?.closeMaps()
    process.exitCode = code
  })
  .catch(err => {
    engine?.closeMaps()
    console.error(`${bad('✗')} ${(err as Error).message}`)
    process.exitCode = 1
  })