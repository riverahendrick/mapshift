# Mapshift vs Graft: retrieval and agent benchmark

This folder compares two local code-map tools for coding agents on the same repositories, questions and machine:

- **Mapshift** 0.1.1 (this repository, built from commit `0d4f375`)
- **Graft** 0.29.0 (npm `@nanonets/graft`, also published as Trail-code)

Every number below comes from `results/retrieval.json` and `results/agents.json`. The tables were printed by `report.mjs`, not typed by hand.

## What was measured

### Retrieval (`run-retrieval.mjs`)

- **Repositories:** three public repositories, pinned in `repos.json`.

  | Repo | Language | Commit |
  |---|---|---|
  | sindresorhus/ky | TypeScript | `3541888878c4d303a8bc2ad61815f4e048f55a5d` |
  | pallets/click | Python | `08b803cf32ceb2ae6a772c62d5da42757a897d44` |
  | spf13/cobra | Go | `adbc8813901bba65827259daa8e22ff94ec1f30e` |

- **Questions:** `questions/<repo>.json` holds 12 questions per repository, 36 in total. Each repository gets 6 plain-English questions, 3 name lookups ("where is `X` defined") and 3 caller questions ("what calls `X`"). Each question records its ground truth as a file, a qualified name and the definition's line span. All of them were written from reading the code and frozen before the benchmark harness ran. Comment and docstring text was not copied into the questions.

  Exception, to disclose: while checking output formats, both tools were tried by hand on cobra before the cobra questions were written. That check covered one search about suggesting similar subcommand names, `legacyArgs` callers, and a lookup of `ShellCompDirective`, which overlap cobra-c1, cobra-k1 and cobra-n1. The questions were not reworded after the full runs.
- **Commands run, with the same limit of 3 results for both tools:**

  | Question kind | Mapshift | Graft |
  |---|---|---|
  | Plain-English and name questions | `mapshift map find "<question>" --project <repo> --limit 3` | `graft ask "<question>" <repo> --source -n 3` |
  | Caller questions | `mapshift map trace <name> --project <repo>` | `graft callers <name> <repo>` |

  The caller commands ran with each tool's default depth.
- **Scoring:** a result counts as correct when three things hold: it is in the same file as the ground truth, it has the same bare name, and its line range overlaps the definition's span.
  - **Caller questions:** only direct callers are scored. Mapshift also prints callers-of-callers indented underneath, and those are ignored.
  - **hit@1 and hit@3:** whether a correct result appears first, or anywhere in the first three.
  - **Errors:** a tool error is recorded as a miss. No question was dropped.
- **Answer size:** the characters printed on stdout, divided by 4 to give tokens. This includes Graft's `[graft] tokens saved …` advice lines, because an agent receives those lines too. The figure with those lines removed is also given.
- **Latency:** each command runs once untimed as a warm-up, then 3 timed runs. The figure is the median wall-clock time of those 3 runs, process start included. Both tools are Node CLIs started the same way, as `node <entry>` with no shell.
- **Build time:** the median of 3 cold builds. Each build started with no index at all: Mapshift got an empty `MAPSHIFT_HOME`, and Graft's `graft/` folder was deleted.
- **Index size:** bytes on disk. For Mapshift that is `MAPSHIFT_HOME/repos`, which is kept outside the repository. For Graft it is the `graft/` folder that it writes inside the repository.
- **Isolation:** each tool got its own clone of each repository, so neither tool indexed the other's files.

### Agents (`run-agents.mjs`)

- **Setup:** 5 tasks on click (`agent-tasks.json`), one run per task per arm, 10 runs in total.
- **Tasks:** each task asks the agent to locate code and explain it in two sentences. The accepted answers and the rubric were written before any run.
- **Command:** Claude Code headless, as `claude -p --model sonnet --max-turns 8 --output-format stream-json --verbose --setting-sources project,local --strict-mcp-config --mcp-config <one server> --allowedTools <that server's 5 tools>,Read,Grep,Glob --tools Read,Grep,Glob --no-session-persistence`.
- **CLAUDE.md:** `--setting-sources project,local` still loaded the personal `~/.claude/CLAUDE.md`, which names Graft. Both arms therefore also get `--settings '{"claudeMdExcludes":["**/.claude/CLAUDE.md","**/CLAUDE.md"]}'`. The first canary run was made before this fix: its answer showed that the file had leaked. That run was discarded and redone.
- **Graft's sixth tool:** Graft's server also exposes `graft_check_freshness`. The agent could see it, but it was not in the allowed list, and it was never called.
- **Run order and isolation:** runs went one after another. Which arm ran first alternated from task to task. Each arm worked in its own clone with a prebuilt index.
- **What was recorded:** tokens and cost come from Claude Code's final `result` event. Tool calls are counted by unique `tool_use` id.
- **Judging:**
  - **Blind sheet:** the answers were judged strictly from a shuffled sheet with the arm labels removed.
  - **Imperfect blinding:** Graft's tool output tells the agent to end its reply with a "graft saved ~N tokens" line. The agent did this in every Graft run, so those answers could be recognised.
  - **Verdicts:** recorded in `results/agent-verdicts.json`.

## How to reproduce

You need Node 22.13 or newer, git, Graft 0.29.0 installed globally (`graft` on PATH), Mapshift built in this repository (`npm run build`), and for the agent part, Claude Code logged in. All clones, indexes and raw agent logs go into one work folder outside this repository.

```sh
# retrieval: clones the pinned repos into <work>/bench-repos, builds 3x per tool, runs all 36 questions
node bench/run-retrieval.mjs --work <work>
# re-score stored outputs after a logged ground-truth correction (runs no tool)
node bench/run-retrieval.mjs --work <work> --rescore

# agents
node bench/run-agents.mjs --work <work> --smoke       # both MCP servers answer initialize + tools/list
node bench/run-agents.mjs --work <work>               # the 10 runs (skips runs already in results/agents.json)
node bench/run-agents.mjs --work <work> --blind       # <work>/agents/blind-sheet.json for judging
#   write results/agent-verdicts.json, then:
node bench/run-agents.mjs --work <work> --summarize

node bench/report.mjs                                 # prints every table below
```

`MAPSHIFT_BIN` and `GRAFT_BIN` can point at other builds of either tool. Every tool process runs with `DO_NOT_TRACK=1`, which turns off Graft's anonymous telemetry and update check for these runs only, and with `NO_COLOR=1`. Mapshift always runs with `MAPSHIFT_HOME` inside the work folder.

## Results: retrieval

Tools: Mapshift 0.1.1, Graft 0.29.0. Node v24.19.0, Windows 11 (win32 10.0.26200). Top 3 results per question; latency is the median of 3 warm runs; build time is the median of 3 cold builds.

| Repo | Tool | hit@1 | hit@3 | Median answer tokens | Median latency | Build time (median) | Index size |
|---|---|---|---|---|---|---|---|
| ky (TypeScript) | mapshift | 5/12 (42%) | 6/12 (50%) | 374.5 | 4062 ms | 3.5 s | 1628 KB |
| ky (TypeScript) | graft | 5/12 (42%) | 8/12 (67%) | 447 | 6696 ms | 5.5 s | 4040 KB |
| click (Python) | mapshift | 8/12 (67%) | 8/12 (67%) | 567.5 | 1301 ms | 3.3 s | 2248 KB |
| click (Python) | graft | 7/12 (58%) | 7/12 (58%) | 1153.5 | 1811 ms | 4.2 s | 6235 KB |
| cobra (Go) | mapshift | 6/12 (50%) | 7/12 (58%) | 299.5 | 935 ms | 2.8 s | 996 KB |
| cobra (Go) | graft | 5/12 (42%) | 5/12 (42%) | 372 | 1458 ms | 12.0 s | 2475 KB |
| **all** | mapshift | 19/36 (53%) | 21/36 (58%) | 378 | 1382 ms | | |
| **all** | graft | 17/36 (47%) | 20/36 (56%) | 490.5 | 1811 ms | | |

- **Advice lines:** Mapshift prints no `[graft] ...`-style advice lines, so its figures are the same either way. With Graft's advice lines removed, the median answer sizes in tokens are:

  | Question kind | Mapshift | Graft |
  |---|---|---|
  | concept | 426 | 571 |
  | name | 494 | 885 |
  | callers | 47 | 48 |
  | all kinds | 378 | 359 |

  The all-kinds figure is lower for Graft only because the three kinds are mixed into one median.
- **Individual cold builds (ms):**

  | Repo | Mapshift | Graft |
  |---|---|---|
  | ky | 3534 / 3652 / 2982 | 5264 / 5496 / 7018 |
  | click | 3900 / 3252 / 2858 | 4210 / 4053 / 5074 |
  | cobra | 2760 / 2826 / 1441 | 12036 / 35327 / 8496 |

  The Graft cobra builds varied widely, from 8.5 s to 35.3 s, so its 12.0 s median is not a stable figure.

By question kind (all repos):

| Kind | Tool | hit@1 | hit@3 | Median answer tokens | Errors |
|---|---|---|---|---|---|
| concept | mapshift | 3/18 (17%) | 5/18 (28%) | 426 | 0 |
| concept | graft | 1/18 (6%) | 4/18 (22%) | 703 | 0 |
| name | mapshift | 9/9 (100%) | 9/9 (100%) | 494 | 0 |
| name | graft | 7/9 (78%) | 7/9 (78%) | 1017 | 0 |
| callers | mapshift | 7/9 (78%) | 7/9 (78%) | 47 | 0 |
| callers | graft | 9/9 (100%) | 9/9 (100%) | 121 | 0 |

Per question (rank of the first correct result; - = not in the top results):

| Question | Kind | Mapshift rank | Graft rank | Mapshift tokens | Graft tokens |
|---|---|---|---|---|---|
| ky-c1 | concept | - | - | 371 | 563 |
| ky-c2 | concept | 1 | 2 | 258 | 5900 |
| ky-c3 | concept | - | 2 | 525 | 843 |
| ky-c4 | concept | 3 | 2 | 565 | 441 |
| ky-c5 | concept | - | - | 378 | 432 |
| ky-c6 | concept | - | - | 433 | 236 |
| ky-n1 | name | 1 | 1 | 368 | 453 |
| ky-n2 | name | 1 | - | 494 | 1616 |
| ky-n3 | name | 1 | 1 | 463 | 2911 |
| ky-k1 | callers | - | 1 | 48 | 167 |
| ky-k2 | callers | 1 | 1 | 45 | 157 |
| ky-k3 | callers | - | 1 | 37 | 120 |
| click-c1 | concept | - | - | 568 | 1713 |
| click-c2 | concept | 1 | - | 608 | 928 |
| click-c3 | concept | - | - | 660 | 1711 |
| click-c4 | concept | - | - | 567 | 2375 |
| click-c5 | concept | 1 | 1 | 534 | 1507 |
| click-c6 | concept | - | - | 661 | 1568 |
| click-n1 | name | 1 | 1 | 593 | 1290 |
| click-n2 | name | 1 | 1 | 550 | 1017 |
| click-n3 | name | 1 | 1 | 600 | 730 |
| click-k1 | callers | 1 | 1 | 45 | 126 |
| click-k2 | callers | 1 | 1 | 47 | 115 |
| click-k3 | callers | 1 | 1 | 62 | 128 |
| cobra-c1 | concept | - | - | 315 | 338 |
| cobra-c2 | concept | - | - | 378 | 198 |
| cobra-c3 | concept | - | - | 363 | 374 |
| cobra-c4 | concept | - | - | 419 | 370 |
| cobra-c5 | concept | - | - | 283 | 1283 |
| cobra-c6 | concept | 2 | - | 411 | 383 |
| cobra-n1 | name | 1 | - | 284 | 1774 |
| cobra-n2 | name | 1 | 1 | 557 | 838 |
| cobra-n3 | name | 1 | 1 | 231 | 528 |
| cobra-k1 | callers | 1 | 1 | 98 | 116 |
| cobra-k2 | callers | 1 | 1 | 44 | 121 |
| cobra-k3 | callers | 1 | 1 | 57 | 115 |

One ground-truth correction was made after the first run, and it is logged in `questions/click.json`. For click-k2, the direct caller of `join_options` is the nested function `_write_opts` inside `Option.get_help_spec`. Both tools returned that function, but the original ground truth listed only the enclosing method. The wording of the question did not change. Both tools were rescored from their stored output, and each gained one hit.

## Results: agents

Agents: 10 runs on click, model sonnet (`claude-sonnet-5-5`), max 8 turns.

| Arm | Correct | Avg tool calls | Avg turns | Avg input | Avg cache read | Avg cache write | Avg output | Avg total tokens | Avg cost | Total cost |
|---|---|---|---|---|---|---|---|---|---|---|
| mapshift | 4/5 | 1.4 | 2.4 | 5 | 15864 | 2550 | 321 | 18739 | $0.0150 | $0.0750 |
| graft | 5/5 | 1.8 | 2.8 | 6 | 21043 | 6063 | 482 | 27594 | $0.0312 | $0.1560 |

Leaving out T1 gives these averages:

| Arm | Avg cost | Avg cache write |
|---|---|---|
| mapshift | $0.0153 | 2546 |
| graft | $0.0289 | 5290 |

The discarded canary was a Mapshift-arm T1 run, so it had already warmed the prompt cache for the Mapshift T1 rerun. Graft's T1 paid a cold cache write. The tools/list each server sends was measured by `--smoke` and is stored in `agents.json`:

| Server | Tools | Characters |
|---|---|---|
| Mapshift | 5 | 2,713 |
| Graft | 6 | 3,341 |

| Task | Arm | Correct | Tool calls (by name) | Turns | Cache write | Cost |
|---|---|---|---|---|---|---|
| T1 | graft | yes | 1 (graft_find_code×1) | 2 | 9157 | $0.0403 |
| T1 | mapshift | yes | 1 (map_find×1) | 2 | 2564 | $0.0138 |
| T2 | graft | yes | 3 (graft_find_code×1, Grep×1, Read×1) | 4 | 6766 | $0.0374 |
| T2 | mapshift | no | 1 (map_find×1) | 2 | 2682 | $0.0146 |
| T3 | graft | yes | 1 (graft_find_code×1) | 2 | 5780 | $0.0278 |
| T3 | mapshift | yes | 1 (map_find×1) | 2 | 2440 | $0.0135 |
| T4 | graft | yes | 2 (Grep×1, Read×1) | 3 | 3073 | $0.0203 |
| T4 | mapshift | yes | 3 (map_search×2, Read×1) | 4 | 2682 | $0.0198 |
| T5 | graft | yes | 2 (graft_find_code×1, Grep×1) | 3 | 5540 | $0.0301 |
| T5 | mapshift | yes | 1 (map_find×1) | 2 | 2380 | $0.0133 |

**T2, Mapshift arm:**

- **Marked incorrect:** the run named the right method (`Option.consume_value`), but explained the prompt condition wrongly. It said click prompts when no parser, environment or default-map value is found. In the code, a default-map value still prompts, and only when `required` or `prompt_required` is set.
- **Probable cause:** the agent stopped after one `map_find` call and said it had not read the function body.
- **How the verdict changed:** it was first judged correct and changed on a second strict pass. That pass is logged in `results/agent-verdicts.json`.

## Where each tool is better

**Graft is better at:**

- **Callers when the caller is a TypeScript `#private` method.** Graft returns `#calculateRetryDelay` and `#fetch` (ky-k1, ky-k3). Mapshift credits the call to the class `Ky`, so it misses the method that answers the question. Graft got 9/9 caller questions; Mapshift got 7/9.
- **Some plain-English questions on ky.** For ky-c3 (upload progress), Graft ranks `streamRequest` second and Mapshift does not return it. On ky, Graft's hit@3 is 8/12 against Mapshift's 6/12.
- **Agent accuracy in this small sample.** Graft got 5/5 and Mapshift 4/5. The Mapshift miss on T2 came from an agent that answered after one search without reading the code. The Graft arm on the same task ran a search, a `Grep` and a `Read`, and stated the condition exactly.

**Mapshift is better at:**

- **Name lookups.** Mapshift found 9/9 at rank 1 and Graft 7/9. Graft missed `deepMerge` (ky-n2), returning `deepMergeInternal` first, and missed `ShellCompDirective` (cobra-n1).
- **Answer size on searches.** With Graft's advice lines removed, Mapshift's median answers are smaller for plain-English questions (426 against 571 tokens) and name lookups (494 against 885). The two are equal for caller questions (47 against 48). Graft's `--source` output is sometimes very large: 5,900 tokens for ky-c2 and 2,911 for ky-n3.
- **Speed and footprint.** Every repository had lower warm latency (1.4 s against 1.8 s median overall), faster cold builds, and an index about 2.5 times smaller. Mapshift keeps its index outside the repository; Graft writes `graft/` into the repository and also edits `.gitignore` and adds `.ignore`.
- **A few plain-English hits Graft missed.** These are `HelpFormatter.write_dl` (click-c2) and `GetActiveHelpConfig` (cobra-c6). Many of Graft's top-3 slots go to whole-file nodes such as `cobra.go`, which never match a definition.

**Neither tool is good at plain-English questions.** Mapshift found 5/18 in the top 3 and Graft 4/18. On cobra, Mapshift's top results for several questions were the `doc/` generators, apparently because the word "cobra" in the question matches `cobra.Command` there.

**The agent test barely separates the tools.** Sonnet already knows click, and often searched for the right name directly (for example `Option.consume_value`). On this sample, the Mapshift arm used fewer tool calls (1.4 against 1.8) and cost about half as much: $0.015 against $0.031 per run, or $0.015 against $0.029 without T1. A likely reason, which was not tested, is that Graft's larger tools/list (3,341 against 2,713 characters) and larger tool output raise cache writes. With one run per task, the cost difference and the 4/5 against 5/5 accuracy are observations, not significant results.

## Limits of this benchmark

- **Who wrote the questions:** they come from the side that maintains Mapshift. They were frozen before scoring, with the one logged correction above.
- **Sample size:** 36 questions and 10 agent runs, run once each, are a small sample. A difference of one or two hits is within noise.
- **Agent test:** the tasks are on a well-known library that the model already knows, so they mostly test the model and not the map.
- **Extra agent runs:** besides the 10 counted runs, there was 1 discarded canary task run. There were also 4 one-turn headless checks: a login check and three tests of how to keep CLAUDE.md out.
- **Windows only:** latency includes Node process start-up, and only Windows was tested.


## Rerun after fixes (2026-11-17)

The first run above found three gaps: TypeScript `#private` methods were not recognised (so their callers were credited to the whole class), plain-English questions could not match words used inside a function's body, and one agent answer stated a detail it had not read. All three were fixed (private members, body-word search, and an instruction to read exact lines before stating a detail), then the retrieval benchmark was run again unchanged: same questions, same repositories, same commits, same machine. The agent runs were not repeated.

Tools: Mapshift 0.1.1, Graft 0.29.0. Node v24.19.0, win32 10.0.26200. Top 3 results per question; latency is the median of 3 warm runs; build time is the median of 3 cold builds.

| Repo | Tool | hit@1 | hit@3 | Median answer tokens | Median latency | Build time (median) | Index size |
|---|---|---|---|---|---|---|---|
| ky (TypeScript) | mapshift | 7/12 (58%) | 8/12 (67%) | 360.5 | 745 ms | 2.1 s | 1788 KB |
| ky (TypeScript) | graft | 5/12 (42%) | 8/12 (67%) | 447 | 1140 ms | 2.6 s | 4040 KB |
| click (Python) | mapshift | 8/12 (67%) | 8/12 (67%) | 542 | 752 ms | 1.7 s | 2616 KB |
| click (Python) | graft | 7/12 (58%) | 7/12 (58%) | 1153.5 | 1185 ms | 2.3 s | 6235 KB |
| cobra (Go) | mapshift | 6/12 (50%) | 9/12 (75%) | 299.5 | 752 ms | 1.1 s | 1144 KB |
| cobra (Go) | graft | 5/12 (42%) | 5/12 (42%) | 372 | 1181 ms | 1.7 s | 2475 KB |
| **all** | mapshift | 21/36 (58%) | 25/36 (69%) | 382.5 | 750 ms | | |
| **all** | graft | 17/36 (47%) | 20/36 (56%) | 490.5 | 1173 ms | | |

Without Graft's `[graft] ...` advice lines, the overall median answer is 359 tokens for Graft (Mapshift prints no such lines: 382.5).
Without advice lines, concept: mapshift 434, graft 571 median tokens.
Without advice lines, name: mapshift 463, graft 885 median tokens.
Without advice lines, callers: mapshift 52, graft 48 median tokens.
Single cold builds (ms): ky: mapshift 1924/2127/2622, graft 2711/2339/2584; click: mapshift 2064/1541/1651, graft 2633/2250/2177; cobra: mapshift 1165/1130/1095, graft 2081/1657/1688.

By question kind (all repos):

| Kind | Tool | hit@1 | hit@3 | Median answer tokens | Errors |
|---|---|---|---|---|---|
| concept | mapshift | 3/18 (17%) | 7/18 (39%) | 434 | 0 |
| concept | graft | 1/18 (6%) | 4/18 (22%) | 703 | 0 |
| name | mapshift | 9/9 (100%) | 9/9 (100%) | 463 | 0 |
| name | graft | 7/9 (78%) | 7/9 (78%) | 1017 | 0 |
| callers | mapshift | 9/9 (100%) | 9/9 (100%) | 52 | 0 |
| callers | graft | 9/9 (100%) | 9/9 (100%) | 121 | 0 |
