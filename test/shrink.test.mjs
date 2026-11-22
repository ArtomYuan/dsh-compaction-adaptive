/**
 * Checks for the adaptive shrink planner.
 * Run: ELECTRON_RUN_AS_NODE=1 "<dsh node>" test/shrink.test.mjs
 */
import assert from 'node:assert/strict'
import {
  SHRINK_DEFAULTS,
  learnRatio,
  planShrink,
  resolveShrinkConfig,
  satisfiesShrink,
} from '../lib/shrink.js'

// --- the failing case from a model switch: shadowed 2706 tokens -------------
const small = planShrink({ shadowedTokens: 2_706 })
assert.equal(small.attempt, true, 'a 2706-token range is still worth compressing')
assert.ok(small.ceiling <= 2_706 * 0.92, 'the plan must target below the guard threshold')
assert.ok(small.budgets[0] < 2_706, 'the first budget must already be smaller than the shadowed range')
assert.ok(small.budgets[0] >= SHRINK_DEFAULTS.minBudgetTokens)
assert.ok(small.budgets.length <= SHRINK_DEFAULTS.attempts)
assert.ok(small.budgets.every((budget, index) => index === 0 || budget < small.budgets[index - 1]),
  'each retry must ask for less than the previous one')
assert.equal(small.reason, 'shrink')

// --- the payoff gate: too little to gain ------------------------------------
const tiny = planShrink({ shadowedTokens: 120 })
assert.equal(tiny.attempt, false, 'a 120-token range cannot pay for a call')
assert.equal(tiny.reason, 'not-worth-it')
assert.deepEqual(tiny.budgets, [])
assert.equal(planShrink({ shadowedTokens: 0 }).reason, 'empty-shadow')

// --- ratio drives the budget ------------------------------------------------
const learnedSmall = planShrink({ shadowedTokens: 20_000, ratio: 0.25 })
const learnedLarge = planShrink({ shadowedTokens: 20_000, ratio: 0.7 })
assert.ok(learnedSmall.budgets[0] < learnedLarge.budgets[0], 'a better ratio asks for a tighter budget')
assert.ok(planShrink({ shadowedTokens: 20_000, ratio: 0.99 }).budgets[0]
  <= Math.floor(20_000 * SHRINK_DEFAULTS.ratioMax), 'ratioMax bounds the plan')

// --- learning ---------------------------------------------------------------
const start = SHRINK_DEFAULTS.ratioInit
const up = learnRatio(start, { observedRatio: 0.9 })
assert.ok(up > start, 'an observed ratio above the estimate raises it')
assert.ok(up <= SHRINK_DEFAULTS.ratioMax, 'learning stays inside ratioMax')
const down = learnRatio(start, { observedRatio: 0.01 })
assert.ok(down < start, 'an observed ratio below the estimate lowers it')
assert.ok(down >= SHRINK_DEFAULTS.ratioMin, 'learning stays inside ratioMin')
assert.equal(learnRatio(Number.NaN, { observedRatio: 0.5 }), resolveShrinkConfig().ratioInit,
  'a missing previous value seeds from the config')

// --- the guard -----------------------------------------------------------------
assert.equal(satisfiesShrink({ summaryTokens: 900, shadowedTokens: 2_706 }), true)
assert.equal(satisfiesShrink({ summaryTokens: 2_743, shadowedTokens: 2_706 }), false,
  'the observed failure (2743 >= 2706) must be rejected')
assert.equal(satisfiesShrink({ summaryTokens: 2_520, shadowedTokens: 2_706 }), false,
  'a summary just under the original is still not enough')
assert.equal(satisfiesShrink({ summaryTokens: 2_489, shadowedTokens: 2_706 }), true,
  'the margin is what the guard is asked to accept')

// --- config bounds ------------------------------------------------------------
const clamped = resolveShrinkConfig({ attempts: 99, margin: 5, ratioInit: -1 })
assert.equal(clamped.attempts, 6)
assert.ok(clamped.margin <= 0.99)
assert.ok(clamped.ratioInit >= 0.05)

console.log('shrink: all checks passed')
