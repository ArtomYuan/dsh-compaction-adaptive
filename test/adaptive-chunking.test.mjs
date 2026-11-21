/**
 * Pure checks for adaptive chunk sizing: budgets derived from the summary
 * model's window, the learned capacity scale, and size-failure classification.
 * Run: ELECTRON_RUN_AS_NODE=1 "<dsh node>" test/adaptive-chunking.test.mjs
 */
import assert from 'node:assert/strict'
import {
  conservativeTokens,
  isSizeFailure,
  nextScale,
  packByBudget,
  planChunking,
  resolveChunkConfig,
  utf8Bytes,
} from '../lib/chunking.js'

/** Deterministic stand-in for the harness character heuristic (3 chars/token). */
const estimate = (text) => Math.ceil(text.length / 3)

const config = resolveChunkConfig()

// A 1M summary model: single-shot may use 70% of what remains after output and overhead.
const big = planChunking({
  contentTokens: 500_000,
  contentBytes: 2_000_000,
  capacity: { window: 1_048_576, reservedTokens: 8_192, overheadTokens: 4_000 },
  config,
})
const bigCapacity = 1_048_576 - 8_192 - 4_000
assert.equal(big.tokenBudget, Math.floor(bigCapacity * 0.7))
assert.equal(big.partTokenBudget, Math.floor(bigCapacity * 0.45))
assert.equal(big.byteBudget, config.chunkTriggerBytes)
assert.equal(big.needed, false, '500K tokens fit a 1M summary model')
assert.match(big.reason, /fit the single-shot budget/)

// The same content against a 32K summary model needs parts even though the bytes are small.
const smallWindow = planChunking({
  contentTokens: 40_000,
  contentBytes: 160_000,
  capacity: { window: 32_768, reservedTokens: 4_096, overheadTokens: 1_000 },
  config,
})
assert.equal(smallWindow.needed, true, 'a 32K model cannot take 40K tokens even at 160 KB')
assert.match(smallWindow.reason, /tokens >/)
assert.ok(smallWindow.partTokenBudget > 0 && smallWindow.partTokenBudget < 40_000)

// Bytes remain a real trigger on their own (transport limit).
const byteBound = planChunking({
  contentTokens: 100,
  contentBytes: 3_000_000,
  capacity: { window: 1_048_576, reservedTokens: 0, overheadTokens: 0 },
  config,
})
assert.equal(byteBound.needed, true)
assert.match(byteBound.reason, /bytes >/)

// An unknown window leaves the decision to the byte cap.
const unknownWindow = planChunking({
  contentTokens: 900_000,
  contentBytes: 1_000,
  capacity: { window: 0, reservedTokens: 0, overheadTokens: 0 },
  config,
})
assert.equal(unknownWindow.tokenBudget, Number.POSITIVE_INFINITY)
assert.equal(unknownWindow.needed, false, 'unknown window must not invent a token trigger')

// A learned scale shrinks every budget and is bounded below.
const scaled = planChunking({
  contentTokens: 500_000,
  contentBytes: 2_000_000,
  capacity: { window: 1_048_576, reservedTokens: 8_192, overheadTokens: 4_000 },
  config,
  scale: 0.6,
})
assert.ok(scaled.tokenBudget < big.tokenBudget)
assert.ok(scaled.partTokenBudget < big.partTokenBudget)
assert.equal(scaled.needed, true, '500K no longer fits at 60% of a 1M window')
const stillFits = planChunking({
  contentTokens: 400_000,
  contentBytes: 1_200_000,
  capacity: { window: 1_048_576, reservedTokens: 8_192, overheadTokens: 4_000 },
  config,
  scale: 0.6,
})
assert.equal(stillFits.needed, false, 'a smaller span still fits after one shrink')
const floored = planChunking({
  contentTokens: 1,
  contentBytes: 1,
  capacity: { window: 1_048_576, reservedTokens: 0, overheadTokens: 0 },
  config,
  scale: 0.01,
})
assert.equal(floored.scale, config.chunkMinScale, 'scale must clamp at chunkMinScale')

// `fixed` sizing uses the whole capacity instead of the adaptive fractions.
const fixedConfig = resolveChunkConfig({ chunkSizing: 'fixed' })
const fixed = planChunking({
  contentTokens: 500_000,
  contentBytes: 2_000_000,
  capacity: { window: 1_048_576, reservedTokens: 8_192, overheadTokens: 4_000 },
  config: fixedConfig,
})
assert.ok(fixed.tokenBudget > big.tokenBudget)
assert.equal(fixed.partTokenBudget, fixed.tokenBudget)

// `chunking: off` never asks for parts.
const off = planChunking({
  contentTokens: 9_999_999,
  contentBytes: 9_999_999,
  capacity: { window: 1_048_576, reservedTokens: 0, overheadTokens: 0 },
  config: resolveChunkConfig({ chunking: 'off' }),
})
assert.equal(off.needed, false)
assert.equal(off.reason, 'chunking disabled')

// Packing honours whichever budget binds first.
const parts = Array.from({ length: 30 }, (_, i) => `part-${i}\n` + 'a'.repeat(900))
const byTokens = packByBudget(parts, { tokenBudget: 1_000, byteBudget: 10_000_000 }, estimate)
for (const chunk of byTokens) {
  assert.ok(conservativeTokens(chunk, estimate(chunk)) <= 1_000, 'token budget must bind')
}
assert.equal(byTokens.join('\n'), parts.join('\n'), 'token packing is lossless')
const byBytes = packByBudget(parts, { tokenBudget: 10_000_000, byteBudget: 3_000 }, estimate)
for (const chunk of byBytes) assert.ok(utf8Bytes(chunk) <= 3_000, 'byte budget must bind')
assert.equal(byBytes.join('\n'), parts.join('\n'), 'byte packing is lossless')

// A single oversized part is cut under both budgets.
const huge = 'x'.repeat(50_000)
const pieces = packByBudget([huge], { tokenBudget: 2_000, byteBudget: 9_000 }, estimate)
assert.equal(pieces.join(''), huge)
for (const piece of pieces) {
  assert.ok(utf8Bytes(piece) <= 9_000)
  assert.ok(conservativeTokens(piece, estimate(piece)) <= 2_000)
}

// CJK is priced by bytes, so it cannot sneak past a token budget.
const cjk = '汉'.repeat(4_000) // 12 000 bytes, ~4 000 real tokens
const cjkPieces = packByBudget([cjk], { tokenBudget: 1_000, byteBudget: 10_000_000 }, estimate)
assert.ok(cjkPieces.length >= 4, `expected >= 4 pieces, got ${cjkPieces.length}`)
for (const piece of cjkPieces) {
  assert.ok(conservativeTokens(piece, estimate(piece)) <= 1_000, 'CJK token price must respect the budget')
}

// Size failures are recognised, real faults are not.
assert.equal(isSizeFailure({ code: 'MAX_TOKENS' }), true)
assert.equal(isSizeFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }), true)
assert.equal(isSizeFailure(new Error('the maximum context length is 32768 tokens')), true)
assert.equal(isSizeFailure(new Error('413 Request Entity Too Large')), true)
assert.equal(isSizeFailure(new Error('request payload too large')), true)
assert.equal(isSizeFailure(new Error('model returned no text')), false)
assert.equal(isSizeFailure(undefined), false)

// Learned capacity: shrink then recover, clamped at both ends.
const shrunk = nextScale(1, 'shrink', config)
assert.ok(shrunk < 1 && shrunk >= config.chunkMinScale)
assert.equal(nextScale(config.chunkMinScale, 'shrink', config), config.chunkMinScale)
assert.ok(nextScale(0.6, 'recover', config) > 0.6)
assert.equal(nextScale(1, 'recover', config), 1)

// Repeated failures converge to the floor instead of collapsing below it.
let scale = 1
for (let i = 0; i < 20; i += 1) scale = nextScale(scale, 'shrink', config)
assert.equal(scale, config.chunkMinScale)

console.log('adaptive chunking: all checks passed')
