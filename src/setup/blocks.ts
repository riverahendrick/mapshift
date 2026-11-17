// Marker-fenced blocks inside someone else's text file (Markdown or TOML). Everything outside the markers
// is kept byte for byte, so adding a block and removing it again gives back the exact original file.

export type Fence = { start: string; end: string }

export const mdFence = (id = 'mapshift'): Fence => ({ start: `<!-- ${id}:start -->`, end: `<!-- ${id}:end -->` })
export const tomlFence = (id: string): Fence => ({ start: `# >>> mapshift: ${id} >>>`, end: `# <<< mapshift: ${id} <<<` })

/** The line ending a file already uses, so added lines match it. */
export const eolOf = (text: string | null): string => (text && /\r\n/.test(text) ? '\r\n' : '\n')

type Found = { from: number; to: number; inner: string }

/** The block's position: from the start marker to just after the end marker's line break. */
export function findBlock(text: string, f: Fence): Found | null {
  const from = lineStart(text, text.indexOf(f.start))
  if (from < 0) return null
  const endAt = text.indexOf(f.end, from)
  if (endAt < 0) return null
  let to = endAt + f.end.length
  if (text.startsWith('\r\n', to)) to += 2
  else if (text[to] === '\n') to += 1
  const innerFrom = text.indexOf('\n', from) + 1
  return { from, to, inner: text.slice(innerFrom, lineStart(text, endAt)) }
}

function lineStart(text: string, i: number): number {
  if (i < 0) return -1
  // a marker counts only at the start of a line (after optional spaces)
  const nl = text.lastIndexOf('\n', i - 1) + 1
  return /^[ \t]*$/.test(text.slice(nl, i)) ? nl : -1
}

/** The text outside a block, which is what conflict checks look at. */
export function outside(text: string, f: Fence): string {
  const b = findBlock(text, f)
  return b ? text.slice(0, b.from) + text.slice(b.to) : text
}

const render = (f: Fence, lines: string[], eol: string): string => [f.start, ...lines, f.end].join(eol) + eol

/**
 * Adds the block at the end of the file, or replaces the one already there. `keep` returns lines inside an
 * existing block that belong to someone else (a program may have written below our lines), which are moved
 * to just after the block instead of being lost. `sep` is what was put before the block to separate it.
 */
export function upsertBlock(
  text: string | null,
  f: Fence,
  lines: string[],
  keep: (inner: string[]) => string[] = () => [],
): { text: string; sep: string; existed: boolean } {
  const eol = eolOf(text)
  const cur = text ?? ''
  const b = findBlock(cur, f)
  if (b) {
    const foreign = keep(b.inner.split(/\r?\n/).filter((_, i, a) => i < a.length - 1 || a[i] !== ''))
    const tail = foreign.length ? foreign.join(eol) + eol : ''
    return { text: cur.slice(0, b.from) + render(f, lines, eol) + tail + cur.slice(b.to), sep: '', existed: true }
  }
  const sep = cur === '' ? '' : cur.endsWith('\n') ? eol : eol + eol
  return { text: cur + sep + render(f, lines, eol), sep, existed: false }
}

/** Removes the block and the separator added with it. Lines that are not ours are kept in its place. */
export function removeBlock(text: string, f: Fence, sep = '', keep: (inner: string[]) => string[] = () => []): string {
  const b = findBlock(text, f)
  if (!b) return text
  const eol = eolOf(text)
  const foreign = keep(b.inner.split(/\r?\n/).filter((_, i, a) => i < a.length - 1 || a[i] !== ''))
  const tail = foreign.length ? foreign.join(eol) + eol : ''
  let from = b.from
  if (!tail && sep && b.to === text.length && text.slice(from - sep.length, from) === sep) from -= sep.length
  return text.slice(0, from) + tail + text.slice(b.to)
}

// ---- TOML specifics

const headerRe = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/
const normKey = (k: string) => k.replace(/["'\s]/g, '').toLowerCase()

/**
 * Inside a TOML block, everything up to the first table that is not one of ours belongs to us; from a
 * foreign table on, the lines belong to whoever wrote them (some agents append new tables at the very end).
 */
export function foreignTomlLines(own: string[]): (inner: string[]) => string[] {
  const mine = new Set(own.map(normKey))
  return inner => {
    const at = inner.findIndex(line => {
      const m = headerRe.exec(line)
      return !!m && !mine.has(normKey(m[1]!))
    })
    return at < 0 ? [] : inner.slice(at)
  }
}

/** TOML basic string: always valid, whatever the path holds (backslashes, quotes, spaces). */
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`
}

export const tomlArray = (xs: string[]): string => `[${xs.map(tomlString).join(', ')}]`
