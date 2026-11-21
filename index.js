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
 * @module dsh-compaction-adaptive
 */

import { attachInsightProjection } from './lib/projection-host.js'

export const name = 'compaction-insight'

/** The projection registry must exist before this row activates. */
export const inject = ['sessionProjections']

/**
 * Register the read-only projection behind the panel.
 * @param {any} ctx - plugin context.
 */
export function apply(ctx) {
  attachInsightProjection(ctx)
}

export default { name, inject, apply }
