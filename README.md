# dsh-compaction-adaptive

Adaptive context compaction for DeepSeek Harness.

The plugin is a compaction backend (`ctx.compaction`) built on
`@deepseek-ai/dsh-compaction-basic`: it keeps that backend's durable
compaction protocol and replaces only its numeric policy. Before every
automatic decision it derives the routed model's pressure threshold and
retained tail from

- the model's real context window (`llm.resolveModelInfo`),
- the output tokens the current request reserves,
- an exponential moving average of how many tokens each turn actually adds.

So a 1M-token cloud route stops trying to fill 800K before summarizing, and a
128K local route keeps more of the recent turn verbatim.

When a single summary request would exceed what the summarizing model can take,
the backend derives its own budgets from that model's declared window — and from
what the route has actually accepted — then digests the shadowed content in
parts and folds the digests into one checkpoint. A rejected request shrinks the
learned capacity and retries smaller; a success lets it recover. No separate
stream-interception plugin is needed for a relay limit.

## What it decides

| Question | Answer source |
| --- | --- |
| When to compact | `window − reserved output − turnsAhead × measured growth`, clamped to `floorRatio … ceilRatio` |
| How much recent history to keep verbatim | at least one turn's worth of measured growth, at least `tailMinTokens`, at most `tailMaxRatio` of the message budget |
| How large one summary request may be | the summary model's window times `chunkSingleShotRatio`, with a byte cap as the transport guard |
| How large one digest part may be | the same capacity times `chunkTokenRatio`, shrunk by the route's learned multiplier |

Cost ceilings stay expressible: a slow local prefill can cap its route with
`routes[].ceilRatio` and the adaptation happens *inside* that cap.

## Install

Requires DeepSeek Harness `>= 0.2.2-rc.1`. The plugin needs no build step: the
repository is the package.

```powershell
# from a local checkout
dsh plugin --profile desktop add D:\path\to\dsh-compaction-adaptive
```

or install it as a bundle from **Plugins → Add plugin** and pick the directory.

Mount it inside the Agent preset's `compaction` group in place of
`compaction-basic` (one backend per realm):

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-adaptive
      name: 'dsh-compaction-adaptive'
      config:
        mode: adaptive
        profile: balanced
        summarizationProvider: deepseek-account
        summarizationModel: deepseek-flash
        # Optional per-host cost ceiling: adapt within it, never exceed it.
        routes:
          - provider: strata-mi50
            model: deepseek-v4.1-flash-2.25bpw
            ceilRatio: 0.25
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
```

Restart the Harness once; the row is composed at boot.

## Configuration

`mode: adaptive | fixed` — `fixed` forwards to the base backend's fixed ratios,
for A/B comparison.

`profile: economy | balanced | quality` — multiplies `turnsAhead`, the retained
tail, and the headroom as a package.

`routes[]` — partial adaptive overrides for one `provider`/`model`, typically a
cost ceiling (`ceilRatio`, `profile`).

Chunking — `chunking: auto | off`, `chunkSizing: adaptive | fixed`,
`chunkSingleShotRatio`, `chunkTokenRatio`, `chunkTriggerBytes`, `chunkBytes`,
`chunkConcurrency`, `chunkMaxTokens`, `mergeMaxTokens`, `chunkRetries`,
`chunkShrinkAttempts`, `chunkShrinkFactor`, `chunkRecoverFactor`,
`chunkMinScale`.

Every field, the planning formula, the learn/recover loop, and the log lines are
documented in [`docs/DETAIL.md`](docs/DETAIL.md).

## Verify

Checks run without a Harness process:

```sh
node test/policy.test.mjs          # threshold / tail planning
node test/chunking.test.mjs        # packing, projection, prompts, concurrency
node test/adaptive-chunking.test.mjs  # model-derived budgets, shrink/recover
```

At runtime:

```
[compaction-adaptive] adaptive mode, balanced profile, 3 turn(s) of headroom, tail >= 4096 tokens, chunking auto/adaptive
[compaction-adaptive] deepseek-account/deepseek-flash window=1048576 budget=1015808 growth=12400 threshold=576716 (55.0%) tail=104038
[compaction-adaptive] chunked summary (20043 tokens > 12822 budget): 2 parts <= 8243 tokens / 700000 B each, concurrency 2, capacity scale 100%
```

## Scope

Reuses `compaction-basic`'s protocol, so session replay, summary checkpoints,
the busy lock, overflow recovery, and `/compact` are unchanged. It does not
change which surface range is compacted, and it drops reasoning blocks from
digested parts.

## Files

| File | Role |
| --- | --- |
| `lib/policy.js` | Pure planning math (window, growth, threshold, tail); no Cordis dependency |
| `lib/chunking.js` | Budget derivation, packing, text projection, digest/fold prompts, bounded concurrency |
| `lib/index.js` | The backend: observes, plans, installs the per-model policy, summarizes, delegates |
| `cordis.patch.yml` | Bundle layer; explains why the row is mounted by the preset |
| `docs/DETAIL.md` | Configuration, log lines, limits |

## License

MIT
