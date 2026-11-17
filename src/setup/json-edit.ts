// Surgical edits of JSON settings files. JSON has no comments, so there is no room for markers: instead
// one member is inserted or removed as text, and every other byte of the file stays exactly as it was.
// Files that are not strict JSON (comments, trailing commas) are left alone; the caller says so.

type Member = { key: string; keyStart: number; valueStart: number; valueEnd: number }

const WS = new Set([' ', '\t', '\n', '\r'])

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.has(s[i]!)) i++
  return i
}

function scanString(s: string, i: number): number {
  // s[i] is the opening quote
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++
    else if (s[j] === '"') return j + 1
  }
  throw new Error('unterminated string')
}

function scanValue(s: string, i: number): number {
  const c = s[i]
  if (c === '"') return scanString(s, i)
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']'
    let j = skipWs(s, i + 1)
    if (s[j] === close) return j + 1
    for (;;) {
      if (c === '{') {
        j = scanString(s, j)
        j = skipWs(s, j) + 1 // the colon
        j = skipWs(s, j)
      }
      j = skipWs(s, scanValue(s, j))
      if (s[j] === ',') j = skipWs(s, j + 1)
      else if (s[j] === close) return j + 1
      else throw new Error('bad JSON')
    }
  }
  let j = i
  while (j < s.length && /[^\s,\]}]/.test(s[j]!)) j++
  return j
}

/** The members of the object that starts at `open` (its `{`), and where it closes. */
function members(s: string, open: number): { list: Member[]; close: number } {
  const list: Member[] = []
  let j = skipWs(s, open + 1)
  if (s[j] === '}') return { list, close: j }
  for (;;) {
    const keyStart = j
    const keyEnd = scanString(s, j)
    const key = JSON.parse(s.slice(keyStart, keyEnd)) as string
    j = skipWs(s, skipWs(s, keyEnd) + 1)
    const valueStart = j
    const valueEnd = scanValue(s, j)
    list.push({ key, keyStart, valueStart, valueEnd })
    j = skipWs(s, valueEnd)
    if (s[j] === ',') j = skipWs(s, j + 1)
    else return { list, close: j }
  }
}

/** Where the object at a key path starts (its `{`), or null when a step is missing or not an object. */
function objectAt(s: string, path: string[]): number | null {
  let open = skipWs(s, s.charCodeAt(0) === 0xfeff ? 1 : 0)
  if (s[open] !== '{') return null
  for (const k of path) {
    const m = members(s, open).list.find(x => x.key === k)
    if (!m || s[m.valueStart] !== '{') return null
    open = m.valueStart
  }
  return open
}

export function isStrictJson(text: string): boolean {
  try {
    const v = JSON.parse(text.replace(/^﻿/, '')) as unknown
    return !!v && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

/** The value at a key path, parsed, or undefined. */
export function getAt(text: string, path: string[]): unknown {
  let v: unknown = JSON.parse(text.replace(/^﻿/, ''))
  for (const k of path) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    v = (v as Record<string, unknown>)[k]
  }
  return v
}

const lineIndent = (s: string, i: number): string => {
  const nl = s.lastIndexOf('\n', i - 1) + 1
  return /^[ \t]*/.exec(s.slice(nl, i))![0]
}

/** The indent step the file uses (two spaces when it cannot tell). */
function indentUnit(s: string): string {
  const m = /\n([ \t]+)"/.exec(s)
  return m ? m[1]! : '  '
}

function valueText(value: unknown, unit: string, base: string, eol: string): string {
  return JSON.stringify(value, null, unit).split('\n').join(eol + base)
}

export type InsertResult = {
  text: string
  /** The first key on the path that this insert created (its index), so removal can take exactly that away. */
  createdAt: number
  /** What was inside the object before, when the insert went into an empty object. */
  emptyInner?: string
}

/**
 * Sets the value at `path` (an object member), creating missing parent objects. An existing member is
 * replaced in place, returning its old text as `prior`. Returns null when a step on the path is not an object.
 */
export function setMember(text: string | null, path: string[], value: unknown): (InsertResult & { prior?: string }) | null {
  const eol = text && /\r\n/.test(text) ? '\r\n' : '\n'
  if (text === null || text.trim() === '') {
    // a new file: build the nested objects
    let v: unknown = value
    for (let i = path.length - 1; i >= 0; i--) v = { [path[i]!]: v }
    return { text: JSON.stringify(v, null, 2).split('\n').join(eol) + eol, createdAt: 0 }
  }
  const unit = indentUnit(text)
  // the deepest existing object on the path
  let depth = path.length - 1
  let open: number | null = null
  for (; depth >= 0; depth--) {
    open = objectAt(text, path.slice(0, depth))
    if (open !== null) break
  }
  if (open === null) return null
  const key = path[depth]!
  const { list, close } = members(text, open)
  const existing = list.find(m => m.key === key)
  if (existing) {
    if (depth < path.length - 1) return null // a step exists but is not an object
    const base = lineIndent(text, existing.keyStart)
    const prior = text.slice(existing.valueStart, existing.valueEnd)
    return {
      text: text.slice(0, existing.valueStart) + valueText(value, unit, base, eol) + text.slice(existing.valueEnd),
      createdAt: depth,
      prior,
    }
  }
  let v: unknown = value
  for (let i = path.length - 1; i > depth; i--) v = { [path[i]!]: v }
  if (list.length) {
    const last = list[list.length - 1]!
    const base = lineIndent(text, last.keyStart)
    const ins = `,${eol}${base}${JSON.stringify(key)}: ${valueText(v, unit, base, eol)}`
    return { text: text.slice(0, last.valueEnd) + ins + text.slice(last.valueEnd), createdAt: depth }
  }
  const closeIndent = lineIndent(text, close)
  const base = closeIndent + unit
  const inner = text.slice(open + 1, close)
  const body = `${eol}${base}${JSON.stringify(key)}: ${valueText(v, unit, base, eol)}${eol}${closeIndent}`
  return { text: text.slice(0, open + 1) + body + text.slice(close), createdAt: depth, emptyInner: inner }
}

/**
 * Takes away what `setMember` added: the member at `path`, or the whole chain from `createdAt` when
 * nothing else has been put inside it since. A replaced member gets its `prior` text back instead.
 */
export function removeMember(text: string, path: string[], o: { createdAt?: number; emptyInner?: string; prior?: string } = {}): string {
  if (o.prior !== undefined) {
    const open = objectAt(text, path.slice(0, -1))
    if (open === null) return text
    const m = members(text, open).list.find(x => x.key === path[path.length - 1])
    return m ? text.slice(0, m.valueStart) + o.prior + text.slice(m.valueEnd) : text
  }
  // remove from the highest created level that still holds only our chain
  let cut = path.length - 1
  for (let d = o.createdAt ?? path.length - 1; d < path.length - 1; d++) {
    const inner = objectAt(text, path.slice(0, d + 1))
    if (inner !== null && members(text, inner).list.length === 1) {
      cut = d
      break
    }
  }
  const open = objectAt(text, path.slice(0, cut))
  if (open === null) return text
  const { list, close } = members(text, open)
  const i = list.findIndex(m => m.key === path[cut])
  if (i < 0) return text
  const m = list[i]!
  if (list.length === 1) return text.slice(0, open + 1) + (cut === (o.createdAt ?? -1) && o.emptyInner !== undefined ? o.emptyInner : '') + text.slice(close)
  if (i === list.length - 1) return text.slice(0, list[i - 1]!.valueEnd) + text.slice(m.valueEnd)
  return text.slice(0, m.keyStart) + text.slice(list[i + 1]!.keyStart)
}
