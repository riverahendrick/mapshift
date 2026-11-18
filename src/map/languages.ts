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
  | 'bash'
  | 'zig'
  | 'ocaml'
  | 'haskell'
  | 'julia'
  | 'clojure'
  | 'nix'
  | 'solidity'
  | 'r'
  | 'erlang'
  | 'gleam'
  | 'perl'
  | 'elm'
  | 'gdscript'
  | 'commonlisp'
  | 'elisp'
  | 'racket'
  | 'scheme'
  | 'ada'
  | 'rescript'
  | 'glsl'
  | 'cuda'
  | 'terraform'
  | 'astro'

export type LangInfo = {
  label: string
  exts: string[]
  /** Folder name of the grammar inside the `tree-sitter-wasm` package. */
  grammar: string
  /** Use only the queries in `queries.ts`, not the tag file the grammar package ships (which is partial or noisy for some grammars). */
  ownTags?: boolean
  /** A function is written as one definition per pattern clause (Haskell, Erlang): adjacent clauses of one name are one definition. */
  clauses?: boolean
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
  bash: { label: 'Shell', exts: ['.sh', '.bash', '.zsh'], grammar: 'bash', ownTags: true, tier: 'broad' },
  zig: { label: 'Zig', exts: ['.zig'], grammar: 'zig', ownTags: true, tier: 'broad' },
  ocaml: { label: 'OCaml', exts: ['.ml'], grammar: 'ocaml', ownTags: true, tier: 'broad' },
  haskell: { label: 'Haskell', exts: ['.hs'], grammar: 'haskell', ownTags: true, clauses: true, tier: 'broad' },
  julia: { label: 'Julia', exts: ['.jl'], grammar: 'julia', ownTags: true, tier: 'broad' },
  clojure: { label: 'Clojure', exts: ['.clj', '.cljs', '.cljc'], grammar: 'clojure', ownTags: true, tier: 'broad' },
  nix: { label: 'Nix', exts: ['.nix'], grammar: 'nix', ownTags: true, tier: 'broad' },
  solidity: { label: 'Solidity', exts: ['.sol'], grammar: 'solidity', ownTags: true, tier: 'broad' },
  r: { label: 'R', exts: ['.r'], grammar: 'r', ownTags: true, tier: 'broad' },
  erlang: { label: 'Erlang', exts: ['.erl', '.hrl'], grammar: 'erlang', ownTags: true, clauses: true, tier: 'broad' },
  gleam: { label: 'Gleam', exts: ['.gleam'], grammar: 'gleam', ownTags: true, tier: 'broad' },
  perl: { label: 'Perl', exts: ['.pl', '.pm'], grammar: 'perl', ownTags: true, tier: 'broad' },
  elm: { label: 'Elm', exts: ['.elm'], grammar: 'elm', ownTags: true, tier: 'broad' },
  gdscript: { label: 'GDScript', exts: ['.gd'], grammar: 'gdscript', ownTags: true, tier: 'broad' },
  commonlisp: { label: 'Common Lisp', exts: ['.lisp', '.lsp', '.asd'], grammar: 'commonlisp', ownTags: true, tier: 'broad' },
  elisp: { label: 'Emacs Lisp', exts: ['.el'], grammar: 'elisp', ownTags: true, tier: 'broad' },
  racket: { label: 'Racket', exts: ['.rkt'], grammar: 'racket', ownTags: true, tier: 'broad' },
  scheme: { label: 'Scheme', exts: ['.scm', '.ss', '.sld'], grammar: 'scheme', ownTags: true, tier: 'broad' },
  ada: { label: 'Ada', exts: ['.adb', '.ads', '.ada'], grammar: 'ada', ownTags: true, tier: 'broad' },
  rescript: { label: 'ReScript', exts: ['.res', '.resi'], grammar: 'rescript', ownTags: true, tier: 'broad' },
  glsl: { label: 'GLSL', exts: ['.glsl', '.vert', '.frag', '.comp'], grammar: 'glsl', ownTags: true, tier: 'broad' },
  cuda: { label: 'CUDA', exts: ['.cu', '.cuh'], grammar: 'cuda', ownTags: true, tier: 'broad' },
  terraform: { label: 'Terraform', exts: ['.tf', '.tfvars', '.hcl'], grammar: 'terraform', ownTags: true, tier: 'broad' },
  astro: { label: 'Astro', exts: ['.astro'], grammar: 'typescript', tier: 'deep', scriptsAs: 'typescript' },
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
