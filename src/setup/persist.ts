// `npx mapshift setup` runs from npm's temporary cache. Agents must not be pointed at that copy: npm clears
// the cache, and the map tools would stop working later without a word. So setup first installs a lasting
// copy (the same version), then carries on from it.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

/** True when this script runs from npm's temporary npx cache. */
export function isTemporaryCopy(script: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const s = script.replace(/\\/g, '/').toLowerCase()
  if (s.includes('/_npx/')) return true
  const cache = env.npm_config_cache?.replace(/\\/g, '/').toLowerCase()
  return !!cache && s.startsWith(cache.replace(/\/+$/, '') + '/')
}

/** npm's own script, run by this same Node (never by a bare `npm` name from some folder). */
export function npmCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const given = env.npm_execpath
  if (given && /npm-cli\.js$/i.test(given) && existsSync(given)) return given
  const nodeDir = dirname(process.execPath)
  for (const p of [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(p)) return p
  }
  return null
}

const npm = (cli: string, args: string[], inherit: boolean) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: homedir(), stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true })

/**
 * Installs this version of Mapshift globally and returns the lasting copy's entry point, or null with the
 * reason. Output from npm is shown, so the person sees what happens.
 */
export function installLasting(version: string): { main: string | null; why?: string } {
  const cli = npmCli()
  if (!cli) return { main: null, why: 'npm was not found next to Node' }
  const res = npm(cli, ['install', '--global', `mapshift@${version}`, '--no-fund', '--no-audit'], true)
  if (res.status !== 0) return { main: null, why: 'npm could not install it' }
  const root = npm(cli, ['root', '--global'], false).stdout?.trim()
  const main = root ? join(root, 'mapshift', 'dist', 'cli', 'main.js') : ''
  return main && existsSync(main) ? { main } : { main: null, why: `the installed copy was not found under ${root ?? 'the global folder'}${sep}mapshift` }
}

/** Runs the lasting copy with the same arguments and passes its exit code on. */
export function continueFrom(main: string, args: string[]): number {
  const res = spawnSync(process.execPath, [main, ...args], { cwd: homedir(), stdio: 'inherit', windowsHide: true })
  return res.status ?? 1
}
