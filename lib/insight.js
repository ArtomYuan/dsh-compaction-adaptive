/**
 * Read-only projections for the compaction insight panel.
 *
 * Everything here is derived from facts the harness already keeps: the same
 * `TokenMeasurement` the pressure gate uses, the plan the engine installed, the
 * chunk budgets derived from the summary model's window, and the durable
 * `compaction/*` events. Nothing here writes to a session, so a panel can call
 * it as often as it likes.
 *
 * Deliberate honesty rules:
 * - `compaction/start` records only `turn`/`sourceCommandId`, so the panel may
 *   say "manual" vs "automatic", never "pressure" vs "overflow".
 * - `compaction/summary` records the shadowed span and the summarizing route,
 *   never whether the call was chunked. Chunk evidence therefore comes from the
 *   engine's own in-process log (`chunkRuns`), which is not durable and does not
 *   claim to be.
 *
 * @module dsh-compaction-adaptive/insight
 */

/** One compaction transaction rebuilt from its durable events. */
const COMPACTION_TYPES = new Set(['compaction/start', 'compaction/summary', 'compaction/end'])

/** Fraction of a whole for one bar segment; 0 when the whole is unknown. */
function share(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0
  return Math.max(0, Math.min(1, part / whole))
}

/**
 * Number of measured turns until the surface reaches the pressure threshold.
 * @param {number} totalTokens - current surface pressure.
 * @param {number} thresholdTokens - installed trigger point.
 * @param {number} growthTokens - per-turn growth estimate.
 * @returns {number | null} turns, or `null` when growth is not positive.
 */
export function turnsToThreshold(totalTokens, thresholdTokens, growthTokens) {
  if (!Number.isFinite(growthTokens) || growthTokens <= 0) return null
  const remaining = thresholdTokens - totalTokens
  if (remaining <= 0) return 0
  return Math.ceil(remaining / growthTokens)
}

/**
 * Shape the panel's top card: how full the window is, where the trigger sits,
 * and how the bar splits into retained tail, usable middle, and free headroom.
 * @param {object} input - snapshot input.
 * @param {any} input.plan - installed plan from the policy module.
 * @param {{totalTokens: number}} input.measurement - current meeting.
 * @param {Readonly<Record<string, any>>} input.adaptive - effective adaptive settings.
 * @returns {object} panel card data.
 */
export function budgetSnapshot(input) {
  const total = Number.isFinite(input.measurement?.totalTokens) ? input.measurement.totalTokens : 0
  const plan = input.plan ?? null
  const window = plan?.contextWindow ?? 0
  const budget = plan?.messageBudget ?? 0
  const threshold = plan?.thresholdTokens ?? 0
  const tail = plan?.retainTokens ?? 0
  const growth = plan?.growthTokens ?? 0
  return {
    totalTokens: total,
    windowTokens: window,
    budgetTokens: budget,
    thresholdTokens: threshold,
    thresholdRatio: plan?.thresholdRatio ?? null,
    tailTokens: tail,
    growthTokens: growth,
    usedRatio: share(total, window),
    thresholdShare: share(threshold, window),
    tailShare: share(tail, window),
    usableShare: share(Math.max(0, Math.min(total, threshold) - tail), window),
    freeShare: share(Math.max(0, window - Math.max(total, threshold)), window),
    turnsToThreshold: turnsToThreshold(total, threshold, growth),
    turnsAhead: input.adaptive?.turnsAhead ?? null,
    profile: input.adaptive?.profile ?? null,
    mode: input.adaptive?.mode ?? null,
  }
}

/**
 * Derive the chunk card's budgets for one route.
 * @param {object} input - snapshot input.
 * @param {Readonly<Record<string, any>>} input.chunkConfig - resolved chunking configuration.
 * @param {{window: number, reservedTokens: number, overheadTokens: number}} input.capacity - summary-model capacity.
 * @param {number} input.scale - learned capacity multiplier for the route.
 * @returns {object} chunk card data.
 */
export function chunkSnapshot(input) {
  const config = input.chunkConfig
  const capacity = Math.max(
    0,
    (input.capacity.window > 0 ? input.capacity.window : 0) - input.capacity.reservedTokens - input.capacity.overheadTokens,
  )
  const scale = Number.isFinite(input.scale) ? input.scale : 1
  const adaptive = config.chunkSizing !== 'fixed'
  return {
    enabled: config.chunking !== 'off',
    sizing: config.chunkSizing,
    scale,
    capacityTokens: capacity,
    singleShotTokens: Math.floor(capacity * (adaptive ? config.chunkSingleShotRatio : 1) * scale),
    partTokens: Math.max(256, Math.floor(capacity * (adaptive ? config.chunkTokenRatio : 1) * scale)),
    partBytes: Math.max(10_000, Math.floor(config.chunkBytes * scale)),
    triggerBytes: Math.floor(config.chunkTriggerBytes * scale),
    concurrency: config.chunkConcurrency,
    retries: config.chunkRetries,
    shrinkAttempts: config.chunkShrinkAttempts,
    shrinkFactor: config.chunkShrinkFactor,
    recoverFactor: config.chunkRecoverFactor,
    minScale: config.chunkMinScale,
  }
}

/**
 * Rebuild compaction transactions from durable events.
 *
 * Pairs `start`/`summary`/`end` by `compactionId`; a transaction keeps its
 * summary even when the close carries an error, because both facts matter to a
 * reader ("it wrote a summary, then failed to commit" is different from "it
 * never summarized").
 * @param {readonly any[]} events - session events in log order.
 * @param {number} [limit] - newest records to keep.
 * @returns {object[]} newest-first transactions.
 */
export function summarizeCompactions(events, limit = 20) {
  const open = new Map()
  const done = []
  for (const event of events ?? []) {
    if (!COMPACTION_TYPES.has(event?.type)) continue
    const id = event.data?.compactionId
    if (id === undefined) continue
    let record = open.get(id)
    if (record === undefined) {
      record = { compactionId: id }
      open.set(id, record)
    }
    if (event.type === 'compaction/start') {
      record.startedAt = event.time
      record.seq = event.seq
      record.turn = event.data.turn
      record.manual = event.data.turn === null
      record.commandId = event.data.sourceCommandId ?? null
    } else if (event.type === 'compaction/summary') {
      record.shadowedTokenCount = event.data.shadowedTokenCount ?? 0
      record.shadowedNodes = Array.isArray(event.data.shadowedSeqs) ? event.data.shadowedSeqs.length : 0
      record.provider = event.data.provider ?? null
      record.model = event.data.model ?? null
      record.maxTokens = event.data.maxTokens ?? null
      record.summaryChars = Array.isArray(event.data.summary)
        ? event.data.summary.reduce((sum, block) => sum + (typeof block?.text === 'string' ? block.text.length : 0), 0)
        : 0
    } else {
      record.endedAt = event.time
      record.error = event.data.error ?? null
      open.delete(id)
      done.push(record)
    }
  }
  // A transaction still open when the panel reads is a live lock, not history.
  for (const record of open.values()) done.push({ ...record, inFlight: true })
  done.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
  return done.slice(0, limit).map((record) => ({
    ...record,
    durationMs: record.startedAt !== undefined && record.endedAt !== undefined
      ? Math.max(0, record.endedAt - record.startedAt)
      : null,
    status: record.inFlight === true ? 'running' : record.error ? 'failed' : 'ok',
  }))
}

/**
 * Count automatic vs manual and ok vs failed transactions for a summary strip.
 * @param {readonly any[]} records - transactions from {@link summarizeCompactions}.
 * @returns {{total: number, automatic: number, manual: number, failed: number, running: number, shadowedTokens: number}} counts.
 */
export function compactionTotals(records) {
  const totals = { total: 0, automatic: 0, manual: 0, failed: 0, running: 0, shadowedTokens: 0 }
  for (const record of records ?? []) {
    totals.total += 1
    if (record.manual === true) totals.manual += 1
    else totals.automatic += 1
    if (record.status === 'failed') totals.failed += 1
    if (record.status === 'running') totals.running += 1
    totals.shadowedTokens += Number.isFinite(record.shadowedTokenCount) ? record.shadowedTokenCount : 0
  }
  return totals
}

/**
 * Append one in-process chunk run, keeping the log bounded.
 * @param {object[]} log - mutable run log, oldest first.
 * @param {object} entry - run facts.
 * @param {number} [limit] - maximum retained entries.
 * @returns {object[]} the same log.
 */
export function recordChunkRun(log, entry, limit = 20) {
  log.push({ ...entry })
  while (log.length > limit) log.shift()
  return log
}

/**
 * Append one learned-capacity change, keeping the series bounded.
 * @param {object[]} series - mutable series, oldest first.
 * @param {object} entry - `{ at, scale, reason }`.
 * @param {number} [limit] - maximum retained points.
 * @returns {object[]} the same series.
 */
export function recordScaleChange(series, entry, limit = 40) {
  const last = series[series.length - 1]
  if (last !== undefined && last.scale === entry.scale && last.reason === entry.reason) return series
  series.push({ ...entry })
  while (series.length > limit) series.shift()
  return series
}
