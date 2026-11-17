// Shared helpers for the Mapshift vs Graft benchmark.
// Everything that touches the disk outside bench/ lives under one work folder (BENCH_WORK, or --work <dir>).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BENCH = dirname(fileURLToPath(import.meta.url))

export function argValue(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

export const WORK = resolve(argValue('work') ?? process.env.BENCH_WORK ?? join(tmpdir(), 'mapshift-bench'))
export const REPOS_DIR = join(WORK, 'bench-repos')
export const repoPath = (tool, name) => join(REPOS_DIR, tool, name) // tool: 'upstream' | 'mapshift' | 'graft' | 'agent-mapshift' | 'agent-graft'

export const readJson = p => JSON.parse(readFileSync(p, 'utf8'))
export const REPOS = readJson(join(BENCH, 'repos.json')).repos

/** The JS entry of each CLI, run with this same node binary and no shell. */
export function toolEntries() {
  const mapshift = resolve(process.env.MAPSHIFT_BIN ?? join(BENCH, '..', 'dist', 'cli', 'main.js'))
  let graft = process.env.GRAFT_BIN
  if (!graft) {
    const root = spawnSync('npm root -g', { encoding: 'utf8', shell: true }).stdout.trim()
    graft = join(root, '@nanonets', 'graft', 'dist', 'bin', 'graft.js')
  }
  for (const p of [mapshift, graft]) if (!existsSync(p)) throw new Error(`missing tool entry: ${p}`)
  return { mapshift, graft: resolve(graft) }
}

/** Environment shared by every tool process: no colour, no telemetry or update checks. */
export function toolEnv(extra = {}) {
  return { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', DO_NOT_TRACK: '1', ...extra }
}

export const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')

/** Runs `node <entry> ...args` in cwd; resolves {code, stdout, stderr, ms}. */
export function run(entry, args, { cwd, env, timeoutMs = 600_000 } = {}) {
  return new Promise(res => {
    const t0 = performance.now()
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', d => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', d => (stderr += d))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      res({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), ms: performance.now() - t0 })
    })
    child.on('error', err => {
      clearTimeout(timer)
      res({ code: -1, stdout, stderr: String(err), ms: performance.now() - t0 })
    })
  })
}

function git(args, cwd) {
  // repository config and hooks are never run: fsmonitor and hooks are switched off for every call
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

/** Clones repo.url into upstream/ once, then makes a separate pinned clone per tool so neither tool sees the other's files. */
export function ensureClone(repo, tool) {
  const up = repoPath('upstream', repo.name)
  if (!existsSync(join(up, '.git'))) {
    mkdirSync(dirname(up), { recursive: true })
    git(['clone', '--quiet', repo.url, up], WORK)
  }
  const dest = repoPath(tool, repo.name)
  if (!existsSync(join(dest, '.git'))) {
    mkdirSync(dirname(dest), { recursive: true })
    git(['clone', '--quiet', '--no-checkout', up, dest], WORK)
    git(['checkout', '--quiet', '--detach', repo.commit], dest)
  } else if (git(['rev-parse', 'HEAD'], dest) !== repo.commit) {
    git(['checkout', '--quiet', '--detach', repo.commit], dest)
  }
  const now = git(['rev-parse', 'HEAD'], dest)
  if (now !== repo.commit) throw new Error(`${dest} is at ${now}, expected ${repo.commit}`)
  // every tracked file must be on disk (a clone without a checkout would silently give both tools an empty repo)
  const missing = git(['ls-files', '--deleted'], dest)
  if (missing) throw new Error(`${dest} is missing tracked files, for example ${missing.split('\n')[0]}`)
  return dest
}

export function dirSize(p) {
  if (!existsSync(p)) return 0
  const st = statSync(p)
  if (!st.isDirectory()) return st.size
  return readdirSync(p).reduce((s, n) => s + dirSize(join(p, n)), 0)
}

/** Stored text never carries this machine's folders: the work folder becomes <work> and the home folder ~. */
export function scrub(s) {
  let out = s
  for (const [from, to] of [
    [WORK, '<work>'],
    [homedir(), '~'],
  ])
    for (const v of [from, from.replace(/\\/g, '/'), from.replace(/\\/g, '\\\\')]) out = out.split(v).join(to)
  return out
}
export const deepScrub = v =>
  typeof v === 'string' ? scrub(v) : Array.isArray(v) ? v.map(deepScrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepScrub(x)])) : v

export const median = xs => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
export const tokens = chars => Math.round(chars / 4)
