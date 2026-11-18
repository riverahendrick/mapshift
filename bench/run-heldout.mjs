#!/usr/bin/env node
// Held-out retrieval benchmark: 64 blind questions (heldout/*.json) on four repositories, Mapshift against Graft.
// Usage: node bench/run-heldout.mjs --work <dir> [--from <dir with local clones named axios, httpx, chi, json>] [--repo chi] [--builds 3] [--runs 3]
//        node bench/run-heldout.mjs --rescore     scores the stored outputs again (runs no tool)
//        --set <folder> reads another question set (repos.json, spans.json, <repo>.json) from that folder, and
//        writes results/<folder name>.json; the matching rule below is the same for every set.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { platform, release } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BENCH, WORK, argValue, dirSize, ensureClone, median, readJson, run, scrub, tokens, toolEntries, toolEnv } from './lib.mjs'
import { parseGraftAsk, parseGraftCallers, parseMapshiftFind, parseMapshiftTrace } from './run-retrieval.mjs'

const BUILDS = Number(argValue('builds') ?? 3)
const RUNS = Number(argValue('runs') ?? 3)
const LIMIT = 3
const only = argValue('repo')
const FROM = argValue('from')
const HELD = argValue('set') ? resolve(argValue('set')) : join(BENCH, 'heldout')
const SET = argValue('set') ? basename(HELD) : 'heldout'
const OUT = join(BENCH, 'results', only ? `${SET}-${only}.json` : `${SET}.json`)
const KINDS = ['developer', 'agent', 'name', 'callers']
const REPOS = readJson(join(HELD, 'repos.json'))
const SPANS = readJson(join(HELD, 'spans.json')).spans

// ---------- one matching rule, used for both tools ----------
//
// A result matches an accepted answer when:
//  1. File: the same path after turning \ into / and dropping a leading ./ (case-sensitive).
//  2. Name: both names are normalised into segments. Graft's "[dir/] " prefix, parameter lists "(...)" and generic
//     arguments "<...>" are dropped; Go receivers "(*T).M" / "(T).M" become "T.M"; "::" and "#" become ".". The last
//     segments must be equal. If BOTH names carry a container (Class., receiver, impl type), the containers must be
//     equal too; a bare name is accepted against a qualified answer (so `InsertRoute`, `node.InsertRoute` and
//     `(*node).InsertRoute` all match `node.InsertRoute`).
//  3. Span: only for answers listed in heldout/spans.json (the bare name has more than one definition in that file),
//     the result's printed line range must overlap the answer's span. For caller output this is the call-site line
//     (Mapshift) or the caller's span (Graft). A result with no line numbers never matches such an answer.
// A containing class or file is not the answer: `LineDecoder` does not match `LineDecoder.decode`.

const normFile = f => (f ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
export function segments(name) {
  let s = (name ?? '').trim()
  s = s.replace(/^\[[^\]]*\]\s*/, '') // Graft directory tag
  s = s.replace(/\(\s*\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*\./g, '$1.') // Go receiver (*T). or (T).
  for (let prev = null; prev !== s; ) {
    prev = s
    s = s.replace(/\([^()]*\)/g, '').replace(/<[^<>]*>/g, '')
  }
  s = s.replace(/::/g, '.').replace(/#/g, '.').replace(/[*&\s]/g, '')
  return s.split('.').filter(Boolean)
}
const spanFor = (repo, a) => SPANS.find(x => x.repo === repo && x.file === a.file && x.qualified === a.qualified)
export function matches(result, answer, repo) {
  if (!result.file || normFile(result.file) !== answer.file) return false
  const r = segments(result.name)
  const t = answer.qualified.split('.')
  if (!r.length || r.at(-1) !== t.at(-1)) return false
  if (r.length > 1 && t.length > 1 && r.at(-2) !== t.at(-2)) return false
  const span = spanFor(repo, answer)
  if (span) {
    if (result.start === undefined || result.start === null) return false
    return result.start <= span.end && (result.end ?? result.start) >= span.start
  }
  return true
}
const rankOf = (results, answers, repo) => results.findIndex(r => answers.some(a => matches(r, a, repo)))

// ---------- tools ----------

const { mapshift, graft } = toolEntries()
const parserFor = (tool, kind) => (tool === 'mapshift' ? (kind === 'callers' ? parseMapshiftTrace : parseMapshiftFind) : kind === 'callers' ? parseGraftCallers : parseGraftAsk)

function rmInWork(p) {
  const full = resolve(p)
  if (!full.toLowerCase().startsWith(WORK.toLowerCase() + '\\') && !full.startsWith(WORK + '/')) throw new Error(`refusing to delete outside the work folder: ${full}`)
  rmSync(full, { recursive: true, force: true })
}

function score(tool, q, repo, stdout, code) {
  const results = code === 0 ? parserFor(tool, q.kind)(stdout) : []
  const rank = rankOf(results, q.answers, repo)
  // secondary, looser figure: any of the first 3 results is in an answer's file (a whole-file node counts here)
  const fileRank = results.findIndex(r => q.answers.some(a => normFile(r.file) === a.file))
  return { fileHit3: fileRank >= 0 && fileRank < 3, parsed: results.length, top3: results.slice(0, 3).map(r => ({ name: r.name, file: r.file ?? null, start: r.start ?? null, end: r.end ?? null })), rank: rank < 0 ? null : rank + 1, hit1: rank === 0, hit3: rank >= 0 && rank < 3 }
}

async function ask(tool, q, repo, dir, home) {
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
  const withoutBanner = first.stdout.split(/\r?\n/).filter(l => !/^\[graft\]/.test(l)).join('\n')
  return {
    command: [tool, ...args.map(a => (a === dir ? '<repo>' : a))].join(' '),
    exitCode: first.code,
    stderr: first.stderr.trim() ? scrub(first.stderr.trim()).slice(0, 1000) : '',
    ...score(tool, q, repo, first.stdout, first.code),
    answerChars: first.stdout.length,
    answerTokens: tokens(first.stdout.length),
    answerTokensWithoutBanner: tokens(withoutBanner.length),
    latencyMs: timed.map(t => Math.round(t.ms)),
    medianLatencyMs: Math.round(median(timed.map(t => t.ms))),
    output: scrub(first.stdout),
  }
}

async function buildMapshift(repo, dir) {
  const times = []
  let home
  for (let i = 1; i <= BUILDS; i++) {
    home = join(WORK, 'mapshift-home', repo.name, `build${i}`)
    rmInWork(home)
    const r = await run(mapshift, ['map', 'build', '--project', dir], { cwd: dir, env: toolEnv({ MAPSHIFT_HOME: home }) })
    if (r.code !== 0) throw new Error(`mapshift build failed on ${repo.name}: ${r.stderr}`)
    const m = /Mapped (\d[\d,]*) changed files/.exec(r.stdout + r.stderr)
    const files = /Files\s+(\d[\d,]*)/.exec(r.stdout + r.stderr)
    if (!m || !files || m[1] !== files[1]) throw new Error(`mapshift build on ${repo.name} did not report a full cold build:\n${r.stdout}${r.stderr}`)
    times.push(r.ms)
  }
  return { home, buildMs: times.map(Math.round), medianBuildMs: Math.round(median(times)), indexBytes: dirSize(join(home, 'repos')) }
}

async function buildGraft(repo, dir) {
  const times = []
  for (let i = 1; i <= BUILDS; i++) {
    rmInWork(join(dir, 'graft'))
    const r = await run(graft, ['build', dir], { cwd: dir, env: toolEnv() })
    if (r.code !== 0) throw new Error(`graft build failed on ${repo.name}: ${r.stderr}`)
    const m = /parsed: (\d+) of (\d+) files \((\d+) replayed from cache\)/.exec(r.stdout + r.stderr)
    if (!m || m[3] !== '0') throw new Error(`graft build on ${repo.name} was not cold: ${m ? m[0] : 'no parse line'}`)
    times.push(r.ms)
  }
  return { buildMs: times.map(Math.round), medianBuildMs: Math.round(median(times)), indexBytes: dirSize(join(dir, 'graft')) }
}

// ---------- summary ----------

function summarize(rows) {
  const s = { questions: rows.length, hit1: 0, hit3: 0, fileHit3: 0, errors: 0, zeroParsed: 0 }
  for (const r of rows) {
    s.fileHit3 += r.fileHit3 ? 1 : 0
    s.hit1 += r.hit1 ? 1 : 0
    s.hit3 += r.hit3 ? 1 : 0
    s.errors += r.exitCode === 0 ? 0 : 1
    s.zeroParsed += r.parsed === 0 ? 1 : 0
  }
  s.medianAnswerTokens = median(rows.map(r => r.answerTokens))
  s.medianAnswerTokensWithoutBanner = median(rows.map(r => r.answerTokensWithoutBanner))
  s.medianLatencyMs = median(rows.map(r => r.medianLatencyMs))
  return s
}
function finalize(out) {
  const both = rows => ({ mapshift: summarize(rows.map(r => r.mapshift)), graft: summarize(rows.map(r => r.graft)) })
  const byKind = rows => Object.fromEntries(KINDS.map(k => [k, both(rows.filter(r => r.kind === k))]))
  for (const repo of out.repos) repo.summary = { ...both(repo.questions), byKind: byKind(repo.questions) }
  const all = out.repos.flatMap(r => r.questions)
  out.overall = { ...both(all), byKind: byKind(all) }
}

function printSummary(out) {
  const pad = (s, n) => String(s).padEnd(n)
  console.log(`\n${pad('scope', 12)}${pad('tool', 10)}${pad('hit@1', 8)}${pad('hit@3', 8)}${pad('med tok', 9)}med ms`)
  const line = (label, s, t) => console.log(`${pad(label, 12)}${pad(t, 10)}${pad(`${s.hit1}/${s.questions}`, 8)}${pad(`${s.hit3}/${s.questions}`, 8)}${pad(s.medianAnswerTokens, 9)}${s.medianLatencyMs}`)
  for (const r of out.repos) for (const t of ['mapshift', 'graft']) line(r.name, r.summary[t], t)
  for (const k of KINDS) for (const t of ['mapshift', 'graft']) line(k, out.overall.byKind[k][t], t)
  for (const t of ['mapshift', 'graft']) line('ALL', out.overall[t], t)
  console.log(`\nwrote ${OUT}`)
}

function rescore() {
  const out = readJson(OUT)
  for (const repo of out.repos) {
    const qs = Object.fromEntries(readJson(join(HELD, `${repo.name}.json`)).map(q => [q.id, q]))
    for (const row of repo.questions) {
      row.answers = qs[row.id].answers
      for (const tool of ['mapshift', 'graft']) Object.assign(row[tool], score(tool, qs[row.id], repo.name, row[tool].output, row[tool].exitCode))
    }
  }
  finalize(out)
  out.rescoredAt = new Date().toISOString()
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
  printSummary(out)
}

async function main() {
  if (process.argv.includes('--rescore')) return rescore()
  const version = async entry => (await run(entry, ['--version'], { env: toolEnv() })).stdout.trim().split(/\r?\n/)[0]
  const out = {
    generatedAt: new Date().toISOString(),
    machine: { os: `${platform()} ${release()}`, node: process.version },
    tools: { mapshift: await version(mapshift), graft: await version(graft) },
    settings: { limit: LIMIT, builds: BUILDS, timedRuns: RUNS, warmup: 1, tokens: 'chars / 4 of everything the command prints on stdout', matching: 'see the comment block at the top of run-heldout.mjs' },
    repos: [],
  }
  for (const r of REPOS.filter(x => !only || x.name === only)) {
    // --from points at local clones (no network); otherwise the public URL in heldout/repos.json is cloned
    const repo = { ...r, url: FROM && existsSync(join(FROM, r.name, '.git')) ? resolve(FROM, r.name) : r.url }
    const qs = readJson(join(HELD, `${r.name}.json`))
    console.error(`[${r.name}] cloning and building`)
    const mdir = ensureClone(repo, 'mapshift')
    const gdir = ensureClone(repo, 'graft')
    const mb = await buildMapshift(repo, mdir)
    const gb = await buildGraft(repo, gdir)
    const rows = []
    for (const q of qs) {
      console.error(`[${r.name}] ${q.id}`)
      const m = await ask('mapshift', q, r.name, mdir, mb.home)
      const g = await ask('graft', q, r.name, gdir)
      rows.push({ id: q.id, kind: q.kind, question: q.question, symbol: q.symbol ?? null, answers: q.answers, mapshift: m, graft: g })
    }
    const { home, ...mbuild } = mb
    out.repos.push({ name: r.name, language: r.lang, commit: r.commit, build: { mapshift: mbuild, graft: gb }, questions: rows })
  }
  finalize(out)
  mkdirSync(join(BENCH, 'results'), { recursive: true })
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
  printSummary(out)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(err => {
    console.error(err)
    process.exitCode = 1
  })
