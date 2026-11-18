# Changelog

## 0.1.4 (2026-11-18)

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
