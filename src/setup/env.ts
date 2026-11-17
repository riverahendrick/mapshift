import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where every agent keeps its personal settings. An explicit `--home` wins over everything, so a trial run
 * in a throwaway folder can never reach the real config; otherwise the agents' own overrides are honoured.
 */
export type Targets = {
  home: string
  /** True when the person passed --home: nothing may be run against the real home then. */
  explicit: boolean
  codex: string
  gemini: string
  grok: string
  cursor: string
  claude: string
  /** Where Mapshift keeps its setup record and backups for this home. */
  mapshift: string
}

export type Env = Record<string, string | undefined>

export function targets(o: { home?: string; env?: Env } = {}): Targets {
  const env = o.env ?? process.env
  const explicit = !!o.home
  const home = resolve(o.home ?? homedir())
  const fromEnv = (name: string, fallback: string) => {
    const v = env[name]?.trim()
    return !explicit && v ? resolve(v) : fallback
  }
  const custom = env.MAPSHIFT_HOME?.trim()
  return {
    home,
    explicit,
    codex: fromEnv('CODEX_HOME', join(home, '.codex')),
    gemini: join(home, '.gemini'),
    grok: fromEnv('GROK_HOME', join(home, '.grok')),
    cursor: join(home, '.cursor'),
    claude: join(home, '.claude'),
    mapshift: custom ? resolve(custom) : join(home, '.mapshift'),
  }
}

/**
 * The full path of a program on PATH, or null. Only absolute PATH folders are searched, and the current
 * folder never is: on Windows a bare name would otherwise find a program planted in a project. Nothing is run.
 */
export function which(name: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(d => d && isAbsolute(d))
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com', ''] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext)
      try {
        if (statSync(p).isFile()) return p
      } catch {
        /* not here */
      }
    }
  }
  return null
}

/** The program that runs Mapshift: this Node, and this package's built entry point. Absolute paths, so no PATH is needed. */
export type Runtime = { node: string; script: string }

export function runtime(o: Partial<Runtime> = {}): Runtime {
  const script = o.script ?? builtEntry()
  return { node: o.node ?? process.execPath, script }
}

/** dist/cli/main.js of this package, whether running from dist or from the TypeScript sources. */
export function builtEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url)) // .../dist/setup or .../src/setup
  const pkg = resolve(here, '..', '..')
  const script = join(pkg, 'dist', 'cli', 'main.js')
  if (!existsSync(script)) throw new Error(`Mapshift is not built yet (${script} is missing). Run "npm run build" first.`)
  return script
}

/** A path written the way shells and config files read best: forward slashes on Windows too. */
export const fwd = (p: string): string => p.replace(/\\/g, '/')

/** One shell command line that runs Mapshift with these arguments. Paths are quoted and use forward slashes. */
export function shellLine(rt: Runtime, args: string[]): string {
  const q = (s: string) => `"${fwd(s).replace(/"/g, '\\"')}"`
  return [q(rt.node), q(rt.script), ...args].join(' ')
}

/** `~/...` for display, so plans stay short and do not show the person's user name twice. */
export function tilde(p: string, home: string): string {
  const h = resolve(home)
  const r = resolve(p)
  const same = process.platform === 'win32' ? r.toLowerCase().startsWith(h.toLowerCase()) : r.startsWith(h)
  return same && (r.length === h.length || r[h.length] === '\\' || r[h.length] === '/') ? `~${fwd(r.slice(h.length)) || ''}` : fwd(r)
}
