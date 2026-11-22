# dsh-compaction-adaptive

Adaptive context compaction for DeepSeek Harness.

[![npm](https://img.shields.io/npm/v/dsh-compaction-adaptive)](https://www.npmjs.com/package/dsh-compaction-adaptive)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

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

Requires DeepSeek Harness `>= 0.2.2-rc.1`. There is no build step: the published
package is the repository.

```sh
# from npm — the shortest form
dsh plugin --profile desktop add dsh-compaction-adaptive

# straight from GitHub
dsh plugin --profile desktop add https://github.com/ArtomYuan/dsh-compaction-adaptive

# pinned to a tag, for a reproducible profile
dsh plugin --profile desktop add https://codeload.github.com/ArtomYuan/dsh-compaction-adaptive/tar.gz/refs/tags/v0.2.0

# a local checkout, while developing: pack it, then install the tarball
pnpm pack --pack-destination .dist
dsh plugin --profile desktop add .dist/dsh-compaction-adaptive-0.2.0.tgz
```

`dsh plugin` forwards to the bundled pnpm, so a git install is pinned to a commit
in the profile lockfile; `dsh plugin --profile desktop update` moves it forward.

> **Install from a package, never as a linked directory.** A `link:` install
> (adding the checkout path, `link:…`, or a directory that pnpm links) does not
> install the package's dependencies. The plugin imports
> `@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-llm` and
> `@deepseek-ai/schemastery` from the Harness, so a linked install leaves those
> imports unresolvable; the preset row then fails to activate, the realm has no
> `compaction` service, and **every session fails to initialize** — sessions
> vanish from the sidebar instead of reporting an error. Pack a tarball or install
> from the registry.

The same URLs work in **Plugins → Add plugin**, where picking a local directory is
also accepted.

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
node test/insight.test.mjs         # panel projections: budget card, chunk card, transactions
node test/projection.test.mjs      # session projection: fold, wire payload, schemas
```

At runtime:

```
[compaction-adaptive] adaptive mode, balanced profile, 3 turn(s) of headroom, tail >= 4096 tokens, chunking auto/adaptive
[compaction-adaptive] deepseek-account/deepseek-flash window=1048576 budget=1015808 growth=12400 threshold=576716 (55.0%) tail=104038
[compaction-adaptive] chunked summary (20043 tokens > 12822 budget): 2 parts <= 8243 tokens / 700000 B each, concurrency 2, capacity scale 100%
```

## Insight panel

Two surfaces, two jobs. Both are read-only; neither influences compaction.

### Inside a session — the tab above the conversation

The session view row (`对话 / 轨迹 / 上下文 / 编队 …`) gains **压缩洞察**, registered on
the `conversation.view` list slot (session scope, order 40). It describes the open
conversation:

- a segmented **budget bar**: used tokens, the retained tail, an amber tick where
  this backend will compact, and the remaining turns of headroom;
- three stats: used share of the window, threshold share of the window, measured
  growth per turn;
- a **chunk card**: the learned capacity multiplier and the chunking mode;
- the durable **transaction list**: when each compaction ran, automatic or
  `/compact`, the shadowed token and node counts, the summarizing route, the
  summary length, the duration, and the outcome.

The budget, tail, threshold, growth and chunk numbers are *live engine state*, not
logged events, so they cannot ride a projection: the engine publishes each
planning snapshot into `lib/live.js` (a bounded, process-local registry) and
`GET /compaction-adaptive/insight?sessionId=…` returns `{ live, view, cold }` for
the tab.

### In the panel list — the overview

The left sidebar lists **压缩洞察** beside the other panels; it opens a root-scoped
page spanning **all workspaces**, grouped by working directory, one row per
session: title, provider, threshold share, used tokens, last planning time. A row
opens that session. Data comes from `GET /compaction-adaptive/overview`.

The overview lists only sessions this process actually planned: a session that was
never measured has no window, threshold or growth numbers, and inventing them
would be worse than leaving it out. Send one message in a session and it appears
after a refresh.

### How the durable half is projected

`lib/projection.js` folds `compaction/*` events into plain state, and the browser
reads the published value by key through `useProjection`. The projection is
registered with `wire.summary: false`, so it never rides along in a session
summary; both the fold and the view are wrapped, so a failure degrades the panel
to an empty list rather than failing a session load.

## Scope

Reuses `compaction-basic`'s protocol, so session replay, summary checkpoints,
the busy lock, overflow recovery, and `/compact` are unchanged. It does not
change which surface range is compacted, and it drops reasoning blocks from
digested parts.

## Releasing

Pushing a `v*` tag runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml):
the checks run first, then `npm stage publish` over OIDC. The version is *staged*,
not live — a maintainer approves it with 2FA on npmjs.com under **Staged Packages**
(or `npm stage approve <id>`). An OIDC token cannot approve by design, so the human
gate is on approval rather than on a stored token.

The trusted publisher is registered as stage-only, which makes a direct
`npm publish` from the workflow fail:

```sh
npm trust github dsh-compaction-adaptive \
  --file publish.yml --repo ArtomYuan/dsh-compaction-adaptive --allow-stage-publish
```

The same fields exist in the package's **Settings → Trusted publishing** page
(owner `ArtomYuan`, repository `dsh-compaction-adaptive`, workflow `publish.yml`,
environment empty).

## Files

| File | Role |
| --- | --- |
| `lib/policy.js` | Pure planning math (window, growth, threshold, tail); no Cordis dependency |
| `lib/chunking.js` | Budget derivation, packing, text projection, digest/fold prompts, bounded concurrency |
| `lib/insight.js` | Read-only projections for the observation panel: budget card, chunk card, compaction transactions |
| `lib/projection.js` | Session projection behind the panel: fold, wire payload, schemas |
| `lib/live.js` | Process-local registry of each session's latest planning snapshot (budget, tail, threshold, chunk capacity) |
| `index.js` | Package root: projection host plus the panel's two JSON routes |
| `client.js` | Browser half: the session view tab and the overview page |
| `insight-host.js` | Host row that registers the projection (`wire.summary: false`) |
| `client.js` | Browser half: the `compaction-insight` tab type and its panel |
| `lib/index.js` | The backend: observes, plans, installs the per-model policy, summarizes, delegates |
| `cordis.patch.yml` | Bundle layer; explains why the row is mounted by the preset |
| `docs/DETAIL.md` | Configuration, log lines, limits |

## License

MIT
