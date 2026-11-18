// Unit test for the held-out matching rule: node bench/test-heldout-match.mjs (exits 1 on a failure)
import { matches, segments } from './run-heldout.mjs'
const T = [
  [{ name: 'InsertRoute', file: 'tree.go', start: 148, end: 238 }, { file: 'tree.go', qualified: 'node.InsertRoute' }, 'chi', true],
  [{ name: '(*node).InsertRoute', file: 'tree.go', start: 148 }, { file: 'tree.go', qualified: 'node.InsertRoute' }, 'chi', true],
  [{ name: '(*Mux).InsertRoute', file: 'tree.go', start: 148 }, { file: 'tree.go', qualified: 'node.InsertRoute' }, 'chi', false],
  [{ name: '[_examples/rest/] AdminOnly', file: '_examples/rest/main.go', start: 1 }, { file: '_examples/rest/main.go', qualified: 'AdminOnly' }, 'chi', true],
  [{ name: 'decode_hex_escape', file: 'src/read.rs', start: 377, end: 377 }, { file: 'src/read.rs', qualified: 'IoRead.decode_hex_escape' }, 'json', true],
  [{ name: 'decode_hex_escape', file: 'src/read.rs', start: 764, end: 766 }, { file: 'src/read.rs', qualified: 'IoRead.decode_hex_escape' }, 'json', false],
  [{ name: 'decode_hex_escape', file: 'src/read.rs' }, { file: 'src/read.rs', qualified: 'IoRead.decode_hex_escape' }, 'json', false],
  [{ name: 'serialize_f64', file: 'src/ser.rs', start: 169, end: 180 }, { file: 'src/ser.rs', qualified: 'MapKeySerializer.serialize_f64' }, 'json', false],
  [{ name: 'serialize_f64', file: 'src/ser.rs', start: 1042, end: 1061 }, { file: 'src/ser.rs', qualified: 'MapKeySerializer.serialize_f64' }, 'json', true],
  [{ name: 'LineDecoder', file: 'httpx/_decoders.py', start: 321, end: 378 }, { file: 'httpx/_decoders.py', qualified: 'LineDecoder.decode' }, 'httpx', false],
  [{ name: 'FileField.get_length', file: 'httpx/_multipart.py', start: 177, end: 177 }, { file: 'httpx/_multipart.py', qualified: 'FileField.get_length' }, 'httpx', true],
  [{ name: 'DataField.get_length', file: 'httpx/_multipart.py', start: 177, end: 177 }, { file: 'httpx/_multipart.py', qualified: 'FileField.get_length' }, 'httpx', false],
  [{ name: 'Axios.request', file: 'lib/core/Axios.js', start: 1 }, { file: 'lib/core/Axios.js', qualified: 'Axios._request' }, 'axios', false],
  [{ name: 'Axios._request', file: 'lib\\core\\Axios.js', start: 1 }, { file: 'lib/core/Axios.js', qualified: 'Axios._request' }, 'axios', true],
  [{ name: 'dispatchRequest.onAdapterResolution', file: 'lib/core/dispatchRequest.js', start: 1 }, { file: 'lib/core/dispatchRequest.js', qualified: 'onAdapterResolution' }, 'axios', true],
  [{ name: 'IoRead<R>::decode_hex_escape', file: 'src/read.rs', start: 372 }, { file: 'src/read.rs', qualified: 'IoRead.decode_hex_escape' }, 'json', true],
  [{ name: 'settle', file: 'lib/core/other.js', start: 1 }, { file: 'lib/core/settle.js', qualified: 'settle' }, 'axios', false],
  [{ name: 'Value::pointer', file: 'src/value/mod.rs', start: 1 }, { file: 'src/value/mod.rs', qualified: 'Value.pointer' }, 'json', true],
  [{ name: 'pointer_mut', file: 'src/value/mod.rs', start: 1 }, { file: 'src/value/mod.rs', qualified: 'Value.pointer' }, 'json', false],
]
let fail = 0
for (const [r, a, repo, exp] of T) {
  const got = matches(r, a, repo)
  if (got !== exp) fail++
  console.log(got === exp ? 'ok  ' : 'FAIL', r.name, '->', a.qualified, got, JSON.stringify(segments(r.name)))
}
console.log(fail ? `${fail} FAILED` : `all ${T.length} ok`)
if (fail) process.exitCode = 1
