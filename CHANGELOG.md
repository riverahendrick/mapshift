# Changelog

## 0.1.7 (2026-11-18)

- 🥇 Mapshift's section now goes at the top of each agent's rules file (`GEMINI.md`, `AGENTS.md` and the like), above any other code tool's, so agents use the map first. `mapshift setup` moves a section an earlier version put at the bottom, and `mapshift uninstall` still gives the file back exactly as it was.
- 🧾 Agents end each code task with one line, `Mapshift: USED — <what for>; <figures>` or `Mapshift: NOT USED — <why>`, so you can see the map at work in any agent's chat. The figures are copied from Mapshift's own answers, never estimated.
- ➕ From the second answer on, an answer's top line also carries the session's totals, counting every answer, so the closing line needs no arithmetic.

## 0.1.6 (2026-11-18)

- 🗺️ Every map answer that spares real reading now says so in one line at the top, so you can see the map working in any agent's log. It counts only the files the answer points at, never the whole project, costs about 25 tokens, and never asks the agent to repeat it.

## 0.1.5 (2026-11-18)

- 🧺 Several questions in one call: `map_find`, `map_trace` and `map_file` take a list. In real agent runs that halved the turns (16 to 8) and cut tool calls from 13 to 5, with every answer still right. Still five tools, so nothing extra loads into each chat.
- 🧪 `mapshift code-mode on|off|status` turns on Claude Code's experimental Code Mode only after checking it can run on the computer, says what changes, and takes it out again with `off` or `mapshift uninstall`.

## 0.1.4 (2026-11-18)

- 🔄 Mapshift keeps itself up to date: every 3 days, when an agent starts it, it checks npm for a new version in the background and installs it, along with the Claude Code add-on. `mapshift auto-update off` turns it off, and `mapshift auto-update status` shows the last check. The request carries nothing about you or your code.
- 🔍 `mapshift setup --check` lists the coding agents on the computer that don't have Mapshift yet; `mapshift update` points them out too, and running `mapshift setup` again adds it only where it is missing.
- 🤝 In Claude Code, `/mapshift setup` adds Mapshift to the other coding agents on the computer, and the add-on says once a day when it finds one without it.
- 🧩 Codex 0.170 and newer get a `$mapshift` skill, since they no longer read custom prompts (older Codex keeps `/prompts:mapshift`).
- 🩹 agy's status line works on Windows: agy passed its quotes to the command prompt in a form it could not read.
- 🧮 The cost self-check in Claude Code no longer reports a gap after an app restart.

## 0.1.3 (2026-11-18)

- 🧭 Smarter search: the map now follows the call graph around the best word matches, so the function that ties them together (the entry point that calls every matched helper) ranks second instead of getting lost below them. The best word match keeps first place.
- 🔀 Routing never sends work to a model whose usage limit is reached. Until the limit resets, the closest usable model takes over: one step weaker with more thinking effort for small work, one step stronger for hard work. This also works when the limited model is the one picked in the app.
- 🗣️ 23 more languages: Bash and Zsh, Zig, OCaml, Haskell, Julia, Clojure, Nix, Solidity, R, Erlang, Gleam, Perl, Elm, GDScript, Common Lisp, Emacs Lisp, Racket, Scheme, Ada, ReScript, GLSL, CUDA and Terraform, plus Astro components.
- 🤝 Setup for 12 more agents: Windsurf, VS Code (Copilot agent mode), GitHub Copilot CLI, opencode, Kiro, Qwen Code, Claude Desktop, Hermes, Factory Droid, Kimi Code, Qoder and Pi. Those not tested on a real install are marked beta.
- ⚡ One odd file can no longer stall a map build: saved terminal output is skipped, and every file gets a time budget. Mapping bat went from 33 s to about 7 s.
- 🔗 Exact callers: two definitions with one name in one file each keep their own callers, Rust methods are named by their type (`SliceRead.decode`), and `fn.call(…)`, `fn.apply(…)` and `fn.bind(…)` count as calls to `fn`.
- 📏 A sealed benchmark: 120 questions on six new repositories, written by an author who never ran either tool, hashed and published before the run. Results are in [bench/README.md](bench/README.md).

## 0.1.2 (2026-11-17)

- 🖥️ `mapshift ui`: a live dashboard in the terminal, with tabs you can click, bars and gauges. Running `mapshift` on its own opens it.
- 🔋 The Claude Code panel shows how far each usage limit was stretched: where it would be without Mapshift, and how much longer it lasts at your pace.
- 🔎 Better search: plain-English and agent-style questions rank the right code higher, and the map now also searches the comments that explain each definition, words inside function bodies, and private class members.
- 🗺️ The map works on its own: switching model routing off no longer stops it, and `/mapshift map on|off` controls the starting points separately.
- 🌐 The web dashboard shows Claude Code limits and today's cost next to Codex, and writes your home folder as `~`.
- 💬 Friendlier terminal answers and clearer errors, for example when `--project` names a folder that does not exist.
- 📏 A benchmark against Graft on a separate set of questions never used for tuning, in [bench/README.md](bench/README.md).

## 0.1.1 (2026-11-17)

- 🎯 Starting points: with every prompt, Claude Code now gets the few places in the code the request is clearly about (location, signature, callers), straight from the map. Nothing is added when the map has no clear answer.
- ⚡ Map tools load up front in Claude Code instead of waiting behind a tool search, so agents use them from the first prompt.
- 📏 Map savings are exact: "saved" always equals "without" minus "with", and an answer that spared nothing counts against it.

## 0.1.0 (2026-11-17)

The first release.

- 🗺️ Code map for 20 languages: builds itself, refreshes before every answer, and lives outside your project.
- 🔧 Five map tools for coding agents: find, trace, file outline, overview and exact search.
- 🔀 Model and effort routing for Anthropic, OpenAI, Google and xAI models, raised by how far a change spreads in the map.
- 📊 Claude Code add-on: automatic routing on every request, and a dashboard with limits, savings and the map.
- ⚙️ One-line setup for Codex, Gemini CLI, Antigravity, Grok, Cursor and Claude Code, with `off`, `on` and `uninstall`.
- 🌐 A local web dashboard and a text report for agents that cannot draw panels.
- ⬆️ `mapshift update` gets the newest version and updates the Claude Code add-on too.
