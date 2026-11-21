/**
 * Pure adaptive budgeting for the adaptive compaction backend.
 *
 * Nothing here touches a Context, a Session, or the LLM seam: the whole policy
 * decision is a function of (window, reserved output, measured growth). That
 * keeps the interesting arithmetic testable with a plain Node process, while
 * `lib/index.js` owns the durable compaction protocol it reuses from
 * `@deepseek-ai/dsh-compaction-basic`.
 *
 * @module dsh-compaction-adaptive/policy
 */

/** Strategy profiles: how much working room the policy tries to keep. */
export const PROFILES = Object.freeze({
  economy: Object.freeze({ turnsAhead: 0.6, tailScale: 0.6, headroomScale: 0.9, tailMaxScale: 0.8 }),
  balanced: Object.freeze({ turnsAhead: 1, tailScale: 1, headroomScale: 1, tailMaxScale: 1 }),
  quality: Object.freeze({ turnsAhead: 1.75, tailScale: 1.4, headroomScale: 1.15, tailMaxScale: 1.25 }),
})

/** Scalar configuration keys consumed by this module (the rest belongs to the base backend). */
export const ADAPTIVE_KEYS = Object.freeze([
  'mode',
  'profile',
  'turnsAhead',
  'growthAlpha',
  'floorRatio',
  'ceilRatio',
  'headroomMinRatio',
  'headroomMaxRatio',
  'minHeadroomTokens',
  'tailRatio',
  'tailMinTokens',
  'tailMaxRatio',
  'keepTurns',
  'cooldownSteps',
  'thrashMargin',
  'minGrowthTokens',
  'verbose',
])

const DEFAULTS = Object.freeze({
  mode: 'adaptive',
  profile: 'balanced',
  turnsAhead: 3,
  growthAlpha: 0.35,
  floorRatio: 0.35,
  ceilRatio: 0.9,
  headroomMinRatio: 0.06,
  headroomMaxRatio: 0.4,
  minHeadroomTokens: 0,
  tailRatio: 0.1,
  tailMinTokens: 4096,
  tailMaxRatio: 0.22,
  keepTurns: 1,
  cooldownSteps: 1,
  thrashMargin: 1.15,
  minGrowthTokens: 0,
  verbose: false,
})

/** Supported `mode` values. */
export const MODES = Object.freeze(['adaptive', 'fixed'])

function fail(message) {
  throw new Error(`dsh-compaction-adaptive: ${message}`)
}

function assertNumber(name, value, { min, max, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${name} (${String(value)}) must be a finite number`)
  }
  if (integer && !Number.isInteger(value)) fail(`${name} (${value}) must be an integer`)
  if (min !== undefined && value < min) fail(`${name} (${value}) must be >= ${min}`)
  if (max !== undefined && value > max) fail(`${name} (${value}) must be <= ${max}`)
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high)
}

/**
 * Validate the adaptive half of the plugin configuration.
 *
 * @param {Record<string, unknown>} [raw] - raw plugin configuration.
 * @returns {Readonly<Record<string, any>>} resolved adaptive configuration.
 */
export function resolveAdaptiveConfig(raw = {}) {
  const config = { ...DEFAULTS }
  for (const key of ADAPTIVE_KEYS) {
    if (raw[key] !== undefined) config[key] = raw[key]
  }

  if (!MODES.includes(config.mode)) {
    fail(`mode (${String(config.mode)}) must be one of ${MODES.join(', ')}`)
  }
  if (!Object.hasOwn(PROFILES, config.profile)) {
    fail(`profile (${String(config.profile)}) must be one of ${Object.keys(PROFILES).join(', ')}`)
  }
  assertNumber('turnsAhead', config.turnsAhead, { min: 0.25, max: 50 })
  assertNumber('growthAlpha', config.growthAlpha, { min: 0.01, max: 1 })
  assertNumber('floorRatio', config.floorRatio, { min: 0.05, max: 1 })
  assertNumber('ceilRatio', config.ceilRatio, { min: 0.05, max: 1 })
  assertNumber('headroomMinRatio', config.headroomMinRatio, { min: 0, max: 1 })
  assertNumber('headroomMaxRatio', config.headroomMaxRatio, { min: 0.01, max: 1 })
  assertNumber('minHeadroomTokens', config.minHeadroomTokens, { min: 0, integer: true })
  assertNumber('tailRatio', config.tailRatio, { min: 0, max: 1 })
  assertNumber('tailMinTokens', config.tailMinTokens, { min: 0, integer: true })
  assertNumber('tailMaxRatio', config.tailMaxRatio, { min: 0.01, max: 1 })
  assertNumber('keepTurns', config.keepTurns, { min: 0, max: 20 })
  assertNumber('cooldownSteps', config.cooldownSteps, { min: 0, max: 20, integer: true })
  assertNumber('thrashMargin', config.thrashMargin, { min: 1, max: 3 })
  assertNumber('minGrowthTokens', config.minGrowthTokens, { min: 0, integer: true })
  if (typeof config.verbose !== 'boolean') fail('verbose must be a boolean')
  if (config.floorRatio > config.ceilRatio) {
    fail(`floorRatio (${config.floorRatio}) must not exceed ceilRatio (${config.ceilRatio})`)
  }
  if (config.headroomMinRatio > config.headroomMaxRatio) {
    fail(`headroomMinRatio (${config.headroomMinRatio}) must not exceed headroomMaxRatio (${config.headroomMaxRatio})`)
  }
  return Object.freeze(config)
}

/**
 * Fold one measured step delta into the session's growth estimate.
 *
 * A non-positive delta means the surface shrank (a compaction landed, or the
 * turn consumed a pruned tool output); it re-baselines without polluting the
 * estimate, because the useful signal is how fast the session grows, not the
 * size of a summary.
 *
 * @param {number} previous - current estimate in tokens.
 * @param {number} delta - measured tokens added since the previous observation.
 * @param {number} alpha - exponential weight of the newest sample in (0, 1].
 * @returns {number} the updated estimate.
 */
export function nextGrowth(previous, delta, alpha) {
  if (!Number.isFinite(delta) || delta <= 0) return previous
  if (!Number.isFinite(previous) || previous <= 0) return delta
  return alpha * delta + (1 - alpha) * previous
}

/**
 * Validate one route's partial adaptive overrides.
 *
 * Routes exist for cost, not for overflow: a route whose prefill is expensive
 * wants a lower ceiling even when the window is large. A partial override only
 * has to be self-consistent; it is merged over the service defaults at planning
 * time, so omitted keys keep adapting globally.
 *
 * @param {Record<string, unknown>} raw - one `routes` entry.
 * @param {number} index - entry position, used in diagnostics.
 * @returns {Readonly<Record<string, any>>} the validated partial override.
 */
export function resolveRouteOverride(raw, index = 0) {
  const name = `routes[${index}]`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`)
  for (const key of Object.keys(raw)) {
    if (!ADAPTIVE_KEYS.includes(key) && key !== 'provider' && key !== 'model') {
      fail(`${name}: unknown key "${key}"`)
    }
  }
  if (typeof raw.provider !== 'string' || raw.provider.length === 0) fail(`${name}.provider must be a non-empty string`)
  if (typeof raw.model !== 'string' || raw.model.length === 0) fail(`${name}.model must be a non-empty string`)

  /** @type {Record<string, any>} */
  const override = {}
  for (const key of ADAPTIVE_KEYS) {
    if (raw[key] !== undefined) override[key] = raw[key]
  }
  // Validate each supplied key on its own: a route may lower only the ceiling,
  // and the floor/ceiling relation is settled by `mergeAdaptive` against the
  // service defaults it will actually merge with.
  if (override.mode !== undefined && !MODES.includes(override.mode)) {
    fail(`${name}.mode (${String(override.mode)}) must be one of ${MODES.join(', ')}`)
  }
  if (override.profile !== undefined && !Object.hasOwn(PROFILES, override.profile)) {
    fail(`${name}.profile (${String(override.profile)}) must be one of ${Object.keys(PROFILES).join(', ')}`)
  }
  if (override.turnsAhead !== undefined) assertNumber(`${name}.turnsAhead`, override.turnsAhead, { min: 0.25, max: 50 })
  if (override.growthAlpha !== undefined) assertNumber(`${name}.growthAlpha`, override.growthAlpha, { min: 0.01, max: 1 })
  if (override.floorRatio !== undefined) assertNumber(`${name}.floorRatio`, override.floorRatio, { min: 0.05, max: 1 })
  if (override.ceilRatio !== undefined) assertNumber(`${name}.ceilRatio`, override.ceilRatio, { min: 0.05, max: 1 })
  if (override.headroomMinRatio !== undefined) assertNumber(`${name}.headroomMinRatio`, override.headroomMinRatio, { min: 0, max: 1 })
  if (override.headroomMaxRatio !== undefined) assertNumber(`${name}.headroomMaxRatio`, override.headroomMaxRatio, { min: 0.01, max: 1 })
  if (override.minHeadroomTokens !== undefined) assertNumber(`${name}.minHeadroomTokens`, override.minHeadroomTokens, { min: 0, integer: true })
  if (override.tailRatio !== undefined) assertNumber(`${name}.tailRatio`, override.tailRatio, { min: 0, max: 1 })
  if (override.tailMinTokens !== undefined) assertNumber(`${name}.tailMinTokens`, override.tailMinTokens, { min: 0, integer: true })
  if (override.tailMaxRatio !== undefined) assertNumber(`${name}.tailMaxRatio`, override.tailMaxRatio, { min: 0.01, max: 1 })
  if (override.keepTurns !== undefined) assertNumber(`${name}.keepTurns`, override.keepTurns, { min: 0, max: 20 })
  if (override.cooldownSteps !== undefined) assertNumber(`${name}.cooldownSteps`, override.cooldownSteps, { min: 0, max: 20, integer: true })
  if (override.thrashMargin !== undefined) assertNumber(`${name}.thrashMargin`, override.thrashMargin, { min: 1, max: 3 })
  if (override.minGrowthTokens !== undefined) assertNumber(`${name}.minGrowthTokens`, override.minGrowthTokens, { min: 0, integer: true })
  if (override.verbose !== undefined && typeof override.verbose !== 'boolean') fail(`${name}.verbose must be a boolean`)
  return Object.freeze(override)
}

/**
 * Merge one route's partial overrides over the service defaults and settle the
 * cross-field relations the pure planner relies on.
 * @param {Readonly<Record<string, any>>} base - resolved service defaults.
 * @param {Readonly<Record<string, any>> | undefined} override - partial route override.
 * @returns {Record<string, any>} effective settings.
 */
export function mergeAdaptive(base, override) {
  if (override === undefined) return base
  const merged = { ...base, ...override }
  if (merged.floorRatio > merged.ceilRatio) merged.floorRatio = merged.ceilRatio
  if (merged.headroomMinRatio > merged.headroomMaxRatio) {
    merged.headroomMinRatio = merged.headroomMaxRatio
  }
  return merged
}

/**
 * Build the exact-route override table.
 * @param {readonly unknown[] | undefined} list - configured `routes` entries.
 * @returns {ReadonlyMap<string, Readonly<Record<string, any>>>} overrides keyed by `provider\\u0000model`.
 */
export function resolveRoutes(list) {
  const table = new Map()
  if (list === undefined) return table
  if (!Array.isArray(list)) fail('routes must be an array')
  for (const [index, raw] of list.entries()) {
    const override = resolveRouteOverride(raw, index)
    const key = `${raw.provider}\u0000${raw.model}`
    if (table.has(key)) fail(`routes: duplicate entry for ${raw.provider}/${raw.model}`)
    table.set(key, override)
  }
  return table
}

/** Key used by the route override table. */
export function routeKey(provider, model) {
  return `${provider}\u0000${model}`
}

/**
 * Choose the pressure threshold and retained tail for one routed model.
 *
 * The threshold is expressed twice, exactly as the base backend expects it:
 * as a window fraction (`thresholdRatio`) and as the absolute headroom it
 * leaves below the message budget (`headroomTokens`), so both `min()` terms
 * agree on one token budget.
 *
 * @param {object} input - planning input.
 * @param {number} input.contextWindow - adapter-declared window in tokens.
 * @param {number} input.reservedTokens - output tokens the routed request reserves.
 * @param {number} input.growthTokens - per-turn growth estimate in tokens.
 * @param {Readonly<Record<string, any>>} input.adaptive - resolved adaptive configuration.
 * @param {string} [input.profile] - profile name; defaults to the configured one.
 * @param {boolean} [input.force] - overflow recovery: keep the smallest tail.
 * @returns {null | {contextWindow: number, messageBudget: number, growthTokens: number, thresholdTokens: number, thresholdRatio: number, headroomTokens: number, retainTokens: number}} the plan, or `null` when the route has no usable budget.
 */
export function planPolicy(input) {
  const window = input.contextWindow
  const reserved = Math.max(0, input.reservedTokens ?? 0)
  if (!Number.isInteger(window) || window <= 0) return null
  const budget = window - reserved
  if (budget <= 1024) return null

  const adaptive = input.adaptive
  const preset = PROFILES[input.profile ?? adaptive.profile] ?? PROFILES.balanced
  const floorToken = Math.max(1024, Math.ceil(window * adaptive.floorRatio))
  const ceilToken = Math.max(floorToken, Math.floor(window * adaptive.ceilRatio))
  const ceiling = Math.max(1, Math.min(ceilToken, budget - 1024))
  const floorBound = Math.min(floorToken, ceiling)

  const growth = clamp(
    Number.isFinite(input.growthTokens) ? Math.max(0, input.growthTokens) : 0,
    0,
    budget / 2,
  )
  const headroomFloor = Math.max(window * adaptive.headroomMinRatio * preset.headroomScale, adaptive.minHeadroomTokens)
  const headroomCeil = Math.max(headroomFloor, Math.min(window * adaptive.headroomMaxRatio, budget - 1024))
  const headroom = clamp(growth * adaptive.turnsAhead * preset.turnsAhead, headroomFloor, headroomCeil)

  let thresholdTokens = Math.floor(budget - headroom)
  if (input.force) thresholdTokens = ceiling
  thresholdTokens = clamp(thresholdTokens, floorBound, ceiling)
  if (thresholdTokens < 1) return null

  const thresholdRatio = thresholdTokens / window
  const headroomTokens = Math.max(0, Math.floor(budget - thresholdTokens))

  const tailFloor = Math.max(
    1,
    Math.min(adaptive.tailMinTokens, Math.floor(thresholdTokens * 0.5)),
  )
  const tailCeil = Math.max(
    tailFloor,
    Math.floor(Math.min(budget * adaptive.tailMaxRatio * preset.tailMaxScale, thresholdTokens * 0.6)),
  )
  const wantedTail = input.force
    ? 0
    : Math.max(growth * adaptive.keepTurns, budget * adaptive.tailRatio * preset.tailScale)
  const retainTokens = Math.floor(clamp(wantedTail, tailFloor, tailCeil))

  return {
    contextWindow: window,
    messageBudget: budget,
    growthTokens: Math.round(growth),
    thresholdTokens,
    thresholdRatio,
    headroomTokens,
    retainTokens,
  }
}

/** Human-readable one-line plan summary used by the plugin's logging. */
export function describePlan(plan, target) {
  const pct = (plan.thresholdTokens / plan.contextWindow) * 100
  return `${target} window=${plan.contextWindow} budget=${plan.messageBudget} `
    + `growth=${plan.growthTokens} threshold=${plan.thresholdTokens} (${pct.toFixed(1)}%) `
    + `tail=${plan.retainTokens}`
}
