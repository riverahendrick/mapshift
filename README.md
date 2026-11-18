<p align="center">
  <img src="assets/banner.svg" alt="Mapshift: map your code, shift to the right model" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-14b8a6"></a>
  <img alt="Node 22.13 or newer" src="https://img.shields.io/badge/node-%E2%89%A522.13-0e7490">
  <img alt="Windows, macOS and Linux" src="https://img.shields.io/badge/runs%20on-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-6e7ff3">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-a78bfa">
</p>

**Mapshift** helps coding agents spend fewer tokens without doing worse work. It does two things:

- 🗺️ **Maps your code.** Every function, class and call in your project, kept fresh on its own. Your agent asks the map where things are instead of opening file after file.
- 🔀 **Shifts to the right model.** Each request gets the model and thinking effort it actually needs: a light model for a quick question, the strong one for risky or far-reaching changes.

It runs entirely on your computer. No account, no server, no telemetry. Your code never leaves your machine.

<p align="center">
  <img src="assets/screens/tui-overview.png" alt="The Mapshift terminal dashboard: the model in use, Claude Code limits, the map and today's savings" width="92%">
</p>

---

## Contents

- [Quick start](#quick-start)
- [What you get in each agent](#what-you-get-in-each-agent)
- [Dashboards](#dashboards)
- [How the map works](#how-the-map-works)
- [How routing decides](#how-routing-decides)
- [How the numbers are counted](#how-the-numbers-are-counted)
- [How it compares](#how-it-compares)
- [Commands](#commands)
- [Update, turn off or remove](#update-turn-off-or-remove)
- [Privacy and safety](#privacy-and-safety)
- [FAQ](#faq)

---

## Quick start

You need [Node.js](https://nodejs.org) 22.13 or newer. Then run one line:

```bash
npx mapshift@latest setup
```

Setup finds **every** coding agent on your computer (Codex, Gemini CLI, Antigravity, Grok, Cursor, VS Code, Windsurf, Claude Code and [the rest below](#what-you-get-in-each-agent)), shows exactly which files it will change, backs each one up, and asks before changing anything. Restart your agents and they are ready.

**Claude Code** gets the full experience (live model switching and a dashboard) as an add-on. In a terminal session:

```text
/plugin install mapshift --marketplace riverahendrick/mapshift
```

In the desktop app, click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `riverahendrick/mapshift`, then **Add plugin**.

**Installed a new coding agent later?** Run `mapshift setup` again: it adds Mapshift only where it is missing. `mapshift setup --check` lists the agents that still need it, and `mapshift update` points them out too. In Claude Code, `/mapshift setup` does the same, and the add-on tells you once a day when it finds an agent without Mapshift.

<details>
<summary><b>For AI agents:</b> install Mapshift for the person you work with</summary>

1. Check Node.js is 22.13 or newer: `node --version`.
2. Run `npx mapshift@latest setup --yes`. It installs a lasting copy and wires up every supported agent it finds.
3. If you are Claude Code, also run `claude plugin marketplace add riverahendrick/mapshift` and `claude plugin install mapshift@mapshift`.
4. Run `mapshift setup --check` and confirm it says every coding agent found has Mapshift.
5. Tell the person to restart their agents, and that `mapshift uninstall` removes everything again.

</details>

---

## What you get in each agent

| Agent | 🗺️ Map tools | 🔀 Model routing | 📊 Dashboard |
|---|---|---|---|
| **Claude Code** | ✅ | ✅ Automatic, every request | ✅ Panel beside the chat, plus a status band |
| **Codex** (CLI and IDE) | ✅ | 💡 Advice | `$mapshift` in the chat (with your 5-hour and weekly limits; older Codex: `/prompts:mapshift`), and the terminal and web dashboards |
| **Gemini CLI** | ✅ | 💡 Advice | `/mapshift` in the chat, and the web dashboard |
| **Antigravity** (`agy`) | ✅ | 💡 Advice | ✅ Status line, `/mapshift`, and the web dashboard |
| **Grok CLI** | ✅ | 💡 Advice | ✅ Status line, `/mapshift`, and the web dashboard |
| **Cursor** (beta) | ✅ | 💡 Advice | Web dashboard |
| **Windsurf**, **VS Code** (Copilot agent mode), **GitHub Copilot CLI**, **Claude Desktop**, **Kimi Code** | ✅ | 💡 Advice | Web dashboard |
| **opencode**, **Kiro**, **Qwen Code**, **Hermes**, **Factory Droid**, **Qoder**, **Pi** (all beta) | ✅ | 💡 Advice | Web dashboard |

"Beta" means setup follows the agent's documentation but has not yet been tried on a real install. Setup only ever changes your personal settings, backs each file up first, and leaves alone any file it cannot edit safely (a config with comments, or an older layout), saying so.

Claude Code lets an add-on change the model on every request, so routing there is fully automatic. The other agents do not allow that today. There Mapshift advises instead: its instructions ask the agent to hand routine side work to lighter helpers where the agent has them, and `/mapshift` shows which model and effort the last request needed. If an agent adds a way to switch models, Mapshift will use it.

---

## Dashboards

The same numbers in three places. All of them read local files only.

- **In Claude Code:** `/mapshift` opens a panel beside the chat, with the mode, the model in use, gauges for every usage limit, today's savings, and how much further each limit goes because of Mapshift.
- **In any terminal:** `mapshift ui` (or just `mapshift`) opens a live dashboard. Switch tabs with the arrow keys or a click; `r` refreshes, `q` quits.
- **In your browser:** `mapshift dash` opens a private page on `127.0.0.1` that only this computer can reach. It follows your light or dark theme.

<p align="center">
  <img src="assets/screens/tui-activity.png" alt="The terminal dashboard's activity tab: every map lookup and routing choice, newest first" width="49%">
  <img src="assets/screens/tui-map.png" alt="The terminal dashboard's map tab: lookups by tool, languages and agents" width="49%">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screens/web-dashboard-dark.png">
    <img src="assets/screens/web-dashboard-light.png" alt="The web dashboard: map status, Claude Code limit gauges, tokens saved and recent activity" width="92%">
  </picture>
</p>

<sub>Screenshots from a short demo on the public <a href="https://github.com/spf13/cobra">cobra</a> repository: three questions on a light model and two on a standard one, all real.</sub>

---

## How the map works

- **Builds itself.** The first time an agent uses a map tool in a project, the map builds in the background. There is nothing to run and nothing to remember.
- **Stays fresh.** Before every answer it checks which files changed (size and time, then content) and re-reads only those.
- **Understands 41 languages**, plus the scripts inside Vue, Svelte and Astro files:
  - Full call and import tracking: TypeScript, JavaScript, Python, Go, Java, Kotlin and C#.
  - Definitions and calls: Rust, PHP, Dart, Swift, Ruby, Scala, Lua, Elixir, PowerShell, C, C++, CUDA, Bash and Zsh, Zig, OCaml, Haskell, Julia, Clojure, Nix, Solidity, R, Erlang, Gleam, Perl, Elm, GDScript, Common Lisp, Emacs Lisp, Racket, Scheme, Ada, ReScript, GLSL and Terraform.
- **Follows the call graph.** A question in words first finds the definitions that match it, then walks the call links around them. The function that ties the matches together (the entry point calling every matched helper) moves up to second place; the best word match keeps first.
- **Is honest about what it knows.** Every call link is marked: confirmed through an import, a fair guess, or ambiguous. Files it skips (very large, generated, unreadable) are listed by name, never silently missing.
- **Lives outside your project.** The map is kept in `~/.mapshift/`, so nothing is added to your repository, and all worktrees of a repository share one map.
- **Gives starting points (Claude Code).** With each prompt, the agent gets the few places the request is clearly about: location, signature and callers. When the map has no clear answer, nothing is added.
- **Works on its own.** Turning model switching off leaves the map running. `/mapshift map off` turns the map's starting points off too, and `/mapshift map on` brings them back.

Agents get five tools:

| Tool | What it answers |
|---|---|
| `map_find` | "Where is this done?", by plain words or by name, with the code, its callers and what it calls |
| `map_trace` | Who calls a function, what it calls, or everything a change to it can reach |
| `map_file` | A file's whole outline in a few lines |
| `map_overview` | The project at a glance: languages, main folders, entry points, most used code |
| `map_search` | Every line matching some text, grouped by the function it sits in |

<p align="center">
  <img src="assets/screens/cli-find.png" alt="mapshift map find answering a plain-English question with the code, its callers and what it calls" width="92%">
</p>

---

## How routing decides

1. **The wording.** Is it a quick question, an everyday change, complex work, or risky work (security, money, data, production)? Pasted logs and code are set aside so they do not inflate the request.
2. **The map.** For a change, the map measures how far it spreads: how many functions and files call the code being changed. A change that reaches 60 functions across 13 files is harder than its wording suggests, so it moves up a level. A question stays a question, however widely used the code it asks about.
3. **Quality comes first:**
   - Mapshift never moves down on risky work or far-reaching changes.
   - It moves up after failing tests or repeated errors.
   - Your own choice always wins.
4. **Usage limits.** A model whose usage limit is reached is never asked again until the limit resets, even when it is the model picked in the app. Until then the closest usable model takes over: one step weaker with more thinking effort for small work, one step stronger for hard work. A toast says which model stands in and for how long. When the whole account is at its limit, nothing is rerouted, since no model can help.

There are five modes: ⚡ **Auto** (the default), 💎 **Quality**, 🪙 **Saver**, 🎛️ **Manual** and ⏸️ **Off**. Each project remembers its own mode. **Off** stops model switching only; the map keeps saving tokens.

---

## How the numbers are counted

Every number Mapshift shows comes from its local logs, by these rules:

- **Map tokens saved:**
  - A map answer costs its own size.
  - It is credited with the full size of the files it pointed to, but only those the agent did **not** open anyway in that chat.
  - If the agent read them all, the answer saved nothing.
- **Without Mapshift** means the same requests run on the model you picked yourself, plus the files the map saved the agent from reading.
- **With Mapshift** is what was actually used.
- **Model switching** can cost more than it saves when hard work needs a stronger model. Mapshift shows that as it is ("$0.40 more, spent on stronger models for harder work").
- **Limits stretched (Claude Code):** each limit's use is divided by today's with ÷ without ratio, giving "you'd be at 61% without Mapshift, not 48%". At your pace since the limit reset, the panel also shows how much longer it lasts before it runs out. Limits are counted in usage, which follows cost closely but not exactly, so this is an estimate too.
- **Estimates:** sizes in tokens are estimated at four characters per token, and dollar values use each provider's list prices. Your plan may cost less, so these are labelled estimates. On a subscription, the limit gauges show what really matters.

`/mapshift trace` in Claude Code shows the inputs behind each decision.

---

## How it compares

Two other open-source tools give coding agents a code map: [Trail-code](https://github.com/trailhq/Trail-Code) (formerly Graft) and [CodeGraph](https://github.com/colbymchenry/codegraph). Both are good projects, MIT like Mapshift. The table below was checked against their source code (Trail-code 0.28.0, CodeGraph 1.6.2) in November 2026.

| | **Mapshift** | **Trail-code** (Graft) | **CodeGraph** |
|---|---|---|---|
| First build | ✅ Automatic, on the first question | `trail init` / `graft build` | `codegraph init` |
| Stays fresh | ✅ Checked before every answer | ✅ Checked before every answer | ✅ File watcher |
| Where the index lives | `~/.mapshift/`, outside the repo | `graft/` and `.trail/` in the repo | `.codegraph/` in the repo |
| Telemetry | ✅ None | On by default (opt out) | On by default (opt out) |
| Background process | ✅ None | ✅ None | A daemon per project |
| Picks the model per request | ✅ Claude Code: automatic, and never a model at its usage limit. Others: advice | ❌ | ❌ |
| Dashboards | ✅ Claude Code panel, terminal, web | Status line, `trail status`, graph viewer | Graph viewer (hidden behind a setting) |
| Token savings shown | ✅ Whole-file sizes, credited only if the agent did not open those files anyway (Claude Code); an upper bound elsewhere | Whole-file sizes | Not tracked (a benchmark in the README) |
| Usage limits and cost | ✅ 5-hour and weekly limits, cost with and without | $ saved in the status line | ❌ |
| Map tools for agents | 5 | 6 | 8 (1 shown by default) |
| Languages | ✅ 41, plus Vue, Svelte and Astro (42 grammars) | 28, plus Vue, Svelte and Astro | 32 grammars, 41 listed |
| Agents it sets up | 18 | 13 | 20 |
| **Measured:** right code first, 120 sealed questions | **86 (72%)** | 59 (49%) | not measured |
| **Measured:** right code in the top 3 | **101 (84%)** | 68 (57%) | not measured |
| **Measured:** plain-English questions, right code in the top 3 | **35 of 48** | 15 of 48 | not measured |
| **Measured:** median answer size | **447 tokens** | 827 tokens | not measured |
| **Measured:** median time per command-line lookup, start-up included | **0.58 s** | 1.9 s | not measured |
| **Measured:** index size, six projects | **0.9 to 5.5 MB** | 2.1 to 14.7 MB | not measured |
| **Measured:** cold build time | Faster on 4 of 6 projects | Faster on 2 of 6 (hono, bat) | not measured |

The measured rows come from a sealed benchmark against Graft 0.29.0: 120 questions on six public projects (postcss, hono, rich, werkzeug, echo and bat, in JavaScript, TypeScript, Python, Go and Rust). The questions were written from the projects' source by an author who never ran either tool, and their hash was published before the Mapshift version under test was frozen. Nobody tuning Mapshift saw a question before the single scored run. They mix how a developer asks, how an agent searches, exact names, and "who calls this"; on caller questions both tools found all 12. Graft built two of the six maps faster: bat's slow build came from one folder of saved terminal output, which Mapshift now skips (after the run, bat built in about 6 to 8 s against Graft's 12.4 s). Every question, answer, loss and caveat is in [bench/README.md](bench/README.md), with the commands to run it yourself; the questions themselves are in [bench/sealed](bench/sealed).

**Where they are ahead:** CodeGraph sets up more agents (20 against 18), detects web framework routes, and finds dead code and import cycles. Trail-code shares team learnings through the repository, draws the code graph, posts a change's blast radius on pull requests, and can add exact call links from language servers. If you need one of those, use them; Mapshift's tools work alongside either.

---

## Commands

| Command | What it does |
|---|---|
| `mapshift setup` | Add Mapshift to every coding agent it finds (`--dry-run` to preview, `--yes` to skip the question, `--check` to list the agents that still need it) |
| `mapshift report` | Map, savings and limits as text |
| `mapshift ui` | The dashboard right in the terminal (also opens when you run `mapshift` alone) |
| `mapshift dash` | Open the dashboard in your browser |
| `mapshift off` / `on` | Pause Mapshift in every agent, or bring it back |
| `mapshift update` | Get the newest version now, and update the Claude Code add-on too (`--check` to only look) |
| `mapshift auto-update on` / `off` | Update by itself every 3 days (on by default; `status` shows the last check) |
| `mapshift uninstall` | Take out everything setup added |
| `mapshift map build` | Build or update the map of this project |
| `mapshift map find <words>` | Find code by plain words or by name |
| `mapshift map trace <name>` | Who calls it (`--out`: what it calls, `--impact`: what a change reaches) |
| `mapshift map file <path>` | A file's outline: every definition and its lines |
| `mapshift map overview` | The whole project at a glance |
| `mapshift map search <text>` | Every matching line (`--regex`, `--case`, `--path <folder>`) |
| `mapshift route "<request>"` | Which model and effort a request needs |

In Claude Code, `/mapshift` opens the dashboard, `/mapshift auto`, `quality`, `saver`, `manual` or `off` switch modes, and `/mapshift map on` or `map off` turns the map's starting points on or off. `/mapshift setup` adds Mapshift to the other coding agents on the computer.

---

## Update, turn off or remove

**Mapshift keeps itself up to date.** Every 3 days, when one of your agents starts it, it checks npm for a new version in the background and installs it, along with the Claude Code add-on. Nothing waits on it, and new features simply arrive. The next chat you open uses them. `mapshift auto-update status` shows the last check, and `~/.mapshift/logs/update.log` keeps every result.

```bash
mapshift update               # get the newest version right now
mapshift auto-update off      # stop updating by itself (on brings it back)
mapshift off                  # pause it everywhere
mapshift on                   # bring it back
mapshift uninstall            # remove everything setup added, exactly
```

Setup backs up every file before changing it and only writes between its own clearly marked lines, so your own settings stay as they were.

---

## Privacy and safety

- **Fully local.** No telemetry, no accounts. The map and its logs stay in `~/.mapshift/`. The only request Mapshift makes is asking npm for its newest version: every 3 days in the background (see [Updates](#update-turn-off-or-remove)), or when you run `mapshift update`. That request carries nothing about you or your code.
- **Never touches credentials.** Mapshift never reads your login files and never routes your traffic through anything.
- **Safe with projects you do not trust.** Mapshift never starts a program from inside a project folder, it never follows links that point outside the project, and a project's own git settings cannot make it run anything.
- **Your settings only.** Setup changes personal settings only, never files shared with your team.

---

## FAQ

**Does it make my agent worse?**
Routing is built quality first: it only goes lighter where it is safe, never on risky or far-reaching work, and moves up after failures. In Claude Code you can always press **Think harder** or pick a mode.

**Does my code leave my computer?**
No. Mapshift reads your files locally and sends nothing anywhere.

**Which plans does it work with?**
Subscriptions and API keys alike. On a subscription the dashboard shows your 5-hour and weekly limits; with an API key it shows dollars.

**Windows, macOS, Linux?**
All three. It needs nothing but Node.js: no compilers, no native modules.

---

## License

[MIT](LICENSE). The bundled language grammars keep their own open-source licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
