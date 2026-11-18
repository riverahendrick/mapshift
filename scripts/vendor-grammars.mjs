// Copies only the language parsers Mapshift reads (and their tag queries) into dist/grammars, so the
// published package carries only these grammars instead of the parser collection's ~100.
// Run by `npm run build`.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const source = join(dirname(require.resolve('tree-sitter-wasm/manifest.json')), 'out')
const target = fileURLToPath(new URL('../dist/grammars/', import.meta.url))

// keep in step with src/map/languages.ts (grammar names, plus the extra tag sets they borrow)
const GRAMMARS = [
  'typescript', 'tsx', 'javascript', 'python', 'go', 'java', 'kotlin', 'c_sharp', 'rust', 'php', 'dart', 'swift', 'ruby', 'scala', 'lua', 'elixir', 'powershell', 'c', 'cpp',
  'bash', 'zig', 'ocaml', 'haskell', 'julia', 'clojure', 'nix', 'solidity', 'r', 'erlang', 'gleam', 'perl', 'elm', 'gdscript', 'commonlisp', 'elisp', 'racket', 'scheme', 'ada', 'rescript', 'glsl', 'cuda', 'terraform',
]

let bytes = 0
for (const g of GRAMMARS) {
  const from = join(source, g)
  const to = join(target, g)
  mkdirSync(to, { recursive: true })
  for (const file of [`tree-sitter-${g}.wasm`, 'tags.scm']) {
    if (!existsSync(join(from, file))) continue
    copyFileSync(join(from, file), join(to, file))
    bytes += readFileSync(join(to, file)).length
  }
}
const pkgDir = dirname(require.resolve('tree-sitter-wasm/manifest.json'))
writeFileSync(
  join(target, 'NOTICE.md'),
  `# Language grammars\n\nThe WebAssembly grammars and tag queries in this folder come from the tree-sitter-wasm package\n(${JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version}), which builds them from each language's tree-sitter grammar.\nEach grammar keeps its own open-source license; the collection is MIT licensed:\n\n${readFileSync(join(pkgDir, 'LICENSE'), 'utf8')}`,
)
console.log(`Bundled ${GRAMMARS.length} grammars (${(bytes / 1048576).toFixed(1)} MB) into dist/grammars`)
