#!/usr/bin/env node
// Prints the README tables from results/retrieval.json and results/agents.json, so no number is typed by hand.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BENCH, readJson } from './lib.mjs'

const pct = (a, b) => `${a}/${b} (${Math.round((100 * a) / b)}%)`
const kb = b => `${(b / 1024).toFixed(0)} KB`
const sec = ms => `${(ms / 1000).toFixed(1)} s`

// `node bench/report.mjs --heldout` prints the held-out tables (results/heldout.json, results/heldout-agents.json) instead
const HELDOUT = process.argv.includes('--heldout')
if (HELDOUT) heldout()

function heldout() {
  const ms = v => `${Math.round(v)} ms`
  const h = readJson(join(BENCH, 'results', 'heldout.json'))
  const tools = ['mapshift', 'graft']
  console.log(`Tools: Mapshift ${h.tools.mapshift}, Graft ${h.tools.graft}. Node ${h.machine.node}, ${h.machine.os}. Top ${h.settings.limit} results; latency is the median over questions of each question's median of ${h.settings.timedRuns} warm runs; build time is the median of ${h.settings.builds} cold builds.\n`)
  console.log('Overall (64 questions):\n')
  console.log('| Tool | hit@1 | hit@3 | Right file in top 3 | Median answer tokens | Same, without Graft advice lines | Median latency | Errors | No result parsed |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const t of tools) {
    const s = h.overall[t]
    console.log(`| ${t} | ${pct(s.hit1, s.questions)} | ${pct(s.hit3, s.questions)} | ${pct(s.fileHit3, s.questions)} | ${s.medianAnswerTokens} | ${s.medianAnswerTokensWithoutBanner} | ${ms(s.medianLatencyMs)} | ${s.errors} | ${s.zeroParsed} |`)
  }
  console.log('\nBy question kind (all repos):\n')
  console.log('| Kind | Tool | hit@1 | hit@3 | Right file in top 3 | Median answer tokens | Same, without advice lines | Median latency |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const [k, v] of Object.entries(h.overall.byKind))
    for (const t of tools) {
      const s = v[t]
      console.log(`| ${k} | ${t} | ${pct(s.hit1, s.questions)} | ${pct(s.hit3, s.questions)} | ${pct(s.fileHit3, s.questions)} | ${s.medianAnswerTokens} | ${s.medianAnswerTokensWithoutBanner} | ${ms(s.medianLatencyMs)} |`)
    }
  console.log('\nBy repository:\n')
  console.log('| Repo | Tool | hit@1 | hit@3 | Median answer tokens | Median latency | Build time (median of 3) | Index size |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const r of h.repos)
    for (const t of tools) {
      const s = r.summary[t]
      const b = r.build[t]
      console.log(`| ${r.name} (${r.language}) | ${t} | ${pct(s.hit1, s.questions)} | ${pct(s.hit3, s.questions)} | ${s.medianAnswerTokens} | ${ms(s.medianLatencyMs)} | ${sec(b.medianBuildMs)} | ${kb(b.indexBytes)} |`)
    }
  console.log(`\nSingle cold builds (ms): ${h.repos.map(x => `${x.name}: mapshift ${x.build.mapshift.buildMs.join('/')}, graft ${x.build.graft.buildMs.join('/')}`).join('; ')}.`)
  console.log('\nPer question (rank of the first matching result; - = not in the results):\n')
  console.log('| Question | Kind | Mapshift rank | Graft rank | Mapshift tokens | Graft tokens |')
  console.log('|---|---|---|---|---|---|')
  const all = h.repos.flatMap(r => r.questions)
  for (const q of all) console.log(`| ${q.id} | ${q.kind} | ${q.mapshift.exitCode ? 'error' : (q.mapshift.rank ?? '-')} | ${q.graft.exitCode ? 'error' : (q.graft.rank ?? '-')} | ${q.mapshift.answerTokens} | ${q.graft.answerTokens} |`)
  // a "win" is mechanical: rank 1 against not in the top 3 first, then in the top 3 against not in the top 3
  const wins = (a, b) => [...all.filter(q => q[a].rank === 1 && !q[b].hit3), ...all.filter(q => q[a].hit3 && q[a].rank !== 1 && !q[b].hit3)]
  for (const [a, b] of [['graft', 'mapshift'], ['mapshift', 'graft']]) {
    const w = wins(a, b)
    console.log(`\n${a} found it and ${b} did not (${w.length}):`)
    for (const q of w) console.log(`- ${q.id} (${q.kind}, ${a} rank ${q[a].rank}): ${a} top: ${q[a].top3.map(x => `${x.name} ${x.file}:${x.start ?? ''}`).join('; ')} | ${b} top: ${q[b].top3.map(x => `${x.name} ${x.file}:${x.start ?? ''}`).join('; ') || '(nothing)'}`)
  }
  const both = all.filter(q => !q.mapshift.hit3 && !q.graft.hit3)
  console.log(`\nNeither in the top 3 (${both.length}): ${both.map(q => q.id).join(', ')}`)

  const ap = join(BENCH, 'results', 'heldout-agents.json')
  if (!existsSync(ap)) return
  const a = readJson(ap)
  if (!a.summary) return
  console.log(`\nAgents: ${a.runs.length} runs on ${a.repo} (${a.commit.slice(0, 12)}), model ${a.model}, max ${a.maxTurns} turns.\n`)
  console.log('| Arm | Correct | Avg tool calls | Avg turns | Avg input | Avg cache read | Avg cache write | Avg output | Avg total tokens | Avg cost | Total cost |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [arm, s] of Object.entries(a.summary))
    console.log(`| ${arm} | ${s.correct}/${s.runs} | ${s.avgToolCalls.toFixed(1)} | ${s.avgTurns.toFixed(1)} | ${Math.round(s.avgInputTokens)} | ${Math.round(s.avgCacheReadTokens)} | ${Math.round(s.avgCacheWriteTokens)} | ${Math.round(s.avgOutputTokens)} | ${Math.round(s.avgTotalTokens)} | $${s.avgCostUsd.toFixed(4)} | $${s.totalCostUsd.toFixed(4)} |`)
  if (a.mcpServers) console.log(`\nMCP tools/list size: ${Object.entries(a.mcpServers).map(([k, v]) => `${k} ${v.tools.length} tools, ${v.toolSchemaChars} chars`).join('; ')}.`)
  console.log('\n| Task | Arm | Correct | Tool calls (by name) | Turns | Input | Cache read | Cache write | Output | Cost |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of [...a.runs].sort((x, y) => x.task.localeCompare(y.task) || x.arm.localeCompare(y.arm)))
    console.log(`| ${r.task} | ${r.arm} | ${r.correct ? 'yes' : 'no'} | ${r.toolCallCount} (${Object.entries(r.toolCallsByName).map(([n, c]) => `${n.replace(/^mcp__\w+?__/, '')}×${c}`).join(', ')}) | ${r.turns} | ${r.tokens.input} | ${r.tokens.cacheRead} | ${r.tokens.cacheWrite} | ${r.tokens.output} | $${(r.costUsd ?? 0).toFixed(4)} |`)
}

const rp = join(BENCH, 'results', 'retrieval.json')
if (!HELDOUT && existsSync(rp)) {
  const r = readJson(rp)
  console.log(`Tools: Mapshift ${r.tools.mapshift}, Graft ${r.tools.graft}. Node ${r.machine.node}, ${r.machine.os}. Top ${r.settings.limit} results per question; latency is the median of ${r.settings.timedRuns} warm runs; build time is the median of ${r.settings.builds} cold builds.\n`)
  console.log('| Repo | Tool | hit@1 | hit@3 | Median answer tokens | Median latency | Build time (median) | Index size |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const repo of r.repos)
    for (const t of ['mapshift', 'graft']) {
      const s = repo.summary[t]
      const b = repo.build[t]
      console.log(`| ${repo.name} (${repo.language}) | ${t} | ${pct(s.hit1, s.questions)} | ${pct(s.hit3, s.questions)} | ${s.medianAnswerTokens} | ${Math.round(s.medianLatencyMs)} ms | ${sec(b.medianBuildMs)} | ${kb(b.indexBytes)} |`)
    }
  for (const t of ['mapshift', 'graft']) {
    const s = r.overall[t]
    console.log(`| **all** | ${t} | ${pct(s.hit1, s.questions)} | ${pct(s.hit3, s.questions)} | ${s.medianAnswerTokens} | ${Math.round(s.medianLatencyMs)} ms | | |`)
  }
  const all = r.repos.flatMap(x => x.questions)
  const med = xs => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  }
  console.log(`\nWithout Graft's \`[graft] ...\` advice lines, the overall median answer is ${med(all.map(q => Math.round(q.graft.answerCharsWithoutBanner / 4)))} tokens for Graft (Mapshift prints no such lines: ${med(all.map(q => Math.round(q.mapshift.answerCharsWithoutBanner / 4)))}).`)
  for (const k of ['concept', 'name', 'callers']) {
    const qs = all.filter(q => q.kind === k)
    console.log(`Without advice lines, ${k}: mapshift ${med(qs.map(q => Math.round(q.mapshift.answerCharsWithoutBanner / 4)))}, graft ${med(qs.map(q => Math.round(q.graft.answerCharsWithoutBanner / 4)))} median tokens.`)
  }
  console.log(`Single cold builds (ms): ${r.repos.map(x => `${x.name}: mapshift ${x.build.mapshift.buildMs.join('/')}, graft ${x.build.graft.buildMs.join('/')}`).join('; ')}.`)
  console.log('\nBy question kind (all repos):\n')
  console.log('| Kind | Tool | hit@1 | hit@3 | Median answer tokens | Errors |')
  console.log('|---|---|---|---|---|---|')
  for (const k of ['concept', 'name', 'callers'])
    for (const t of ['mapshift', 'graft']) {
      const s = r.overall.byKind[k][t]
      console.log(`| ${k} | ${t} | ${pct(s.hit1, s.questions)} | ${pct(s.hit3, s.questions)} | ${s.medianAnswerTokens} | ${s.errors} |`)
    }
  console.log('\nPer question (rank of the first correct result; - = not in the results):\n')
  console.log('| Question | Kind | Mapshift rank | Graft rank | Mapshift tokens | Graft tokens |')
  console.log('|---|---|---|---|---|---|')
  for (const repo of r.repos)
    for (const q of repo.questions)
      console.log(`| ${q.id} | ${q.kind} | ${q.mapshift.exitCode ? 'error' : (q.mapshift.rank ?? '-')} | ${q.graft.exitCode ? 'error' : (q.graft.rank ?? '-')} | ${q.mapshift.answerTokens} | ${q.graft.answerTokens} |`)
}

const ap = join(BENCH, 'results', 'agents.json')
if (!HELDOUT && existsSync(ap)) {
  const a = readJson(ap)
  if (a.summary) {
    console.log(`\nAgents: ${a.runs.length} runs on ${a.repo}, model ${a.model}, max ${a.maxTurns} turns.\n`)
    console.log('| Arm | Correct | Avg tool calls | Avg turns | Avg input | Avg cache read | Avg cache write | Avg output | Avg total tokens | Avg cost | Total cost |')
    console.log('|---|---|---|---|---|---|---|---|---|---|---|')
    for (const [arm, s] of Object.entries(a.summary))
      console.log(`| ${arm} | ${s.correct}/${s.runs} | ${s.avgToolCalls.toFixed(1)} | ${s.avgTurns.toFixed(1)} | ${Math.round(s.avgInputTokens)} | ${Math.round(s.avgCacheReadTokens)} | ${Math.round(s.avgCacheWriteTokens)} | ${Math.round(s.avgOutputTokens)} | ${Math.round(s.avgTotalTokens)} | $${s.avgCostUsd.toFixed(4)} | $${s.totalCostUsd.toFixed(4)} |`)
    for (const arm of Object.keys(a.summary)) {
      const rest = a.runs.filter(r => r.arm === arm && r.task !== 'T1')
      console.log(`Without T1 (${arm}): avg cost $${(rest.reduce((s, r) => s + r.costUsd, 0) / rest.length).toFixed(4)}, avg cache write ${Math.round(rest.reduce((s, r) => s + r.tokens.cacheWrite, 0) / rest.length)}.`)
    }
    if (a.mcpServers) console.log(`MCP tools/list size: ${Object.entries(a.mcpServers).map(([k, v]) => `${k} ${v.tools.length} tools, ${v.toolSchemaChars} chars`).join('; ')}.`)
    console.log('\n| Task | Arm | Correct | Tool calls (by name) | Turns | Cache write | Cost |')
    console.log('|---|---|---|---|---|---|---|')
    for (const r of [...a.runs].sort((x, y) => x.task.localeCompare(y.task) || x.arm.localeCompare(y.arm)))
      console.log(`| ${r.task} | ${r.arm} | ${r.correct ? 'yes' : 'no'} | ${r.toolCallCount} (${Object.entries(r.toolCallsByName).map(([n, c]) => `${n.replace(/^mcp__\w+?__/, '')}×${c}`).join(', ')}) | ${r.turns} | ${r.tokens.cacheWrite} | $${(r.costUsd ?? 0).toFixed(4)} |`)
  }
}
