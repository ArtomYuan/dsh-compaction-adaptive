/**
 * Adaptive compaction backend: the shipped replay-aware engine, re-planned per
 * routed model and per measured session growth.
 *
 * Why a subclass: the durable compaction protocol (start marker, replay, one
 * summary replacement, lock, retries, overflow recovery) already lives in
 * `BasicCompactionEngine` and must not be re-implemented. Only the numeric
 * policy is replaced: before each automatic decision the effective budget for
 * the routed model is recomputed from its window, the reserved output, and an
 * exponential moving average of how many tokens the last turns added, then
 * installed as that model's policy entry. The base engine then prices the
 * request, picks its range, and summarizes exactly as before.
 *
 * @module dsh-compaction-adaptive
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  conservativeTokens,
  digestMessages,
  isSizeFailure,
  mapLimit,
  mergeInstruction,
  mergeMessages,
  nextScale,
  packByBudget,
  planChunking,
  projectMessages,
  resolveChunkConfig,
  streamText,
  utf8Bytes,
} from './chunking.js'
import {
  budgetSnapshot,
  chunkSnapshot,
  compactionTotals,
  recordChunkRun,
  recordScaleChange,
  summarizeCompactions,
} from './insight.js'
import {
  ADAPTIVE_KEYS,
  describePlan,
  mergeAdaptive,
  nextGrowth,
  planPolicy,
  resolveAdaptiveConfig,
  resolveRoutes,
  routeKey,
} from './policy.js'

/** Fields the base backend resolves itself; everything else is adaptive-only. */
const BASE_KEYS = Object.freeze([
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto',
])

/** Retained per-session observations; derived cache, never persisted. */
const EMPTY_STATE = Object.freeze({ growth: 0, last: undefined, cooldown: 0 })

/** Keep the per-target policy table bounded on long-lived engines. */
const MAX_POLICY_ENTRIES = 24

/**
 * Split raw plugin configuration into base-backend and adaptive halves.
 * @param {Record<string, any>} config - raw row configuration.
 * @returns {Record<string, any>} the base-backend half.
 */
function baseConfigOf(config) {
  const base = {}
  for (const key of BASE_KEYS) {
    if (config[key] !== undefined) base[key] = config[key]
  }
  return base
}

/** Adaptive compaction engine exposed as `ctx.compaction`. */
export default class AdaptiveCompactionEngine extends BasicCompactionEngine {
  /**
   * Row schema. Every documented field is typed so the settings surface can
   * render it; `resolveAdaptiveConfig` remains the single authority on ranges.
   */
  static Config = z.object({
    mode: z.string(),
    profile: z.string(),
    turnsAhead: z.number(),
    growthAlpha: z.number(),
    floorRatio: z.number(),
    ceilRatio: z.number(),
    headroomMinRatio: z.number(),
    headroomMaxRatio: z.number(),
    minHeadroomTokens: z.number().step(1).min(0),
    tailRatio: z.number(),
    tailMinTokens: z.number().step(1).min(0),
    tailMaxRatio: z.number(),
    keepTurns: z.number(),
    cooldownSteps: z.number().step(1).min(0),
    thrashMargin: z.number(),
    minGrowthTokens: z.number().step(1).min(0),
    verbose: z.boolean(),
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(z.any()),
    routes: z.array(z.any()),
    chunking: z.string(),
    chunkTriggerBytes: z.number().step(1).min(10_000),
    chunkBytes: z.number().step(1).min(10_000),
    chunkConcurrency: z.number().step(1).min(1),
    chunkMaxTokens: z.number().step(1).min(128),
    mergeMaxTokens: z.number().step(1).min(128),
    chunkRetries: z.number().step(1).min(0),
    auto: z.boolean(),
  })

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {Record<string, any>} [config] - row configuration.
   */
  constructor(ctx, config = {}) {
    super(ctx, baseConfigOf(config))
    /** @type {Readonly<Record<string, any>>} */
    this.adaptive = resolveAdaptiveConfig(config)
    /** @type {ReadonlyMap<string, Readonly<Record<string, any>>>} */
    this.routes = resolveRoutes(config.routes)
    /** @type {Readonly<Record<string, any>>} */
    this.chunk = resolveChunkConfig(config)
    /** @type {Map<string, number>} learned per-summarizer capacity multipliers. */
    this.scales = new Map()
    /** @type {object[]} newest-last in-process chunk runs (not durable). */
    this.chunkRuns = []
    /** @type {object[]} newest-last learned-capacity changes (not durable). */
    this.scaleSeries = []
    /** @type {WeakMap<object, { growth: number, last: number | undefined, cooldown: number }>} */
    this.sessions = new WeakMap()
    /** @type {Map<string, string>} */
    this.warned = new Map()
    if (this.adaptive.mode === 'adaptive') this._installRequestHook()
    ctx.logger?.info(
      `[compaction-adaptive] ${this.adaptive.mode} mode, ${this.adaptive.profile} profile, `
      + `${this.adaptive.turnsAhead} turn(s) of headroom, tail >= ${this.adaptive.tailMinTokens} tokens, `
      + `chunking ${this.chunk.chunking}/${this.chunk.chunkSizing}`,
    )
  }

  /**
   * Re-plan the proposed route before the base engine prices a model switch.
   * The hook is registered as an ordinary waterfall listener, so it runs inside
   * the routing listeners that the base engine awaits, and never changes the
   * selected configuration.
   */
  _installRequestHook() {
    this.ctx.on('agent/request', async ({ agent, signal }, next) => {
      const config = await next()
      try {
        if (signal?.aborted) return config
        const provider = config?.provider
        const model = config?.model
        if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) {
          return config
        }
        // Only a change of route needs a fresh plan here: an unchanged route is
        // planned by the pre-step path, which also owns growth observation.
        const previous = agent.session?.requestHeader?.()?.config
        if (previous?.provider === provider && previous?.model === model) return config
        await this._observe(agent, agent.session?.requestHeader?.(), { provider, model }, {
          signal,
          reservedOverride: config.maxTokens,
          log: true,
        })
      } catch (error) {
        this._warnOnce('request-hook', error)
      }
      return config
    })
  }

  /**
   * Automatic compaction entry point: plan, install, then delegate.
   * @param {any} agent - agent requesting the step.
   * @param {'pressure' | 'context-overflow'} trigger - why policy is asking.
   * @param {AbortSignal} signal - turn cancellation.
   * @returns {Promise<any>} the base result, or `null`.
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (this.adaptive.mode !== 'adaptive') return super.compactIfNeeded(agent, trigger, signal)

    const header = agent.session?.requestHeader?.()
    const routed = header?.config
    if (!routed || !routed.provider || !routed.model) {
      return super.compactIfNeeded(agent, trigger, signal)
    }

    let planned = null
    try {
      planned = await this._observe(
        agent,
        header,
        { provider: routed.provider, model: routed.model },
        { signal, force: trigger === 'context-overflow', log: true },
      )
    } catch (error) {
      if (signal?.aborted) throw error
      this._warnOnce(`${routed.provider}/${routed.model}`, error)
    }

    const state = this._state(agent.session)
    if (planned !== null && trigger === 'pressure' && this._shouldHold(planned, state)) {
      if (this.adaptive.verbose) {
        this.ctx.logger?.info(
          `[compaction-adaptive] holding after a recent compaction: `
          + `${planned.measurement.totalTokens} < `
          + `${Math.round(planned.plan.thresholdTokens * this.adaptive.thrashMargin)}`,
        )
      }
      return null
    }
    state.cooldown = 0

    const result = await super.compactIfNeeded(agent, trigger, signal)
    if (result !== null && result !== undefined) {
      state.cooldown = this.adaptive.cooldownSteps
      state.last = undefined
      this.ctx.logger?.info(
        `[compaction-adaptive] shadowed ${result.shadowedSeqs.length} nodes `
        + `(~${result.shadowedTokenCount} tokens)`,
      )
    }
    return result
  }

  /**
   * Measure the surface once, fold growth, plan the routed model's budget, and
   * install it as that model's policy entry.
   * @param {any} agent - agent owning the measured session.
   * @param {any} header - latest durable request header, when known.
   * @param {{provider: string, model: string}} target - routed model.
   * @param {{signal?: AbortSignal, force?: boolean, reservedOverride?: number, log?: boolean}} options - planning options.
   * @returns {Promise<null | {plan: any, measurement: any}>} the plan and measurement.
   */
  async _observe(agent, header, target, options = {}) {
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, options.signal)
    const contextWindow = info?.context?.contextWindow
    const measurement = this.ctx.tokenMeter.measure(agent.session, header)
    const state = this._state(agent.session)

    const previous = state.last
    const delta = previous === undefined ? undefined : measurement.totalTokens - previous
    if (delta !== undefined && delta > this.adaptive.minGrowthTokens) {
      state.growth = nextGrowth(state.growth, delta, this.adaptive.growthAlpha)
    }
    state.last = measurement.totalTokens

    const reservedTokens = options.reservedOverride ?? header?.config?.maxTokens ?? info?.defaultMaxTokens ?? 0
    const adaptive = this._adaptiveFor(target)
    const plan = planPolicy({
      contextWindow,
      reservedTokens,
      growthTokens: state.growth,
      adaptive,
      force: options.force === true,
    })
    if (plan === null) return null

    this._installPlan(target, plan)
    if (options.log) {
      this.ctx.logger?.info(`[compaction-adaptive] ${describePlan(plan, `${target.provider}/${target.model}`)}`)
    }
    return { plan, measurement, adaptive }
  }

  /**
   * Effective adaptive settings for one route: the service defaults, with the
   * route's partial overrides applied. Route overrides exist for cost control
   * (an expensive prefill wants a lower ceiling), so they must win over the
   * growth-derived target whenever they are stricter.
   * @param {{provider: string, model: string}} target - routed model.
   * @returns {Record<string, any>} effective adaptive settings.
   */
  _adaptiveFor(target) {
    const override = this.routes.get(routeKey(target.provider, target.model))
    return mergeAdaptive(this.adaptive, override)
  }

  /**
   * Summarization hook shared with the base backend.
   *
   * The single-shot request is measured in the currency its consumer cares
   * about — the summary model's own token budget — with the transport byte cap
   * as a second guard. A request that fits keeps the base behavior, including
   * its prefix-cache reuse; one that does not is digested in parts sized from
   * that same budget and folded back into one checkpoint. This replaces the
   * separate stream-interception plugin that used to handle the oversized case.
   *
   * The multi-call result is deliberately *unmarked* (`llmStreamCall` absent):
   * the contract reserves that marker for a summary produced by exactly one
   * `ctx.llm.stream()` call, and the durable record then keeps only the output.
   *
   * @param {any} input - replayed conversation prefix to condense.
   * @param {any} agent - routed model, session, and tool history.
   * @param {AbortSignal} [signal] - cancellation forwarded to every call.
   * @returns {Promise<any>} summary blocks and the call envelope.
   */
  async summarize(input, agent, signal) {
    if (this.chunk.chunking === 'off') return super.summarize(input, agent, signal)
    let prepared
    try {
      prepared = await this._chunkPlan(input, agent)
    } catch (error) {
      this._warnOnce('chunk-plan', error)
      return super.summarize(input, agent, signal)
    }
    if (!prepared.plan.needed) return super.summarize(input, agent, signal)
    return this._chunkedSummarize(prepared, agent, signal)
  }

  /**
   * Measure the single-shot request and derive the chunk budgets from the model
   * that will summarize it.
   * @param {any} input - summarization input.
   * @param {any} agent - owning agent.
   * @returns {Promise<{target: any, system: string | null, parts: string[], capacity: any, contentTokens: number, contentBytes: number, plan: any}>} plan.
   */
  async _chunkPlan(input, agent) {
    const target = this._summarizationTarget(agent)
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model)
    const { system, parts } = projectMessages(input.messages ?? [])
    const estimate = (text) => this._estimateText(text)
    const systemTokens = system === null ? 0 : conservativeTokens(system, estimate(system))
    let contentTokens = systemTokens
    let contentBytes = system === null ? 0 : utf8Bytes(system)
    for (const part of parts) {
      contentTokens += conservativeTokens(part, estimate(part))
      contentBytes += utf8Bytes(part) + 1
    }
    const toolsBytes = input.tools === undefined ? 0 : utf8Bytes(JSON.stringify(input.tools))
    const capacity = {
      window: info?.context?.contextWindow ?? 0,
      reservedTokens: target.maxTokens ?? 0,
      overheadTokens: systemTokens + this._estimateText(mergeInstruction(0)) + Math.ceil(toolsBytes / 3),
    }
    const plan = planChunking({
      contentTokens,
      contentBytes,
      capacity,
      config: this.chunk,
      scale: this._scaleFor(target),
    })
    return { target, system, parts, capacity, contentTokens, contentBytes, plan }
  }

  /**
   * Digest the shadowed content in parts, then fold the digests into one
   * checkpoint — shrinking the parts and retrying when the route rejects a
   * request as too large, and recovering the learned capacity after success.
   * @param {any} prepared - measured plan from {@link _chunkPlan}.
   * @param {any} agent - owning agent.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @returns {Promise<any>} unmarked summary result.
   */
  async _chunkedSummarize(prepared, agent, signal) {
    const { target, system, parts, capacity, contentTokens, contentBytes } = prepared
    const key = routeKey(target.provider, target.model)
    const stream = (options) => this.ctx.llm.stream(options)
    const base = {
      provider: target.provider,
      model: target.model,
      sessionId: agent.session?.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    const estimate = (text) => this._estimateText(text)

    let attempt = 0
    for (;;) {
      const plan = planChunking({
        contentTokens,
        contentBytes,
        capacity,
        config: this.chunk,
        scale: this._scaleFor(target),
      })
      const chunks = packByBudget(
        parts,
        { tokenBudget: plan.partTokenBudget, byteBudget: plan.partByteBudget },
        estimate,
      )
      if (chunks.length === 0) return super.summarize(prepared, agent, signal)

      this.ctx.logger?.info(
        `[compaction-adaptive] chunked summary (${plan.reason}): ${chunks.length} parts `
        + `<= ${plan.partTokenBudget} tokens / ${plan.partByteBudget} B each, `
        + `concurrency ${this.chunk.chunkConcurrency}, capacity scale ${(plan.scale * 100).toFixed(0)}%`,
      )

      try {
        const digests = await mapLimit(chunks, this.chunk.chunkConcurrency, (text, index) => (
          this._withRetries(signal, (label) => this._call(stream, base, text, index, chunks.length, system, label))
        ))
        signal?.throwIfAborted()
        const merged = await this._fold(target, system, digests, capacity, signal, base)
        const recovered = nextScale(this._scaleFor(target), 'recover', this.chunk)
        this.scales.set(key, recovered)
        recordScaleChange(this.scaleSeries, { at: Date.now(), scale: recovered, reason: 'recover' })
        recordChunkRun(this.chunkRuns, {
          at: Date.now(),
          provider: target.provider,
          model: target.model,
          parts: chunks.length,
          tokens: contentTokens,
          bytes: contentBytes,
          scale: plan.scale,
        })
        this.ctx.logger?.info(
          `[compaction-adaptive] chunked summary done: ${chunks.length} digests folded into ${merged.length} chars`,
        )
        const summary = [{ type: 'text', text: merged }]
        return {
          summary,
          rawOutput: summary,
          provider: target.provider,
          model: target.model,
          maxTokens: this.chunk.mergeMaxTokens,
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (!isSizeFailure(error) || attempt >= this.chunk.chunkShrinkAttempts) throw error
        attempt += 1
        const next = nextScale(this._scaleFor(target), 'shrink', this.chunk)
        this.scales.set(key, next)
        recordScaleChange(this.scaleSeries, { at: Date.now(), scale: next, reason: 'shrink' })
        this.ctx.logger?.warn(
          `[compaction-adaptive] ${key} rejected a chunked request (${error instanceof Error ? error.message : String(error)}); `
          + `shrinking capacity to ${(next * 100).toFixed(0)}% and retrying`,
        )
      }
    }
  }

  /**
   * One digest call for a packed part.
   * @param {(options: any) => AsyncIterable<any>} stream - LLM stream factory.
   * @param {Record<string, any>} base - shared generate options.
   * @param {string} text - packed part text.
   * @param {number} index - part index.
   * @param {number} total - part count.
   * @param {string | null} system - replayed system head.
   * @param {string} label - retry label.
   * @returns {Promise<string>} digest text.
   */
  async _call(stream, base, text, index, total, system, label) {
    try {
      return await streamText(
        stream,
        { ...base, maxTokens: this.chunk.chunkMaxTokens },
        digestMessages(system, text, index, total),
        { BlockAssembler, LlmError },
      )
    } catch (error) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  /**
   * Fold digests into the structured checkpoint, grouping them first when the
   * digests themselves no longer fit one request.
   * @param {any} target - summarization route.
   * @param {string | null} system - replayed system head.
   * @param {string[]} digests - per-part notes.
   * @param {any} capacity - summarizer capacity.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @param {Record<string, any>} base - shared generate options.
   * @returns {Promise<string>} checkpoint text.
   */
  async _fold(target, system, digests, capacity, signal, base) {
    const stream = (options) => this.ctx.llm.stream(options)
    const foldBudget = Math.max(
      1_024,
      Math.floor(
        Math.max(0, capacity.window - capacity.reservedTokens - capacity.overheadTokens)
        * (this.chunk.chunkSizing === 'fixed' ? 1 : this.chunk.chunkSingleShotRatio)
        * this._scaleFor(target),
      ),
    )
    let notes = digests
    for (let round = 0; round < 3; round += 1) {
      const estimate = (text) => this._estimateText(text)
      const total = notes.reduce((sum, note) => sum + conservativeTokens(note, estimate(note)), 0)
      if (total <= foldBudget) break
      const groups = packByBudget(
        notes,
        { tokenBudget: Math.max(1_024, Math.floor(foldBudget * 0.5)), byteBudget: this.chunk.chunkBytes },
        estimate,
      )
      if (groups.length >= notes.length) break
      this.ctx.logger?.info(
        `[compaction-adaptive] digests (${total} tokens) exceed the fold budget ${foldBudget}; `
        + `condensing ${notes.length} → ${groups.length} in round ${round + 1}`,
      )
      notes = await mapLimit(groups, this.chunk.chunkConcurrency, (text, index) => (
        this._withRetries(signal, (label) => this._call(stream, base, text, index, groups.length, system, label))
      ))
      signal?.throwIfAborted()
    }
    return this._withRetries(signal, () => streamText(
      stream,
      { ...base, maxTokens: this.chunk.mergeMaxTokens },
      mergeMessages(system, notes),
      { BlockAssembler, LlmError },
    ))
  }

  /**
   * Conservative token estimate for arbitrary text.
   * @param {string} text - measured text.
   * @returns {number} tokens.
   */
  _estimateText(text) {
    const meter = this.ctx.tokenMeter
    if (typeof meter?.estimateMessage === 'function') {
      try {
        return meter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] })
      } catch {
        // Fall through to the character heuristic below.
      }
    }
    return Math.ceil(text.length / 3)
  }

  /**
   * Learned capacity multiplier for a route.
   * @param {{provider: string, model: string}} target - summarization route.
   * @returns {number} multiplier in [chunkMinScale, 1].
   */
  _scaleFor(target) {
    const scale = this.scales.get(routeKey(target.provider, target.model))
    return Number.isFinite(scale) ? scale : 1
  }

  /**
   * Resolve the summarization route and budget, mirroring the base backend:
   * an explicit per-route or service-level summarization pair wins, otherwise
   * the conversation's own routed model summarizes itself.
   * @param {any} agent - owning agent.
   * @returns {{provider: string, model: string, maxTokens: number}} target.
   */
  _summarizationTarget(agent) {
    const routed = agent.session?.requestHeader?.()?.config
    const target = routed?.provider && routed?.model
      ? { provider: routed.provider, model: routed.model }
      : agent.options?.provider && agent.options?.model
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined
    const policy = target === undefined ? this.config : this._policyFor(target)
    const configured = policy.summarizationProvider
      ? { provider: policy.summarizationProvider, model: policy.summarizationModel }
      : undefined
    const resolved = configured ?? target ?? undefined
    if (resolved === undefined) {
      throw new Error('chunked summarization: no provider/model available to summarize with')
    }
    return { provider: resolved.provider, model: resolved.model, maxTokens: this.chunk.mergeMaxTokens }
  }

  /**
   * Read the effective policy for one routed model (explicit entry over the
   * service defaults), without re-planning it.
   * @param {{provider: string, model: string}} target - routed model.
   * @returns {Record<string, any>} effective policy fields.
   */
  _policyFor(target) {
    const entry = (this.config.modelPolicies ?? []).find((policy) => (
      policy.provider === target.provider && policy.model === target.model
    ))
    return {
      summarizationProvider: entry?.summarizationProvider ?? this.config.summarizationProvider,
      summarizationModel: entry?.summarizationModel ?? this.config.summarizationModel,
      maxTokens: entry?.maxTokens ?? this.config.maxTokens,
    }
  }

  /**
   * Retry one call a bounded number of times, never past cancellation.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @param {(label: string) => Promise<any>} run - call to attempt.
   * @returns {Promise<any>} the successful result.
   */
  async _withRetries(signal, run) {
    let attempt = 0
    for (;;) {
      signal?.throwIfAborted()
      try {
        return await run(attempt === 0 ? 'chunk summarization' : `chunk summarization (retry ${attempt})`)
      } catch (error) {
        signal?.throwIfAborted()
        if (attempt >= this.chunk.chunkRetries) throw error
        attempt += 1
      }
    }
  }

  /**
   * Build the read-only snapshot the insight panel renders.
   *
   * Pure projection: reads the same measurement the pressure gate uses, the
   * plan the engine would install for the current route, the chunk budgets the
   * summary model implies, and the durable `compaction/*` events. Nothing is
   * written, so a panel may poll it.
   * @param {any} agent - agent whose session is being described.
   * @returns {Promise<object>} panel snapshot.
   */
  async insight(agent) {
    const session = agent?.session
    const header = session?.requestHeader?.()
    const routed = header?.config
    const measurement = this.ctx.tokenMeter.measure(session, header)
    const state = this._state(session)

    const conversation = routed?.provider && routed?.model
      ? { provider: routed.provider, model: routed.model }
      : agent?.options?.provider && agent?.options?.model
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined

    const conversationInfo = conversation === undefined
      ? undefined
      : await this.ctx.llm.resolveModelInfo(conversation.provider, conversation.model)
    const conversationWindow = conversationInfo?.context?.contextWindow ?? 0
    const reserved = routed?.maxTokens ?? conversationInfo?.defaultMaxTokens ?? 0
    const adaptive = conversation === undefined ? this.adaptive : this._adaptiveFor(conversation)
    const plan = conversationWindow > 0
      ? planPolicy({
        contextWindow: conversationWindow,
        reservedTokens: reserved,
        growthTokens: state.growth,
        adaptive,
        profile: adaptive.profile,
      })
      : null

    const summaryTarget = this._summarizationTarget(agent)
    const summaryInfo = await this.ctx.llm.resolveModelInfo(summaryTarget.provider, summaryTarget.model)
    const capacity = {
      window: summaryInfo?.context?.contextWindow ?? 0,
      reservedTokens: summaryTarget.maxTokens ?? 0,
      overheadTokens: this._overheadTokens(agent, header),
    }
    const scale = this._scaleFor(summaryTarget)
    const records = summarizeCompactions(this._eventsOf(session), 20)

    return {
      at: Date.now(),
      conversation: conversation ?? null,
      conversationWindow,
      summaryRoute: { provider: summaryTarget.provider, model: summaryTarget.model },
      budget: budgetSnapshot({ plan, measurement, adaptive }),
      chunk: chunkSnapshot({ chunkConfig: this.chunk, capacity, scale }),
      compactions: records,
      compactionTotals: compactionTotals(records),
      chunkRuns: this.chunkRuns.slice().reverse(),
      scaleSeries: this.scaleSeries.slice(),
      growth: { ema: Math.round(state.growth), cooldown: state.cooldown },
    }
  }

  /**
   * Read a session's events without depending on an events collection.
   * @param {any} session - session to read.
   * @returns {any[]} events in log order.
   */
  _eventsOf(session) {
    const events = []
    const end = session?.seq ?? 0
    for (let seq = 0; seq < end; seq += 1) {
      const event = session.eventAt?.(seq)
      if (event !== undefined) events.push(event)
    }
    return events
  }

  /**
   * Estimate the fixed overhead a summarization request carries: the replayed
   * system head, the instruction, and the tool schemas.
   * @param {any} agent - owning agent.
   * @param {any} header - latest request header.
   * @returns {number} overhead tokens.
   */
  _overheadTokens(agent, header) {
    let systemTokens = 0
    try {
      const head = agent?.session?.eventAt?.(0)
      const message = head === undefined ? null : agent.session.deriveEventMessage(head)
      const text = message === null
        ? ''
        : (message.content ?? [])
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
      if (text.length > 0) systemTokens = conservativeTokens(text, this._estimateText(text))
    } catch {
      // A session whose head does not project (custom seed) contributes no system prompt.
    }
    const toolsBytes = header?.tools === undefined ? 0 : utf8Bytes(JSON.stringify(header.tools))
    return systemTokens + this._estimateText(mergeInstruction(0)) + Math.ceil(toolsBytes / 3)
  }

  /**
   * Record one routed model's adaptive budget without discarding the explicit
   * routing a user configured for that model (its summarization target, for
   * instance, which must survive re-planning).
   * @param {{provider: string, model: string}} target - routed model.
   * @param {any} plan - planned budget.
   */
  _installPlan(target, plan) {
    const current = this.config
    const policies = current.modelPolicies ?? []
    const existing = policies.find((policy) => (
      policy.provider === target.provider && policy.model === target.model
    ))
    /** @type {Record<string, any>} */
    const entry = { ...existing, provider: target.provider, model: target.model }
    delete entry.retainRatio
    entry.thresholdRatio = plan.thresholdRatio
    entry.headroomTokens = plan.headroomTokens
    entry.retainTokens = plan.retainTokens

    const others = policies.filter((policy) => (
      policy.provider !== target.provider || policy.model !== target.model
    ))
    const next = [...others, entry].slice(-MAX_POLICY_ENTRIES)
    // The base engine re-reads `config` at every decision and at summary time,
    // so replacing the resolved value is enough and leaves no cross-agent state.
    this.config = { ...current, modelPolicies: next }
  }

  /**
   * Skip a step immediately after a compaction unless the surface has climbed
   * back past the threshold with a margin: this is what stops two summarization
   * attempts from trading a few tokens back and forth.
   * @param {{plan: any, measurement: any}} planned - current plan and measurement.
   * @param {{cooldown: number}} state - session observation state.
   * @returns {boolean} whether to hold this step.
   */
  _shouldHold(planned, state) {
    if (state.cooldown <= 0) return false
    state.cooldown -= 1
    const margin = planned.adaptive?.thrashMargin ?? this.adaptive.thrashMargin
    return planned.measurement.totalTokens < planned.plan.thresholdTokens * margin
  }

  /**
   * Read or create the derived per-session observation state.
   * @param {object} session - measured session.
   * @returns {{ growth: number, last: number | undefined, cooldown: number }} state.
   */
  _state(session) {
    let state = this.sessions.get(session)
    if (state === undefined) {
      state = { ...EMPTY_STATE }
      this.sessions.set(session, state)
    }
    return state
  }

  /**
   * Log one warning per key; a missing window declaration must not repeat on
   * every step of a long turn.
   * @param {string} key - deduplication key.
   * @param {unknown} error - failure to report.
   */
  _warnOnce(key, error) {
    const message = error instanceof Error ? error.message : String(error)
    if (this.warned.get(key) === message) return
    this.warned.set(key, message)
    this.ctx.logger?.warn(`[compaction-adaptive] ${key}: ${message}`)
  }
}

export { ADAPTIVE_KEYS }
