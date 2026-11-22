/**
 * Process-local registry of each session's latest planning snapshot.
 *
 * The panel's budget and chunk cards describe *live engine state* — the resolved
 * window, the threshold it will compact at, the measured growth, the retained
 * tail, the learned chunk capacity — none of which is a durable event, so a
 * session projection cannot carry it (a projection must be replayable from the
 * log). The engine therefore publishes the snapshot it just computed here, and
 * the host route in `../index.js` reads it back for the browser.
 *
 * Scope: one process, best effort, bounded. Losing an entry only means the panel
 * falls back to the durable transaction list.
 *
 * @module dsh-compaction-adaptive/live
 */

/** Newest snapshots kept; older sessions are dropped. */
const LIMIT = 64

/** @type {Map<string, object>} */
const snapshots = new Map()

/**
 * Record one session's planning snapshot.
 * @param {unknown} sessionId - owning session id.
 * @param {object} snapshot - plain, JSON-serializable values.
 */
export function publishLive(sessionId, snapshot) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  snapshots.set(sessionId, snapshot)
  while (snapshots.size > LIMIT) {
    const oldest = snapshots.keys().next()
    if (oldest.done === true) break
    snapshots.delete(oldest.value)
  }
}

/**
 * Read one session's latest snapshot.
 * @param {unknown} sessionId - session id.
 * @returns {object | undefined} the snapshot, when this process planned it.
 */
export function readLive(sessionId) {
  return typeof sessionId === 'string' ? snapshots.get(sessionId) : undefined
}

/**
 * Every snapshot this process holds, newest first.
 * @returns {{ sessionId: string, snapshot: object }[]} the registry contents.
 */
export function liveSessions() {
  return [...snapshots.entries()]
    .map(([sessionId, snapshot]) => ({ sessionId, snapshot }))
    .sort((left, right) => (right.snapshot?.at ?? 0) - (left.snapshot?.at ?? 0))
}
