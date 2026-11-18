import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { AGENTS } from '../src/agents/registry.ts'
import { targets, type Targets } from '../src/setup/env.ts'
import { loadHome } from '../src/setup/pieces.ts'
import { missingAgents, runOff, runOn, runSetup, runUninstall, type RunOptions } from '../src/setup/setup.ts'

// Every test works in a throwaway home; no real agent folder is read or written.
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'mapshift-agents-'))
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
  const t = targets({ home, env })
  const rel = (abs: string) => relative(home, abs).replace(/\\/g, '/')
  const put = (r: string, text: string) => {
    mkdirSync(dirname(join(home, r)), { recursive: true })
    writeFileSync(join(home, r), text)
  }
  const read = (r: string) => {
    const f = isAbsolute(r) ? r : join(home, r) // an absolute path (from the targets) is taken as it is
    return existsSync(f) ? readFileSync(f, 'utf8') : null
  }
  return { base, home, env, lines, opts, t, rel, put, read, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

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

type Read = (rel: string) => string | null
type Case = {
  id: string
  /** A file or folder of the agent that makes it count as installed (relative to the home). */
  marker: (t: Targets) => string
  /** The agent's own files as a person has them, other servers and all. */
  existing: (t: Targets) => Record<string, string>
  /** The JSON settings file setup edits (also used to prove commented files are left alone). */
  json?: (t: Targets) => string
  /** Files setup creates when the agent has none of its own. */
  created: (t: Targets) => string[]
  check: (read: Read, t: Targets, existing: boolean) => void
}

const OTHER = '{\n  "mcpServers": {\n    "other": {\n      "command": "node",\n      "args": ["other.js"]\n    }\n  }\n}\n'
const mcp = (read: Read, file: string, top = 'mcpServers') => {
  const server = JSON.parse(read(file)!)[top].mapshift
  assert.equal(server.args[1] ?? server.command[2], 'mcp')
  return server
}
const block = (read: Read, file: string) => assert.ok(read(file)!.includes('map_find'), `${file} carries the map advice`)

const CASES: Case[] = [
  {
    id: 'windsurf',
    marker: t => join(t.windsurf, 'user_settings.pb'),
    existing: t => ({ [join(t.windsurf, 'mcp_config.json')]: '{\n  "mcpServers": {\n    "graft": {\n      "command": "graft",\n      "args": ["mcp"]\n    }\n  }\n}\n' }),
    json: t => join(t.windsurf, 'mcp_config.json'),
    created: t => [join(t.windsurf, 'mcp_config.json')],
    check: (read, t, existing) => {
      const f = join(t.windsurf, 'mcp_config.json')
      mcp(read, f)
      if (existing) assert.ok(JSON.parse(read(f)!).mcpServers.graft, 'the other server stays')
    },
  },
  {
    id: 'vscode',
    marker: t => join(t.vscode, 'settings.json'),
    existing: t => ({ [join(t.vscode, 'mcp.json')]: '{\n  "servers": {\n    "other": {\n      "type": "stdio",\n      "command": "x"\n    }\n  },\n  "inputs": []\n}\n' }),
    json: t => join(t.vscode, 'mcp.json'),
    created: t => [join(t.vscode, 'mcp.json')],
    check: (read, t, existing) => {
      const f = join(t.vscode, 'mcp.json')
      assert.equal(mcp(read, f, 'servers').type, 'stdio')
      if (existing) assert.ok(JSON.parse(read(f)!).servers.other)
      if (existing) assert.deepEqual(JSON.parse(read(f)!).inputs, [])
    },
  },
  {
    id: 'copilot',
    marker: t => join(t.copilot, 'config.json'),
    existing: t => ({ [join(t.copilot, 'mcp-config.json')]: OTHER }),
    json: t => join(t.copilot, 'mcp-config.json'),
    created: t => [join(t.copilot, 'mcp-config.json')],
    check: (read, t, existing) => {
      const f = join(t.copilot, 'mcp-config.json')
      const s = mcp(read, f)
      assert.equal(s.type, 'local')
      assert.deepEqual(s.tools, ['*'])
      if (existing) assert.ok(JSON.parse(read(f)!).mcpServers.other)
    },
  },
  {
    id: 'opencode',
    marker: t => join(t.opencode, 'service.json'),
    existing: t => ({
      [join(t.opencode, 'opencode.json')]:
        '{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "servers": {\n      "other": {\n        "type": "local",\n        "command": ["x"]\n      }\n    }\n  }\n}\n',
      [join(t.opencode, 'AGENTS.md')]: 'Be brief.',
    }),
    json: t => join(t.opencode, 'opencode.json'),
    created: t => [join(t.opencode, 'opencode.jsonc'), join(t.opencode, 'AGENTS.md')],
    check: (read, t) => {
      const doc = JSON.parse(read(existsSync(join(t.opencode, 'opencode.json')) ? join(t.opencode, 'opencode.json') : join(t.opencode, 'opencode.jsonc'))!)
      assert.equal(doc.mcp.servers.mapshift.type, 'local')
      assert.equal(doc.mcp.servers.mapshift.command[2], 'mcp')
      block(read, join(t.opencode, 'AGENTS.md'))
    },
  },
  {
    id: 'kiro',
    marker: t => join(t.kiro, 'extensions', 'x.txt'),
    existing: t => ({ [join(t.kiro, 'settings', 'mcp.json')]: OTHER, [join(t.kiro, 'steering', 'product.md')]: '# Product\nBe nice.\n' }),
    json: t => join(t.kiro, 'settings', 'mcp.json'),
    created: t => [join(t.kiro, 'settings', 'mcp.json'), join(t.kiro, 'steering', 'mapshift.md')],
    check: (read, t) => {
      mcp(read, join(t.kiro, 'settings', 'mcp.json'))
      const steering = read(join(t.kiro, 'steering', 'mapshift.md'))!
      assert.ok(steering.startsWith('---\ninclusion: always\n---\n'), 'front matter comes first')
      assert.ok(steering.includes('mapshift:managed') && steering.includes('map_find'))
    },
  },
  {
    id: 'qwen',
    marker: t => join(t.qwen, 'tmp', 'x.txt'),
    existing: t => ({ [join(t.qwen, 'settings.json')]: '{\n  "theme": "dark"\n}\n', [join(t.qwen, 'QWEN.md')]: '# Mine\nAlways test.\n' }),
    json: t => join(t.qwen, 'settings.json'),
    created: t => [join(t.qwen, 'settings.json'), join(t.qwen, 'QWEN.md')],
    check: (read, t, existing) => {
      mcp(read, join(t.qwen, 'settings.json'))
      if (existing) assert.equal(JSON.parse(read(join(t.qwen, 'settings.json'))!).theme, 'dark')
      block(read, join(t.qwen, 'QWEN.md'))
    },
  },
  {
    id: 'claude-desktop',
    marker: t => join(t.claudeDesktop, 'Cache', 'x.txt'),
    existing: t => ({ [join(t.claudeDesktop, 'claude_desktop_config.json')]: '{\r\n  "preferences": {\r\n    "sidebarMode": "chat"\r\n  }\r\n}\r\n' }),
    json: t => join(t.claudeDesktop, 'claude_desktop_config.json'),
    created: t => [join(t.claudeDesktop, 'claude_desktop_config.json')],
    check: (read, t, existing) => {
      const f = join(t.claudeDesktop, 'claude_desktop_config.json')
      mcp(read, f)
      if (existing) assert.equal(JSON.parse(read(f)!).preferences.sidebarMode, 'chat')
    },
  },
  {
    id: 'hermes',
    marker: t => join(t.hermes, 'logs', 'x.txt'),
    existing: t => ({ [join(t.hermes, 'config.yaml')]: 'model:\n  default: x\n\nagent:\n  max_turns: 30\n' }),
    created: t => [join(t.hermes, 'config.yaml')],
    check: (read, t, existing) => {
      const yaml = read(join(t.hermes, 'config.yaml'))!
      assert.ok(yaml.includes('\nmcp_servers:\n  mapshift:\n    command: "C:\\\\Program Files\\\\nodejs\\\\node.exe"\n'))
      assert.ok(yaml.includes('args: ["C:\\\\Users\\\\me\\\\My Tools\\\\mapshift\\\\dist\\\\cli\\\\main.js", "mcp"]'))
      if (existing) assert.ok(yaml.startsWith('model:\n  default: x\n'), 'the person\'s settings come first, unchanged')
    },
  },
  {
    id: 'droid',
    marker: t => join(t.factory, 'logs', 'x.txt'),
    existing: t => ({ [join(t.factory, 'mcp.json')]: OTHER, [join(t.factory, 'AGENTS.md')]: '# Prefs\r\nUse tabs.\r\n' }),
    json: t => join(t.factory, 'mcp.json'),
    created: t => [join(t.factory, 'mcp.json'), join(t.factory, 'AGENTS.md')],
    check: (read, t) => {
      mcp(read, join(t.factory, 'mcp.json'))
      block(read, join(t.factory, 'AGENTS.md'))
    },
  },
  {
    id: 'kimi',
    marker: t => join(t.kimi, 'sessions', 'x.txt'),
    existing: t => ({ [join(t.kimi, 'mcp.json')]: OTHER }),
    json: t => join(t.kimi, 'mcp.json'),
    created: t => [join(t.kimi, 'mcp.json'), join(t.kimi, 'AGENTS.md')],
    check: (read, t) => {
      mcp(read, join(t.kimi, 'mcp.json'))
      block(read, join(t.kimi, 'AGENTS.md'))
    },
  },
  {
    id: 'qoder',
    marker: t => join(t.qoder, 'x.txt'),
    existing: t => ({ [join(t.qoder, 'settings.json')]: '{\n  "model": "m",\n  "mcpServers": {}\n}\n' }),
    json: t => join(t.qoder, 'settings.json'),
    created: t => [join(t.qoder, 'settings.json')],
    check: (read, t, existing) => {
      const f = join(t.qoder, 'settings.json')
      mcp(read, f)
      if (existing) assert.equal(JSON.parse(read(f)!).model, 'm')
    },
  },
  {
    id: 'pi',
    marker: t => join(t.pi, 'sessions', 'x.txt'),
    existing: t => ({ [join(t.pi, 'mcp.json')]: OTHER, [join(t.pi, 'AGENTS.md')]: 'Pi rules' }),
    json: t => join(t.pi, 'mcp.json'),
    created: t => [join(t.pi, 'mcp.json'), join(t.pi, 'AGENTS.md')],
    check: (read, t) => {
      const s = mcp(read, join(t.pi, 'mcp.json'))
      assert.equal(s.exposure, 'direct')
      block(read, join(t.pi, 'AGENTS.md'))
    },
  },
]

const NEW_IDS = CASES.map(c => c.id)

test('every new agent has a test case, and only the ones not checked on this computer are (beta)', () => {
  const ids = AGENTS.map(a => a.id)
  const beta = AGENTS.filter(a => a.beta).map(a => a.id)
  for (const id of ['windsurf', 'vscode', 'copilot', 'claude-desktop', 'kimi']) assert.ok(!beta.includes(id as never), `${id} was checked on this computer`)
  for (const id of ['opencode', 'kiro', 'qwen', 'hermes', 'droid', 'qoder', 'pi']) assert.ok(beta.includes(id as never), `${id} is beta`)
  for (const id of NEW_IDS) assert.ok(ids.includes(id as never), id)
  assert.deepEqual(
    [...ids].filter(id => !['codex', 'gemini', 'agy', 'grok', 'cursor', 'claude'].includes(id)).sort(),
    [...NEW_IDS].sort(),
    'no new agent without a case',
  )
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  for (const a of AGENTS) assert.ok(a.label && a.next, a.id)
})

for (const c of CASES) {
  test(`${c.id}: setup then uninstall gives back the exact files (existing config with other servers)`, async () => {
    const s = sandbox()
    try {
      const files = c.existing(s.t)
      for (const [p, text] of Object.entries(files)) s.put(s.rel(p), text)
      s.put(s.rel(c.marker(s.t)), 'x')
      const before = tree(s.home)
      assert.equal(await runSetup(s.opts({ agents: c.id, yes: true })), 0)
      assert.notDeepEqual(tree(s.home), before)
      c.check(s.read, s.t, true)
      // every changed file was backed up first, exactly as it was
      const saved = tree(join(s.env.MAPSHIFT_HOME, 'backups', readdirSync(join(s.env.MAPSHIFT_HOME, 'backups'))[0]!))
      for (const [p, text] of Object.entries(files)) {
        if (s.read(s.rel(p)) !== text) assert.equal(saved[s.rel(p)], text, `backup of ${s.rel(p)}`)
      }
      // a second run changes nothing
      const after = tree(s.home)
      assert.equal(await runSetup(s.opts({ agents: c.id, yes: true })), 0)
      assert.deepEqual(tree(s.home), after)
      // off and on
      assert.equal(await runOff(s.opts()), 0)
      assert.deepEqual(tree(s.home), before)
      assert.equal(await runOn(s.opts()), 0)
      assert.deepEqual(tree(s.home), after)
      // uninstall
      assert.equal(await runUninstall(s.opts({ yes: true })), 0)
      assert.deepEqual(tree(s.home), before)
      assert.equal(loadHome(targets({ home: s.home, env: s.env })), null)
    } finally {
      s.cleanup()
    }
  })

  test(`${c.id}: with none of its own files, setup creates them and uninstall removes them and their folders`, async () => {
    const s = sandbox()
    try {
      s.put(s.rel(c.marker(s.t)), 'x')
      const before = tree(s.home)
      assert.equal(await runSetup(s.opts({ agents: c.id, yes: true })), 0)
      for (const f of c.created(s.t)) assert.ok(existsSync(f), `${s.rel(f)} was created`)
      c.check(s.read, s.t, false)
      assert.equal(await runUninstall(s.opts({ yes: true })), 0)
      assert.deepEqual(tree(s.home), before)
      for (const f of c.created(s.t)) assert.equal(existsSync(f), false, `${s.rel(f)} is gone`)
    } finally {
      s.cleanup()
    }
  })

  test(`${c.id}: --dry-run (even with --yes) and no --yes write nothing, not even a record`, async () => {
    const s = sandbox()
    try {
      for (const [p, text] of Object.entries(c.existing(s.t))) s.put(s.rel(p), text)
      s.put(s.rel(c.marker(s.t)), 'x')
      const before = tree(s.home)
      const beforeBase = tree(s.base)
      assert.equal(await runSetup(s.opts({ agents: c.id, dryRun: true, yes: true })), 0)
      assert.equal(await runSetup(s.opts({ agents: c.id })), 0)
      assert.deepEqual(tree(s.home), before)
      assert.deepEqual(tree(s.base), beforeBase, 'nothing outside the home either (no backups, no setup record)')
      assert.ok(s.lines.some(l => l.includes('Dry run: nothing was changed')))
    } finally {
      s.cleanup()
    }
  })

  test(`${c.id}: it is offered only when its folder exists`, () => {
    const s = sandbox()
    try {
      const agent = AGENTS.find(a => a.id === c.id)!
      assert.equal(agent.detect(s.t, { PATH: '' }), false)
      s.put(s.rel(c.marker(s.t)), 'x')
      assert.equal(agent.detect(s.t, { PATH: '' }), true)
    } finally {
      s.cleanup()
    }
  })

  if (c.json) {
    test(`${c.id}: a settings file with comments is left alone, and said so`, async () => {
      const s = sandbox()
      try {
        const commented = '{\n  // my settings\n  "theme": "dark"\n}\n'
        s.put(s.rel(c.json!(s.t)), commented)
        s.put(s.rel(c.marker(s.t)), 'x')
        assert.equal(await runSetup(s.opts({ agents: c.id, yes: true })), 0)
        assert.equal(s.read(s.rel(c.json!(s.t))), commented)
        assert.ok(s.lines.join('\n').includes('not plain JSON'))
        assert.equal(await runUninstall(s.opts({ yes: true })), 0)
        assert.equal(s.read(s.rel(c.json!(s.t))), commented)
      } finally {
        s.cleanup()
      }
    })
  }
}

test('all of the new agents set up together, in one home, and come out again exactly', async () => {
  const s = sandbox()
  try {
    for (const c of CASES) {
      for (const [p, text] of Object.entries(c.existing(s.t))) s.put(s.rel(p), text)
      s.put(s.rel(c.marker(s.t)), 'x')
    }
    const before = tree(s.home)
    assert.equal(await runSetup(s.opts({ agents: NEW_IDS.join(','), yes: true })), 0)
    const after = tree(s.home)
    for (const c of CASES) c.check(s.read, s.t, true)
    assert.equal(await runSetup(s.opts({ agents: NEW_IDS.join(','), yes: true })), 0)
    assert.deepEqual(tree(s.home), after)
    assert.equal(await runUninstall(s.opts({ yes: true })), 0)
    assert.deepEqual(tree(s.home), before)
  } finally {
    s.cleanup()
  }
})

test('Hermes: an existing mcp_servers section is left alone and said so; Kiro: a steering file of the same name too', async () => {
  const s = sandbox()
  try {
    const yaml = 'model: x\nmcp_servers:\n  mine:\n    command: "m"\n'
    const steering = '# my own mapshift notes\n'
    s.put(s.rel(join(s.t.hermes, 'config.yaml')), yaml)
    s.put(s.rel(join(s.t.kiro, 'steering', 'mapshift.md')), steering)
    await runSetup(s.opts({ agents: 'hermes,kiro', yes: true }))
    assert.equal(s.read(s.rel(join(s.t.hermes, 'config.yaml'))), yaml)
    assert.equal(s.read(s.rel(join(s.t.kiro, 'steering', 'mapshift.md'))), steering)
    const text = s.lines.join('\n')
    assert.ok(text.includes('already has an "mcp_servers" section'))
    assert.ok(text.includes('a file you made already has this name'))
    await runUninstall(s.opts({ yes: true }))
    assert.equal(s.read(s.rel(join(s.t.hermes, 'config.yaml'))), yaml)
    assert.equal(s.read(s.rel(join(s.t.kiro, 'steering', 'mapshift.md'))), steering)
  } finally {
    s.cleanup()
  }
})

test('Hermes: servers added next to Mapshift\'s block later are never lost; a new top-level key after it is fine', async () => {
  const hermes = (s: ReturnType<typeof sandbox>) => s.rel(join(s.t.hermes, 'config.yaml'))
  for (const edit of [
    // a server added under mcp_servers, inside our block / right after it
    (t: string) => t.replace('\n# <<< mapshift: mcp <<<', '\n  other:\n    command: "o"\n# <<< mapshift: mcp <<<'),
    (t: string) => t.replace('# <<< mapshift: mcp <<<\n', '# <<< mapshift: mcp <<<\n  other:\n    command: "o"\n'),
  ]) {
    const s = sandbox()
    try {
      s.put(hermes(s), 'model: x\n')
      await runSetup(s.opts({ agents: 'hermes', yes: true }))
      const edited = edit(s.read(hermes(s))!)
      assert.ok(edited.includes('  other:\n    command: "o"'))
      s.put(hermes(s), edited)
      s.lines.length = 0
      await runSetup(s.opts({ agents: 'hermes', yes: true }))
      assert.equal(s.read(hermes(s)), edited, 'setup leaves the file alone')
      assert.ok(s.lines.join('\n').includes('left as is (edit that part by hand)'))
      await runOff(s.opts())
      assert.equal(s.read(hermes(s)), edited, 'off leaves the file alone')
      assert.ok(s.lines.join('\n').includes('remove the marked block by hand'))
    } finally {
      s.cleanup()
    }
  }
  const s = sandbox()
  try {
    s.put(hermes(s), 'model: x\n')
    await runSetup(s.opts({ agents: 'hermes', yes: true }))
    const edited = `${s.read(hermes(s))}\nplugins:\n  enabled: true\n`
    s.put(hermes(s), edited)
    await runUninstall(s.opts({ yes: true }))
    // the new key survives; only a blank line is left where the block was (the block was no longer at the end)
    assert.equal(s.read(hermes(s)), 'model: x\n\n\nplugins:\n  enabled: true\n')
  } finally {
    s.cleanup()
  }
})

test('Copilot CLI: a folder holding only the VS Code extension\'s "ide" folder does not count as installed', () => {
  const s = sandbox()
  try {
    const agent = AGENTS.find(a => a.id === 'copilot')!
    s.put(s.rel(join(s.t.copilot, 'ide', 'lock.json')), '{}')
    assert.equal(agent.detect(s.t, { PATH: '' }), false)
    s.put(s.rel(join(s.t.copilot, 'config.json')), '{}')
    assert.equal(agent.detect(s.t, { PATH: '' }), true)
  } finally {
    s.cleanup()
  }
})

test('opencode: an existing opencode.jsonc is used before opencode.json, and a new file is opencode.jsonc', async () => {
  const s = sandbox()
  try {
    const jsonc = '{\n  "theme": "x"\n}\n'
    s.put('.config/opencode/opencode.jsonc', jsonc)
    s.put('.config/opencode/opencode.json', '{}\n')
    await runSetup(s.opts({ agents: 'opencode', yes: true }))
    assert.ok(JSON.parse(s.read('.config/opencode/opencode.jsonc')!).mcp.servers.mapshift)
    assert.equal(s.read('.config/opencode/opencode.json'), '{}\n')
    await runUninstall(s.opts({ yes: true }))
    assert.equal(s.read('.config/opencode/opencode.jsonc'), jsonc)
    rmSync(join(s.home, '.config/opencode/opencode.jsonc'))
    await runSetup(s.opts({ agents: 'opencode', yes: true }))
    assert.ok(JSON.parse(s.read('.config/opencode/opencode.json')!).mcp.servers.mapshift, 'only opencode.json exists, so that one is used')
    assert.equal(existsSync(join(s.home, '.config/opencode/opencode.jsonc')), false)
    await runUninstall(s.opts({ yes: true }))
    assert.equal(s.read('.config/opencode/opencode.json'), '{}\n')
  } finally {
    s.cleanup()
  }
})

test('opencode: a config in the old layout (servers directly under "mcp") is left alone and said so', async () => {
  const s = sandbox()
  try {
    const old = '{\n  "mcp": {\n    "mine": { "type": "local", "command": ["m"] }\n  }\n}\n'
    s.put('.config/opencode/opencode.json', old)
    await runSetup(s.opts({ agents: 'opencode', yes: true }))
    assert.equal(s.read('.config/opencode/opencode.json'), old)
    assert.ok(s.lines.join('\n').includes('opencode 1'))
  } finally {
    s.cleanup()
  }
})

test('a rewritten config keeps its permissions, and a linked config stays a link', async () => {
  const s = sandbox()
  try {
    const rel = '.codeium/windsurf/mcp_config.json'
    s.put(rel, '{}\n')
    const file = join(s.home, rel)
    if (process.platform !== 'win32') chmodSync(file, 0o600)
    const before = statSync(file).mode & 0o777
    await runSetup(s.opts({ agents: 'windsurf', yes: true }))
    assert.ok(JSON.parse(s.read(rel)!).mcpServers.mapshift)
    assert.equal(statSync(file).mode & 0o777, before, 'the same permissions')

    // a config kept elsewhere and linked into place (a dotfiles manager)
    const real = join(s.base, 'dotfiles', 'mcp_config.json')
    mkdirSync(dirname(real), { recursive: true })
    writeFileSync(real, '{}\n')
    rmSync(file)
    try {
      symlinkSync(real, file)
    } catch {
      return // this system does not let a normal user make links
    }
    await runSetup(s.opts({ agents: 'windsurf', yes: true }))
    assert.ok(lstatSync(file).isSymbolicLink(), 'still a link')
    assert.ok(JSON.parse(readFileSync(real, 'utf8')).mcpServers.mapshift, 'written where the link points')
  } finally {
    s.cleanup()
  }
})

test('Claude Desktop from the Microsoft Store: its package folder is used when it exists', () => {
  const s = sandbox()
  try {
    const store = join(s.home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude')
    assert.notEqual(targets({ home: s.home, env: s.env, platform: 'win32' }).claudeDesktop, store)
    mkdirSync(store, { recursive: true })
    assert.equal(targets({ home: s.home, env: s.env, platform: 'win32' }).claudeDesktop, store)
    assert.notEqual(targets({ home: s.home, env: s.env, platform: 'darwin' }).claudeDesktop, store, 'only on Windows')
  } finally {
    s.cleanup()
  }
})

test('config folders follow each system and each agent\'s own overrides, but never with an explicit --home', () => {
  const env = { APPDATA: resolve('/roam'), XDG_CONFIG_HOME: resolve('/xdg'), LOCALAPPDATA: resolve('/local'), QWEN_HOME: '/q', KIMI_CODE_HOME: '/k', QODER_CONFIG_DIR: '/qo', PI_CODING_AGENT_DIR: '/p', COPILOT_HOME: '/c', HERMES_HOME: '/h' }
  const home = join(tmpdir(), 'mapshift-targets-home')
  // explicit home: nothing is read from the real environment
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const t = targets({ home, env, platform })
    for (const dir of [t.vscode, t.claudeDesktop, t.opencode, t.qwen, t.kimi, t.qoder, t.pi, t.copilot, t.hermes, t.windsurf, t.kiro, t.factory]) {
      assert.ok(relative(home, dir) && !relative(home, dir).startsWith('..'), `${platform}: ${dir} is inside the explicit home`)
    }
  }
  const rel = (p: string, platform: NodeJS.Platform) => relative(home, p).replace(/\\/g, '/') || platform
  assert.equal(rel(targets({ home, env, platform: 'win32' }).vscode, 'win32'), 'AppData/Roaming/Code/User')
  assert.equal(rel(targets({ home, env, platform: 'darwin' }).vscode, 'darwin'), 'Library/Application Support/Code/User')
  assert.equal(rel(targets({ home, env, platform: 'linux' }).vscode, 'linux'), '.config/Code/User')
  assert.equal(rel(targets({ home, env, platform: 'darwin' }).claudeDesktop, 'darwin'), 'Library/Application Support/Claude')
  assert.equal(rel(targets({ home, env, platform: 'win32' }).opencode, 'win32'), '.config/opencode', 'opencode uses ~/.config on every system')
  assert.equal(rel(targets({ home, env, platform: 'win32' }).windsurf, 'win32'), '.codeium/windsurf')
  assert.equal(rel(targets({ home, env, platform: 'win32' }).pi, 'win32'), '.pi/agent')
  // no explicit home: the overrides count
  const win = targets({ env, platform: 'win32' })
  assert.equal(win.vscode, join(resolve('/roam'), 'Code', 'User'))
  assert.equal(win.claudeDesktop, join(resolve('/roam'), 'Claude'))
  const lin = targets({ env, platform: 'linux' })
  assert.equal(lin.vscode, join(resolve('/xdg'), 'Code', 'User'))
  assert.equal(lin.opencode, join(resolve('/xdg'), 'opencode'))
  assert.equal(lin.claudeDesktop, join(resolve('/xdg'), 'Claude'))
  const mac = targets({ env, platform: 'darwin' })
  assert.ok(mac.vscode.endsWith(join('Library', 'Application Support', 'Code', 'User')))
  assert.equal(lin.qwen, resolve('/q'))
  assert.equal(lin.kimi, resolve('/k'))
  assert.equal(lin.qoder, resolve('/qo'))
  assert.equal(lin.pi, resolve('/p'))
  assert.equal(lin.copilot, resolve('/c'))
  assert.equal(lin.hermes, resolve('/h'))
})

test('setup --check: agents found without Mapshift are listed, then none after setup, and none while it is off', async () => {
  const s = sandbox()
  try {
    s.put('.codex/config.toml', 'model = "x"\n')
    s.put('.kiro/settings/mcp.json', '{}\n')
    const ids = () => missingAgents({ home: s.home, env: s.env }).map(m => m.id).sort()
    assert.deepEqual(ids(), ['codex', 'kiro'])
    await runSetup(s.opts({ agents: 'codex', yes: true }))
    assert.deepEqual(ids(), ['kiro'], 'codex is done; kiro is still waiting')
    await runSetup(s.opts({ yes: true }))
    assert.deepEqual(ids(), [])
    await runOff(s.opts())
    assert.deepEqual(ids(), [], 'paused on purpose: nothing to point out')
  } finally {
    s.cleanup()
  }
})