import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTemporaryCopy } from '../src/setup/persist.ts'

test('a copy run through npx is recognised as temporary, a global install is not', () => {
  assert.equal(isTemporaryCopy('C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\4f2e\\node_modules\\mapshift\\dist\\cli\\main.js', {}), true)
  assert.equal(isTemporaryCopy('/home/a/.npm/_npx/9c1/node_modules/mapshift/dist/cli/main.js', {}), true)
  assert.equal(isTemporaryCopy('/tmp/cache/x/mapshift/dist/cli/main.js', { npm_config_cache: '/tmp/cache' }), true)
  assert.equal(isTemporaryCopy('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\mapshift\\dist\\cli\\main.js', {}), false)
  assert.equal(isTemporaryCopy('/usr/local/lib/node_modules/mapshift/dist/cli/main.js', { npm_config_cache: '/home/a/.npm' }), false)
})
