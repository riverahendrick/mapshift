// `mapshift setup`, `off`, `on` and `uninstall`: adds Mapshift to each coding agent's personal settings,
// backing up every file first and recording exactly what was added, so all of it can be taken away again.
import { execFileSync } from 'node:child_process'
import { mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { AGENTS, agentById, claudeCommands, claudeUndo, type AgentDef } from '../agents/registry.ts'
import { bad, bold, dim, good, header, warn } from '../cli/ui.ts'
import { newer } from './update.ts'
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
      ...(p.kind === 'block' ? { format: p.format, fence: p.fence, own: p.own, guard: p.guard } : {}),
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
  c.out(`\n  ${dim('Pause it:')} mapshift off   ${dim('Resume:')} mapshift on   ${dim('Remove:')} mapshift uninstall`)
  c.out(`  ${dim('Mapshift keeps itself up to date: every 3 days it checks npm for a new version. Turn that off:')} mapshift auto-update off\n`)
  return 0
}

/**
 * The coding agents on this computer that Mapshift is not in yet: found, with something setup would still add.
 * Claude Code is left out (its own add-on says so), and nothing is listed while Mapshift is paused with
 * `mapshift off`, since the person chose that.
 */
export function missingAgents(o: Pick<RunOptions, 'home' | 'env' | 'rt'> = {}): { id: AgentId; label: string }[] {
  const c = context({ ...o, out: () => {} })
  const prev = loadHome(c.t)
  if (prev?.state === 'off') return []
  const found = AGENTS.filter(a => a.id !== 'claude' && a.detect(c.t, c.env))
  const plan = execute(c, found.flatMap(a => a.pieces(c.t, c.rt)), prev?.state === 'on' ? prev.records : [], false)
  return found.filter(a => plan.outcomes.some(x => x.piece.agent === a.id && x.action === 'add')).map(a => ({ id: a.id, label: a.label }))
}

// ---- Claude Code's Code Mode: an experimental Claude Code feature in which Claude writes a short program that
// makes several tool calls in one step. Mapshift only turns it on when asked, after checking it can run here.

const CODE_MODE = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE'
/** The first Claude Code release with Code Mode. */
export const CODE_MODE_MIN = '2.1.323'

export type CodeModeCheck = { on: boolean; byMapshift: boolean; version: string | null; blockers: string[] }

/**
 * Whether Code Mode is on in the personal Claude Code settings, and what would stop it from running here.
 * Reads only that settings file and `claude --version`; never a credential.
 */
export function checkCodeMode(o: Pick<RunOptions, 'home' | 'env'> & { version?: string | null } = {}): CodeModeCheck {
  const c = context({ ...o, out: () => {} })
  const env = c.env
  const file = join(c.t.claude, 'settings.json')
  let settings: { env?: Record<string, unknown>; apiKeyHelper?: unknown } = {}
  try {
    settings = JSON.parse(readText(file) ?? '{}') as typeof settings
  } catch {
    /* unreadable: treated as empty */
  }
  // run from inside a Claude Code session, the environment holds that session's own values (the Desktop app
  // sets its own ANTHROPIC_BASE_URL, for one): then only the settings file speaks for the person
  const fromEnv = (k: string) => (env.CLAUDECODE ? undefined : env[k])
  const val = (k: string) => String(settings.env?.[k] ?? fromEnv(k) ?? '')
  const version = o.version !== undefined ? o.version : claudeVersion(c)
  const blockers: string[] = []
  if (!version) blockers.push('Claude Code was not found on this computer')
  else if (newer(CODE_MODE_MIN, version)) blockers.push(`Claude Code ${version} is too old: Code Mode needs ${CODE_MODE_MIN} or newer (run: claude update)`)
  if (settings.apiKeyHelper) blockers.push('an API key helper is set, and Code Mode does not start with one')
  if (['DISABLE_TELEMETRY', 'CLAUDE_CODE_ENABLE_TELEMETRY'].some(k => val(k) === '1') || val('OTEL_METRICS_EXPORTER') || val('OTEL_LOGS_EXPORTER')) blockers.push('telemetry export or DISABLE_TELEMETRY is set, and Code Mode does not start with either')
  if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(k => val(k) === '1') || val('ANTHROPIC_BASE_URL')) blockers.push('Claude Code goes through a cloud provider or a gateway here, and Code Mode needs a Claude subscription or Console account')
  if (process.platform === 'win32' && !which('git', env)) blockers.push('Git for Windows is not installed, and Code Mode needs it on Windows')
  const prev = loadHome(c.t)
  const byMapshift = !!prev?.records.some(r => r.kind === 'json' && r.key?.join('.') === `env.${CODE_MODE}`)
  return { on: val(CODE_MODE) === '1', byMapshift, version, blockers }
}

function claudeVersion(c: Ctx): string | null {
  const exe = which('claude', c.env)
  if (!exe) return null
  try {
    const out = execFileSync(exe, ['--version'], { cwd: homedir(), encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' && !/\.exe$/i.test(exe) })
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null
  } catch {
    return null
  }
}

const codeModePiece = (t: Targets): Piece => ({ agent: 'claude', label: 'Code Mode', path: join(t.claude, 'settings.json'), kind: 'json', key: ['env', CODE_MODE], value: '1' })

/** `mapshift code-mode on|off|status`. On only after the checks pass; off takes out only what Mapshift added. */
export async function runCodeMode(o: RunOptions & { action: string; version?: string | null }): Promise<number> {
  const c = context(o)
  const st = checkCodeMode({ ...o, version: o.version })
  c.out(header('Code Mode in Claude Code'))
  const what = `  ${dim('Claude writes a short program that makes several tool calls in one step: fewer round trips, less output to read.')}\n  ${dim('Experimental: terminal sessions only (not the Desktop app, VS Code or claude -p), and a Code Mode chat resumes only with it on.')}`
  if (o.action === 'on') {
    if (st.on) {
      c.out(`  ${good('✓')} Already on${st.byMapshift ? '' : ' (you turned it on yourself)'}. New terminal sessions use it.\n`)
      return 0
    }
    if (st.blockers.length) {
      c.out(`  ${bad('✗')} Not turned on: it would not run here.`)
      for (const b of st.blockers) c.out(`    - ${b}`)
      c.out('')
      return 1
    }
    const prev = loadHome(c.t)
    const res = execute(c, [codeModePiece(c.t)], prev?.records ?? [], true)
    const skipped = res.outcomes.find(x => x.action === 'skip')
    if (skipped) {
      c.out(`  ${warn('!')} ${skipped.reason ?? 'Left as is.'}\n`)
      return 1
    }
    saveHome(c.t, {
      home: c.t.home,
      state: prev?.state ?? 'on',
      agents: prev?.agents ?? [],
      records: [...res.records.values()],
      claude: prev?.claude ?? false,
      updatedAt: new Date().toISOString(),
    })
    c.out(`  ${good('✓')} Code Mode is on for new Claude Code terminal sessions. Claude Code asks you to confirm it once, then restarts.`)
    c.out(`${what}\n  ${dim('Turn it off:')} mapshift code-mode off\n`)
    return 0
  }
  if (o.action === 'off') {
    const prev = loadHome(c.t)
    const mine = prev?.records.filter(r => r.kind === 'json' && r.key?.join('.') === `env.${CODE_MODE}`) ?? []
    if (!mine.length) {
      c.out(st.on ? `  ${warn('!')} Code Mode was turned on outside Mapshift, so Mapshift left it alone. Remove ${bold(CODE_MODE)} from ~/.claude/settings.json to turn it off.\n` : `  ${good('✓')} Code Mode is already off.\n`)
      return 0
    }
    removeAll(c, mine)
    saveHome(c.t, { ...prev!, records: prev!.records.filter(r => !mine.includes(r)), updatedAt: new Date().toISOString() })
    c.out(`  ${good('✓')} Code Mode is off for new Claude Code sessions.\n`)
    return 0
  }
  c.out(`  ${dim('State')}    ${st.on ? good('on') : 'off'}${st.on && !st.byMapshift ? dim(' (turned on outside Mapshift)') : ''}`)
  c.out(`  ${dim('Claude')}   ${st.version ?? 'not found'}`)
  if (st.blockers.length) for (const b of st.blockers) c.out(`  ${warn('!')} ${b}`)
  else if (!st.on) c.out(`  ${good('✓')} It can run here: ${bold('mapshift code-mode on')}`)
  c.out(`${what}\n`)
  return 0
}

/** `mapshift setup --check`: which agents on this computer still need Mapshift, as words or as JSON. */
export function runCheck(o: RunOptions & { json?: boolean }): number {
  const c = context(o)
  const missing = missingAgents(o)
  if (o.json) {
    c.out(JSON.stringify({ missing }))
    return 0
  }
  c.out(header('Coding agents without Mapshift'))
  if (!missing.length) c.out(`  ${good('✓')} Every coding agent found on this computer has Mapshift.\n`)
  else c.out(`  ${missing.map(m => m.label).join(' · ')}\n\n  Add it to them: ${bold('mapshift setup')}\n`)
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
