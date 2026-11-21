/**
 * Pure checks for byte-bounded chunked summarization.
 * Run: ELECTRON_RUN_AS_NODE=1 "<dsh node>" test/chunking.test.mjs
 */
import assert from 'node:assert/strict'
import {
  CHUNK_DEFAULTS,
  CHUNK_MODES,
  chunkInstruction,
  digestMessages,
  mapLimit,
  mergeInstruction,
  mergeMessages,
  packChunks,
  projectMessages,
  requestBytes,
  resolveChunkConfig,
  utf8Bytes,
} from '../lib/chunking.js'

const defaults = resolveChunkConfig()
assert.equal(defaults.chunking, 'auto')
assert.ok(Object.isFrozen(defaults))
assert.deepEqual(Object.keys(defaults).sort(), Object.keys(CHUNK_DEFAULTS).sort())
assert.deepEqual([...CHUNK_MODES], ['auto', 'off'])

// Validation is actionable.
assert.throws(() => resolveChunkConfig({ chunking: 'sometimes' }), /chunking/)
assert.throws(() => resolveChunkConfig({ chunkBytes: 9_000 }), /chunkBytes/)
assert.throws(() => resolveChunkConfig({ chunkBytes: 5_000_000 }), /must not exceed chunkTriggerBytes/)
assert.throws(() => resolveChunkConfig({ chunkConcurrency: 9 }), /chunkConcurrency/)
assert.throws(() => resolveChunkConfig({ chunkRetries: -1 }), /chunkRetries/)

// Sizing counts messages and tool schemas.
const small = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(100) }] }] }
assert.ok(requestBytes(small) > 100)
assert.ok(requestBytes({ ...small, tools: [{ name: 't', description: 'd' }] }) > requestBytes(small))

// Projection: system head separated, reasoning dropped, roles labeled.
const projected = projectMessages([
  { role: 'system', content: [{ type: 'text', text: 'you are an agent' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'assistant', content: [{ type: 'reasoning', text: 'SECRET THOUGHTS' }, { type: 'text', text: 'hi' }] },
  { role: 'assistant', content: [{ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' }] },
  { role: 'tool', content: [{ type: 'text', text: 'file body' }] },
  { role: 'user', content: [{ type: 'image', attachment: { width: 10, height: 10 } }] },
])
assert.equal(projected.system, 'you are an agent')
assert.equal(projected.parts.length, 5)
assert.ok(!projected.parts.join('\n').includes('SECRET THOUGHTS'), 'reasoning must not be shipped')
assert.match(projected.parts[0], /^### user\nhello$/)
assert.match(projected.parts[1], /^### assistant\nhi$/)
assert.match(projected.parts[2], /tool-call read/)
assert.match(projected.parts[3], /### tool result/)
assert.match(projected.parts[4], /\[image omitted\]/)

// Packing preserves order and content when no part needs splitting.
const parts = Array.from({ length: 20 }, (_, i) => `part-${i}-` + 'y'.repeat(400))
const packed = packChunks(parts, 2_000)
assert.ok(packed.length > 1)
assert.equal(packed.join('\n'), parts.join('\n'), 'packing must be lossless')
for (const chunk of packed) assert.ok(utf8Bytes(chunk) <= 2_000, `chunk of ${utf8Bytes(chunk)} B exceeds budget`)

// One oversized part is cut, and every piece still fits the budget.
const huge = 'z'.repeat(30_000)
const pieces = packChunks([huge], 2_000)
assert.equal(pieces.join(''), huge)
for (const piece of pieces) assert.ok(utf8Bytes(piece) <= 2_000)

// CJK content is measured in bytes, not characters.
const cjk = '汉'.repeat(5_000) // 15 000 bytes
const cjkChunks = packChunks([cjk], 3_000)
assert.ok(cjkChunks.length >= 5, `expected at least 5 pieces, got ${cjkChunks.length}`)
for (const chunk of cjkChunks) assert.ok(utf8Bytes(chunk) <= 3_000)

// Digest requests carry the system head once and the part index.
const digest = digestMessages('sys', 'body', 0, 3)
assert.equal(digest[0].role, 'system')
assert.equal(digest.at(-1).role, 'user')
assert.match(digest.at(-1).content[0].text, /part 1 of 3/)
assert.match(digest.at(-1).content[0].text, /body$/)
assert.equal(digestMessages(null, 'b', 1, 2).length, 1, 'no system head means no system message')

// The folding request keeps every section the checkpoint format requires.
const merge = mergeMessages('sys', ['digest one', 'digest two'])
const mergeText = merge.at(-1).content[0].text
for (const section of ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code', 'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context']) {
  assert.ok(mergeText.includes(`## ${section}`), `merge instruction must keep "${section}"`)
}
assert.match(mergeText, /--- digest 2 ---\ndigest two/)
assert.ok(mergeInstruction(2).includes('2 partial digests'))
assert.ok(chunkInstruction(0, 2).includes('part 1 of 2'))

// Bounded concurrency keeps input order, and never exceeds the limit.
let inFlight = 0
let peak = 0
const results = await mapLimit([10, 5, 1], 2, async (ms) => {
  inFlight += 1
  peak = Math.max(peak, inFlight)
  await new Promise((resolve) => setTimeout(resolve, ms))
  inFlight -= 1
  return ms * 2
})
assert.deepEqual(results, [20, 10, 2], 'results must keep input order')
assert.equal(peak, 2, `expected two tasks in flight, saw ${peak}`)

console.log('chunking: all checks passed')
