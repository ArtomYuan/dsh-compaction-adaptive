/**
 * Adaptive shrink planning.
 *
 * The base engine refuses a compaction whose summary is not strictly smaller
 * than the content it shadows. A fixed target ratio cannot express that: how far
 * a checkpoint compresses depends on what the shadowed range *is* (a previous
 * checkpoint compresses badly, raw tool output compresses well) and on the
 * structural floor a checkpoint cannot go below (its headings and required
 * sections cost tokens no matter how terse the prose).
 *
 * So the budget is derived, not configured:
 *
 *   target  = (shadowed - floor) * ratio        ratio learned per route
 *   ladder  = target, then a quarter of the previous attempt
 *   gate    = skip entirely when the best possible gain is not worth a call
 *
 * Every knob here is a *bound*, not a value: `ratioInit` only seeds the learning,
 * `margin` only guards against estimation error, `floorTokens` only seeds the
 * structural floor.
 *
 * @module dsh-compaction-adaptive/shrink
 */

/** Bounds for the derived budget; all optional at the call site. */
export const SHRINK_DEFAULTS = Object.freeze({
  /** Seed for the structural floor of a checkpoint, in tokens. */
  floorTokens: 400,
  /** Seed for the achievable compression ratio. */
  ratioInit: 0.5,
  /** Never plan above this share of the shadowed range. */
  ratioMax: 0.7,
  /** Never plan below this share; a summary still has to be useful. */
  ratioMin: 0.25,
  /** The result must land under `shadowed * margin` to satisfy the guard. */
  margin: 0.92,
  /** Best possible gain, in tokens, below which a call is not worth making. */
  minGainTokens: 64,
  /** Attempts in the ladder. */
  attempts: 3,
  /** Each retry multiplies the previous budget by this factor. */
  shaveFactor: 0.35,
  /** Smallest budget the ladder may propose. */
  minBudgetTokens: 96,
  /** EMA weight for learning the achievable ratio. */
  ratioAlpha: 0.4,
})

/**
 * Resolve the config with defaults, clamping the bounds.
 * @param {object} [input] - partial config.
 * @returns {typeof SHRINK_DEFAULTS} resolved config.
 */
export function resolveShrinkConfig(input = {}) {
  const read = (key, min, max) => {
    const raw = input?.[key]
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : SHRINK_DEFAULTS[key]
    return Math.min(max, Math.max(min, value))
  }
  return {
    floorTokens: read('floorTokens', 64, 8192),
    ratioInit: read('ratioInit', 0.05, 0.95),
    ratioMax: read('ratioMax', 0.1, 0.98),
    ratioMin: read('ratioMin', 0.02, 0.9),
    margin: read('margin', 0.5, 0.99),
    minGainTokens: read('minGainTokens', 0, 8192),
    attempts: Math.round(read('attempts', 1, 6)),
    shaveFactor: read('shaveFactor', 0.1, 0.9),
    minBudgetTokens: read('minBudgetTokens', 32, 4096),
    ratioAlpha: read('ratioAlpha', 0.05, 1),
  }
}

/**
 * Plan the shrink for one summary.
 *
 * The gain test comes first: when even a perfect compression would save less than
 * one call's worth of tokens, compacting is not worth it, and attempting it is
 * how a small shadowed range fails the base guard over and over.
 * @param {{ shadowedTokens: number, config?: object, ratio?: number }} input - inputs.
 * @returns {{ attempt: boolean, reason: string, ceiling: number, floor: number, ratio: number, budgets: number[] }} plan.
 */
export function planShrink(input) {
  const config = resolveShrinkConfig(input.config)
  const shadowed = Math.max(0, Math.round(input.shadowedTokens ?? 0))
  const ratio = clampRatio(input.ratio ?? config.ratioInit, config)
  const floor = Math.min(config.floorTokens, Math.floor(shadowed * 0.8))
  const ceiling = Math.floor(shadowed * config.margin)
  const bestGain = shadowed - Math.max(floor, Math.min(ceiling, Math.round((shadowed - floor) * config.ratioMin)))
  if (shadowed <= 0) {
    return { attempt: false, reason: 'empty-shadow', ceiling, floor, ratio, budgets: [] }
  }
  if (bestGain < config.minGainTokens) {
    return { attempt: false, reason: 'not-worth-it', ceiling, floor, ratio, budgets: [] }
  }
  const ideal = Math.round((shadowed - floor) * ratio)
  const budgets = []
  let current = clamp(ideal, config.minBudgetTokens, Math.max(config.minBudgetTokens, ceiling))
  for (let index = 0; index < config.attempts; index += 1) {
    if (current < config.minBudgetTokens) break
    budgets.push(current)
    current = Math.floor(current * config.shaveFactor)
  }
  if (budgets.length === 0) budgets.push(Math.min(config.minBudgetTokens, Math.max(1, ceiling)))
  return { attempt: true, reason: 'shrink', ceiling, floor, ratio, budgets }
}

/**
 * Decide whether a produced summary satisfies the shrink requirement.
 * @param {{ summaryTokens: number, shadowedTokens: number, config?: object }} input - measured sizes.
 * @returns {boolean} true when the summary is small enough to commit.
 */
export function satisfiesShrink(input) {
  const config = resolveShrinkConfig(input.config)
  return input.summaryTokens <= Math.floor((input.shadowedTokens ?? 0) * config.margin)
}

/**
 * Fold one observed outcome into the route's ratio.
 *
 * The observed value is clamped to the configured bounds first, so a freak result
 * cannot drag the estimate outside what the next plan may legally propose.
 * @param {number} previous - current ratio.
 * @param {{ observedRatio: number, config?: object }} input - measurement.
 * @returns {number} next ratio.
 */
export function learnRatio(previous, input) {
  const config = resolveShrinkConfig(input.config)
  const observed = clampRatio(input.observedRatio, config)
  const base = typeof previous === 'number' && Number.isFinite(previous) ? clampRatio(previous, config) : config.ratioInit
  return clampRatio(base + (observed - base) * config.ratioAlpha, config)
}

/**
 * Clamp a ratio into the configured band.
 * @param {number} value - candidate.
 * @param {typeof SHRINK_DEFAULTS} config - resolved config.
 * @returns {number} clamped ratio.
 */
function clampRatio(value, config) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return config.ratioInit
  return Math.min(config.ratioMax, Math.max(config.ratioMin, value))
}

/**
 * Clamp a value.
 * @param {number} value - candidate.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped value.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
