#!/usr/bin/env node
// Real-agent comparison: Claude Code headless on one repository, once per task per arm.
// Usage:
//   node bench/run-agents.mjs --work <dir> --smoke              check both MCP servers answer initialize + tools/list
//   node bench/run-agents.mjs --work <dir> [--only T1 --arm mapshift] [--force]
//                                                             run the missing runs (or one), appending to results/agents.json
//   node bench/run-agents.mjs --work <dir> --blind             write the answers, shuffled and without arm labels, for judging
//   node bench/run-agents.mjs --work <dir> --summarize         merge results/agent-verdicts.json into results/agents.json
import { spawn } from 'node:child_process'
//   Optional, for other task sets (defaults are the original click run):
//   --tasks <file> --repos <file> --out <file> --verdicts <file> [--from <dir with a local clone named like the repo>]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BENCH, REPOS, WORK, argValue, deepScrub, ensureClone, readJson, run, toolEntries, toolEnv } from './lib.mjs'

const TASKS = readJson(resolve(BENCH, argValue('tasks') ?? 'agent-tasks.json'))
const repoList = argValue('repos') ? [readJson(resolve(BENCH, argValue('repos')))].map(j => (Array.isArray(j) ? j : j.repos))[0] : REPOS
const REPO = (r => (r && argValue('from') && existsSync(join(argValue('from'), r.name, '.git')) ? { ...r, url: resolve(argValue('from'), r.name) } : r))(repoList.find(r => r.name === TASKS.repo))
const OUT = resolve(BENCH, argValue('out') ?? join('results', 'agents.json'))
const VERDICTS = resolve(BENCH, argValue('verdicts') ?? join('results', 'agent-verdicts.json'))
const AG = join(WORK, 'agents')
const MAPSHIFT_HOME = join(WORK, 'mapshift-home', 'agents')
const MODEL = 'sonnet'
const MAX_TURNS = 8

const ARMS = {
  mapshift: { server: 'mapshift', tools: ['map_find', 'map_trace', 'map_file', 'map_overview', 'map_search'] },
  graft: { server: 'graft', tools: ['graft_find_code', 'graft_trace_calls', 'graft_find_all', 'graft_file_api', 'graft_repo_map'] },
}
const BUILTIN = ['Read', 'Grep', 'Glob']
const allowedFor = arm => [...ARMS[arm].tools.map(t => `mcp__${ARMS[arm].server}__${t}`), ...BUILTIN]

const { mapshift, graft } = toolEntries()

function mcpServer(arm, dir) {
  return arm === 'mapshift'
    ? { command: process.execPath, args: [mapshift, 'mcp'], env: { MAPSHIFT_HOME, DO_NOT_TRACK: '1', NO_COLOR: '1' } }
    : { command: process.execPath, args: [graft, 'mcp', dir], env: { DO_NOT_TRACK: '1', NO_COLOR: '1' } }
}

/** Two pinned clones, one per arm, so one tool's index files never show up in the other arm's Grep/Glob. Indexes are built before any run (warm). */
async function prepare() {
  mkdirSync(AG, { recursive: true })
  const dirs = {}
  for (const arm of Object.keys(ARMS)) {
    dirs[arm] = ensureClone(REPO, `agent-${arm}`)
    const cfg = { mcpServers: { [ARMS[arm].server]: mcpServer(arm, dirs[arm]) } }
    writeFileSync(join(AG, `mcp-${arm}.json`), JSON.stringify(cfg, null, 2))
  }
  const m = await run(mapshift, ['map', 'build', '--project', dirs.mapshift], { cwd: dirs.mapshift, env: toolEnv({ MAPSHIFT_HOME }) })
  if (m.code !== 0) throw new Error(`mapshift build failed: ${m.stderr}`)
  if (!existsSync(join(dirs.graft, 'graft'))) {
    const g = await run(graft, ['build', dirs.graft], { cwd: dirs.graft, env: toolEnv() })
    if (g.code !== 0) throw new Error(`graft build failed: ${g.stderr}`)
  }
  return dirs
}

/** initialize + tools/list over stdio, by hand. */
function smokeServer(arm, dir) {
  const s = mcpServer(arm, dir)
  return new Promise(res => {
    const child = spawn(s.command, s.args, { cwd: dir, env: { ...process.env, ...s.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    const timer = setTimeout(() => {
      child.kill()
      res({ arm, error: 'timeout' })
    }, 60_000)
    child.stdout.setEncoding('utf8').on('data', d => {
      buf += d
      for (const line of buf.split('\n')) {
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
          if (msg.id === 2) {
            clearTimeout(timer)
            child.kill()
            res({ arm, tools: msg.result.tools.map(t => t.name), descriptionChars: msg.result.tools.reduce((n, t) => n + JSON.stringify(t).length, 0) })
          }
        } catch {}
      }
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } } }) + '\n')
  })
}

/** Environment for the headless agent: the parent session's own Claude/MCP variables are left out. */
function agentEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|MCP_)/i.test(k)))
}

function runClaude(arm, task, dir) {
  const prompt = `${task.prompt}\n\n${TASKS.promptSuffix}`
  const args = [
    '-p',
    '--model', MODEL,
    '--max-turns', String(MAX_TURNS),
    '--output-format', 'stream-json',
    '--verbose',
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--mcp-config', join(AG, `mcp-${arm}.json`),
    '--allowedTools', allowedFor(arm).join(','),
    '--tools', BUILTIN.join(','),
    '--no-session-persistence',
    // --setting-sources alone still loads the personal ~/.claude/CLAUDE.md; this keeps every CLAUDE.md out of both arms
    '--settings', JSON.stringify({ claudeMdExcludes: ['**/.claude/CLAUDE.md', '**/CLAUDE.md'] }),
  ]
  return new Promise(res => {
    const t0 = performance.now()
    const child = spawn('claude', args, { cwd: dir, env: agentEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', d => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', d => (stderr += d))
    const timer = setTimeout(() => child.kill(), 15 * 60_000)
    child.on('close', code => {
      clearTimeout(timer)
      res({ code, stdout, stderr, ms: performance.now() - t0 })
    })
    child.stdin.end(prompt)
  })
}

function parseStream(raw) {
  const events = raw.split(/\r?\n/).filter(Boolean).flatMap(l => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })
  const init = events.find(e => e.type === 'system' && e.subtype === 'init')
  const result = events.find(e => e.type === 'result')
  const calls = new Map()
  for (const e of events)
    if (e.type === 'assistant')
      for (const b of e.message?.content ?? []) if (b.type === 'tool_use' && !calls.has(b.id)) calls.set(b.id, { name: b.name, input: b.input })
  const errors = []
  for (const e of events)
    if (e.type === 'user')
      for (const b of e.message?.content ?? []) if (b.type === 'tool_result' && b.is_error) errors.push({ id: b.tool_use_id, text: String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 300) })
  const u = result?.usage ?? {}
  return {
    init: init ? { model: init.model, tools: init.tools, mcpServers: init.mcp_servers, permissionMode: init.permissionMode, slashCommands: init.slash_commands?.length ?? null, skills: init.skills ?? null, plugins: init.plugins ?? null } : null,
    subtype: result?.subtype ?? 'no-result',
    isError: result?.is_error ?? true,
    turns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    tokens: {
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    },
    toolCalls: [...calls.values()].map(c => ({ name: c.name, input: c.input })),
    toolErrors: errors,
    permissionDenials: result?.permission_denials ?? [],
    answer: result?.result ?? null,
  }
}

const load = () => (existsSync(OUT) ? readJson(OUT) : { repo: REPO.name, commit: REPO.commit, model: MODEL, maxTurns: MAX_TURNS, runs: [] })
const save = d => {
  mkdirSync(join(BENCH, 'results'), { recursive: true })
  writeFileSync(OUT, JSON.stringify(deepScrub(d), null, 2) + '\n')
}

async function runAll() {
  const dirs = await prepare()
  mkdirSync(join(AG, 'raw'), { recursive: true })
  const only = argValue('only')
  const onlyArm = argValue('arm')
  const data = load()
  for (const [i, task] of TASKS.tasks.entries()) {
    if (only && task.id !== only) continue
    const order = i % 2 === 0 ? ['mapshift', 'graft'] : ['graft', 'mapshift'] // alternate who goes first
    for (const arm of order) {
      if (onlyArm && arm !== onlyArm) continue
      const existing = data.runs.findIndex(r => r.task === task.id && r.arm === arm)
      if (existing >= 0 && !process.argv.includes('--force')) continue
      console.error(`[agents] ${task.id} ${arm}`)
      const r = await runClaude(arm, task, dirs[arm])
      writeFileSync(join(AG, 'raw', `${task.id}-${arm}.jsonl`), r.stdout)
      const p = parseStream(r.stdout)
      const rec = {
        task: task.id,
        arm,
        exitCode: r.code,
        wallMs: Math.round(r.ms),
        ...p,
        toolCallCount: p.toolCalls.length,
        toolCallsByName: p.toolCalls.reduce((m, c) => ((m[c.name] = (m[c.name] ?? 0) + 1), m), {}),
        stderr: r.stderr.trim().slice(0, 500),
        correct: null,
        judgeNote: null,
      }
      if (existing >= 0) data.runs[existing] = rec
      else data.runs.push(rec)
      save(data)
      console.error(`  ${p.subtype} turns=${p.turns} calls=${rec.toolCallCount} cost=${p.costUsd}`)
    }
  }
}

function blind() {
  const data = load()
  const shuffled = data.runs.map(r => ({ r, k: Math.random() })).sort((a, b) => a.k - b.k)
  const key = {}
  const sheet = shuffled.map(({ r }, i) => {
    const code = `A${String(i + 1).padStart(2, '0')}`
    key[code] = { task: r.task, arm: r.arm }
    const task = TASKS.tasks.find(t => t.id === r.task)
    // Graft's tool output asks the agent to end with a "graft saved ~N tokens" line; it is dropped here (sheet only) so the arm is less recognisable
    const answer = typeof r.answer === 'string' ? r.answer.split(/\r?\n/).filter(l => !/graft saved|tokens saved/i.test(l)).join('\n').trim() : r.answer
    return { code, task: r.task, prompt: task.prompt, accept: task.accept, rubric: task.rubric, stoppedBy: r.subtype, answer }
  })
  mkdirSync(AG, { recursive: true })
  writeFileSync(join(AG, 'blind-sheet.json'), JSON.stringify(sheet.sort((a, b) => a.task.localeCompare(b.task)), null, 2))
  writeFileSync(join(AG, 'blind-key.json'), JSON.stringify(key, null, 2))
  console.log(`wrote ${join(AG, 'blind-sheet.json')}`)
}

function summarize() {
  const data = load()
  const verdicts = readJson(VERDICTS).verdicts
  const key = readJson(join(AG, 'blind-key.json'))
  for (const [code, v] of Object.entries(verdicts)) {
    const k = key[code]
    const r = data.runs.find(x => x.task === k.task && x.arm === k.arm)
    r.correct = v.correct
    r.judgeNote = v.note
    r.blindCode = code
  }
  const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  data.summary = Object.fromEntries(
    Object.keys(ARMS).map(arm => {
      const rs = data.runs.filter(r => r.arm === arm)
      return [
        arm,
        {
          runs: rs.length,
          correct: rs.filter(r => r.correct === true).length,
          avgToolCalls: avg(rs.map(r => r.toolCallCount)),
          avgTurns: avg(rs.map(r => r.turns ?? 0)),
          avgInputTokens: avg(rs.map(r => r.tokens.input)),
          avgCacheReadTokens: avg(rs.map(r => r.tokens.cacheRead)),
          avgCacheWriteTokens: avg(rs.map(r => r.tokens.cacheWrite)),
          avgOutputTokens: avg(rs.map(r => r.tokens.output)),
          avgTotalTokens: avg(rs.map(r => r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite + r.tokens.output)),
          avgCostUsd: avg(rs.map(r => r.costUsd ?? 0)),
          totalCostUsd: rs.reduce((s, r) => s + (r.costUsd ?? 0), 0),
          hitTurnLimit: rs.filter(r => r.subtype === 'error_max_turns').length,
        },
      ]
    }),
  )
  save(data)
  console.log(JSON.stringify(data.summary, null, 2))
}

async function main() {
  if (process.argv.includes('--smoke')) {
    const dirs = await prepare()
    const data = load()
    data.mcpServers = {}
    for (const arm of Object.keys(ARMS)) {
      const s = await smokeServer(arm, dirs[arm])
      console.log(JSON.stringify(s))
      data.mcpServers[arm] = { tools: s.tools, toolSchemaChars: s.descriptionChars } // characters of the tools/list entries the agent receives
    }
    save(data)
    return
  }
  if (process.argv.includes('--blind')) return blind()
  if (process.argv.includes('--summarize')) return summarize()
  await runAll()
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
