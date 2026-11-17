import { bold, brand, dim } from './ui.ts'

/**
 * A map answer for a person at a terminal: the same content agents get, with the formatting marks turned
 * into styling. Headings are bold, code is dimmed with its line numbers, and the code fences disappear.
 */
export function pretty(text: string): string {
  let code = false
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      code = !code
      continue
    }
    if (code) out.push(`    ${dim(line)}`)
    else if (line.startsWith('### ')) out.push(`\n${bold(line.slice(4))}`)
    else if (/^(Called by|Calls|Impact): /.test(line)) out.push(`  ${dim(line.slice(0, line.indexOf(':') + 1))}${line.slice(line.indexOf(':') + 1)}`)
    else if (line.startsWith('Map · ')) out.push(brand(line))
    else out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** The routing notes in words a person reads easily ("hard: refactor" → "Hard work (refactor)"). */
export function plainReason(r: string): string {
  const s = r.trim()
  let m: RegExpExecArray | null
  if ((m = /^(\d+) files?$/.exec(s))) return `Touches ${m[1]} file${m[1] === '1' ? '' : 's'}`
  if ((m = /^hard: (.+)$/.exec(s))) return `Hard work (${m[1]})`
  if ((m = /^substantial: (.+)$/.exec(s))) return `A sizeable job (${m[1]})`
  if ((m = /^(\d+) points listed$/.exec(s))) return `Lists ${m[1]} things to do`
  if ((m = /^(.+) area$/.exec(s))) return `A risky area (${m[1]})`
  const words: Record<string, string> = {
    'looks small': 'Looks like a small request',
    'large repo': 'A large project',
    'unknown cause': 'The cause is not known yet',
    'real-world stakes': 'Real-world stakes',
    'you asked for top quality': 'You asked for top quality',
    'several signs of a big job': 'Several signs of a big job',
    'big change in a risky area': 'A big change in a risky area',
  }
  return words[s] ?? s.charAt(0).toUpperCase() + s.slice(1)
}
