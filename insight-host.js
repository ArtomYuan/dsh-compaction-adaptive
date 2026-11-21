/**
 * Host row for the insight panel.
 *
 * The compaction backend itself is mounted by the Agent preset. This row lives
 * in the profile instead, because a session projection is a host-level registry
 * whose values the browser reads — the browser half (`./client`) can only see
 * what a host half publishes.
 *
 * @module dsh-compaction-adaptive/insight-host
 */

import { insightProjectionDefinition } from './lib/projection.js'

export const name = 'compaction-insight-host'

/** The projection registry must exist before this row activates. */
export const inject = ['sessionProjections']

/**
 * Register the read-only projection behind the panel.
 * @param {any} ctx - plugin context.
 */
export function apply(ctx) {
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

export default { name, inject, apply }
