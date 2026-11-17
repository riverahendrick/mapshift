// `mapshift setup`, `off`, `on` and `uninstall`: adds Mapshift to each coding agent's personal settings,
// backing up every file first and recording exactly what was added, so all of it can be taken away again.
import { execFileSync } from 'node:child_process'
import { mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { AGENTS, agentById, claudeCommands, claudeUndo, type AgentDef } from '../agents/registry.ts'
import { bad, bold, dim, good, header, warn } from '../cli/ui.ts'
import { runtime, targets, tilde, which, type Env, type Runtime, type Targets } from './env.ts'
import {
  applyPiece,
  backup,
  loadHome,
  missingDirs,
  readText,
  recId,
  removeEmptyDirs,
  removeRec,
  saveHome,
  stampNow,
  writeText,
  type AgentId,
  type Outcome,
  type Piece,
  type Rec,
} from './pieces.ts'

export type RunOptions = {
  home?: string
  agents?: string
  yes?: boolean
  dryRun?: boolean
  env?: Env
  rt?: Partial<Runtime>
  /** Whether a person can answer a question here. Defaults to stdin being a terminal. */
  interactive?: boolean
  ask?: (question: string) => Promise<boolean>
  out?: (line: string) => void
  /** Runs one of Claude Code's own commands. Tests replace it. */
  runClaude?: (exe: string, args: string[]) => void
  now?: Date
}

type Ctx = { t: Targets; rt: Runtime; out: (s: string) => void; env: Env; stamp: string }

function context(o: RunOptions): Ctx {
  const env = o.env ?? process.env
  return {
    t: targets({ home: o.home, env }),
    rt: runtime(o.rt),
    out: o.out ?? (s => console.log(s)),
    env,
    stamp: stampNow(o.now),
  }
}

/** The agents to work on: the ones named with --agents, or every one found on this computer. */
function pickAgents(c: Ctx, names: string | undefined): { list: AgentDef[]; error?: string } {
  if (names) {
    const ids = names.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    const unknown = ids.filter(id => !agentById(id))
    if (unknown.length) return { list: [], error: `Unknown agent "${unknown[0]}". Choose from: ${AGENTS.map(a => a.id).join(', ')}.` }
    return { list: AGENTS.filter(a => ids.includes(a.id)) }
  }
  return { list: AGENTS.filter(a => a.detect(c.t, c.env)) }
}

type RunResult = { outcomes: Outcome[]; records: Map<string, Rec>; changed: string[]; backups: Set<string> }

/** Applies pieces file by file. With `write: false` it only works out what would change. */
function execute(c: Ctx, pieces: Piece[], prev: Rec[], write: boolean): RunResult {
  const byId = new Map(prev.map(r => [r.id, r]))
  const records = new Map(byId)
  const files = new Map<string, { orig: string | null; text: string | null }>()
  const outcomes: Outcome[] = []
  for (const p of pieces) {
    const path = resolve(p.path)
    let f = files.get(path)
    if (!f) {
      const orig = readText(path)
      f = { orig, text: orig }
      files.set(path, f)
    }
    const id = recId(p)
    const before = records.get(id) // from an earlier run, or from another agent in this one (a shared file)
    const step = applyPiece(p, f.text, before)
    outcomes.push({ piece: p, action: step.action, reason: step.reason })
    if (step.action === 'skip') continue
    f.text = step.text
    const base: Rec = before ?? { id, kind: p.kind, path, agents: [], label: p.label }
    records.set(id, {
      ...base,
      ...step.rec,
      agents: [...new Set([...base.agents, p.agent])],
      ...(p.kind === 'block' ? { format: p.format, fence: p.fence, own: p.own } : {}),
      ...(p.kind === 'json' ? { key: p.key } : {}),
    })
  }
  const changed: string[] = []
  const backups = new Set<string>()
  for (const [path, f] of files) {
    if (f.text === null || f.text === f.orig) continue
    changed.push(path)
    if (!write) continue
    const b = backup(path, c.t, c.stamp)
    if (b) backups.add(dirname(b))
    const dirs = missingDirs(path)
    mkdirSync(dirname(path), { recursive: true })
    writeText(path, f.text)
    if (dirs.length) for (const r of records.values()) if (r.path === path && r.created) r.dirs = dirs
  }
  return { outcomes, records, changed, backups }
}

/** Takes recorded changes out again, newest first, so each removal sees the file as it left it. */
function removeAll(c: Ctx, recs: Rec[]): { notes: string[]; touched: number } {
  const notes: string[] = []
  const byPath = new Map<string, Rec[]>()
  for (const r of recs) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r])
  let touched = 0
  for (const [path, list] of byPath) {
    const orig = readText(path)
    if (orig === null) continue
    let text: string | null = orig
    for (const r of [...list].reverse()) {
      if (text === null) break
      const res = removeRec(r, text)
      if (res.note) notes.push(res.note)
      text = res.text
    }
    if (text === orig) continue
    backup(path, c.t, c.stamp)
    touched++
    if (text === null) unlinkSync(path)
    else writeText(path, text)
  }
  // folders setup created, once all files are out, deepest first
  removeEmptyDirs([...new Set(recs.flatMap(r => r.dirs ?? []))].sort((a, b) => b.length - a.length))
  return { notes, touched }
}

const MARK: Record<Outcome['action'], (s: string) => string> = {
  add: s => good(s),
  update: s => warn(s),
  same: s => dim(s),
  skip: s => warn(s),
}
const SIGN: Record<Outcome['action'], string> = { add: '+', update: '~', same: '✓', skip: '!' }
const VERB: Record<Outcome['action'], string> = { add: 'add', update: 'update', same: 'already set', skip: 'skip' }

function printPlan(c: Ctx, agents: AgentDef[], outcomes: Outcome[]): void {
  const width = Math.max(...outcomes.map(o => o.piece.label.length), 12)
  // a file two agents share (GEMINI.md) is changed by the first; the second only shares it
  const firstBy = new Map<string, AgentId>()
  for (const o of outcomes) if (o.action === 'add' || o.action === 'update') if (!firstBy.has(recId(o.piece))) firstBy.set(recId(o.piece), o.piece.agent)
  for (const a of agents) {
    c.out(`  ${bold(a.label)}${a.beta ? dim('  (beta)') : ''}`)
    if (a.id === 'claude') {
      c.out(`    ${dim('Claude Code adds Mapshift with its own commands:')}`)
      for (const args of claudeCommands(c.rt)) c.out(`    ${dim('$')} ${claudeLine(args)}`)
      continue
    }
    for (const o of outcomes.filter(x => x.piece.agent === a.id)) {
      const owner = firstBy.get(recId(o.piece))
      const note = o.action !== 'same' ? '' : owner && owner !== a.id ? `  shared with ${agentById(owner)!.label}` : '  already set'
      c.out(`    ${MARK[o.action](SIGN[o.action])} ${o.piece.label.padEnd(width)}  ${dim(tilde(o.piece.path, c.t.home))}${dim(note)}`)
      if (o.reason) c.out(`      ${dim(o.reason)}`)
    }
  }
}

const claudeLine = (args: string[]): string => ['claude', ...args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(' ')

/** Runs Claude Code's own command only for the real home and only through a real program file (never a shell). */
function claudeRunner(c: Ctx, o: RunOptions): { exe: string | null; why?: string } {
  if (!o.yes) return { exe: null, why: 'Mapshift runs these for you only with --yes. Run them yourself:' }
  if (c.t.explicit) return { exe: null, why: '--home points somewhere else, so Claude Code was left alone. Run these yourself if you want them:' }
  const exe = which('claude', c.env)
  if (!exe) return { exe: null, why: 'Claude Code is not on PATH. Run these once it is:' }
  if (process.platform === 'win32' && !/\.exe$/i.test(exe) && !o.runClaude) return { exe: null, why: 'Run these yourself in a terminal:' }
  return { exe }
}

function defaultRun(exe: string, args: string[]): void {
  execFileSync(exe, args, { cwd: homedir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120_000 })
}

export async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>(done => rl.question(question, done))
    return /^\s*y(es)?\s*$/i.test(answer)
  } finally {
    rl.close()
  }
}

export async function runSetup(o: RunOptions): Promise<number> {
  const c = context(o)
  const { list: agents, error } = pickAgents(c, o.agents)
  c.out(header('Set up Mapshift for your coding agents'))
  if (error) {
    c.out(`  ${bad('✗')} ${error}`)
    return 2
  }
  if (!agents.length) {
    c.out(`  No coding agents found in ${tilde(c.t.home, c.t.home) === '~' ? 'your home folder' : c.t.home}.`)
    c.out(`  Name them to set them up anyway, for example: ${bold('mapshift setup --agents codex,grok')}\n`)
    return 1
  }
  c.out(`  ${dim('Agents')}  ${agents.map(a => a.label + (a.beta ? ' (beta)' : '')).join(' · ')}`)
  if (c.t.explicit) c.out(`  ${dim('Home  ')}  ${c.t.home}`)
  c.out('')

  const prev = loadHome(c.t)
  const pieces = agents.flatMap(a => a.pieces(c.t, c.rt))
  const plan = execute(c, pieces, prev?.state === 'on' ? prev.records : [], false)
  printPlan(c, agents, plan.outcomes)
  c.out('')

  const interactive = o.interactive ?? !!process.stdin.isTTY
  let go = !!o.yes && !o.dryRun
  if (!go && !o.dryRun && interactive) {
    c.out(`  ${dim('Each file is backed up first, and')} ${bold('mapshift uninstall')} ${dim('takes everything out again.')}`)
    go = await (o.ask ?? askYesNo)('  Apply these changes? [y/N] ')
    if (!go) {
      c.out(`  Nothing was changed.\n`)
      return 0
    }
  }
  if (!go) {
    c.out(o.dryRun ? `  ${dim('Dry run: nothing was changed.')}` : `  ${dim('Nothing was changed. Run again with')} ${bold('--yes')} ${dim('to apply (there is no keyboard here to ask).')}`)
    c.out('')
    return 0
  }

  const res = execute(c, pieces, prev?.state === 'on' ? prev.records : [], true)
  let claudeDone = prev?.claude ?? false
  if (agents.some(a => a.id === 'claude')) claudeDone = setUpClaude(c, o) || claudeDone
  const doneAgents = agents.filter(a => a.id === 'claude' || res.outcomes.some(x => x.piece.agent === a.id && x.action !== 'skip')).map(a => a.id)
  saveHome(c.t, {
    home: c.t.home,
    state: 'on',
    agents: [...new Set([...(prev?.state === 'on' ? prev.agents : []), ...doneAgents])] as AgentId[],
    records: [...res.records.values()],
    claude: claudeDone,
    updatedAt: new Date().toISOString(),
  })

  const skipped = res.outcomes.filter(x => x.action === 'skip').length
  c.out(`  ${good('✓')} ${res.changed.length ? `Changed ${res.changed.length} file${res.changed.length === 1 ? '' : 's'}` : 'Everything was already set up'}${skipped ? `, ${skipped} skipped (see ! above)` : ''}.`)
  if (res.backups.size) c.out(`  ${dim('Backups')}  ${tilde(join(c.t.mapshift, 'backups', c.stamp), c.t.home)}`)
  c.out(`\n${bold('Next steps')}`)
  const w = Math.max(...agents.map(a => a.label.length))
  for (const a of agents) c.out(`  ${a.label.padEnd(w)}  ${a.next}`)
  c.out(`\n  ${dim('Pause it:')} mapshift off   ${dim('Resume:')} mapshift on   ${dim('Remove:')} mapshift uninstall\n`)
  return 0
}

function setUpClaude(c: Ctx, o: RunOptions): boolean {
  const cmds = claudeCommands(c.rt)
  const { exe, why } = claudeRunner(c, o)
  if (!exe) {
    c.out(`  ${warn('!')} Claude Code: ${why?.replace(/:$/, '')} ${dim('(the three commands above).')}`)
    return false
  }
  const run = o.runClaude ?? defaultRun
  for (const args of cmds) {
    try {
      run(exe, args)
      c.out(`  ${good('✓')} ${claudeLine(args)}`)
    } catch (err) {
      c.out(`  ${warn('!')} ${claudeLine(args)} ${dim(`did not finish: ${firstLine(err)}`)}`)
    }
  }
  return true
}

const firstLine = (err: unknown): string => {
  const e = err as { stderr?: Buffer | string; message?: string }
  return (String(e.stderr ?? '').trim() || e.message || 'unknown error').split('\n')[0]!.slice(0, 160)
}

/** `mapshift off`: takes Mapshift out of every agent, keeping a note of which agents to put it back into. */
export async function runOff(o: RunOptions): Promise<number> {
  const c = context(o)
  c.out(header('Turn Mapshift off'))
  const home = loadHome(c.t)
  if (!home) {
    c.out(`  Mapshift is not set up here, so there is nothing to turn off.\n`)
    return 0
  }
  if (home.state === 'off') {
    c.out(`  Mapshift is already off. Turn it back on with ${bold('mapshift on')}.\n`)
    return 0
  }
  const { notes, touched } = removeAll(c, home.records)
  saveHome(c.t, { ...home, state: 'off', records: [], updatedAt: new Date().toISOString() })
  for (const n of notes) c.out(`  ${warn('!')} ${n}`)
  c.out(`  ${good('✓')} Mapshift is off for ${labels(home.agents.filter(a => a !== 'claude'))} (${touched} file${touched === 1 ? '' : 's'} changed, backed up first).`)
  if (home.agents.includes('claude')) c.out(`  ${dim('Claude Code: turn the plugin off with /plugin inside Claude Code.')}`)
  c.out(`  Restart the agents for it to take effect. ${bold('mapshift on')} brings it back.\n`)
  return 0
}

/** `mapshift on`: puts Mapshift back into the agents it was turned off for. */
export async function runOn(o: RunOptions): Promise<number> {
  const c = context(o)
  const home = loadHome(c.t)
  if (!home) {
    c.out(`${header('Turn Mapshift on')}  Mapshift is not set up here yet. Run ${bold('mapshift setup')} first.\n`)
    return 1
  }
  if (home.state === 'on') {
    c.out(`${header('Turn Mapshift on')}  Mapshift is already on.\n`)
    return 0
  }
  const agents: AgentId[] = home.agents.filter(a => a !== 'claude')
  const pieces = AGENTS.filter(a => agents.includes(a.id)).flatMap(a => a.pieces(c.t, c.rt))
  const res = execute(c, pieces, [], true)
  saveHome(c.t, { ...home, state: 'on', records: [...res.records.values()], updatedAt: new Date().toISOString() })
  c.out(header('Turn Mapshift on'))
  for (const x of res.outcomes.filter(x => x.action === 'skip')) c.out(`  ${warn('!')} ${x.piece.label} for ${agentById(x.piece.agent)!.label}: ${x.reason}`)
  c.out(`  ${good('✓')} Mapshift is on again for ${labels(agents)}. Restart the agents for it to take effect.\n`)
  return 0
}

/** `mapshift uninstall`: removes everything setup added and nothing else. */
export async function runUninstall(o: RunOptions): Promise<number> {
  const c = context(o)
  c.out(header('Remove Mapshift from your coding agents'))
  const home = loadHome(c.t)
  if (!home) {
    c.out(`  Mapshift is not set up here, so there is nothing to remove.\n`)
    return 0
  }
  const interactive = o.interactive ?? !!process.stdin.isTTY
  const files = [...new Set(home.records.map(r => r.path))]
  for (const f of files) c.out(`  ${warn('-')} ${tilde(f, c.t.home)}`)
  if (!o.yes) {
    if (o.dryRun || !interactive) {
      c.out(`\n  ${dim('Nothing was changed.')} ${o.dryRun ? '' : `Run again with ${bold('--yes')} to remove it.`}\n`)
      return 0
    }
    if (!(await (o.ask ?? askYesNo)('\n  Remove Mapshift from these files? [y/N] '))) {
      c.out(`  Nothing was changed.\n`)
      return 0
    }
  }
  const { notes, touched } = removeAll(c, home.records)
  for (const n of notes) c.out(`  ${warn('!')} ${n}`)
  saveHome(c.t, null)
  c.out(`  ${good('✓')} Removed Mapshift from ${labels(home.agents.filter(a => a !== 'claude'))} (${touched} file${touched === 1 ? '' : 's'}; backups in ${tilde(join(c.t.mapshift, 'backups', c.stamp), c.t.home)}).`)
  if (home.agents.includes('claude')) {
    const { exe, why } = home.claude && o.yes ? claudeRunner(c, o) : { exe: null, why: 'Claude Code: run these to remove it there too:' }
    if (exe) {
      for (const args of claudeUndo()) {
        try {
          ;(o.runClaude ?? defaultRun)(exe, args)
          c.out(`  ${good('✓')} ${claudeLine(args)}`)
        } catch (err) {
          c.out(`  ${warn('!')} ${claudeLine(args)} ${dim(`did not finish: ${firstLine(err)}`)}`)
        }
      }
    } else {
      c.out(`  ${dim(why ?? '')}`)
      for (const args of claudeUndo()) c.out(`      ${claudeLine(args)}`)
    }
  }
  c.out('')
  return 0
}

const labels = (ids: AgentId[]): string => ids.map(id => agentById(id)?.label ?? id).join(', ') || 'no agents'
