// `mapshift update`: the one command that brings an installed Mapshift up to date. It asks npm for the
// newest version (the only request Mapshift makes; the background check in autoupdate.ts runs these same
// steps every few days), installs it in place, and updates the Claude Code add-on too. Agents keep pointing at the same install, so nothing
// else needs to change.
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { bad, bold, dim, good, header, warn } from '../cli/ui.ts'
import { which } from './env.ts'
import { npmCli } from './persist.ts'

/** `1.10.0` is newer than `1.9.3`. Pre-release tags count as older than the release. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre] = v.trim().replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map(n => Number(n) || 0), pre: pre ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return d > 0
  }
  return x.pre === null && y.pre !== null
}

type Run = (exe: string, args: string[], show: boolean) => { status: number | null; stdout: string; stderr?: string }

const defaultRun: Run = (exe, args, show) => {
  const r = spawnSync(exe, args, { cwd: homedir(), encoding: 'utf8', windowsHide: true, stdio: show ? 'inherit' : ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

export async function runUpdate(o: { current: string; check?: boolean; run?: Run; out?: (s: string) => void; claude?: string | null; missing?: () => { label: string }[] }): Promise<number> {
  const out = o.out ?? ((s: string) => console.log(s))
  // coding agents installed since the last setup: said once at the end, whatever the update did
  const newAgents = async () => {
    let list: { label: string }[] = []
    try {
      list = o.missing ? o.missing() : (await import('./setup.ts')).missingAgents()
    } catch {
      /* only a hint */
    }
    if (list.length) out(`  ${warn('!')} Found without Mapshift: ${list.map(m => m.label).join(' · ')}. Add it to them: ${bold('mapshift setup')}\n`)
  }
  const run = o.run ?? defaultRun
  out(header('Update'))
  const cli = npmCli()
  if (!cli) {
    out(`  ${bad('✗')} npm was not found next to Node. Install Node.js from nodejs.org, then try again.`)
    return 1
  }
  const view = run(process.execPath, [cli, 'view', 'mapshift', 'version'], false)
  const latest = view.status === 0 ? view.stdout.trim().split(/\s+/).pop() ?? '' : ''
  if (!/^\d+\.\d+\.\d+/.test(latest)) {
    out(
      /E404|404 Not Found/.test(view.stderr ?? '')
        ? `  ${warn('!')} Mapshift is not published on npm yet, so there is nothing newer to get.`
        : `  ${bad('✗')} Could not reach npm to look for a new version. Check your connection and try again.`,
    )
    return 1
  }
  if (!newer(latest, o.current)) {
    out(`  ${good('✓')} You have the newest version, ${bold(o.current)}.\n`)
    await newAgents()
    return 0
  }
  out(`  A new version is out: ${bold(o.current)} → ${bold(latest)}`)
  if (o.check) {
    out(`  Run ${bold('mapshift update')} to install it.\n`)
    return 0
  }
  const inst = run(process.execPath, [cli, 'install', '--global', `mapshift@${latest}`, '--no-fund', '--no-audit'], true)
  if (inst.status !== 0) {
    out(`  ${bad('✗')} npm could not install it. Nothing else was changed.`)
    return 1
  }
  out(`  ${good('✓')} Mapshift ${latest} is installed. Your agents already point at it.`)
  const claude = o.claude === undefined ? which('claude') : o.claude
  if (claude) {
    run(claude, ['plugin', 'marketplace', 'update', 'mapshift'], false)
    const up = run(claude, ['plugin', 'update', 'mapshift@mapshift', '--scope', 'user'], false)
    out(up.status === 0 ? `  ${good('✓')} The Claude Code add-on is updated too.` : `  ${warn('!')} The Claude Code add-on was not updated ${dim('(run: claude plugin update mapshift@mapshift)')}.`)
  }
  out(`\n  Open a new chat to use it. In Claude Code you can also type ${bold('/reload-plugins')}.\n`)
  await newAgents()
  return 0
}
