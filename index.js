/**
 * Package root: the insight panel's host half.
 *
 * The root entry is what the profile mounts, and a profile row's `name` must be
 * an **exact package specifier** for its client bundle to load at all —
 * `dsh-client-modules` classifies a row whose name carries a subpath as "not a
 * client row" (`exactPackageSpecifier` returns undefined) and never loads
 * `./client`. So the browser half's host lives here, and the compaction backend
 * lives at `./engine`, which the Agent preset mounts inside its `compaction`
 * group (that row is deliberately *not* a client row).
 *
 * Two host responsibilities:
 * 1. register the session projection the right-sidebar tab reads;
 * 2. serve the panel's page data over HTTP, because a `main` panel is
 *    root-scoped: it receives no session props and cannot read a session
 *    projection, so — like `dsh-context` does for its own page — the host
 *    answers with the projection it folds.
 *
 * @module dsh-compaction-adaptive
 */

import { attachInsightProjection } from './lib/projection-host.js'
import { INSIGHT_PROJECTION_KEY, viewInsight } from './lib/projection.js'

/** Route the panel page fetches. */
const ROUTE = '/compaction-adaptive/insight'

export const name = 'compaction-insight'

/** `webServer` and `sessions` arrive through `ctx.inject`, so they are optional here. */
export const inject = ['sessionProjections']

/**
 * Register the projection and the panel's data route.
 * @param {any} ctx - plugin context.
 */
export function apply(ctx) {
  attachInsightProjection(ctx)

  ctx.inject(['webServer', 'sessionProjections'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (req, res) => { serveInsight(scope, req, res) },
    }), 'compaction-insight: insight route')
  })
}

/**
 * Answer one panel request with the folded projection of the requested session.
 * @param {any} ctx - plugin context carrying `sessionProjections`.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {import('node:http').ServerResponse} res - response to write.
 */
function serveInsight(ctx, req, res) {
  const send = (status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(payload)
  }
  try {
    const url = new URL(req.url ?? ROUTE, 'http://local')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null || sessionId === '') {
      send(400, { error: 'sessionId is required' })
      return
    }
    const sessions = ctx.get('sessions')
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    if (session === undefined) {
      send(404, { error: `session not found: ${sessionId}` })
      return
    }
    const state = ctx.sessionProjections.stateOf(session, INSIGHT_PROJECTION_KEY)
    send(200, viewInsight(state))
  } catch (error) {
    send(500, { error: error instanceof Error ? error.message : String(error) })
  }
}

export default { name, inject, apply }
