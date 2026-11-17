/**
 * The languages the map understands.
 *
 * Deep languages get full call and import resolution. Broad languages get their definitions and
 * calls, matched by name. Vue and Svelte files are read through their script blocks.
 */
export type LangId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'rust'
  | 'php'
  | 'dart'
  | 'swift'
  | 'ruby'
  | 'scala'
  | 'lua'
  | 'elixir'
  | 'powershell'
  | 'c'
  | 'cpp'
  | 'vue'
  | 'svelte'

export type LangInfo = {
  label: string
  exts: string[]
  /** Folder name of the grammar inside the `tree-sitter-wasm` package. */
  grammar: string
  tier: 'deep' | 'broad'
  /** Other grammars' tag queries to add (TypeScript builds on the JavaScript tags). */
  extraTags?: string[]
  /** Parse the script blocks of this file with another language. */
  scriptsAs?: LangId
}

export const LANGS: Record<LangId, LangInfo> = {
  typescript: { label: 'TypeScript', exts: ['.ts', '.mts', '.cts'], grammar: 'typescript', tier: 'deep', extraTags: ['javascript'] },
  tsx: { label: 'TypeScript', exts: ['.tsx'], grammar: 'tsx', tier: 'deep', extraTags: ['javascript'] },
  javascript: { label: 'JavaScript', exts: ['.js', '.jsx', '.mjs', '.cjs'], grammar: 'javascript', tier: 'deep' },
  python: { label: 'Python', exts: ['.py', '.pyi'], grammar: 'python', tier: 'deep' },
  go: { label: 'Go', exts: ['.go'], grammar: 'go', tier: 'deep' },
  java: { label: 'Java', exts: ['.java'], grammar: 'java', tier: 'deep' },
  kotlin: { label: 'Kotlin', exts: ['.kt', '.kts'], grammar: 'kotlin', tier: 'deep' },
  csharp: { label: 'C#', exts: ['.cs'], grammar: 'c_sharp', tier: 'deep' },
  rust: { label: 'Rust', exts: ['.rs'], grammar: 'rust', tier: 'broad' },
  php: { label: 'PHP', exts: ['.php'], grammar: 'php', tier: 'broad' },
  dart: { label: 'Dart', exts: ['.dart'], grammar: 'dart', tier: 'broad' },
  swift: { label: 'Swift', exts: ['.swift'], grammar: 'swift', tier: 'broad' },
  ruby: { label: 'Ruby', exts: ['.rb'], grammar: 'ruby', tier: 'broad' },
  scala: { label: 'Scala', exts: ['.scala', '.sc'], grammar: 'scala', tier: 'broad' },
  lua: { label: 'Lua', exts: ['.lua'], grammar: 'lua', tier: 'broad' },
  elixir: { label: 'Elixir', exts: ['.ex', '.exs'], grammar: 'elixir', tier: 'broad' },
  powershell: { label: 'PowerShell', exts: ['.ps1', '.psm1'], grammar: 'powershell', tier: 'broad' },
  c: { label: 'C', exts: ['.c', '.h'], grammar: 'c', tier: 'broad' },
  cpp: { label: 'C++', exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'], grammar: 'cpp', tier: 'broad' },
  vue: { label: 'Vue', exts: ['.vue'], grammar: 'typescript', tier: 'deep', scriptsAs: 'typescript' },
  svelte: { label: 'Svelte', exts: ['.svelte'], grammar: 'typescript', tier: 'deep', scriptsAs: 'typescript' },
}

const BY_EXT = new Map<string, LangId>()
for (const [id, info] of Object.entries(LANGS) as [LangId, LangInfo][]) for (const ext of info.exts) BY_EXT.set(ext, id)

/** The language of a file, from its extension, or null when the map does not read it. */
export function langOf(path: string): LangId | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.d.ts')) return 'typescript'
  const dot = lower.lastIndexOf('.')
  if (dot < 0 || dot < lower.lastIndexOf('/')) return null
  return BY_EXT.get(lower.slice(dot)) ?? null
}
