/**
 * Plain-Node checks for the adaptive planning math.
 * Run: ELECTRON_RUN_AS_NODE=1 "<dsh node>" test/policy.test.mjs
 */
import assert from 'node:assert/strict'
import {
  ADAPTIVE_KEYS,
  PROFILES,
  describePlan,
  mergeAdaptive,
  nextGrowth,
  planPolicy,
  resolveAdaptiveConfig,
  resolveRouteOverride,
  resolveRoutes,
  routeKey,
} from '../lib/policy.js'

const defaults = resolveAdaptiveConfig()
assert.equal(defaults.mode, 'adaptive')
assert.equal(defaults.profile, 'balanced')
assert.equal(defaults.turnsAhead, 3)
assert.equal(ADAPTIVE_KEYS.length, Object.keys(defaults).length)

// Raw values override; the resolved object is frozen.
const custom = resolveAdaptiveConfig({ turnsAhead: 6, profile: 'quality', verbose: true })
assert.equal(custom.turnsAhead, 6)
assert.equal(custom.profile, 'quality')
assert.equal(custom.verbose, true)
assert.ok(Object.isFrozen(custom))

// Rejections are actionable.
assert.throws(() => resolveAdaptiveConfig({ mode: 'magic' }), /mode/)
assert.throws(() => resolveAdaptiveConfig({ profile: 'nope' }), /profile/)
assert.throws(() => resolveAdaptiveConfig({ floorRatio: 0.9, ceilRatio: 0.5 }), /floorRatio/)
assert.throws(() => resolveAdaptiveConfig({ tailMaxRatio: 0 }), /tailMaxRatio/)

// Growth: first sample seeds, later samples blend, shrinkage re-baselines only.
assert.equal(nextGrowth(0, 12000, 0.35), 12000)
assert.equal(nextGrowth(12000, 0, 0.35), 12000)
assert.equal(nextGrowth(12000, -40000, 0.35), 12000)
assert.equal(nextGrowth(10000, 20000, 0.35), 0.35 * 20000 + 0.65 * 10000)
assert.equal(nextGrowth(10000, 20000, 1), 20000)

/** Plan helper kept readable in assertions. */
const plan = (contextWindow, reservedTokens, growthTokens, extra = {}) => planPolicy({
  contextWindow,
  reservedTokens,
  growthTokens,
  adaptive: resolveAdaptiveConfig(extra.adaptive),
  force: extra.force === true,
  profile: extra.profile,
})

// No usable window means no plan rather than a wild guess.
assert.equal(plan(undefined, 0, 0), null)
assert.equal(plan(1000, 5000, 0), null)

// Large cloud window, heavy turns: compacts well before 90% and keeps ~3 turns.
const cloud = plan(1_000_000, 32_000, 30_000)
assert.equal(cloud.messageBudget, 968_000)
assert.ok(cloud.thresholdTokens < 0.9 * 1_000_000, `expected earlier trigger, got ${cloud.thresholdTokens}`)
assert.ok(cloud.thresholdTokens >= 0.35 * 1_000_000)
assert.ok(cloud.retainTokens >= cloud.growthTokens * 1 && cloud.retainTokens < cloud.thresholdTokens)
assert.ok(cloud.headroomTokens >= 0, 'headroom must stay non-negative')

// Small window: the ceiling cannot exceed the message budget.
const small = plan(131_072, 32_768, 0)
assert.ok(small.thresholdTokens <= small.messageBudget - 1024)
assert.ok(small.retainTokens > 0 && small.retainTokens < small.thresholdTokens)
assert.ok(small.thresholdRatio <= 0.9)

// Growth ordering: more growth per turn triggers earlier, never later.
const slow = plan(524_288, 8_192, 5_000)
const fast = plan(524_288, 8_192, 60_000)
assert.ok(fast.thresholdTokens < slow.thresholdTokens, 'faster growth must trigger earlier')
assert.ok(fast.retainTokens >= slow.retainTokens, 'faster growth must keep at least as much tail')

// Overflow recovery forces the ceiling and the smallest legal tail.
const forced = plan(524_288, 8_192, 5_000, { force: true })
assert.equal(forced.thresholdTokens, Math.min(Math.floor(0.9 * 524_288), 524_288 - 8_192 - 1024))
assert.ok(forced.retainTokens <= plan(524_288, 8_192, 5_000).retainTokens)

// Profiles scale the same window monotonically.
const economy = plan(524_288, 8_192, 20_000, { profile: 'economy' })
const balanced = plan(524_288, 8_192, 20_000, { profile: 'balanced' })
const quality = plan(524_288, 8_192, 20_000, { profile: 'quality' })
assert.ok(economy.retainTokens <= balanced.retainTokens)
assert.ok(balanced.retainTokens <= quality.retainTokens)
assert.ok(Object.keys(PROFILES).length === 3)

// The description line is the operator-facing summary.
assert.match(describePlan(balanced, 'p/m'), /^p\/m window=524288 budget=\d+ growth=20000 threshold=\d+/)

// Route overrides: partial, validated, merged over the service defaults.
const single = resolveRouteOverride({ provider: 'p', model: 'm', ceilRatio: 0.25 }, 0)
assert.deepEqual(Object.keys(single).sort(), ['ceilRatio'])
assert.equal(single.ceilRatio, 0.25)
assert.throws(() => resolveRouteOverride({ provider: 'p', model: 'm', nope: 1 }, 3), /routes\[3\]: unknown key/)
assert.throws(() => resolveRouteOverride({ provider: '', model: 'm' }, 0), /provider/)
assert.throws(() => resolveRouteOverride({ provider: 'p', model: 'm', ceilRatio: 4 }, 0), /ceilRatio/)

const table = resolveRoutes([
  { provider: 'strata-mi50', model: 'big', ceilRatio: 0.25 },
  { provider: 'strata-local', model: 'small', profile: 'economy' },
])
assert.equal(table.size, 2)
assert.equal(table.get(routeKey('strata-mi50', 'big')).ceilRatio, 0.25)
assert.equal(table.get(routeKey('strata-local', 'small')).profile, 'economy')
assert.throws(() => resolveRoutes([
  { provider: 'a', model: 'b' },
  { provider: 'a', model: 'b' },
]), /duplicate/)

// A cost ceiling must win over the growth-derived target.
const merged = mergeAdaptive(resolveAdaptiveConfig(), table.get(routeKey('strata-mi50', 'big')))
const capped = planPolicy({
  contextWindow: 1_048_576,
  reservedTokens: 32_768,
  growthTokens: 25_000,
  adaptive: merged,
  profile: merged.profile,
})
assert.equal(capped.thresholdTokens, Math.floor(0.25 * 1_048_576))
const uncapped = plan(1_048_576, 32_768, 25_000)
assert.ok(capped.thresholdTokens < uncapped.thresholdTokens, 'the route ceiling must compact earlier')

// Every plan must be resolvable by the base backend's own invariants.
for (const window of [32_768, 131_072, 262_144, 524_288, 1_048_576, 2_000_000]) {
  for (const reserved of [0, 8_192, 32_768]) {
    for (const growth of [0, 1_000, 50_000, 400_000]) {
      for (const profile of Object.keys(PROFILES)) {
        const result = plan(window, reserved, growth, { profile })
        if (result === null) continue
        assert.ok(result.thresholdRatio > 0 && result.thresholdRatio <= 1, 'ratio in (0,1]')
        assert.ok(result.headroomTokens >= 0, 'headroom non-negative')
        assert.ok(result.retainTokens >= 0, 'tail non-negative')
        assert.ok(result.retainTokens < result.thresholdTokens, 'tail below threshold')
        const resolvedThreshold = Math.floor(Math.min(
          window * result.thresholdRatio,
          result.messageBudget - result.headroomTokens,
        ))
        assert.ok(resolvedThreshold > 0, 'base threshold positive')
        assert.ok(result.retainTokens < resolvedThreshold, 'base retention check passes')
      }
    }
  }
}

console.log('policy: all checks passed')

