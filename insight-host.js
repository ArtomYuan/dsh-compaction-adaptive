/**
 * Backwards-compatible alias for the pre-0.3 root row name.
 *
 * The projection host now lives at the package root (see `../index.js`) because a
 * profile row's `name` must be an exact package specifier for its client bundle
 * to load. This module stays so an existing row that names
 * `dsh-compaction-adaptive/insight-host` keeps working.
 *
 * @module dsh-compaction-adaptive/insight-host
 */

import { attachInsightProjection } from './lib/projection-host.js'

export const name = 'compaction-insight'

export const inject = ['sessionProjections']

export function apply(ctx) {
  attachInsightProjection(ctx)
}

export default { name, inject, apply }
