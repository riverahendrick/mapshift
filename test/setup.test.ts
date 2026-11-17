import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { AGENTS } from '../src/agents/registry.ts'
import { targets, which } from '../src/setup/env.ts'
import { loadHome } from '../src/setup/pieces.ts'
import { runOff, runOn, runSetup, runUninstall, type RunOptions } from '../src/setup/setup.ts'

// Every test works in a throwaway home: the real ~/.codex, ~/.gemini, ~/.grok, ~/.cursor and ~/.claude are never touched.
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'mapshift-setup-'))
  const home = join(base, 'home')
  mkdirSync(home)
  const env = { MAPSHIFT_HOME: join(base, 'mapshift'), PATH: '' }
  const lines: string[] = []
  const opts = (more: Partial<RunOptions> = {}): RunOptions => ({
    home,
    env,
    rt: { node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\me\\My Tools\\mapshift\\dist\\cli\\main.js' },
    interactive: false,
    out: s => lines.push(s),
    ...more,
  })
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(home, rel)), { recursive: true })
    writeFileSync(join(home, rel), text)
  }
  const read = (rel: string) => (existsSync(join(home, rel)) ? readFileSync(join(home, rel), 'utf8') : null)
  return { base, home, env, lines, opts, put, read, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

/** Every file under a folder with its bytes, by path relative to it. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(dir, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8')
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

const USER_FILES: Record<string, string> = {
  '.codex/config.toml': 'model = "gpt-6-luna"\n\n[mcp_servers.other]\ncommand = "other"\n',
  '.codex/AGENTS.md': '# My rules\n\nAlways write tests.\n',
  '.gemini/settings.json': '{\n  "theme": "dark"\n}\n',
  '.gemini/GEMINI.md': 'Be brief.',
  '.gemini/config/mcp_config.json': '{\n  "mcpServers": {\n    "othertool": {\n      "command": "node"\n    }\n  }\n}\n',
  '.gemini/antigravity-cli/settings.json': '{\n  "model": "m",\n  "statusLine": {\n    "type": "",\n    "command": "",\n    "enabled": true\n  }\n}\n',
  '.grok/config.toml': '[mcp_servers.othertool]\r\ncommand = "node"\r\n',
}
const ALL = 'codex,gemini,agy,grok,cursor'

test('setup writes every agent, backs up first, and uninstall gives back the exact original files', async () => {
  const s = sandbox()
  try {
    for (const [p, t] of Object.entries(USER_FILES)) s.put(p, t)
    const before = tree(s.home)
    assert.equal(await runSetup(s.opts({ agents: ALL, yes: true })), 0)

    // what each agent got
    const codex = s.read('.codex/config.toml')!
    assert.ok(codex.startsWith(USER_FILES['.codex/config.toml']!), 'existing Codex settings are kept byte for byte')
    assert.ok(codex.includes('[mcp_servers.mapshift]\ncommand = "C:\\\\Program Files\\\\nodejs\\\\node.exe"'))
    assert.ok(codex.includes('args = ["C:\\\\Users\\\\me\\\\My Tools\\\\mapshift\\\\dist\\\\cli\\\\main.js", "mcp"]'))
    assert.ok(s.read('.codex/AGENTS.md')!.includes('map_find'))
    assert.ok(s.read('.codex/prompts/mapshift.md')!.includes('report --agent codex'))
    assert.deepEqual(JSON.parse(s.read('.gemini/settings.json')!).mcpServers.mapshift.args[1], 'mcp')
    assert.equal(s.read('.gemini/GEMINI.md')!.split('mapshift:start').length, 2, 'one shared block for Gemini CLI and agy')
    assert.ok(s.read('.gemini/commands/mapshift.toml')!.includes('report --agent gemini'))
    assert.ok(JSON.parse(s.read('.gemini/config/mcp_config.json')!).mcpServers.othertool, 'the other server stays')
    const agyStatus = JSON.parse(s.read('.gemini/antigravity-cli/settings.json')!).statusLine
    assert.equal(agyStatus.type, 'command')
    assert.equal(agyStatus.stack_with_default, true)
    assert.ok(agyStatus.command.includes('statusline --agent agy'))
    const grok = s.read('.grok/config.toml')!
    assert.ok(grok.startsWith(USER_FILES['.grok/config.toml']!))
    assert.ok(grok.includes('[ui.status_line]\r\ntype = "command"'), 'CRLF file gets CRLF lines')
    assert.ok(s.read('.grok/skills/mapshift/SKILL.md')!.includes('user-invocable: true'))
    assert.ok(s.read('.grok/rules/mapshift.md')!.includes('map_trace'))
    assert.ok(JSON.parse(s.read('.cursor/mcp.json')!).mcpServers.mapshift)
    assert.ok(s.read('.cursor/skills/mapshift/SKILL.md')!.includes('map_find'))

    // every changed file was backed up as it was before
    const backups = join(s.env.MAPSHIFT_HOME, 'backups')
    const [stamp] = readdirSync(backups)
    const saved = tree(join(backups, stamp!))
    for (const [p, t] of Object.entries(USER_FILES)) assert.equal(saved[p], t, `backup of ${p}`)

    // a second run changes nothing
    const after = tree(s.home)
    s.lines.length = 0
    assert.equal(await runSetup(s.opts({ agents: ALL, yes: true })), 0)
    assert.deepEqual(tree(s.home), after)
    assert.ok(s.lines.some(l => l.includes('Everything was already set up')))

    // uninstall: back to the exact files, matching the first backups, and the folders setup made are gone
    assert.equal(await runUninstall(s.opts({ yes: true })), 0)
    assert.deepEqual(tree(s.home), before)
    for (const [p, t] of Object.entries(saved)) assert.equal(s.read(p), t, `${p} matches its backup`)
    assert.equal(existsSync(join(s.home, '.cursor')), false)
    assert.equal(existsSync(join(s.home, '.codex', 'prompts')), false)
    assert.equal(loadHome(targets({ home: s.home, env: s.env })), null)
  } finally {
    s.cleanup()
  }
})

test('off takes Mapshift out and on puts the same back', async () => {
  const s = sandbox()
  try {
    for (const [p, t] of Object.entries(USER_FILES)) s.put(p, t)
    const before = tree(s.home)
    await runSetup(s.opts({ agents: ALL, yes: true }))
    const on = tree(s.home)
    assert.equal(await runOff(s.opts()), 0)
    assert.deepEqual(tree(s.home), before)
    assert.equal(loadHome(targets({ home: s.home, env: s.env }))!.state, 'off')
    assert.equal(await runOn(s.opts()), 0)
    assert.deepEqual(tree(s.home), on)
    assert.equal(await runOff(s.opts()), 0)
    assert.equal(await runUninstall(s.opts({ yes: true })), 0)
    assert.deepEqual(tree(s.home), before)
  } finally {
    s.cleanup()
  }
})

test('setup leaves alone what a person set up by hand, and says so', async () => {
  const s = sandbox()
  try {
    const codex = '[mcp_servers.mapshift]\ncommand = "my-own"\n'
    const agy = '{\n  "statusLine": { "type": "command", "command": "my-line" }\n}\n'
    const gemini = '{\n  // comments make this JSONC\n  "theme": "dark"\n}\n'
    const prompt = '---\ndescription: mine\n---\nMy own prompt\n'
    s.put('.codex/config.toml', codex)
    s.put('.codex/prompts/mapshift.md', prompt)
    s.put('.gemini/antigravity-cli/settings.json', agy)
    s.put('.gemini/settings.json', gemini)
    s.put('.grok/config.toml', '[ui]\nstatus_line = { type = "builtin" }\n')
    await runSetup(s.opts({ agents: 'codex,agy,gemini,grok', yes: true }))
    assert.equal(s.read('.codex/config.toml'), codex)
    assert.equal(s.read('.codex/prompts/mapshift.md'), prompt)
    assert.equal(s.read('.gemini/antigravity-cli/settings.json'), agy)
    assert.equal(s.read('.gemini/settings.json'), gemini)
    assert.ok(!s.read('.grok/config.toml')!.includes('[ui.status_line]'), 'no second status line table')
    assert.ok(s.read('.grok/config.toml')!.includes('[mcp_servers.mapshift]'), 'the rest still goes in')
    const text = s.lines.join('\n')
    assert.ok(text.includes('already in this file (added by hand)'))
    assert.ok(text.includes('not plain JSON'))
    assert.ok(text.includes('a file you made already has this name'))
    assert.ok(text.includes('you already have'))
    await runUninstall(s.opts({ yes: true }))
    assert.equal(s.read('.codex/config.toml'), codex)
    assert.equal(s.read('.codex/prompts/mapshift.md'), prompt)
  } finally {
    s.cleanup()
  }
})

test('without --yes and without a keyboard, setup only shows the plan', async () => {
  const s = sandbox()
  try {
    s.put('.codex/config.toml', 'x = 1\n')
    const before = tree(s.home)
    assert.equal(await runSetup(s.opts({ agents: 'codex' })), 0)
    assert.deepEqual(tree(s.home), before)
    assert.ok(s.lines.some(l => l.includes('Nothing was changed')))
    assert.equal(await runSetup(s.opts({ agents: 'codex', dryRun: true, yes: true })), 0, '--dry-run wins over --yes')
    assert.deepEqual(tree(s.home), before)
    // a person who answers no
    assert.equal(await runSetup(s.opts({ agents: 'codex', interactive: true, ask: async () => false })), 0)
    assert.deepEqual(tree(s.home), before)
    assert.equal(await runSetup(s.opts({ agents: 'nope' })), 2)
  } finally {
    s.cleanup()
  }
})

test('agents are found by their settings folder or on PATH, never in the current folder', () => {
  const s = sandbox()
  try {
    s.put('.codex/config.toml', '')
    const bin = join(s.base, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, process.platform === 'win32' ? 'grok.exe' : 'grok'), '')
    const t = targets({ home: s.home, env: s.env })
    const found = (env: Record<string, string>) => AGENTS.filter(a => a.detect(t, env)).map(a => a.id)
    assert.deepEqual(found({ PATH: '' }), ['codex'])
    assert.deepEqual(found({ PATH: bin }), ['codex', 'grok'])
    assert.equal(which('grok', { PATH: `.${process.platform === 'win32' ? ';' : ':'}relative` }), null, 'relative PATH entries are ignored')
  } finally {
    s.cleanup()
  }
})

test('an explicit --home wins over CODEX_HOME and GROK_HOME; without it they are honoured', () => {
  const env = { CODEX_HOME: '/elsewhere/codex', GROK_HOME: '/elsewhere/grok' }
  const pinned = targets({ home: '/tmp/try', env })
  assert.equal(pinned.codex, join(resolve('/tmp/try'), '.codex'))
  assert.equal(pinned.grok, join(resolve('/tmp/try'), '.grok'))
  assert.ok(pinned.mapshift.endsWith('.mapshift'))
  const own = targets({ env })
  assert.ok(own.codex.includes('elsewhere') && own.grok.includes('elsewhere'))
})

test("Claude Code's own commands run only with --yes, only for the real home, never through a shell", async () => {
  const s = sandbox()
  try {
    const bin = join(s.base, 'bin')
    mkdirSync(bin)
    for (const name of ['claude', 'claude.exe']) writeFileSync(join(bin, name), '')
    const env = { ...s.env, PATH: bin }
    const calls: string[][] = []
    const runClaude = (_exe: string, args: string[]) => void calls.push(args)
    // explicit home: printed, not run
    await runSetup(s.opts({ agents: 'claude', yes: true, env, runClaude }))
    assert.equal(calls.length, 0)
    // real home but no --yes: printed, not run (agents: claude only, so no files are written there)
    await runSetup({ ...s.opts({ agents: 'claude', env, runClaude, interactive: true, ask: async () => true }), home: undefined })
    assert.equal(calls.length, 0)
    await runSetup({ ...s.opts({ agents: 'claude', yes: true, env, runClaude }), home: undefined })
    assert.deepEqual(calls.map(c => c.slice(0, 2).join(' ')), ['mcp add-json', 'plugin marketplace', 'plugin install'])
    // the server is added with alwaysLoad, so its tools are ready from the first prompt
    assert.deepEqual(JSON.parse(calls[0]!.at(-1)!), {
      type: 'stdio',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Users\\me\\My Tools\\mapshift\\dist\\cli\\main.js', 'mcp'],
      alwaysLoad: true,
    })
    calls.length = 0
    await runUninstall({ ...s.opts({ yes: true, env, runClaude }), home: undefined })
    assert.deepEqual(calls.map(c => c.slice(0, 2).join(' ')), ['plugin uninstall', 'mcp remove'])
  } finally {
    s.cleanup()
  }
})
