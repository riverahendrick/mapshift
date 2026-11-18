# Changelog

## 0.1.2 (2026-11-17)

- 🖥️ `mapshift ui`: a live dashboard in the terminal, with tabs you can click, bars and gauges. Running `mapshift` on its own opens it.
- 🔋 The Claude Code panel shows how far each usage limit was stretched: where it would be without Mapshift, and how much longer it lasts at your pace.
- 🔎 Better search: plain-English and agent-style questions rank the right code higher, and the map now also searches the comments that explain each definition, words inside function bodies, and private class members.
- 🗺️ The map works on its own: switching model routing off no longer stops it, and `/mapshift map on|off` controls the starting points separately.
- 🌐 The web dashboard shows Claude Code limits and today's cost next to Codex, and writes your home folder as `~`.
- 💬 Friendlier terminal answers and clearer errors, for example when `--project` names a folder that does not exist.
- 📏 A benchmark against Graft on questions written before any tuning, in [bench/README.md](bench/README.md).

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
