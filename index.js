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

  ctx.inject(['webServer', 'sessionProjections'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: DETAIL_ROUTE,
      handler: (req, res) => { serveDetail(scope, req, res) },
    }), 'compaction-insight: detail route')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: OVERVIEW_ROUTE,
      handler: (req, res) => { serveOverview(res) },
    }), 'compaction-insight: overview route')
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
 * Overview for the root-scoped page: every session this process planned, with
 * the live numbers that describe it. Sessions never planned in this process are
 * absent — their numbers do not exist yet, and inventing them would be worse.
 * @param {import('node:http').ServerResponse} res - response.
 */
function serveOverview(res) {
  try {
    send(res, 200, {
      sessions: liveSessions().map(({ sessionId, snapshot }) => ({
        sessionId,
        at: snapshot?.at ?? null,
        provider: snapshot?.provider ?? null,
        model: snapshot?.model ?? null,
        trigger: snapshot?.trigger ?? null,
        windowTokens: snapshot?.measurement?.windowTokens ?? null,
        totalTokens: snapshot?.measurement?.totalTokens ?? null,
        thresholdTokens: snapshot?.plan?.thresholdTokens ?? null,
        thresholdShare: snapshot?.plan?.thresholdShare ?? null,
        tailTokens: snapshot?.plan?.tailTokens ?? null,
        growthTokens: snapshot?.plan?.growthTokens ?? null,
        turnsToThreshold: snapshot?.plan?.turnsToThreshold ?? null,
        chunk: snapshot?.chunk ?? null,
      })),
    })
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

export default { name, inject, apply }
