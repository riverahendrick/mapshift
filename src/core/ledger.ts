import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { logsDir } from './paths.ts'

/** A rough token count: about four characters per token for code and English. Labelled as an estimate wherever shown. */
export const tokensOf = (chars: number): number => Math.ceil(chars / 4)

export type MapEvent = {
  kind: 'map'
  ts: number
  agent: string
  repo: string
  tool: string
  /** Tokens the answer cost the agent. */
  answerTokens: number
  /** The files the answer pointed at, with their full size in tokens. Savings are credited later, only if the agent did not then read them anyway. */
  files: { path: string; tokens: number }[]
}

export type LedgerEvent = MapEvent

const day = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

/** Appends one event to today's log. Logging never interrupts the work. */
export function record(event: LedgerEvent): void {
  try {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${day(event.ts)}.jsonl`), `${JSON.stringify(event)}\n`)
  } catch {
    /* a full disk or a locked file must never break an answer */
  }
}
