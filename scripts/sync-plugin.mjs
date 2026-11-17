#!/usr/bin/env node
// Copies the routing brain into the Claude Code plugin, so both run the same rules.
// The plugin keeps its types in plugins/claude-code/types, so only the type import line changes.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE = join(root, 'src', 'router', 'brain.ts')
export const TARGET = join(root, 'plugins', 'claude-code', 'hooks', 'brain.ts')

/** The plugin's copy of the brain: the same text, with the type import pointed at the plugin's own types. */
export function pluginBrain(source) {
  const from = "from './types.ts'"
  if (!source.includes(from)) throw new Error(`brain.ts no longer imports ${from}; update scripts/sync-plugin.mjs`)
  return source.replace(from, "from '../types'")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const next = pluginBrain(readFileSync(SOURCE, 'utf8'))
  let prev = ''
  try {
    prev = readFileSync(TARGET, 'utf8')
  } catch {
    /* first copy */
  }
  if (prev === next) console.log('Plugin brain already up to date.')
  else {
    writeFileSync(TARGET, next)
    console.log('Plugin brain updated: plugins/claude-code/hooks/brain.ts')
  }
}
