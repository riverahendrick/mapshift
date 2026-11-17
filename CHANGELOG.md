# Changelog

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
