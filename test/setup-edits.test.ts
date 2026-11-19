import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foreignTomlLines, frontMatterEnd, mdFence, removeBlock, tomlFence, tomlString, upsertBlock } from '../src/setup/blocks.ts'
import { getAt, isStrictJson, removeMember, setMember } from '../src/setup/json-edit.ts'
import { applyPiece, removeRec, type Piece, type Rec } from '../src/setup/pieces.ts'

const md = mdFence()
const LINES = ['## Mapshift code map', '- use map_find']
const REC: Rec = { id: 'x', kind: 'block', path: 'GEMINI.md', agents: ['gemini'], label: 'Instructions' }

test('a Markdown block is appended, replaced in place, and removed to the exact original', () => {
  for (const original of ['', '# My rules\n\nBe kind.\n', '# My rules\n\nNo newline at end', '# CRLF rules\r\n\r\nKeep\r\n']) {
    const a = upsertBlock(original === '' ? null : original, md, LINES)
    assert.ok(a.text.includes('<!-- mapshift:start -->') && a.text.includes('- use map_find'))
    assert.ok(a.text.startsWith(original), 'user text before the block is untouched')
    if (original.includes('\r\n')) assert.ok(!/[^\r]\n/.test(a.text), 'the block uses the file\'s CRLF line endings')
    // running again changes nothing
    const b = upsertBlock(a.text, md, LINES)
    assert.equal(b.text, a.text)
    // new content replaces, never duplicates
    const c = upsertBlock(a.text, md, ['## Mapshift', '- changed'])
    assert.equal(c.text.split('mapshift:start').length, 2)
    assert.ok(c.text.includes('- changed') && !c.text.includes('- use map_find'))
    assert.equal(removeBlock(c.text, md, a.sep), original)
  }
})

test('a rules block put first goes above everything but front matter, and comes out to the exact original', () => {
  const piece: Piece = { agent: 'gemini', label: 'Instructions', path: 'GEMINI.md', kind: 'block', format: 'md', fence: md, lines: LINES, top: true }
  for (const original of ['', '# My rules\n\nUse other-tool FIRST.\n', 'No newline at end', '---\ninclusion: always\n---\nBody\n', '# CRLF\r\n\r\nKeep\r\n']) {
    const a = applyPiece(piece, original === '' ? null : original, undefined)
    assert.equal(a.action, 'add')
    const fm = frontMatterEnd(original)
    assert.ok(a.text!.slice(fm).startsWith('<!-- mapshift:start -->'), 'the block comes first, after front matter')
    assert.ok(a.text!.startsWith(original.slice(0, fm)) && a.text!.endsWith(original.slice(fm)), "the person's text is untouched")
    assert.equal(applyPiece(piece, a.text, { ...REC, ...a.rec }).action, 'same', 'running again changes nothing')
    const out = removeRec({ ...REC, ...a.rec, fence: md, format: 'md' }, a.text!)
    assert.equal(out.text ?? '', original)
  }
})

test('a block an older setup appended at the end moves to the top, and uninstall still restores the file', () => {
  const original = '# My rules\n\nUse other-tool FIRST.\n'
  const old = upsertBlock(original, md, LINES)
  const piece: Piece = { agent: 'agy', label: 'Instructions', path: 'GEMINI.md', kind: 'block', format: 'md', fence: md, lines: LINES, top: true }
  const moved = applyPiece(piece, old.text, { ...REC, sep: old.sep })
  assert.equal(moved.action, 'update')
  assert.ok(moved.text!.startsWith('<!-- mapshift:start -->'))
  assert.equal(moved.text!.split('mapshift:start').length, 2, 'moved, not copied')
  assert.ok(moved.text!.endsWith(original))
  assert.equal(removeRec({ ...REC, ...moved.rec, fence: md, format: 'md' }, moved.text!).text, original)
})

test('text a person adds after the block survives removal', () => {
  const a = upsertBlock('Top\n', md, LINES)
  const edited = `${a.text}\nMy later note\n`
  const out = removeBlock(edited, md, a.sep)
  assert.ok(out.startsWith('Top\n') && out.endsWith('\nMy later note\n'))
  assert.ok(!out.includes('mapshift'))
})

test('a TOML block keeps tables another program wrote inside it, on rewrite and on removal', () => {
  const fence = tomlFence('mcp')
  const keep = foreignTomlLines(['mcp_servers.mapshift'])
  const original = 'model = "x"\n\n[mcp_servers.other]\ncommand = "o"\n'
  const lines = ['# Added by Mapshift', '[mcp_servers.mapshift]', 'command = "node"']
  const a = upsertBlock(original, fence, lines, keep)
  // an agent appends its own table before our end marker (toml_edit puts new tables at the end)
  const intruded = a.text.replace('# <<< mapshift: mcp <<<', "[projects.'C:\\x']\ntrust_level = \"trusted\"\n# <<< mapshift: mcp <<<")
  const b = upsertBlock(intruded, fence, lines, keep)
  assert.ok(b.text.includes("[projects.'C:\\x']\ntrust_level = \"trusted\""), 'the foreign table is kept')
  assert.equal(b.text.split('[mcp_servers.mapshift]').length, 2)
  const removed = removeBlock(intruded, fence, a.sep, keep)
  assert.ok(removed.startsWith(original))
  assert.ok(removed.includes("[projects.'C:\\x']") && !removed.includes('mapshift'))
  // keys an agent added to our own table go with it
  const ownKey = a.text.replace('command = "node"', 'command = "node"\nenabled = false')
  assert.equal(removeBlock(ownKey, fence, a.sep, keep), original)
})

test('TOML strings hold Windows paths, quotes and spaces safely', () => {
  assert.equal(tomlString('C:\\Program Files\\nodejs\\node.exe'), '"C:\\\\Program Files\\\\nodejs\\\\node.exe"')
  assert.equal(tomlString('say "hi"'), '"say \\"hi\\""')
  assert.equal(tomlString('a\tb'), '"a\\u0009b"')
})

const VALUE = { command: 'C:\\node.exe', args: ['C:\\m\\main.js', 'mcp'] }
const KEY = ['mcpServers', 'mapshift']

test('a JSON member is added and removed without touching any other byte', () => {
  const shapes = [
    '{\n  "theme": "dark",\n  "mcpServers": {\n    "other": { "command": "o" }\n  }\n}\n',
    '{\n    "theme": "dark"\n}\n', // no mcpServers yet: it is created and taken away again
    '{"mcpServers":{}}', // compact and empty
    '{}',
    '{\r\n  "mcpServers": {\r\n    "a": 1\r\n  }\r\n}\r\n',
    '\uFEFF{\n  "x": [1, 2, {"y": "}"}]\n}\n', // a BOM, and a brace inside a string
  ]
  for (const original of shapes) {
    const r = setMember(original, KEY, VALUE)
    assert.ok(r, original)
    assert.ok(isStrictJson(r.text), `still valid JSON: ${r.text}`)
    assert.deepEqual(getAt(r.text, KEY), VALUE)
    if (original.includes('\r\n')) assert.ok(!/[^\r]\n/.test(r.text))
    const back = removeMember(r.text, KEY, { createdAt: r.createdAt, emptyInner: r.emptyInner })
    assert.equal(back, original)
  }
})

test('a JSON file that does not exist is created with just the entry', () => {
  const r = setMember(null, KEY, VALUE)!
  assert.deepEqual(JSON.parse(r.text), { mcpServers: { mapshift: VALUE } })
  assert.equal(r.createdAt, 0)
})

test('a replaced JSON value gets its old text back', () => {
  const original = '{\n  "statusLine": {"type":"","command":"","enabled":true},\n  "model": "m"\n}\n'
  const r = setMember(original, ['statusLine'], { type: 'command', command: 'x' })!
  assert.equal(r.prior, '{"type":"","command":"","enabled":true}')
  assert.equal(removeMember(r.text, ['statusLine'], { prior: r.prior }), original)
})

test('a server the person adds next to ours stays when ours is removed', () => {
  const r = setMember('{\n  "theme": "dark"\n}\n', KEY, VALUE)!
  const withMine = setMember(r.text, ['mcpServers', 'mine'], { command: 'm' })!.text
  const out = removeMember(withMine, KEY, { createdAt: r.createdAt })
  assert.deepEqual(JSON.parse(out), { theme: 'dark', mcpServers: { mine: { command: 'm' } } })
})

test('JSON with comments is not treated as JSON', () => {
  assert.equal(isStrictJson('{ // note\n "a": 1 }'), false)
  assert.equal(isStrictJson('{ "a": 1, }'), false)
  assert.equal(isStrictJson('[1]'), false)
  assert.equal(setMember('{"mcpServers": 5}', KEY, VALUE), null, 'a non-object on the path is refused')
})
