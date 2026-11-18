#!/usr/bin/env node
// Retrieval benchmark: the same questions against Mapshift and Graft, on the same pinned repositories.
// Usage: node bench/run-retrieval.mjs [--work <dir>] [--repo ky|click|cobra] [--builds 3] [--runs 3]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { platform, release } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BENCH, REPOS, WORK, argValue, dirSize, ensureClone, median, readJson, run, scrub, tokens, toolEntries, toolEnv } from './lib.mjs'

const BUILDS = Number(argValue('builds') ?? 3)
const RUNS = Number(argValue('runs') ?? 3)
const LIMIT = 3
const only = argValue('repo')

const { mapshift, graft } = toolEntries()

/** Removes a folder, but only inside the benchmark work folder. */
function rmInWork(p) {
  const full = resolve(p)
  if (!full.toLowerCase().startsWith(WORK.toLowerCase() + '\\') && !full.startsWith(WORK + '/')) throw new Error(`refusing to delete outside the work folder: ${full}`)
  rmSync(full, { recursive: true, force: true })
}


// ---------- output parsers: each returns results in the order the tool printed them ----------

const toInt = s => (s === undefined ? undefined : Number(s))

/** `### 1. name · kind · file:12-30` */
export function parseMapshiftFind(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^### \d+\. (.+?) · (.+?) · (.+?):(\d+)(?:-(\d+))?\s*$/.exec(line)
    if (m) out.push({ name: m[1], kind: m[2], file: m[3], start: toInt(m[4]), end: toInt(m[5]) ?? toInt(m[4]) })
  }
  return out
}

/** `1. name · kind  [tag]` then an indented `file:L12-L30` line. */
export function parseGraftAsk(text) {
  const out = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\d+)\. (.+?) · (\S+)/.exec(lines[i])
    if (!m) continue
    const hit = { name: m[2], kind: m[3] }
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const loc = /^\s+(\S.*?):L(\d+)(?:-L(\d+))?\s*$/.exec(lines[j])
      if (loc) {
        Object.assign(hit, { file: loc[1], start: toInt(loc[2]), end: toInt(loc[3]) ?? toInt(loc[2]) })
        break
      }
      const fileOnly = /^\s+(\S+)\s*$/.exec(lines[j]) // a whole-file node: no line range, never a definition hit
      if (fileOnly) {
        hit.file = fileOnly[1]
        break
      }
    }
    out.push(hit)
  }
  return out
}

/** Direct callers only (two-space indent): `  - name (file:776)`; deeper levels are callers of callers. */
export function parseMapshiftTrace(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {2}- (.+?) \((.+?):(\d+)\)/.exec(line)
    if (m) out.push({ name: m[1], file: m[2], start: toInt(m[3]), end: toInt(m[3]) })
  }
  return out
}

/** Direct callers: `  calls ← name (file:L757-L779)` */
export function parseGraftCallers(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {2}(\S+) ← (.+?) \((.+?):L(\d+)(?:-L(\d+))?\)/.exec(line)
    if (m) out.push({ edge: m[1], name: m[2], file: m[3], start: toInt(m[4]), end: toInt(m[5]) ?? toInt(m[4]) })
  }
  return out
}

// ---------- scoring ----------

const normFile = f => (f ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
const bare = n => (n ?? '').replace(/\(.*\)\s*/g, ' ').trim().split(/\s+/).pop().split('.').pop().replace(/^#/, '')

/** Same file, same bare name, and the result's lines overlap the definition's span. */
export function matches(result, truth) {
  if (!result.file || normFile(result.file) !== truth.file) return false
  if (bare(result.name) !== bare(truth.name)) return false
  if (result.start === undefined) return true
  return result.start <= truth.end && (result.end ?? result.start) >= truth.line - 3
}
const rankOf = (results, truth) => results.findIndex(r => truth.some(t => matches(r, t)))

// ---------- one tool, one question ----------

async function ask(tool, q, dir, home) {
  const entry = tool === 'mapshift' ? mapshift : graft
  const env = tool === 'mapshift' ? toolEnv({ MAPSHIFT_HOME: home }) : toolEnv()
  const callers = q.kind === 'callers'
  const args =
    tool === 'mapshift'
      ? callers
        ? ['map', 'trace', q.symbol, '--project', dir]
        : ['map', 'find', q.question, '--project', dir, '--limit', String(LIMIT)]
      : callers
        ? ['callers', q.symbol, dir]
        : ['ask', q.question, dir, '--source', '-n', String(LIMIT)]
  await run(entry, args, { cwd: dir, env }) // warm-up, not timed
  const timed = []
  for (let i = 0; i < RUNS; i++) timed.push(await run(entry, args, { cwd: dir, env }))
  const first = timed[0]
  const parse = tool === 'mapshift' ? (callers ? parseMapshiftTrace : parseMapshiftFind) : callers ? parseGraftCallers : parseGraftAsk
  const results = first.code === 0 ? parse(first.stdout) : []
  const rank = rankOf(results, q.truth)
  const banner = first.stdout
    .split(/\r?\n/)
    .filter(l => !/^\[graft\]/.test(l))
    .join('\n')
  return {
    command: [tool, ...args.map(a => (a === dir ? '<repo>' : a))].join(' '),
    exitCode: first.code,
    error: first.code === 0 ? null : scrub(first.stderr.trim()).slice(0, 1000),
    stderr: first.stderr.trim() ? scrub(first.stderr.trim()).slice(0, 1000) : '',
    parsed: results.length,
    top3: results.slice(0, 3).map(r => ({ name: r.name, file: r.file ?? null, start: r.start ?? null, end: r.end ?? null })),
    rank: rank < 0 ? null : rank + 1,
    hit1: rank === 0,
    hit3: rank >= 0 && rank < 3,
    answerChars: first.stdout.length,
    answerTokens: tokens(first.stdout.length),
    answerCharsWithoutBanner: banner.length,
    latencyMs: timed.map(t => Math.round(t.ms)),
    medianLatencyMs: Math.round(median(timed.map(t => t.ms))),
    output: scrub(first.stdout),
  }
}

// ---------- builds ----------

async function buildMapshift(repo, dir) {
  const times = []
  let home
  for (let i = 1; i <= BUILDS; i++) {
    home = join(WORK, 'mapshift-home', repo.name, `build${i}`)
    rmInWork(home) // every build starts with no map at all
    const r = await run(mapshift, ['map', 'build', '--project', dir], { cwd: dir, env: toolEnv({ MAPSHIFT_HOME: home }) })
    if (r.code !== 0) throw new Error(`mapshift build failed on ${repo.name}: ${r.stderr}`)
    times.push(r.ms)
  }
  return { home, buildMs: times.map(Math.round), medianBuildMs: Math.round(median(times)), indexBytes: dirSize(join(home, 'repos')) }
}

async function buildGraft(repo, dir) {
  const times = []
  for (let i = 1; i <= BUILDS; i++) {
    rmInWork(join(dir, 'graft')) // every build starts with no graph and no extraction cache
    const r = await run(graft, ['build', dir], { cwd: dir, env: toolEnv() })
    if (r.code !== 0) throw new Error(`graft build failed on ${repo.name}: ${r.stderr}`)
    times.push(r.ms)
  }
  return { buildMs: times.map(Math.round), medianBuildMs: Math.round(median(times)), indexBytes: dirSize(join(dir, 'graft')) }
}

// ---------- summary ----------

function summarize(rows) {
  const s = { questions: rows.length, hit1: 0, hit3: 0, errors: 0 }
  for (const r of rows) {
    s.hit1 += r.hit1 ? 1 : 0
    s.hit3 += r.hit3 ? 1 : 0
    s.errors += r.exitCode === 0 ? 0 : 1
  }
  s.medianAnswerTokens = median(rows.map(r => r.answerTokens))
  s.medianLatencyMs = median(rows.map(r => r.medianLatencyMs))
  return s
}

/** Scores the stored outputs again against the current question files (for logged ground-truth corrections). Runs no tool. */
function rescore() {
  const file = join(BENCH, 'results', 'retrieval.json')
  const out = readJson(file)
  for (const repo of out.repos) {
    const qs = Object.fromEntries(readJson(join(BENCH, 'questions', `${repo.name}.json`)).questions.map(q => [q.id, q]))
    for (const row of repo.questions) {
      const q = qs[row.id]
      row.truth = q.truth
      for (const tool of ['mapshift', 'graft']) {
        const r = row[tool]
        const callers = q.kind === 'callers'
        const parse = tool === 'mapshift' ? (callers ? parseMapshiftTrace : parseMapshiftFind) : callers ? parseGraftCallers : parseGraftAsk
        const results = r.exitCode === 0 ? parse(r.output) : []
        const rank = rankOf(results, q.truth)
        Object.assign(r, { parsed: results.length, top3: results.slice(0, 3).map(x => ({ name: x.name, file: x.file ?? null, start: x.start ?? null, end: x.end ?? null })), rank: rank < 0 ? null : rank + 1, hit1: rank === 0, hit3: rank >= 0 && rank < 3 })
      }
    }
  }
  finalize(out)
  out.rescoredAt = new Date().toISOString()
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  printSummary(out, file)
}

function finalize(out) {
  const kinds = rows => Object.fromEntries(['concept', 'name', 'callers'].map(k => [k, { mapshift: summarize(rows.filter(r => r.kind === k).map(r => r.mapshift)), graft: summarize(rows.filter(r => r.kind === k).map(r => r.graft)) }]))
  for (const repo of out.repos) repo.summary = { mapshift: summarize(repo.questions.map(r => r.mapshift)), graft: summarize(repo.questions.map(r => r.graft)), byKind: kinds(repo.questions) }
  const all = out.repos.flatMap(r => r.questions)
  out.overall = { mapshift: summarize(all.map(r => r.mapshift)), graft: summarize(all.map(r => r.graft)), byKind: kinds(all) }
}

function printSummary(out, file) {
  const pad = (s, n) => String(s).padEnd(n)
  console.log(`\n${pad('repo', 8)}${pad('tool', 10)}${pad('hit@1', 8)}${pad('hit@3', 8)}${pad('med tok', 9)}${pad('med ms', 8)}${pad('build ms', 10)}index KB`)
  for (const r of out.repos)
    for (const t of ['mapshift', 'graft']) {
      const s = r.summary[t]
      console.log(`${pad(r.name, 8)}${pad(t, 10)}${pad(`${s.hit1}/${s.questions}`, 8)}${pad(`${s.hit3}/${s.questions}`, 8)}${pad(s.medianAnswerTokens, 9)}${pad(s.medianLatencyMs, 8)}${pad(r.build[t].medianBuildMs, 10)}${Math.round(r.build[t].indexBytes / 1024)}`)
    }
  for (const t of ['mapshift', 'graft']) {
    const s = out.overall[t]
    console.log(`${pad('ALL', 8)}${pad(t, 10)}${pad(`${s.hit1}/${s.questions}`, 8)}${pad(`${s.hit3}/${s.questions}`, 8)}${pad(s.medianAnswerTokens, 9)}${s.medianLatencyMs}`)
  }
  console.log(`\nwrote ${file}`)
}

async function main() {
  if (process.argv.includes('--rescore')) return rescore()
  const version = async (entry, args) => (await run(entry, args, { env: toolEnv() })).stdout.trim().split(/\r?\n/)[0]
  const out = {
    generatedAt: new Date().toISOString(),
    machine: { os: `${platform()} ${release()}`, node: process.version },
    tools: { mapshift: await version(mapshift, ['--version']), graft: await version(graft, ['--version']) },
    settings: { limit: LIMIT, builds: BUILDS, timedRuns: RUNS, warmup: 1, tokens: 'chars / 4 of everything the command prints on stdout' },
    repos: [],
  }
  for (const repo of REPOS.filter(r => !only || r.name === only)) {
    const qs = readJson(join(BENCH, 'questions', `${repo.name}.json`)).questions
    console.error(`[${repo.name}] cloning and building`)
    const mdir = ensureClone(repo, 'mapshift')
    const gdir = ensureClone(repo, 'graft')
    const mb = await buildMapshift(repo, mdir)
    const gb = await buildGraft(repo, gdir)
    const rows = []
    for (const q of qs) {
      console.error(`[${repo.name}] ${q.id}`)
      const m = await ask('mapshift', q, mdir, mb.home)
      const g = await ask('graft', q, gdir)
      rows.push({ id: q.id, kind: q.kind, question: q.question, symbol: q.symbol ?? null, truth: q.truth, mapshift: m, graft: g })
    }
    const { home, ...mbuild } = mb
    out.repos.push({
      name: repo.name,
      language: repo.language,
      commit: repo.commit,
      build: { mapshift: mbuild, graft: gb },
      questions: rows,
    })
  }
  finalize(out)
  mkdirSync(join(BENCH, 'results'), { recursive: true })
  const file = join(BENCH, 'results', only ? `retrieval-${only}.json` : 'retrieval.json')
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  printSummary(out, file)
}

// only when run directly: run-heldout.mjs imports the parsers above without starting this benchmark
if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(err => {
    console.error(err)
    process.exitCode = 1
  })
