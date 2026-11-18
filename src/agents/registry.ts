// Every coding agent Mapshift can be added to: how to tell it is installed, and what setup writes for it.
// Only personal (user-level) settings are written, never a project's or a team's files.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mdFence, tomlArray, tomlFence, tomlString } from '../setup/blocks.ts'
import { shellLine, which, type Env, type Runtime, type Targets } from '../setup/env.ts'
import type { AgentId, Piece } from '../setup/pieces.ts'
import { codexPrompt, geminiCommand, grokRules, instructionLines, kiroSteering, skill } from './content.ts'

export type AgentDef = {
  id: AgentId
  label: string
  /** Written and tested as files, but not checked inside the agent itself. */
  beta?: boolean
  detect: (t: Targets, env: Env) => boolean
  pieces: (t: Targets, rt: Runtime) => Piece[]
  /** What to do once, after setup, in plain words. */
  next: string
}

const MCP_TAKEN = 'a "mapshift" MCP server is already in this file (added by hand); left as is'
const mcpConflicts = [
  { re: /^\s*\[\s*mcp_servers\s*\.\s*["']?mapshift["']?\s*\]/m, why: MCP_TAKEN },
  { re: /^\s*mcp_servers\s*\.\s*["']?mapshift["']?\s*[.=]/m, why: MCP_TAKEN },
  { re: /^\s*["']?mapshift["']?\s*=\s*\{/m, why: MCP_TAKEN },
  { re: /^\s*mcp_servers\s*=/m, why: 'MCP servers in this file are written as one inline table; add mapshift by hand' },
]
const STATUS_TAKEN = 'you already have a status line set up; left as is'
const statusConflicts = [
  { re: /^\s*\[\s*ui\s*\.\s*status_line\s*\]/m, why: STATUS_TAKEN },
  { re: /^\s*status_line\s*[.=]/m, why: STATUS_TAKEN },
  { re: /^\s*ui\s*\.\s*status_line/m, why: STATUS_TAKEN },
  { re: /^\s*ui\s*=/m, why: STATUS_TAKEN },
]

const ADDED_LINE = '# Added by Mapshift. Undo with: mapshift uninstall'

/** A TOML MCP server table, for agents whose settings are TOML (Codex, Grok). */
function tomlMcp(agent: AgentId, path: string, rt: Runtime): Piece {
  return {
    agent,
    label: 'MCP server',
    path,
    kind: 'block',
    format: 'toml',
    fence: tomlFence('mcp'),
    own: ['mcp_servers.mapshift'],
    conflicts: mcpConflicts,
    lines: [ADDED_LINE, '[mcp_servers.mapshift]', `command = ${tomlString(rt.node)}`, `args = ${tomlArray([rt.script, 'mcp'])}`],
  }
}

/** The one server entry every agent gets: this Node running `mapshift mcp`. */
const stdio = (rt: Runtime) => ({ command: rt.node, args: [rt.script, 'mcp'] })

/** A JSON MCP server entry, for agents whose settings are JSON (Gemini CLI, Antigravity, Cursor and most others). */
const jsonMcp = (agent: AgentId, path: string, rt: Runtime, o: { key?: string[]; value?: unknown; refuseIf?: { test: (whole: unknown) => boolean; why: string } } = {}): Piece => ({
  agent,
  label: 'MCP server',
  path,
  kind: 'json',
  key: o.key ?? ['mcpServers', 'mapshift'],
  value: o.value ?? stdio(rt),
  ...(o.refuseIf ? { refuseIf: o.refuseIf } : {}),
})

/**
 * opencode 1 keeps each server directly under `mcp` (`mcp.<name>`); version 2 keeps them under `mcp.servers`.
 * A config already in the old layout would read a `servers` entry as a broken server, so it is left alone.
 */
const opencodeOldLayout = {
  test: (whole: unknown) => {
    const mcp = whole && typeof whole === 'object' ? (whole as Record<string, unknown>).mcp : undefined
    return !!mcp && typeof mcp === 'object' && Object.keys(mcp).some(k => k !== 'servers')
  },
  why: 'this opencode config keeps servers directly under "mcp" (opencode 1), so Mapshift left it alone. Update opencode, or add the server by hand',
}

/** The map advice, as a marked block inside the agent's own instructions file. */
const mdRules = (agent: AgentId, path: string): Piece => ({
  agent,
  label: 'Instructions',
  path,
  kind: 'block',
  format: 'md',
  fence: mdFence(),
  lines: instructionLines({ helpers: false }),
})

/** opencode reads `opencode.jsonc` or `opencode.json`; an existing one is used, a new file is `.jsonc` (what opencode makes itself). */
function opencodeConfig(t: Targets): string {
  const jsonc = join(t.opencode, 'opencode.jsonc')
  const json = join(t.opencode, 'opencode.json')
  return existsSync(jsonc) ? jsonc : existsSync(json) ? json : jsonc
}

/** `~/.copilot` alone proves little: VS Code's Copilot extension leaves an `ide` folder there. Anything else means the CLI ran. */
function copilotFootprint(dir: string): boolean {
  try {
    return readdirSync(dir).some(e => e !== 'ide')
  } catch {
    return false
  }
}

const geminiRules = (agent: AgentId, t: Targets): Piece => ({
  agent,
  label: 'Instructions',
  path: join(t.gemini, 'GEMINI.md'),
  kind: 'block',
  format: 'md',
  fence: mdFence(),
  lines: instructionLines({ helpers: false }),
})

/** An empty status line setting (what Antigravity writes by default) may be replaced; a real one never is. */
const emptyStatusLine = (old: unknown): boolean => {
  if (!old || typeof old !== 'object') return false
  const o = old as { type?: unknown; command?: unknown }
  return (!o.type || o.type === '') && (!o.command || o.command === '')
}

export const AGENTS: AgentDef[] = [
  {
    id: 'codex',
    label: 'Codex',
    detect: (t, env) => existsSync(t.codex) || !!which('codex', env),
    pieces: (t, rt) => [
      tomlMcp('codex', join(t.codex, 'config.toml'), rt),
      { agent: 'codex', label: 'Instructions', path: join(t.codex, 'AGENTS.md'), kind: 'block', format: 'md', fence: mdFence(), lines: instructionLines({ helpers: true }) },
      { agent: 'codex', label: '/prompts:mapshift', path: join(t.codex, 'prompts', 'mapshift.md'), kind: 'file', content: codexPrompt(rt) },
    ],
    next: 'Restart Codex (CLI or IDE). Type /prompts:mapshift for the report; /mcp lists "mapshift".',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    detect: (t, env) => existsSync(join(t.gemini, 'settings.json')) || !!which('gemini', env),
    pieces: (t, rt) => [
      jsonMcp('gemini', join(t.gemini, 'settings.json'), rt),
      geminiRules('gemini', t),
      { agent: 'gemini', label: '/mapshift', path: join(t.gemini, 'commands', 'mapshift.toml'), kind: 'file', content: geminiCommand(rt) },
    ],
    next: 'Restart Gemini CLI and trust the folder when it asks (it starts MCP servers only in trusted folders). Type /mapshift for the report.',
  },
  {
    id: 'agy',
    label: 'Antigravity (agy)',
    detect: (t, env) => existsSync(join(t.gemini, 'antigravity-cli')) || !!which('agy', env),
    pieces: (t, rt) => [
      jsonMcp('agy', join(t.gemini, 'config', 'mcp_config.json'), rt),
      geminiRules('agy', t),
      { agent: 'agy', label: '/mapshift', path: join(t.gemini, 'config', 'skills', 'mapshift', 'SKILL.md'), kind: 'file', content: skill(rt, 'agy') },
      {
        agent: 'agy',
        label: 'Status line',
        path: join(t.gemini, 'antigravity-cli', 'settings.json'),
        kind: 'json',
        key: ['statusLine'],
        value: { type: 'command', command: shellLine(rt, ['statusline', '--agent', 'agy']), enabled: true, stack_with_default: true },
        replaceIf: emptyStatusLine,
      },
    ],
    next: 'Restart agy. Type /mapshift for the report; the Mapshift line shows under the built-in status line.',
  },
  {
    id: 'grok',
    label: 'Grok',
    detect: (t, env) => existsSync(t.grok) || !!which('grok', env),
    pieces: (t, rt) => [
      tomlMcp('grok', join(t.grok, 'config.toml'), rt),
      {
        agent: 'grok',
        label: 'Status line',
        path: join(t.grok, 'config.toml'),
        kind: 'block',
        format: 'toml',
        fence: tomlFence('status line'),
        own: ['ui.status_line'],
        conflicts: statusConflicts,
        lines: [ADDED_LINE, '[ui.status_line]', 'type = "command"', `command = ${tomlString(shellLine(rt, ['statusline', '--agent', 'grok']))}`],
      },
      { agent: 'grok', label: 'Instructions', path: join(t.grok, 'rules', 'mapshift.md'), kind: 'file', content: grokRules() },
      { agent: 'grok', label: '/mapshift', path: join(t.grok, 'skills', 'mapshift', 'SKILL.md'), kind: 'file', content: skill(rt, 'grok') },
    ],
    next: 'Restart Grok. Type /mapshift for the report. If Grok asks whether to trust a folder, say yes (or start it with --trust).',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    beta: true,
    detect: (t, env) => existsSync(t.cursor) || !!which('cursor', env),
    pieces: (t, rt) => [
      jsonMcp('cursor', join(t.cursor, 'mcp.json'), rt),
      { agent: 'cursor', label: 'Skill', path: join(t.cursor, 'skills', 'mapshift', 'SKILL.md'), kind: 'file', content: skill(rt, 'cursor') },
    ],
    next: 'Beta: restart Cursor and check that Settings → MCP lists "mapshift". Ask for the mapshift skill to see the report.',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    detect: (t, env) => existsSync(t.windsurf) || !!which('windsurf', env),
    pieces: (t, rt) => [jsonMcp('windsurf', join(t.windsurf, 'mcp_config.json'), rt)],
    next: 'Restart Windsurf, or refresh its MCP list, and check that "mapshift" shows there.',
  },
  {
    id: 'vscode',
    label: 'VS Code (Copilot agent mode)',
    detect: (t, env) => existsSync(t.vscode) || !!which('code', env),
    pieces: (t, rt) => [jsonMcp('vscode', join(t.vscode, 'mcp.json'), rt, { key: ['servers', 'mapshift'], value: { type: 'stdio', ...stdio(rt) } })],
    next: 'Restart VS Code, run "MCP: List Servers" and start "mapshift" (VS Code asks once to trust it). Use Copilot Chat in Agent mode.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    detect: (t, env) => copilotFootprint(t.copilot) || !!which('copilot', env),
    pieces: (t, rt) => [jsonMcp('copilot', join(t.copilot, 'mcp-config.json'), rt, { value: { type: 'local', ...stdio(rt), tools: ['*'] } })],
    next: 'Restart Copilot CLI; /mcp lists "mapshift".',
  },
  {
    id: 'opencode',
    label: 'opencode',
    beta: true,
    detect: (t, env) => existsSync(t.opencode) || !!which('opencode', env),
    pieces: (t, rt) => [
      jsonMcp('opencode', opencodeConfig(t), rt, { key: ['mcp', 'servers', 'mapshift'], value: { type: 'local', command: [rt.node, rt.script, 'mcp'] }, refuseIf: opencodeOldLayout }),
      mdRules('opencode', join(t.opencode, 'AGENTS.md')),
    ],
    next: 'Beta: restart opencode (version 2 or newer, which keeps servers under "mcp.servers"). A config file with comments is left alone: add the server by hand then.',
  },
  {
    id: 'kiro',
    label: 'Kiro',
    beta: true,
    detect: (t, env) => existsSync(t.kiro) || !!which('kiro', env) || !!which('kiro-cli', env),
    pieces: (t, rt) => [
      jsonMcp('kiro', join(t.kiro, 'settings', 'mcp.json'), rt),
      { agent: 'kiro', label: 'Steering', path: join(t.kiro, 'steering', 'mapshift.md'), kind: 'file', content: kiroSteering() },
    ],
    next: 'Beta: restart Kiro. Kiro IDE ships with MCP off: turn it on in Settings (search "MCP"). Kiro CLI needs nothing more.',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    beta: true,
    detect: (t, env) => existsSync(t.qwen) || !!which('qwen', env),
    pieces: (t, rt) => [jsonMcp('qwen', join(t.qwen, 'settings.json'), rt), mdRules('qwen', join(t.qwen, 'QWEN.md'))],
    next: 'Beta: restart Qwen Code; /mcp lists "mapshift". A settings.json with comments is left alone: add the server by hand then.',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    detect: t => existsSync(t.claudeDesktop),
    pieces: (t, rt) => [jsonMcp('claude-desktop', join(t.claudeDesktop, 'claude_desktop_config.json'), rt)],
    next: 'Quit Claude Desktop completely (also from the tray) and open it again; "mapshift" shows under connectors.',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    beta: true,
    detect: (t, env) => existsSync(t.hermes) || !!which('hermes', env),
    pieces: (t, rt) => [
      {
        agent: 'hermes',
        label: 'MCP server',
        path: join(t.hermes, 'config.yaml'),
        kind: 'block',
        format: 'yaml',
        fence: tomlFence('mcp'),
        guard: '^(#.*|mcp_servers:|  mapshift:|    command: .*|    args: .*)$',
        conflicts: [{ re: /^\s*["']?mcp_servers["']?\s*:/m, why: 'this file already has an "mcp_servers" section; add mapshift under it by hand' }],
        lines: [ADDED_LINE, 'mcp_servers:', '  mapshift:', `    command: ${JSON.stringify(rt.node)}`, `    args: [${[rt.script, 'mcp'].map(a => JSON.stringify(a)).join(', ')}]`],
      },
    ],
    next: 'Beta: start a new Hermes session. If the file already had an "mcp_servers" section, setup left it alone and said so.',
  },
  {
    id: 'droid',
    label: 'Factory Droid',
    beta: true,
    detect: (t, env) => existsSync(t.factory) || !!which('droid', env),
    pieces: (t, rt) => [jsonMcp('droid', join(t.factory, 'mcp.json'), rt), mdRules('droid', join(t.factory, 'AGENTS.md'))],
    next: 'Beta: Droid reloads mcp.json by itself; check that /mcp lists "mapshift".',
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    detect: (t, env) => existsSync(t.kimi) || !!which('kimi', env),
    pieces: (t, rt) => [jsonMcp('kimi', join(t.kimi, 'mcp.json'), rt), mdRules('kimi', join(t.kimi, 'AGENTS.md'))],
    next: 'Start a new Kimi Code session: a server added mid-session only joins later ones.',
  },
  {
    id: 'qoder',
    label: 'Qoder CLI',
    beta: true,
    detect: (t, env) => existsSync(t.qoder) || !!which('qodercli', env),
    pieces: (t, rt) => [jsonMcp('qoder', join(t.qoder, 'settings.json'), rt)],
    next: 'Beta: restart the Qoder CLI. The Qoder IDE keeps servers in Settings > MCP; add it there by hand. A settings.json with comments is left alone.',
  },
  {
    id: 'pi',
    label: 'Pi',
    beta: true,
    detect: t => existsSync(t.pi),
    pieces: (t, rt) => [
      // "direct" declares the tools to the model; Pi's default (codemode) only lets scripts call them
      jsonMcp('pi', join(t.pi, 'mcp.json'), rt, { value: { ...stdio(rt), exposure: 'direct' } }),
      mdRules('pi', join(t.pi, 'AGENTS.md')),
    ],
    next: 'Beta: run /reload in Pi, or restart it.',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    detect: (t, env) => existsSync(t.claude) || !!which('claude', env),
    pieces: () => [], // Claude Code is set up with its own commands, below
    next: 'Restart Claude Code. The Mapshift plugin adds routing advice and a live dashboard.',
  },
]

export const agentById = (id: string): AgentDef | undefined => AGENTS.find(a => a.id === id)

/**
 * Claude Code's own commands that add the map server and the Mapshift plugin. The server is added with
 * `alwaysLoad`, so its tools are ready from the first prompt instead of hidden behind a tool search.
 */
export function claudeCommands(rt: Runtime): string[][] {
  const server = { type: 'stdio', command: rt.node, args: [rt.script, 'mcp'], alwaysLoad: true }
  return [
    ['mcp', 'add-json', '--scope', 'user', 'mapshift', JSON.stringify(server)],
    ['plugin', 'marketplace', 'add', 'riverahendrick/mapshift'],
    ['plugin', 'install', 'mapshift@mapshift'],
  ]
}

export const claudeUndo = (): string[][] => [
  ['plugin', 'uninstall', 'mapshift@mapshift'],
  ['mcp', 'remove', '--scope', 'user', 'mapshift'],
]
