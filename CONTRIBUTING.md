# Contributing

Thanks for helping make Mapshift better.

## Getting started

```bash
git clone https://github.com/riverahendrick/mapshift
cd mapshift
npm install
npm test          # unit and end-to-end tests
npm run check     # type check
npm run build     # compile to dist/
```

Node.js 22.13 or newer is needed; the tests run TypeScript directly, which needs Node 23.6 or newer.

The Claude Code add-on lives in `plugins/claude-code/` and has its own tests:

```bash
claude plugin test plugins/claude-code
```

The routing logic is shared: edit `src/router/brain.ts`, then run `node scripts/sync-plugin.mjs` to copy it
into the add-on (a test fails when the two drift apart).

## Layout

| Folder | What lives there |
|---|---|
| `src/map/` | The code map: finding files, parsing, storing, resolving calls, answering questions |
| `src/mcp/` | The tool server agents connect to |
| `src/router/` | How a request's level, model and effort are chosen, and the model catalog |
| `src/setup/`, `src/agents/` | Setup for each coding agent, reports and status lines |
| `src/dashboard/` | The local web dashboard |
| `plugins/claude-code/` | The Claude Code add-on: live routing and the dashboard panel |
| `assets/` | Logo and banner (`node scripts/build-assets.mjs` rebuilds the wordmark and banner) |

## Pull requests

- Keep changes focused, with a test that fails before the change and passes after it.
- New languages: add the grammar to `src/map/languages.ts` and `scripts/vendor-grammars.mjs`, and a test in
  `test/extract.test.ts` covering definitions, calls and imports.
- Model prices: change `src/router/catalog.ts` with the date checked and a link to the provider's own pricing page.
- Anything shown to people (dashboard, command output, README) should be short, plain and correctly capitalized.
