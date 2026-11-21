/**
 * Pure checks for the insight projections the panel will render.
 * Run: ELECTRON_RUN_AS_NODE=1 "<dsh node>" test/insight.test.mjs
 */
import assert from 'node:assert/strict'
import {
  budgetSnapshot,
  chunkSnapshot,
  compactionTotals,
  recordChunkRun,
  recordScaleChange,
  summarizeCompactions,
  turnsToThreshold,
} from '../lib/insight.js'
import { resolveChunkConfig } from '../lib/chunking.js'
import { planPolicy, resolveAdaptiveConfig } from '../lib/policy.js'

// --- turns to threshold -----------------------------------------------------
assert.equal(turnsToThreshold(100, 500, 0), null, 'no growth means no estimate')
assert.equal(turnsToThreshold(600, 500, 20), 0, 'already past the threshold')
assert.equal(turnsToThreshold(400, 500, 20), 5)
assert.equal(turnsToThreshold(401, 500, 20), 5, 'a partial turn still needs a full turn')

// --- budget card ------------------------------------------------------------
const adaptive = resolveAdaptiveConfig()
const plan = planPolicy({
  contextWindow: 1_048_576,
  reservedTokens: 8_192,
  growthTokens: 12_400,
  adaptive,
  profile: adaptive.profile,
})
const budget = budgetSnapshot({ plan, measurement: { totalTokens: 402_000 }, adaptive })
assert.equal(budget.windowTokens, 1_048_576)
assert.equal(budget.thresholdTokens, plan.thresholdTokens)
assert.equal(budget.tailTokens, plan.retainTokens)
assert.equal(budget.growthTokens, 12_400)
assert.ok(budget.usedRatio > 0.38 && budget.usedRatio < 0.39)
assert.ok(Math.abs(budget.thresholdShare - plan.thresholdTokens / 1_048_576) < 1e-9)
assert.ok(budget.tailShare + budget.usableShare + budget.freeShare <= 1.000001, 'segments cannot exceed the window')
assert.equal(budget.turnsToThreshold, Math.ceil((plan.thresholdTokens - 402_000) / 12_400))
assert.equal(budget.profile, 'balanced')

// A missing plan degrades to zeros instead of NaN.
const empty = budgetSnapshot({ plan: null, measurement: { totalTokens: 10 }, adaptive })
assert.equal(empty.windowTokens, 0)
assert.equal(empty.usedRatio, 0)
assert.equal(empty.turnsToThreshold, null)
assert.ok(Number.isFinite(empty.freeShare))

// --- chunk card ------------------------------------------------------------
const chunkConfig = resolveChunkConfig()
const chunk = chunkSnapshot({
  chunkConfig,
  capacity: { window: 1_048_576, reservedTokens: 8_192, overheadTokens: 4_000 },
  scale: 1,
})
const capacity = 1_048_576 - 8_192 - 4_000
assert.equal(chunk.singleShotTokens, Math.floor(capacity * 0.7))
assert.equal(chunk.partTokens, Math.floor(capacity * 0.45))
assert.equal(chunk.concurrency, 2)
assert.equal(chunk.scale, 1)
assert.equal(chunk.enabled, true)

const scaled = chunkSnapshot({
  chunkConfig,
  capacity: { window: 1_048_576, reservedTokens: 8_192, overheadTokens: 4_000 },
  scale: 0.6,
})
assert.ok(scaled.partTokens < chunk.partTokens)
assert.ok(scaled.partBytes < chunk.partBytes)

const fixed = chunkSnapshot({
  chunkConfig: resolveChunkConfig({ chunkSizing: 'fixed' }),
  capacity: { window: 1_048_576, reservedTokens: 0, overheadTokens: 0 },
  scale: 1,
})
assert.equal(fixed.singleShotTokens, 1_048_576, 'fixed sizing uses the whole capacity')

const off = chunkSnapshot({
  chunkConfig: resolveChunkConfig({ chunking: 'off' }),
  capacity: { window: 1_048_576, reservedTokens: 0, overheadTokens: 0 },
  scale: 1,
})
assert.equal(off.enabled, false)

// --- compaction transactions ----------------------------------------------
const events = [
  { type: 'compaction/start', seq: 10, time: 1_000, data: { compactionId: 'a', turn: 3 } },
  { type: 'compaction/summary', seq: 11, time: 1_400, data: {
    compactionId: 'a', shadowedTokenCount: 268_430, shadowedSeqs: [1, 2, 3, 4],
    provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 12_000,
    summary: [{ type: 'text', text: 'x'.repeat(120) }],
  } },
  { type: 'compaction/end', seq: 12, time: 1_900, data: { compactionId: 'a', turn: 3 } },
  { type: 'compaction/start', seq: 20, time: 2_000, data: { compactionId: 'b', turn: null } },
  { type: 'compaction/summary', seq: 21, time: 2_300, data: {
    compactionId: 'b', shadowedTokenCount: 90_000, shadowedSeqs: [7], provider: 'strata-mi50', model: 'deepseek-v4.1',
  } },
  { type: 'compaction/end', seq: 22, time: 2_400, data: { compactionId: 'b', turn: null, error: 'summary failed' } },
  { type: 'compaction/start', seq: 30, time: 3_000, data: { compactionId: 'c', turn: 4 } },
  { type: 'assistant/message', seq: 31, time: 3_100, data: {} },
]
const records = summarizeCompactions(events, 10)
assert.equal(records.length, 3)
assert.equal(records[0].compactionId, 'c', 'newest first')
assert.equal(records[0].status, 'running')
assert.equal(records[0].manual, false)

const manual = records.find((record) => record.compactionId === 'b')
assert.equal(manual.manual, true, 'turn null marks a manual compaction')
assert.equal(manual.status, 'failed')
assert.equal(manual.error, 'summary failed')
assert.equal(manual.durationMs, 400)
assert.equal(manual.shadowedNodes, 1)

const auto = records.find((record) => record.compactionId === 'a')
assert.equal(auto.status, 'ok')
assert.equal(auto.manual, false)
assert.equal(auto.durationMs, 900)
assert.equal(auto.shadowedTokenCount, 268_430)
assert.equal(auto.shadowedNodes, 4)
assert.equal(auto.summaryChars, 120)
assert.equal(auto.provider, 'deepseek-account')

assert.deepEqual(summarizeCompactions(events, 1).map((record) => record.compactionId), ['c'])
assert.deepEqual(summarizeCompactions([], 5), [])
assert.deepEqual(summarizeCompactions([{ type: 'compaction/start', seq: 1, time: 1, data: {} }], 5), [],
  'an event without a compactionId is not a transaction')

const totals = compactionTotals(records)
assert.equal(totals.total, 3)
assert.equal(totals.automatic, 2)
assert.equal(totals.manual, 1)
assert.equal(totals.failed, 1)
assert.equal(totals.running, 1)
assert.equal(totals.shadowedTokens, 358_430)

// --- bounded in-process logs ----------------------------------------------
const runs = []
for (let index = 0; index < 5; index += 1) recordChunkRun(runs, { at: index, parts: index + 1 }, 3)
assert.equal(runs.length, 3, 'run log is bounded')
assert.deepEqual(runs.map((run) => run.at), [2, 3, 4], 'oldest entries drop first')

const series = []
recordScaleChange(series, { at: 1, scale: 1, reason: 'init' })
recordScaleChange(series, { at: 2, scale: 1, reason: 'init' })
assert.equal(series.length, 1, 'an unchanged consecutive point is not appended')
recordScaleChange(series, { at: 3, scale: 0.6, reason: 'shrink' })
recordScaleChange(series, { at: 4, scale: 0.69, reason: 'recover' })
assert.deepEqual(series.map((point) => point.scale), [1, 0.6, 0.69])

console.log('insight: all checks passed')
