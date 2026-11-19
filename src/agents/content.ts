// The words Mapshift adds to each agent: one short instruction block and one `/mapshift` command.
// Kept in one place so every agent says the same thing.
import { MANAGED } from '../setup/pieces.ts'
import { shellLine, type Runtime } from '../setup/env.ts'

const ADDED = `${MANAGED}: added by "mapshift setup"; "mapshift uninstall" removes it`

/** The instruction block, as lines. `helpers` is for agents that can run helpers on their own model. */
export function instructionLines(o: { helpers: boolean }): string[] {
  return [
    '## Mapshift code map: use it first for code questions',
    'Mapshift keeps a map of the project you are working in (MCP server "mapshift"). Its answers give exact file:line ranges and the code itself, for a fraction of the tokens reading files costs.',
    '- Before grepping, listing folders or opening files to find code, call `map_find`. Several things to find? Ask for all of them in one call ("queries").',
    '- For one file\'s functions and classes, call `map_file`. Before changing a function, call `map_trace` with direction "impact".',
    '- Read a file only for lines the answer did not show.',
    ...(o.helpers ? ['- Give routine side work (searching, summaries, running tests) to a helper on a light, cheap model at low effort when you can choose its model.'] : []),
    '- End each code task with one line: `Mapshift: USED — <what for>; <tokens: the "this session" figures from the last 🗺️ line, else its first figures, copied exactly>` or `Mapshift: NOT USED — <why>`. Never estimate or invent a number.',
  ]
}

/** What the `/mapshift` command asks the agent to do: run the report and show it unchanged. */
export function reportSteps(rt: Runtime, agent: string, platform: NodeJS.Platform = process.platform): string {
  const cmd = shellLine(rt, ['report', '--agent', agent])
  return [
    "Show the user Mapshift's report.",
    '',
    `1. Run this command in the terminal${platform === 'win32' ? ' (in PowerShell, put `& ` in front of it)' : ''}:`,
    '',
    `   ${cmd}`,
    '',
    '2. Show its output exactly as printed, inside a code block. Add nothing unless the user asks a question about it.',
  ].join('\n')
}

const DESCRIPTION = "Show Mapshift's code map status, today's map lookups, tokens saved and usage limits"

/** A Codex custom prompt (`/prompts:mapshift`). */
export function codexPrompt(rt: Runtime): string {
  return `---\ndescription: ${DESCRIPTION}\n---\n<!-- ${ADDED} -->\n\n${reportSteps(rt, 'codex')}\n`
}

/** A Gemini CLI custom command (`/mapshift`). A literal multi-line string keeps Windows paths as they are. */
export function geminiCommand(rt: Runtime): string {
  const body = reportSteps(rt, 'gemini')
  if (body.includes("'''")) throw new Error('The Mapshift install path contains three quotes in a row; move it and run setup again.')
  return `# ${ADDED}\ndescription = "${DESCRIPTION}"\nprompt = '''\n${body}\n'''\n`
}

/** A SKILL.md that shows up as `/mapshift`. Cursor has no global rules file, so its skill also carries the map advice. */
export function skill(rt: Runtime, agent: 'agy' | 'grok' | 'cursor' | 'codex'): string {
  const front = [
    '---',
    'name: mapshift',
    `description: ${DESCRIPTION}. Use when the user types ${agent === 'codex' ? '$mapshift' : '/mapshift'} or asks how Mapshift is doing${agent === 'cursor' ? ', and when looking for code: use the mapshift map tools (map_find, map_file, map_trace) before grepping or reading files' : ''}.`,
    ...(agent === 'grok' ? ['user-invocable: true'] : []),
    '---',
  ]
  const extra = agent === 'cursor' ? `\n\n${instructionLines({ helpers: false }).join('\n')}` : ''
  return `${front.join('\n')}\n<!-- ${ADDED} -->\n\n# Mapshift report\n\n${reportSteps(rt, agent)}${extra}\n`
}

/** Kiro loads every Markdown file in ~/.kiro/steering; front matter must come first, so the marker sits below it. */
export function kiroSteering(): string {
  return `---\ninclusion: always\n---\n<!-- ${ADDED} -->\n${instructionLines({ helpers: false }).join('\n')}\n`
}

/** Grok reads every Markdown file in ~/.grok/rules, so the instructions get a file of their own there. */
export function grokRules(): string {
  return `<!-- ${ADDED} -->\n${instructionLines({ helpers: true }).join('\n')}\n`
}
