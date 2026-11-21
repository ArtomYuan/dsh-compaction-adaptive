/**
 * Attach the insight projection to a plugin context.
 *
 * Kept separate from the package root so both the root row and any other host
 * row can reuse it, and so the root stays a thin Cordis plugin.
 *
 * @module dsh-compaction-adaptive/projection-host
 */

import { insightProjectionDefinition } from './projection.js'

/**
 * Register the projection and tie its lifetime to the row.
 * @param {any} ctx - plugin context carrying `sessionProjections`.
 */
export function attachInsightProjection(ctx) {
  let disposed = false
  let handle
  ctx.effect(() => () => {
    disposed = true
    handle?.dispose?.()
  }, 'compaction-insight projection lifetime')

  ctx.sessionProjections.register(insightProjectionDefinition).then(
    (registered) => {
      handle = registered
      if (disposed) {
        handle?.dispose?.()
        return
      }
      ctx.logger?.info(`[compaction-insight] projection "${insightProjectionDefinition.key}" registered`)
    },
    (error) => {
      ctx.logger?.warn(`[compaction-insight] projection registration failed: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}
