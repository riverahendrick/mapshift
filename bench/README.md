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

## Held-out benchmark (blind questions)

Mapshift was tuned against the questions used above. This section uses a second set, `heldout/`.

- **Who wrote the questions:** the side that maintains Mapshift, before this run.
- **Tuning claim:** that side states the set was never used for tuning. This was not verified. The files first appear in commit `07a37ca`, the same commit as the Mapshift build tested here.
- **Disclosure:** before the scored run, both tools were tried by hand while checking output formats, on 8 of the 64 questions: json-agent-3, json-callers-1, chi-dev-3, chi-callers-1, axios-dev-2, axios-callers-2, httpx-dev-6 and httpx-callers-1. The matching rule was written after seeing that output. One example: the decision that a containing class does not count was made after both tools returned `LineDecoder` for httpx-dev-6. No question or accepted answer was changed.

Every table here comes from `results/heldout.json` and `results/heldout-agents.json`, and was printed by `node bench/report.mjs --heldout`.

### Method

- **Repositories:** four, pinned in `heldout/repos.json`. None of them is in the tuning set.

  | Repo | Language | Commit |
  |---|---|---|
  | axios/axios | JavaScript | `c0d4c900515a55bd1e258eee16adb25c404d56ed` |
  | encode/httpx | Python | `7cff5f79bc78649bbcd3fd9aa7a74c86e0f63016` |
  | go-chi/chi | Go | `c64ed7d6635f33a8b2feaff7dcfa55677023ac7d` |
  | serde-rs/json | Rust | `f51fa15a7015c7d02817a46d2db44c899a0016e8` |

- **Questions:** 64 in total, 16 per repository, of four kinds. Each question lists one or more accepted answers as `{file, qualified}`.

  | Kind | Per repository | What the question is |
  |---|---|---|
  | developer | 6 | a plain-English question |
  | agent | 6 | a keyword string, as an agent would type it |
  | name | 2 | "where is `X` defined" |
  | callers | 2 | "what calls `X`" |

- **Commands:** the same as in the first benchmark.

  | Question kind | Mapshift | Graft |
  |---|---|---|
  | developer, agent, name | `mapshift map find "<q>" --limit 3` | `graft ask "<q>" --source -n 3` |
  | callers | `mapshift map trace <symbol>` | `graft callers <symbol>` |

  Every tool process ran with `DO_NOT_TRACK=1`. Mapshift ran with `MAPSHIFT_HOME` inside the work folder.
- **Isolation:** each tool got its own fresh clone at the pinned commit. Graft's `graft/` folder, its `.gitignore` edit and its `.ignore` file never reached Mapshift's copy.
- **Matching:** both tools are scored by one rule, `matches()` in `run-heldout.mjs`. A result counts only if all of these hold:
  - **Same file:** the file path equals an accepted answer's path.
  - **Same name:** names are normalised first. This removes Graft's `[dir/]` tag, parameter lists and generics, turns `::` into `.`, and turns a Go receiver `(*T).` into `T.`. The last segments must then be equal. If both names carry a container (a class, receiver or impl type), the containers must be equal too. So `InsertRoute`, `node.InsertRoute` and `(*node).InsertRoute` all match `node.InsertRoute`.
  - **Overlapping lines, for 12 answers:** for these, the bare name has more than one definition in the file. One example is the four `serialize_f64` in `src/ser.rs`. The result's printed lines must overlap the correct definition. The spans were read from the source and stored in `heldout/spans.json`.

  A whole-file result does not count, and neither does the class that contains the answer. The rule is unit-tested on 19 cases covering both tools' output forms (`node bench/test-heldout-match.mjs`). The tables also give a looser figure, "right file in top 3".
- **Answer size, latency and build time:** measured the same way as in the first benchmark.
  - **Answer size:** the characters printed on stdout, divided by 4.
  - **Latency:** 1 warm-up, then the median of 3 timed runs. Both tools are Node CLIs, so the time includes process start-up.
  - **Build time:** the median of 3 cold builds. The harness refuses a build that is not cold: Mapshift must report every file as mapped, and Graft must report `0 replayed from cache`.
- **Agents:** these were real Claude Code headless runs, model sonnet, `--max-turns 8`. They used the same command, the same CLAUDE.md exclusion and the same per-arm strict MCP config as the first benchmark.
  - **Runs:** one run per task per arm, 12 in total. Which arm ran first alternated by task.
  - **Repository:** serde-rs/json. axios ships an `AGENTS.md`, which Claude Code's built-in agents-md plugin could load, so it was not used.
  - **Tasks:** the first three developer and the first three agent questions of `heldout/json.json`, stored in `heldout/agent-tasks.json`. This rule was fixed, and the rubrics written from the source, before any result was read.
  - **Clean setup:** the first run's `init` event showed one MCP server with its own tools, and no Mapshift or Graft plugin or skill. After the runs, the Graft clone showed only Graft's own `.gitignore` edit and `.ignore` file.
  - **Judging:** a separate Claude session judged every claim against the pinned source. It worked from a shuffled sheet with the arm labels removed, and with Graft's closing "graft saved ~N tokens" line stripped. It did not open the key. Three of its verdicts were spot-checked against the source. The verdicts are in `results/heldout-agent-verdicts.json`.
- **Build changed during the run:** `dist/` was rebuilt partway through the retrieval run, at about 01:08 UTC, and the agent runs came after that. The rebuild only changed the version string, from 0.1.1 to 0.1.2. The only source file that differs from commit `07a37ca` is `src/version.ts`. The search code was the same throughout.

### How to reproduce

```sh
# retrieval: clones from the URLs in heldout/repos.json; --from <dir> uses local clones named axios, httpx, chi, json instead
node bench/run-heldout.mjs --work <work>
node bench/run-heldout.mjs --rescore            # re-scores the stored output and runs no tool

# agents
A="--work <work2> --tasks heldout/agent-tasks.json --repos heldout/repos.json --out results/heldout-agents.json --verdicts results/heldout-agent-verdicts.json"
node bench/run-agents.mjs $A --smoke
node bench/run-agents.mjs $A                    # the 12 runs
node bench/run-agents.mjs $A --blind            # writes <work2>/agents/blind-sheet.json; judge it and write the verdicts file, then:
node bench/run-agents.mjs $A --summarize

node bench/report.mjs --heldout
```

### Results: retrieval

Tools: Mapshift 0.1.1 (commit `07a37ca`) and Graft 0.29.0, on Node v24.19.0 and Windows 11 (win32 10.0.26200). Each tool returned its top 3 results. Latency is the median over the questions of each question's median of 3 warm runs. Build time is the median of 3 cold builds.

Overall (64 questions):

| Tool | hit@1 | hit@3 | Right file in top 3 | Median answer tokens | Same, without Graft advice lines | Median latency | Errors | No result parsed |
|---|---|---|---|---|---|---|---|---|
| mapshift | 36/64 (56%) | 45/64 (70%) | 57/64 (89%) | 398 | 398 | 443 ms | 0 | 1 |
| graft | 27/64 (42%) | 33/64 (52%) | 56/64 (88%) | 629.5 | 498.5 | 1809 ms | 0 | 1 |

By question kind (all repos):

| Kind | Tool | hit@1 | hit@3 | Right file in top 3 | Median answer tokens | Same, without advice lines | Median latency |
|---|---|---|---|---|---|---|---|
| developer | mapshift | 9/24 (38%) | 13/24 (54%) | 21/24 (88%) | 454.5 | 454.5 | 430 ms |
| developer | graft | 5/24 (21%) | 6/24 (25%) | 19/24 (79%) | 778 | 646.5 | 1791 ms |
| agent | mapshift | 12/24 (50%) | 17/24 (71%) | 21/24 (88%) | 382 | 382 | 438 ms |
| agent | graft | 10/24 (42%) | 14/24 (58%) | 22/24 (92%) | 685 | 553 | 1819 ms |
| name | mapshift | 8/8 (100%) | 8/8 (100%) | 8/8 (100%) | 358.5 | 358.5 | 462 ms |
| name | graft | 6/8 (75%) | 6/8 (75%) | 8/8 (100%) | 457 | 325.5 | 1902 ms |
| callers | mapshift | 7/8 (88%) | 7/8 (88%) | 7/8 (88%) | 58.5 | 58.5 | 434 ms |
| callers | graft | 6/8 (75%) | 7/8 (88%) | 7/8 (88%) | 148 | 75 | 1541 ms |

By repository:

| Repo | Tool | hit@1 | hit@3 | Median answer tokens | Median latency | Build time (median of 3) | Index size |
|---|---|---|---|---|---|---|---|
| axios (javascript) | mapshift | 9/16 (56%) | 11/16 (69%) | 476.5 | 580 ms | 3.4 s | 2904 KB |
| axios (javascript) | graft | 7/16 (44%) | 10/16 (63%) | 583.5 | 2086 ms | 4.9 s | 7246 KB |
| httpx (python) | mapshift | 9/16 (56%) | 11/16 (69%) | 352 | 460 ms | 3.0 s | 1500 KB |
| httpx (python) | graft | 8/16 (50%) | 9/16 (56%) | 944 | 1858 ms | 2.7 s | 3757 KB |
| chi (go) | mapshift | 9/16 (56%) | 11/16 (69%) | 432 | 433 ms | 1.3 s | 1056 KB |
| chi (go) | graft | 7/16 (44%) | 8/16 (50%) | 541 | 1823 ms | 2.5 s | 2127 KB |
| json (rust) | mapshift | 9/16 (56%) | 12/16 (75%) | 338 | 387 ms | 1.4 s | 1528 KB |
| json (rust) | graft | 5/16 (31%) | 6/16 (38%) | 413 | 1519 ms | 2.3 s | 3518 KB |

- **Single cold builds (ms):**

  | Repo | Mapshift | Graft |
  |---|---|---|
  | axios | 3634 / 3362 / 3221 | 4663 / 4895 / 5065 |
  | httpx | 6603 / 3011 / 1274 | 2943 / 2557 / 2724 |
  | chi | 1500 / 1268 / 1218 | 2564 / 2496 / 2400 |
  | json | 4492 / 1373 / 1293 | 2316 / 2385 / 2332 |

  Mapshift's first build was much slower on httpx and on json, so its 3.0 s median for httpx is not a stable figure.
- **Latency is mostly process start-up.** On the same machine after the run, `graft --version` alone took 1.15 s, and a `graft callers` query took 1.25 to 1.36 s. Graft's latency here, about 1.8 s, is higher than in the first benchmark, where it was about 1.2 s. The machine was not idle during the scored run, since `dist/` was rebuilt partway through it. So chi was run again afterwards on an idle machine with `--repo chi`, and that output was not kept:

| Measure (chi re-run) | Mapshift | Graft |
|---|---|---|
| All 16 ranks | identical to the scored run | identical to the scored run |
| Median latency | 296 ms | 1158 ms |
| Cold builds (ms) | 950 / 843 / 878 | 1901 / 1654 / 1606 |

The absolute times in the tables above are therefore inflated for both tools, but the ratio held. Start-up does not apply when either tool runs as a long-lived MCP server.
- **The one "no result parsed" row** is axios-callers-2 (`transformData`), and it is the same row for both tools. Both report no callers. All three calls are written `transformData.call(config, …)`, and neither tool links them.
- **Per-question ranks** are printed by `node bench/report.mjs --heldout`.

**Every question where Graft found the answer and Mapshift did not** (4; the top 3 results as stored):

| Question | Graft | Mapshift |
|---|---|---|
| axios-agent-3 `no_proxy CIDR prefix match ip address bytes` | #1 `shouldBypassProxy` | `normalizeCidrBase`, `normalizeNoProxyHost`, `parseCidrEntry`: the right file, but not `isInSubnet` or `shouldBypassProxy` |
| chi-dev-3: how the routing tree splits a node on a shared prefix | #1 `InsertRoute` (tree.go:148) | `addChild` (tree.go), `handle`, `Mount` (mux.go) |
| chi-agent-4 `getMatchedPattern full route template wildcards` | #1 `RoutePattern` (context.go:147) | `Get`, `replaceWildcards` (context.go:163, called by `RoutePattern`), `NewPattern` |
| httpx-agent-5 `wrap low-level transport errors ConnectTimeout ReadError mapping context manager` | #3 `_load_httpcore_exceptions` | the exception classes `ReadError` and `ConnectTimeout`, and `request_context` |

- **Mapshift-only finds:** there were 16 questions where Mapshift found the answer and Graft did not.
- **Graft's whole-file results:** in 4 of those 16 (axios-dev-1, axios-name-1, chi-agent-3, chi-agent-6), Graft's top 3 held the right file as a whole-file node instead of the function. This is one reason the two tools are level on "right file in top 3". Graft's caller output can also list a whole file as a caller when the file only imports the function. For axios-callers-1, Graft's first caller is `http.js` (the import on line 3), and its function-level caller there, `dispatchHttpRequest`, is not listed.
- **Questions neither tool answered:** 15, of which 10 are developer questions. For httpx-dev-6, both tools returned the class `LineDecoder` instead of its `decode` method.

### Results: agents

Agents: 12 runs on serde-rs/json (`f51fa15a7015`), model sonnet (`claude-sonnet-5-5`), max 8 turns.

| Arm | Correct | Avg tool calls | Avg turns | Avg input | Avg cache read | Avg cache write | Avg output | Avg total tokens | Avg cost | Total cost |
|---|---|---|---|---|---|---|---|---|---|---|
| mapshift | 6/6 | 1.7 | 2.7 | 5 | 17336 | 3918 | 361 | 21619 | $0.0210 | $0.1261 |
| graft | 6/6 | 2.0 | 3.0 | 6 | 21953 | 5068 | 449 | 27476 | $0.0270 | $0.1618 |

| Task | Arm | Correct | Tool calls (by name) | Turns | Input | Cache read | Cache write | Output | Cost |
|---|---|---|---|---|---|---|---|---|---|
| H1 | graft | yes | 2 (graft_find_all×1, Read×1) | 3 | 6 | 16687 | 9546 | 423 | $0.0441 |
| H1 | mapshift | yes | 2 (map_search×1, Read×1) | 3 | 6 | 14414 | 7867 | 389 | $0.0368 |
| H2 | graft | yes | 2 (Grep×2) | 3 | 6 | 21623 | 3351 | 416 | $0.0197 |
| H2 | mapshift | yes | 1 (map_find×1) | 2 | 4 | 12915 | 2073 | 255 | $0.0121 |
| H3 | graft | yes | 3 (graft_find_code×1, Grep×1, Read×1) | 4 | 8 | 33576 | 5612 | 669 | $0.0325 |
| H3 | mapshift | yes | 2 (map_find×1, Read×1) | 3 | 6 | 21292 | 3799 | 487 | $0.0222 |
| H4 | graft | yes | 2 (graft_find_code×1, Grep×1) | 3 | 6 | 23627 | 3880 | 480 | $0.0227 |
| H4 | mapshift | yes | 1 (map_find×1) | 2 | 4 | 12908 | 2767 | 200 | $0.0144 |
| H5 | graft | yes | 2 (graft_find_code×2) | 3 | 6 | 22396 | 4082 | 393 | $0.0225 |
| H5 | mapshift | yes | 2 (map_find×1, Grep×1) | 3 | 6 | 20977 | 2586 | 379 | $0.0162 |
| H6 | graft | yes | 1 (graft_find_code×1) | 2 | 4 | 13809 | 3937 | 313 | $0.0203 |
| H6 | mapshift | yes | 2 (map_find×1, Read×1) | 3 | 6 | 21508 | 4413 | 455 | $0.0244 |

- **H1:** the Mapshift arm ran first, by itself, as the setup check. It is counted, and no run was discarded. H1 was the first task for both arms, so both paid a cold cache write.
- **H2, Graft arm:** it used no Graft tool, only `Grep` twice. The first `Grep` failed on an unclosed `(` in the pattern.
- **H5, Mapshift arm:** the answer was correct but thin. The agent said it had not opened the body of `ignore_value`.

### Where each tool is better

**Graft is better at:**

- **The four questions above:** two Go methods (`InsertRoute`, `RoutePattern`) and two keyword searches where it ranked the entry point above helpers.
- **Finding the right file for agent-style keyword searches:** 22/24 against 21/24, which is a difference of one question.
- **Same-named callers:** Graft lists them separately, each with its own span and call-site line. For `decode_four_hex_digits`, it shows both `decode_hex_escape` impls. Mapshift prints one line marked `×2`.

**Mapshift is better at:**

- **Exact definitions:** 45/64 in the top 3 against 33/64, and 36 against 27 at rank 1. The largest gaps are on developer questions (13 against 6) and on Rust (12 against 6).
- **Name lookups:** 8/8 against 6/8.
- **Smaller answers:** 398 median tokens against 630, or 499 for Graft without its advice lines. For caller questions it is 58.5 against 148.
- **Faster CLI runs:** 0.44 s against 1.8 s in the scored run, on a busy machine. On the idle re-run of chi it was 0.30 s against 1.16 s. Both figures include process start-up.
- **Faster cold builds:** on 3 of 4 repositories. Graft was faster on httpx.
- **A smaller index:** 40 to 50% of Graft's size, kept outside the repository.
- **Agent cost:** cheaper on 5 of 6 tasks, $0.021 against $0.027 per run.

**Where the two are level:**

- **The right file:** found for 57/64 against 56/64.
- **Agent correctness:** 6/6 each. Sonnet probably knows serde_json, so this small sample does not separate the tools. With one run per task, the cost difference is an observation, not a significant result.
- **What neither answers:** 15 of 64 questions, mostly plain-English developer questions.

## Sealed benchmark (third set, 2026-11-18)

After the held-out run above, Mapshift was tuned on that set's misses, so from here on the held-out set counts as a development set. A third set was written to be blind, sealed by its hash, and run exactly once.

### Method

- **Questions:** 120 on six public repositories, 20 each (8 developer, 7 agent, 3 name, 2 callers), in `sealed/`. None of the repositories was used in any earlier set.

  | Repo | Language | Commit |
  |---|---|---|
  | postcss/postcss | JavaScript | `b6316e5d61e5` |
  | honojs/hono | TypeScript | `676c8f80fcaf` |
  | Textualize/rich | Python | `3a109ccdffe5` |
  | pallets/werkzeug | Python | `0f43c6ebd426` |
  | labstack/echo | Go | `f275a6b1109e` |
  | sharkdp/bat | Rust | `fbd9a416e85f` |

- **Written blind:** the author worked from the repositories' source only. It never ran either tool and never read Mapshift's search code or any earlier question set.
- **Sealed:** the SHA-256 of the question files was committed (`sealed/SEALED.md`, commit `79a5499`) before the engine under test was frozen. The files in `sealed/` hash to the same value: SHA-256 over `repos.json`, each repository's file in `repos.json` order, then `spans.json`.
- **Kept from tuning:** nobody tuning Mapshift read a question or an answer before the run. The repository names were seen once, in a folder listing; nothing was run on those repositories before the scored run.
- **One run:** Mapshift 0.1.3 (commit `9688b8e`) against Graft 0.29.0, with the same harness, commands and matching rule as the held-out run (`node bench/run-heldout.mjs --set <folder>`). There were no hand queries before the run and no edits to questions, answers or the rule after it.

### Results

Tables printed by `node bench/report.mjs --heldout --set sealed-bench` from `results/sealed-bench.json`.

| Tool | hit@1 | hit@3 | Right file in top 3 | Median answer tokens | Median latency |
|---|---|---|---|---|---|
| mapshift | **86/120 (72%)** | **101/120 (84%)** | **114/120 (95%)** | **446.5** | **579 ms** |
| graft | 59/120 (49%) | 68/120 (57%) | 109/120 (91%) | 827 (695.5 without its advice lines) | 1899 ms |

| Kind | Mapshift hit@1 | Graft hit@1 | Mapshift hit@3 | Graft hit@3 |
|---|---|---|---|---|
| developer (48) | **26** | 9 | **35** | 15 |
| agent (42) | **30** | 22 | **36** | 24 |
| name (18) | **18** | 16 | **18** | 17 |
| callers (12) | 12 | 12 | 12 | 12 |

| Repo | Mapshift hit@1 / hit@3 | Graft hit@1 / hit@3 | Build time, Mapshift / Graft (median of 3) | Index size, Mapshift / Graft |
|---|---|---|---|---|
| postcss | **12 / 17** | 11 / 13 | **2.2 s** / 4.1 s | **904 KB** / 2,084 KB |
| hono | **14 / 16** | 9 / 10 | 46.8 s / **10.7 s** | **5,492 KB** / 14,713 KB |
| rich | **14 / 17** | 10 / 13 | **3.0 s** / 4.6 s | **2,956 KB** / 7,755 KB |
| werkzeug | **16 / 18** | 11 / 12 | **1.8 s** / 2.7 s | **3,032 KB** / 8,171 KB |
| echo | **16 / 18** | 11 / 11 | **1.8 s** / 2.6 s | **3,100 KB** / 6,900 KB |
| bat | **14 / 15** | 7 / 9 | 33.5 s / **12.4 s** | **3,496 KB** / 8,656 KB |

### Notes

- **Where Graft did better:** build time on hono and bat. On caller questions the two tools tied, 12 of 12 each.
- **bat's build time had a cause, fixed after the run.** Its `tests/syntax-tests/highlighted/` folder holds files of saved terminal colour codes. One of them (46 KB) took 18 of the 33 seconds. Mapshift now lists such files as not mapped, and gives every file a parsing time budget. After the run, the same build took about 6 to 8 s on the same machine. That number is not part of the scored run, and Graft's 12.4 s was not measured again.
- **hono's build time varied widely:** 46.8, 62.5 and 11.3 s for three identical cold builds, so the machine was not quiet for all of them.
- **Development numbers after tuning (not blind):** on the held-out set, Mapshift 0.1.3 puts the right code first on 37 of 64 questions and in the top 3 on 50, against 36 and 45 for 0.1.1. These are development numbers; the sealed results above, measured after the tuning on questions it never saw, are the ones to rely on.
- **No agent runs** were made on this set; the earlier agent runs above still stand.