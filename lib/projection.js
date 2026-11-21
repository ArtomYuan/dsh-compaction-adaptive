/**
 * Host-side session projection behind the insight panel.
 *
 * A projection is the only sanctioned way for browser code to read host state:
 * the host folds committed events into plain state, `wire.view` publishes the
 * read-side shape, and the Client reads it by key through `useProjection`. So
 * this unit folds exactly what the durable log can prove — compaction
 * transactions, their outcome, the shadowed span, and the summarizing route —
 * and nothing else.
 *
 * Live engine state (the plan, the growth estimate, the learned chunk capacity)
 * is intentionally absent: a projection must be replayable from the log, and
 * those values are not logged. The panel labels them as live process state.
 *
 * @module dsh-compaction-adaptive/projection
 */

import { z } from 'zod'

/** Projection key read by the panel through `useProjection`. */
export const INSIGHT_PROJECTION_KEY = 'compaction-adaptive/insight'

/** Newest transactions kept in the projection state. */
const MAX_TRANSACTIONS = 40

const transactionSchema = z.object({
  compactionId: z.string(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  turn: z.number().int().nullable(),
  manual: z.boolean(),
  shadowedTokenCount: z.number().int().nonnegative().optional(),
  shadowedNodes: z.number().int().nonnegative().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  summaryChars: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  inFlight: z.boolean().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  status: z.enum(['ok', 'failed', 'running']).optional(),
})

/** Fold state: raw transactions, oldest first. */
const stateSchema = z.object({
  transactions: z.array(transactionSchema).max(MAX_TRANSACTIONS),
})

/** Wire payload: what the browser renders, already counted. */
const viewSchema = z.object({
  transactions: z.array(transactionSchema),
  totals: z.object({
    total: z.number().int().nonnegative(),
    automatic: z.number().int().nonnegative(),
    manual: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    shadowedTokens: z.number().int().nonnegative(),
  }),
})

/**
 * Apply one event to the fold.
 *
 * Only `compaction/*` events are interesting; every other event returns the same
 * state reference so the framework does no downstream work.
 * @param {z.infer<typeof stateSchema>} state - state covering all prior events.
 * @param {any} event - next committed event.
 * @returns {z.infer<typeof stateSchema>} next state.
 */
export function applyInsight(state, event) {
  try {
    return foldInsight(state, event)
  } catch {
    // A fold unit runs inside every session's projection pass: it must never be
    // able to fail a session load. Returning the previous state drops only this
    // unit's contribution to that event.
    return state
  }
}

/**
 * The fold proper. Kept separate so {@link applyInsight} can guarantee the
 * no-throw contract a projection unit needs.
 * @param {any} state - state covering all prior events.
 * @param {any} event - next committed event.
 * @returns {any} next state.
 */
function foldInsight(state, event) {
  if (typeof event?.type !== 'string' || !event.type.startsWith('compaction/')) return state
  const id = event.data?.compactionId
  if (id === undefined) return state

  const transactions = (Array.isArray(state?.transactions) ? state.transactions : []).slice()
  let index = transactions.findIndex((entry) => entry.compactionId === id)
  if (index === -1) {
    if (event.type !== 'compaction/start') return state
    transactions.push({ compactionId: id, startedAt: event.time ?? 0, turn: event.data.turn ?? null, manual: event.data.turn === null })
    index = transactions.length - 1
  } else {
    transactions[index] = { ...transactions[index] }
  }
  const record = transactions[index]

  if (event.type === 'compaction/summary') {
    record.shadowedTokenCount = event.data.shadowedTokenCount ?? 0
    record.shadowedNodes = Array.isArray(event.data.shadowedSeqs) ? event.data.shadowedSeqs.length : 0
    if (typeof event.data.provider === 'string') record.provider = event.data.provider
    if (typeof event.data.model === 'string') record.model = event.data.model
    record.summaryChars = Array.isArray(event.data.summary)
      ? event.data.summary.reduce((sum, block) => sum + (typeof block?.text === 'string' ? block.text.length : 0), 0)
      : 0
  } else if (event.type === 'compaction/end') {
    record.endedAt = event.time ?? 0
    if (typeof event.data.error === 'string') record.error = event.data.error
  }

  while (transactions.length > MAX_TRANSACTIONS) transactions.shift()
  return { transactions }
}

/**
 * Derive the browser payload from fold state.
 *
 * Adds duration and status (pure functions of the folded fields) and the counts
 * the summary strip needs. The fold returns the same state reference for
 * irrelevant events, so this runs only after a compaction event lands.
 * @param {any} state - folded state.
 * @returns {object} wire payload.
 */
export function viewInsight(state) {
  try {
    return projectView(state)
  } catch {
    // `wire.view` runs while the host builds a session summary. A throw here can
    // fail the whole session, so a degraded empty payload is always better than
    // an exception. The panel shows "no records" instead of the session dying.
    return { transactions: [], totals: { total: 0, automatic: 0, manual: 0, failed: 0, running: 0, shadowedTokens: 0 } }
  }
}

/**
 * The view proper, separated for the no-throw wrapper above.
 * @param {any} state - folded state.
 * @returns {object} wire payload.
 */
function projectView(state) {
  const transactions = (Array.isArray(state?.transactions) ? state.transactions : [])
    .map((record) => ({
      ...record,
      durationMs: record.endedAt === undefined ? null : Math.max(0, record.endedAt - record.startedAt),
      status: record.endedAt === undefined ? 'running' : record.error === undefined ? 'ok' : 'failed',
    }))
    .slice()
    .reverse()
  const totals = { total: 0, automatic: 0, manual: 0, failed: 0, running: 0, shadowedTokens: 0 }
  for (const record of transactions) {
    totals.total += 1
    if (record.manual) totals.manual += 1
    else totals.automatic += 1
    if (record.status === 'failed') totals.failed += 1
    if (record.status === 'running') totals.running += 1
    totals.shadowedTokens += typeof record.shadowedTokenCount === 'number' ? record.shadowedTokenCount : 0
  }
  return { transactions, totals }
}

/**
 * The projection definition registered with `ctx.sessionProjections`.
 *
 * `stateVersion` starts at 1: bump it whenever a field or the fold semantics
 * change, so a stale cached checkpoint is discarded rather than replaying with
 * the wrong meaning.
 */
export const insightProjectionDefinition = {
  key: INSIGHT_PROJECTION_KEY,
  stateSchema,
  init: () => ({ transactions: [] }),
  apply: applyInsight,
  wire: {
    viewSchema,
    view: (state) => viewInsight(state),
    // Excluded from every Session summary: a summary-carried projection runs during
    // session load, where a throw fails the load and the host disposes the session.
    summary: false,
  },
  stateVersion: 1,
}
