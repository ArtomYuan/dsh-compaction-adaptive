/**
 * Byte-bounded chunked summarization for requests the single-shot path cannot
 * ship.
 *
 * The compaction backend receives one summarization input per attempt: the
 * replayed prefix (system prompt, tool schemas, shadowed messages) plus the
 * summarizer's trailing instruction. For a large window that payload can exceed
 * what a relay or a small-window summary model accepts in one request, and the
 * whole attempt then fails. This module cuts the *shadowed content* into
 * byte-bounded parts, digests each part, and folds the digests into one
 * checkpoint in the format the harness expects.
 *
 * Everything here is pure except `streamText`, which takes a caller-supplied
 * stream factory: packing, text projection, and prompt construction are
 * testable without a Context, a Session, or a provider.
 *
 * @module dsh-compaction-adaptive/chunking
 */

/** Chunking defaults, chosen to stay below a 3 MB request-body limit. */
export const CHUNK_DEFAULTS = Object.freeze({
  chunking: 'auto',
  chunkSizing: 'adaptive',
  chunkTriggerBytes: 2_400_000,
  chunkBytes: 700_000,
  chunkConcurrency: 2,
  chunkMaxTokens: 4_000,
  mergeMaxTokens: 6_000,
  chunkRetries: 1,
  chunkShrinkAttempts: 2,
  chunkSingleShotRatio: 0.7,
  chunkTokenRatio: 0.45,
  chunkShrinkFactor: 0.6,
  chunkRecoverFactor: 1.15,
  chunkMinScale: 0.25,
})

/** Supported chunking modes. */
export const CHUNK_MODES = Object.freeze(['auto', 'off'])

/** Supported sizing modes: adaptive derives budgets from the summary model. */
export const SIZING_MODES = Object.freeze(['adaptive', 'fixed'])

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

/**
 * Validate the chunking half of the plugin configuration.
 * @param {Record<string, unknown>} [raw] - raw plugin configuration.
 * @returns {Readonly<Record<string, any>>} resolved chunking configuration.
 */
export function resolveChunkConfig(raw = {}) {
  const config = { ...CHUNK_DEFAULTS }
  for (const key of Object.keys(CHUNK_DEFAULTS)) {
    if (raw[key] !== undefined) config[key] = raw[key]
  }
  if (!CHUNK_MODES.includes(config.chunking)) {
    fail(`chunking (${String(config.chunking)}) must be one of ${CHUNK_MODES.join(', ')}`)
  }
  if (!SIZING_MODES.includes(config.chunkSizing)) {
    fail(`chunkSizing (${String(config.chunkSizing)}) must be one of ${SIZING_MODES.join(', ')}`)
  }
  assertNumber('chunkTriggerBytes', config.chunkTriggerBytes, { min: 10_000, integer: true })
  assertNumber('chunkBytes', config.chunkBytes, { min: 10_000, integer: true })
  assertNumber('chunkConcurrency', config.chunkConcurrency, { min: 1, max: 8, integer: true })
  assertNumber('chunkMaxTokens', config.chunkMaxTokens, { min: 128, integer: true })
  assertNumber('mergeMaxTokens', config.mergeMaxTokens, { min: 128, integer: true })
  assertNumber('chunkRetries', config.chunkRetries, { min: 0, max: 5, integer: true })
  assertNumber('chunkShrinkAttempts', config.chunkShrinkAttempts, { min: 0, max: 4, integer: true })
  assertNumber('chunkSingleShotRatio', config.chunkSingleShotRatio, { min: 0.1, max: 1 })
  assertNumber('chunkTokenRatio', config.chunkTokenRatio, { min: 0.05, max: 1 })
  assertNumber('chunkShrinkFactor', config.chunkShrinkFactor, { min: 0.1, max: 0.95 })
  assertNumber('chunkRecoverFactor', config.chunkRecoverFactor, { min: 1, max: 2 })
  assertNumber('chunkMinScale', config.chunkMinScale, { min: 0.05, max: 1 })
  if (config.chunkBytes > config.chunkTriggerBytes) {
    fail(`chunkBytes (${config.chunkBytes}) must not exceed chunkTriggerBytes (${config.chunkTriggerBytes})`)
  }
  return Object.freeze(config)
}

/** UTF-8 byte length of a string, as a relay counts it. */
export function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Size one summarization request the way a transport would: the serialized
 * messages plus the tool schemas the call would carry.
 * @param {{messages?: readonly any[], tools?: readonly any[]}} input - summarization input.
 * @returns {number} approximate request body size in bytes.
 */
export function requestBytes(input) {
  let bytes = 0
  for (const message of input.messages ?? []) {
    bytes += utf8Bytes(JSON.stringify(message)) + 1
  }
  if (input.tools !== undefined && input.tools.length > 0) {
    bytes += utf8Bytes(JSON.stringify(input.tools))
  }
  return bytes
}

/**
 * Split the summarization input into a system head and per-message text parts.
 *
 * Reasoning blocks are dropped: they are not part of what another model needs,
 * and they dominate the byte count of long reasoning-heavy sessions.
 * @param {readonly any[]} messages - replayed conversation prefix.
 * @returns {{system: string | null, parts: string[]}} projected text.
 */
export function projectMessages(messages) {
  let system = null
  const parts = []
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : []
    const blocks = []
    for (const block of content) {
      switch (block?.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text.length > 0) blocks.push(block.text)
          break
        case 'tool-call':
          blocks.push(`<tool-call ${block.name ?? ''}>\n${String(block.arguments ?? '')}`)
          break
        case 'reasoning':
          break
        case 'image':
          blocks.push('[image omitted]')
          break
        default:
          blocks.push(JSON.stringify(block))
      }
    }
    const body = blocks.join('\n').trim()
    if (body.length === 0) continue
    if (message.role === 'system' && system === null) {
      system = body
      continue
    }
    const label = message.role === 'assistant' ? '### assistant'
      : message.role === 'tool' ? '### tool result'
        : '### user'
    parts.push(`${label}\n${body}`)
  }
  return { system, parts }
}

/**
 * Pack text parts into byte-bounded chunks, preserving order and never
 * splitting a part that already fits. One oversized part is cut by characters
 * with a 3-bytes-per-character worst case, so a CJK part cannot overshoot.
 * @param {readonly string[]} parts - ordered text parts.
 * @param {number} limitBytes - per-chunk UTF-8 budget.
 * @returns {string[]} chunks in conversation order.
 */
export function packChunks(parts, limitBytes) {
  const chunks = []
  let current = ''
  let currentBytes = 0
  const flush = () => {
    if (current.length > 0) chunks.push(current)
    current = ''
    currentBytes = 0
  }
  const pieceChars = Math.max(1000, Math.floor(limitBytes / 3))
  for (const part of parts) {
    if (!part) continue
    const bytes = utf8Bytes(part)
    if (bytes > limitBytes) {
      flush()
      for (let offset = 0; offset < part.length; offset += pieceChars) {
        chunks.push(part.slice(offset, offset + pieceChars))
      }
      continue
    }
    if (currentBytes + bytes + 1 > limitBytes) flush()
    current = current === '' ? part : `${current}\n${part}`
    currentBytes += bytes + 1
  }
  flush()
  return chunks
}

/**
 * Conservative token price for one text: the harness heuristic, raised to one
 * token per three UTF-8 bytes when that is larger.
 *
 * The harness heuristic is density-based on characters, so CJK content can
 * undercount by ~3x against a real tokenizer. The byte floor is exact for CJK
 * and only ~33% pessimistic for ASCII, which is the right side to err on when
 * the number decides whether a request fits.
 * @param {string} text - measured text.
 * @param {number} estimate - heuristic estimate for the same text.
 * @returns {number} upper-bound tokens.
 */
export function conservativeTokens(text, estimate) {
  const heuristic = Number.isFinite(estimate) ? estimate : 0
  return Math.max(heuristic, Math.ceil(utf8Bytes(text) / 3))
}

/**
 * Decide whether the single-shot request fits, and how big one part may be.
 *
 * Adaptive sizing derives both budgets from the model that will actually
 * summarize: its declared window, the output it reserves, and the fixed
 * overhead of the system prompt and instruction. The byte caps remain the
 * transport guard, and `scale` is the learned multiplier for a route that has
 * already rejected a request.
 *
 * @param {object} input - planning input.
 * @param {number} input.contentTokens - conservative tokens the single-shot call would carry.
 * @param {number} input.contentBytes - UTF-8 bytes of the same payload.
 * @param {{window: number, reservedTokens: number, overheadTokens: number}} input.capacity - summarizer capacity.
 * @param {Readonly<Record<string, any>>} input.config - resolved chunking configuration.
 * @param {number} [input.scale] - learned capacity multiplier in [minScale, 1].
 * @returns {{needed: boolean, reason: string, scale: number, tokenBudget: number, byteBudget: number, partTokenBudget: number, partByteBudget: number}} plan.
 */
export function planChunking(input) {
  const config = input.config
  const scale = Math.min(1, Math.max(config.chunkMinScale, input.scale ?? 1))
  const fixed = config.chunkSizing === 'fixed'

  const capacityTokens = input.capacity.window > 0
    ? Math.max(0, input.capacity.window - input.capacity.reservedTokens - input.capacity.overheadTokens)
    : Number.POSITIVE_INFINITY
  const singleShotTokens = fixed ? capacityTokens : Math.floor(capacityTokens * config.chunkSingleShotRatio)
  const partTokens = fixed ? capacityTokens : Math.floor(capacityTokens * config.chunkTokenRatio)

  const tokenBudget = Math.floor(singleShotTokens * scale)
  const byteBudget = Math.floor(config.chunkTriggerBytes * scale)
  const partTokenBudget = Math.max(256, Math.floor(partTokens * scale))
  const partByteBudget = Math.max(10_000, Math.floor(config.chunkBytes * scale))

  if (config.chunking === 'off') {
    return {
      needed: false, reason: 'chunking disabled', scale, tokenBudget, byteBudget, partTokenBudget, partByteBudget,
    }
  }
  const overTokens = input.contentTokens > tokenBudget
  const overBytes = input.contentBytes > byteBudget
  const reason = overTokens
    ? `${input.contentTokens} tokens > ${tokenBudget} budget`
    : overBytes
      ? `${input.contentBytes} bytes > ${byteBudget} budget`
      : `${input.contentTokens} tokens / ${input.contentBytes} bytes fit the single-shot budget`
  return {
    needed: overTokens || overBytes,
    reason,
    scale,
    tokenBudget,
    byteBudget,
    partTokenBudget,
    partByteBudget,
  }
}

/**
 * Pack text parts into chunks that satisfy both a token and a byte budget.
 *
 * An oversized single part is cut into character pieces sized so either bound
 * holds in the worst case (1 token per character, 3 bytes per character).
 * @param {readonly string[]} parts - ordered text parts.
 * @param {{tokenBudget: number, byteBudget: number}} budget - per-chunk limits.
 * @param {(text: string) => number} estimate - heuristic token estimator.
 * @returns {string[]} chunks in conversation order.
 */
export function packByBudget(parts, budget, estimate) {
  const tokenBudget = Math.max(1, budget.tokenBudget)
  const byteBudget = Math.max(3, budget.byteBudget)
  const charsPerPiece = Math.max(500, Math.min(Math.floor(byteBudget / 3), tokenBudget))
  const chunks = []
  let current = ''
  let currentTokens = 0
  let currentBytes = 0
  const flush = () => {
    if (current.length > 0) chunks.push(current)
    current = ''
    currentTokens = 0
    currentBytes = 0
  }
  for (const part of parts) {
    if (!part) continue
    const partBytes = utf8Bytes(part)
    const partTokens = conservativeTokens(part, estimate(part))
    if (partBytes > byteBudget || partTokens > tokenBudget) {
      flush()
      for (let offset = 0; offset < part.length; offset += charsPerPiece) {
        chunks.push(part.slice(offset, offset + charsPerPiece))
      }
      continue
    }
    if (currentBytes + partBytes + 1 > byteBudget || currentTokens + partTokens + 1 > tokenBudget) flush()
    current = current === '' ? part : `${current}\n${part}`
    currentBytes += partBytes + 1
    currentTokens += partTokens + 1
  }
  flush()
  return chunks
}

/** Whether a failure looks like "the request was too big" rather than a real fault. */
export function isSizeFailure(error) {
  if (error === null || typeof error !== 'object') return false
  const code = String(error.code ?? '')
  if (code === 'MAX_TOKENS' || code === 'CONTEXT_WINDOW_EXCEEDED' || code === 'request_too_large') return true
  const message = `${error.message ?? ''} ${error.cause?.message ?? ''}`
  return /context (window|length)|too (large|long)|maximum context|max(imum)? tokens|request entity too large|\b413\b|payload/i.test(message)
}

/**
 * Update a route's learned capacity multiplier.
 * @param {number} previous - current multiplier.
 * @param {'shrink' | 'recover'} outcome - observed outcome.
 * @param {Readonly<Record<string, any>>} config - resolved chunking configuration.
 * @returns {number} next multiplier.
 */
export function nextScale(previous, outcome, config) {
  const base = Number.isFinite(previous) ? previous : 1
  const scaled = outcome === 'shrink' ? base * config.chunkShrinkFactor : base * config.chunkRecoverFactor
  return Math.min(1, Math.max(config.chunkMinScale, scaled))
}

/** Instruction for one digest call. */
export function chunkInstruction(index, total) {
  return [
    `You are condensing part ${index + 1} of ${total} of one long conversation, so another model can resume the work from the digests alone.`,
    '',
    'Write terse engineering notes for THIS part only: goals and their evolution, decisions with rationale, exact file paths, commands, identifiers, error strings, numbers, and unfinished work.',
    'Preserve verbatim anything whose exact wording matters. Do not restate the conversation, do not address the reader, and do not call any tool.',
    'If this part contains a prior checkpoint block, keep the facts that are still true and drop what is stale.',
  ].join('\n')
}

/** Instruction for the folding call, matching the single-shot checkpoint format. */
export function mergeInstruction(partCount) {
  return [
    `You are now acting as a compaction engine for this AI coding assistant. ${partCount} partial digests of one conversation follow. Condense them into a single structured checkpoint that lets another model resume the work with no loss of essential context.`,
    '',
    'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
    '',
    '## Primary Request and Intent',
    "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
    '',
    '## Key Technical Concepts',
    '- [technologies, frameworks, patterns, and conventions in play]',
    '',
    '## Files and Code',
    '- [exact path: why it matters, key changes or snippets]',
    '',
    '## Errors and Fixes',
    '- [error: how it was resolved, plus any related user feedback]',
    '',
    '## Pending Jobs',
    '- [explicitly requested work not yet completed]',
    '',
    '## Current Work',
    '- [precisely what was in progress at this checkpoint]',
    '',
    '## Next Step',
    '- [the single next action, directly in line with the most recent request, or "(none)"]',
    '',
    '## Critical Context',
    '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
    '',
    'Rules:',
    '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
    '- Capture user feedback and explicit instructions faithfully, especially corrections.',
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text: do not call any tool or take any other action.',
  ].join('\n')
}

/** Build the request messages for one digest call. */
export function digestMessages(system, chunkText, index, total) {
  const messages = []
  if (system !== null && system.length > 0) {
    messages.push({ role: 'system', content: [{ type: 'text', text: system }] })
  }
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: `${chunkInstruction(index, total)}\n\n---\n\n${chunkText}` }],
  })
  return messages
}

/** Build the request messages for the folding call. */
export function mergeMessages(system, digests) {
  const messages = []
  if (system !== null && system.length > 0) {
    messages.push({ role: 'system', content: [{ type: 'text', text: system }] })
  }
  const body = digests.map((digest, index) => `--- digest ${index + 1} ---\n${digest}`).join('\n\n')
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: `${mergeInstruction(digests.length)}\n\n${body}` }],
  })
  return messages
}

/**
 * Run one streaming completion and return its text.
 * @param {(options: any) => AsyncIterable<any>} stream - LLM stream factory.
 * @param {object} options - generate options, without messages.
 * @param {readonly any[]} messages - request messages.
 * @param {{BlockAssembler: any, LlmError: any}} llm - assembly classes from the LLM seam.
 * @returns {Promise<string>} trimmed text output.
 */
export async function streamText(stream, options, messages, llm) {
  const assembler = new llm.BlockAssembler()
  for await (const chunk of stream({ ...options, messages })) assembler.push(chunk)
  const finish = assembler.finish
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw llm.LlmError.fromFailure(finish.failure)
  }
  if (finish?.kind === 'max-tokens') {
    const error = new Error('chunked summarization truncated at the token cap')
    error.code = 'MAX_TOKENS'
    throw error
  }
  const text = assembler.blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (text.length === 0) throw new Error('chunked summarization produced no text')
  return text
}

/**
 * Map over items with bounded concurrency, preserving input order.
 * @param {readonly any[]} items - work items.
 * @param {number} limit - maximum in-flight tasks.
 * @param {(item: any, index: number) => Promise<any>} run - task.
 * @returns {Promise<any[]>} results in input order.
 */
export async function mapLimit(items, limit, run) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await run(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Instruction for the shrink pass.
 *
 * The base engine refuses a compaction whose summary is not strictly smaller
 * than the content it shadows ("summary is not smaller than the shadowed
 * content"), and a small shadowed range plus a generous budget is exactly how
 * that happens: the model writes a summary as long as the original. This pass
 * compresses the summary itself under a hard token target.
 * @param {number} budgetTokens - hard ceiling for the rewrite.
 * @param {number} originalTokens - size of the summary being rewritten.
 * @returns {string} instruction text.
 */
export function condenseInstruction(budgetTokens, originalTokens) {
  return [
    `Rewrite the checkpoint below in at most ${budgetTokens} tokens; it is currently about ${originalTokens} tokens and must become far smaller, because the whole point of compaction is to hand the next model less text than the original.`,
    '',
    'Keep every fact another engineer would need to resume: goals, decisions and their reasons, exact paths, commands, identifiers, error strings, numbers, and unfinished work. Drop repetition, restated history, and anything already superseded.',
    'Keep the section headings that exist; shorten their bullets to fragments. Do not add commentary, do not address the reader, and do not call any tool.',
  ].join('\n')
}