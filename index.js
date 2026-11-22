/**
 * Package root: the insight panel's host half.
 *
 * The root entry is what the profile mounts, and a profile row's `name` must be
 * an **exact package specifier** for its client bundle to load at all —
 * `dsh-client-modules` classifies a row whose name carries a subpath as "not a
 * client row" and never loads `./client`. So the browser half's host lives here,
 * and the compaction backend lives at `./engine`, which the Agent preset mounts
 * inside its `compaction` group (that row is deliberately *not* a client row).
 *
 * Host responsibilities:
 * 1. register the session projection the right-sidebar tab reads;
 * 2. serve two JSON routes for the panel, because a `main` page is root-scoped
 *    and receives no session props:
 *    - `/compaction-adaptive/insight?sessionId=…` — one session: durable
 *      transactions from the projection plus the engine's live plan snapshot;
 *    - `/compaction-adaptive/overview` — every session this process has planned,
 *      with its live numbers, for the cross-session overview page.
 *
 * @module dsh-compaction-adaptive
 */

import { attachInsightProjection } from './lib/projection-host.js'
import { INSIGHT_PROJECTION_KEY, viewInsight } from './lib/projection.js'
import { liveSessions, readLive } from './lib/live.js'
import { overviewPayload, resetOverviewCache } from './lib/aggregate.js'

/** One session: durable transactions plus the live snapshot. */
const DETAIL_ROUTE = '/compaction-adaptive/insight'
/** Cross-session overview for the root-scoped page. */
const OVERVIEW_ROUTE = '/compaction-adaptive/overview'

export const name = 'compaction-insight'

/** `webServer` and `sessions` arrive through `ctx.inject`, so they are optional here. */
export const inject = ['sessionProjections']

/**
 * Register the projection and the panel's data routes.
 * @param {any} ctx - plugin context.
 */
export function apply(ctx) {
  attachInsightProjection(ctx)

  ctx.inject(['webServer', 'sessionProjections', 'sessionQuery'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: DETAIL_ROUTE,
      handler: (req, res) => { serveDetail(scope, req, res) },
    }), 'compaction-insight: detail route')

    scope.effect(() => {
      scope.webServer.register({
        kind: 'exact',
        path: OVERVIEW_ROUTE,
        handler: (req, res) => { void serveOverview(scope, req, res) },
      })
      return () => {
        resetOverviewCache()
      }
    }, 'compaction-insight: overview route')
  })
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable payload.
 */
function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Detail for one session: projection transactions plus the live plan snapshot.
 * @param {any} ctx - plugin context carrying `sessionProjections`.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
function serveDetail(ctx, req, res) {
  try {
    const url = new URL(req.url ?? DETAIL_ROUTE, 'http://local')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null || sessionId === '') {
      send(res, 400, { error: 'sessionId is required' })
      return
    }
    const sessions = ctx.get('sessions')
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    const state = session === undefined
      ? undefined
      : ctx.sessionProjections.stateOf(session, INSIGHT_PROJECTION_KEY)
    send(res, 200, {
      sessionId,
      live: readLive(sessionId) ?? null,
      view: viewInsight(state),
      cold: session === undefined,
    })
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Overview for the root-scoped page: the whole session corpus (archived
 * included), one row per session with its durable compaction totals, plus the
 * live planning numbers this process holds for the sessions it measured.
 * @param {any} ctx - plugin context.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @returns {Promise<void>} resolves after the response is written.
 */
async function serveOverview(ctx, req, res) {
  try {
    const url = new URL(req.url ?? OVERVIEW_ROUTE, 'http://local')
    const query = url.searchParams.get('q') ?? ''
    const wanted = url.searchParams.get('limit')
    const limit = wanted === null ? undefined : Math.max(1, Math.min(200, Number(wanted) || 60))
    const payload = await overviewPayload(ctx, limit === undefined ? {} : { limit })
    const live = new Map(liveSessions().map(({ sessionId, snapshot }) => [sessionId, snapshot]))
    const rows = payload.rows
      .map((row) => {
        const snapshot = live.get(row.sessionId)
        return {
          ...row,
          live: snapshot === undefined
            ? null
            : {
              provider: snapshot.provider ?? null,
              model: snapshot.model ?? null,
              windowTokens: snapshot.measurement?.windowTokens ?? null,
              totalTokens: snapshot.measurement?.totalTokens ?? null,
              thresholdShare: snapshot.plan?.thresholdShare ?? null,
              tailTokens: snapshot.plan?.tailTokens ?? null,
              growthTokens: snapshot.plan?.growthTokens ?? null,
              turnsToThreshold: snapshot.plan?.turnsToThreshold ?? null,
              chunk: snapshot.chunk ?? null,
              at: snapshot.at ?? null,
            },
        }
      })
      .filter((row) => {
        if (query === '') return true
        const haystack = `${row.title ?? ''} ${row.cwd ?? ''} ${row.sessionId}`.toLowerCase()
        return haystack.includes(query.toLowerCase())
      })
    send(res, 200, { kpi: payload.kpi, sessions: rows, skipped: payload.skipped, at: payload.at, cached: payload.cached })
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

export default { name, inject, apply }
