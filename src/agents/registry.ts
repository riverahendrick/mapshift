// Every coding agent Mapshift can be added to: how to tell it is installed, and what setup writes for it.
// Only personal (user-level) settings are written, never a project's or a team's files.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mdFence, tomlArray, tomlFence, tomlString } from '../setup/blocks.ts'
import { shellLine, which, type Env, type Runtime, type Targets } from '../setup/env.ts'
import type { AgentId, Piece } from '../setup/pieces.ts'
import { codexPrompt, geminiCommand, grokRules, instructionLines, skill } from './content.ts'

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

/** A JSON MCP server entry, for agents whose settings are JSON (Gemini CLI, Antigravity, Cursor). */
const jsonMcp = (agent: AgentId, path: string, rt: Runtime): Piece => ({
  agent,
  label: 'MCP server',
  path,
  kind: 'json',
  key: ['mcpServers', 'mapshift'],
  value: { command: rt.node, args: [rt.script, 'mcp'] },
})

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
