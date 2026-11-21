/**
 * Checks for the insight projection: the fold, the wire payload, and the
 * schemas that guard both.
 * Run: ELECTRON_RUN_AS_NODE=1 "<dsh node>" test/projection.test.mjs
 */
import assert from 'node:assert/strict'
import {
  INSIGHT_PROJECTION_KEY,
  applyInsight,
  insightProjectionDefinition,
  viewInsight,
} from '../lib/projection.js'

const empty = insightProjectionDefinition.init()

// Irrelevant events keep the same reference: no downstream work.
const userEvent = { type: 'user/message', seq: 1, time: 1, data: {} }
assert.equal(applyInsight(empty, userEvent), empty, 'non-compaction events must be a no-op')
assert.equal(applyInsight(empty, { type: 'compaction/start', seq: 2, time: 2, data: {} }), empty,
  'a start without a compactionId is ignored')
assert.equal(applyInsight(empty, { type: 'compaction/summary', seq: 3, time: 3, data: { compactionId: 'x' } }), empty,
  'a summary without a preceding start is ignored')

const started = applyInsight(empty, { type: 'compaction/start', seq: 4, time: 1_000, data: { compactionId: 'a', turn: 3 } })
assert.notEqual(started, empty)
assert.equal(started.transactions.length, 1)
assert.equal(started.transactions[0].manual, false)

const summarized = applyInsight(started, {
  type: 'compaction/summary', seq: 5, time: 1_400,
  data: {
    compactionId: 'a', shadowedTokenCount: 268_430, shadowedSeqs: [1, 2, 3, 4],
    provider: 'deepseek-account', model: 'deepseek-flash',
    summary: [{ type: 'text', text: 'x'.repeat(120) }],
  },
})
assert.equal(summarized.transactions[0].shadowedTokenCount, 268_430)
assert.equal(summarized.transactions[0].shadowedNodes, 4)
assert.equal(summarized.transactions[0].provider, 'deepseek-account')
assert.equal(summarized.transactions[0].summaryChars, 120)

const ended = applyInsight(summarized, { type: 'compaction/end', seq: 6, time: 1_900, data: { compactionId: 'a', turn: 3 } })
assert.equal(ended.transactions[0].endedAt, 1_900)

const manualStart = applyInsight(ended, { type: 'compaction/start', seq: 7, time: 2_000, data: { compactionId: 'b', turn: null } })
const manualEnd = applyInsight(manualStart, { type: 'compaction/end', seq: 8, time: 2_100, data: { compactionId: 'b', turn: null, error: 'boom' } })
const running = applyInsight(manualEnd, { type: 'compaction/start', seq: 9, time: 3_000, data: { compactionId: 'c', turn: 4 } })

// --- wire payload ----------------------------------------------------------
const view = viewInsight(running)
assert.equal(view.transactions.length, 3)
assert.equal(view.transactions[0].compactionId, 'c', 'newest first')
assert.equal(view.transactions[0].status, 'running')
assert.equal(view.transactions[0].durationMs, null)

const auto = view.transactions.find((record) => record.compactionId === 'a')
assert.equal(auto.status, 'ok')
assert.equal(auto.durationMs, 900)
const failed = view.transactions.find((record) => record.compactionId === 'b')
assert.equal(failed.status, 'failed')
assert.equal(failed.manual, true)
assert.equal(failed.error, 'boom')

assert.deepEqual(view.totals, {
  total: 3, automatic: 2, manual: 1, failed: 1, running: 1, shadowedTokens: 268_430,
})
assert.equal(viewInsight(empty).transactions.length, 0)
assert.equal(viewInsight(empty).totals.total, 0)

// --- schemas ---------------------------------------------------------------
assert.equal(insightProjectionDefinition.key, INSIGHT_PROJECTION_KEY)
assert.equal(insightProjectionDefinition.stateVersion, 1)
assert.doesNotThrow(() => insightProjectionDefinition.stateSchema.parse(running))
assert.doesNotThrow(() => insightProjectionDefinition.wire.viewSchema.parse(view))
assert.doesNotThrow(() => insightProjectionDefinition.wire.viewSchema.parse(viewInsight(empty)))
assert.throws(() => insightProjectionDefinition.stateSchema.parse({ transactions: [{ compactionId: 'x' }] }),
  'a transaction missing its start facts must not validate')
assert.throws(() => insightProjectionDefinition.wire.viewSchema.parse({ transactions: [], totals: { total: 1 } }),
  'a partial totals block must not validate')

// The fold is bounded: a long session cannot grow the projection without limit.
let state = empty
for (let index = 0; index < 60; index += 1) {
  state = applyInsight(state, { type: 'compaction/start', seq: index * 2, time: index * 10, data: { compactionId: `id-${index}`, turn: index } })
  state = applyInsight(state, { type: 'compaction/end', seq: index * 2 + 1, time: index * 10 + 5, data: { compactionId: `id-${index}`, turn: index } })
}
assert.equal(state.transactions.length, 40, 'state keeps the newest 40 transactions')
assert.equal(state.transactions[39].compactionId, 'id-59')

console.log('projection: all checks passed')
