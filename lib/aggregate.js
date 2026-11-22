/**
 * Cross-session aggregation behind the overview page.
 *
 * The page spans every session on disk, archived included, so it cannot read the
 * process-local live registry alone. `ctx.sessionQuery` lists the corpus and
 * observes one session at a time with its projections; each observation folds
 * that session's log, so the walk is bounded (a few sessions per request, cached)
 * and always disposes what it opened.
 *
 * Only durable facts are aggregated here: the compaction projection. Live
 * planning numbers (window, threshold, tail, chunk capacity) stay in
 * `live.js`, because they do not exist for a session this process never planned.
 *
 * @module dsh-compaction-adaptive/aggregate
 */

import { INSIGHT_PROJECTION_KEY, viewInsight } from './projection.js'

/** Observations folded per request; the page paginates the rest. */
const SCAN_LIMIT = 60

/** Cached aggregate keyed by the corpus revision we observed. */
let cache = { at: 0, value: null }

/** Empty totals so a session without a projection still counts as seen. */
const EMPTY_TOTALS = { total: 0, automatic: 0, manual: 0, failed: 0, running: 0, shadowedTokens: 0 }

/**
 * Read the projection value out of an observation snapshot, tolerating both the
 * `values`-keyed and the flat shape.
 * @param {unknown} snapshot - `ProjectionSnapshot`.
 * @returns {object | undefined} the wire value for this unit's key.
 */
function projectionValue(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const values = snapshot.values
  if (values !== null && typeof values === 'object' && INSIGHT_PROJECTION_KEY in values) {
    return values[INSIGHT_PROJECTION_KEY]
  }
  if (INSIGHT_PROJECTION_KEY in snapshot) return snapshot[INSIGHT_PROJECTION_KEY]
  return undefined
}

/**
 * Walk the session corpus and fold each session's compaction projection into one
 * row. Failures are per session: one unreadable log never fails the page.
 * @param {any} ctx - plugin context carrying `sessionQuery`.
 * @param {{ signal?: AbortSignal, limit?: number }} options - walk options.
 * @returns {Promise<{ rows: object[], scanned: number, skipped: number }>} the aggregate.
 */
export async function collectOverview(ctx, options = {}) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.listSessions !== 'function') {
    return { rows: [], scanned: 0, skipped: 0 }
  }
  const signal = options.signal
  const limit = options.limit ?? SCAN_LIMIT
  let records
  try {
    records = await query.listSessions(signal)
  } catch {
    return { rows: [], scanned: 0, skipped: 0 }
  }

  const rows = []
  let skipped = 0
  for (const record of records.slice(0, limit)) {
    const header = record?.header
    const sessionId = header?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      skipped += 1
      continue
    }
    let observation
    try {
      observation = await query.observeSession(sessionId, { projectionMode: 'all', signal })
      const view = viewInsight(projectionValue(observation.projections))
      const totals = view.totals ?? EMPTY_TOTALS
      const newest = view.transactions?.[0]
      // The header rarely carries a title: the shell folds it from title events,
      // so ask the query engine, which prefers the live log.
      let title = typeof header.title === 'string' && header.title !== '' ? header.title : undefined
      if (title === undefined && typeof query.readTitle === 'function') {
        try {
          const snapshot = await query.readTitle(sessionId, signal)
          const text = typeof snapshot?.title === 'string' ? snapshot.title : snapshot?.text
          if (typeof text === 'string' && text !== '') title = text
        } catch {
          // A title is cosmetic; the row still counts without one.
        }
      }
      rows.push({
        sessionId,
        title: title ?? sessionId.slice(0, 18),
        titled: title !== undefined,
        cwd: typeof header.cwd === 'string' ? header.cwd : null,
        createdAt: header.createdAt ?? null,
        live: record.live === true,
        persisted: record.persisted === true,
        totals,
        transactions: view.transactions?.length ?? 0,
        lastAt: newest?.startedAt ?? null,
        lastStatus: newest?.status ?? null,
        lastShare: null,
        lastShadowedTokens: newest?.shadowedTokenCount ?? null,
      })
    } catch {
      skipped += 1
    } finally {
      try {
        observation?.dispose?.()
      } catch {
        // A failed dispose cannot change what was already read.
      }
    }
  }

  rows.sort((left, right) => (right.lastAt ?? 0) - (left.lastAt ?? 0))
  return { rows, scanned: rows.length, skipped }
}

/**
 * KPI totals over the aggregated rows.
 * @param {object[]} rows - rows from {@link collectOverview}.
 * @returns {object} card values.
 */
export function summarise(rows) {
  const kpi = {
    sessions: rows.length,
    compactedSessions: 0,
    transactions: 0,
    automatic: 0,
    manual: 0,
    failed: 0,
    running: 0,
    shadowedTokens: 0,
  }
  for (const row of rows) {
    const totals = row.totals ?? EMPTY_TOTALS
    if (totals.total > 0) kpi.compactedSessions += 1
    kpi.transactions += totals.total
    kpi.automatic += totals.automatic
    kpi.manual += totals.manual
    kpi.failed += totals.failed
    kpi.running += totals.running
    kpi.shadowedTokens += totals.shadowedTokens
  }
  kpi.successRate = kpi.transactions === 0 ? null : (kpi.transactions - kpi.failed) / kpi.transactions
  kpi.averageShadowedTokens = kpi.transactions === 0 ? null : kpi.shadowedTokens / kpi.transactions
  return kpi
}

/**
 * Aggregate with a short cache so paging and refreshes do not refold every log.
 * @param {any} ctx - plugin context.
 * @param {{ ttlMs?: number, signal?: AbortSignal }} options - cache options.
 * @returns {Promise<{ kpi: object, rows: object[], skipped: number, at: number, cached: boolean }>} payload.
 */
export async function overviewPayload(ctx, options = {}) {
  const ttl = options.ttlMs ?? 15_000
  const now = Date.now()
  if (cache.value !== null && now - cache.at < ttl) {
    return { ...cache.value, cached: true }
  }
  const { rows, skipped } = await collectOverview(ctx, options)
  const payload = { kpi: summarise(rows), rows, skipped, at: now }
  cache = { at: now, value: payload }
  return { ...payload, cached: false }
}

/** Drop the cached aggregate (used when the row unloads). */
export function resetOverviewCache() {
  cache = { at: 0, value: null }
}
