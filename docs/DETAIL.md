# 自适应上下文压缩

一个压缩后端（`ctx.compaction`）：它把 **何时压缩** 和 **压缩后保留多少近期历史** 从固定比例改成按模型现场推算。

它复用了 DSH 自带的 `@deepseek-ai/dsh-compaction-basic` 的全部持久化协议（`compaction/start` 锁、重放、单条摘要替换、失败重试、溢出恢复），只替换数字策略，所以会话日志、回放、fork、`/compact` 的行为完全不变。

## 它为什么需要"自适应"

原后端按窗口比例算预算：`thresholdTokens = min(窗口 × thresholdRatio, 消息预算 − headroomTokens)`，保留尾窗按 `retainRatio` 或绝对值算。同一组比例放在不同窗口上会得出很不一样的体感：

- 1M 窗口 + 0.8 → 800K 才压缩，单次 prefill 极贵；
- 128K 窗口 + 0.8 → 100K 就压缩，但尾窗只剩 20K，刚聊完的上下文容易被切掉。

按模型逐个写 `modelPolicies` 能治，但要靠手调，且模型一换、会话增长方式一变就失准。

## 每步实际算的东西

每次进入自动压缩判定（`agent/pre-step` 的压力检查、切换模型时的预算复核、上下文溢出恢复）前：

1. 读当前路由模型的真实窗口：`llm.resolveModelInfo(provider, model)` → `context.contextWindow`；同时扣掉该请求预留的输出（`header.config.maxTokens`，未声明则用适配器默认值）。
2. 用 `ctx.tokenMeter.measure()` 现价本会话的表层，和上一次观测相减得到"这一轮新长了多少 token"，折进指数滑动平均 `growth`（`growthAlpha`，默认 0.35；负增长视为压过了/裁剪过，只重新定基准，不污染均值）。
3. 推算触发点：目标是在**按当前速度再聊 `turnsAhead` 轮**之前就压缩，也就是
   `headroom = clamp(growth × turnsAhead, 窗口 × headroomMinRatio, 窗口 × headroomMaxRatio)`，
   `thresholdTokens = 消息预算 − headroom`，再夹在 `floorRatio ~ ceilRatio` 之间。
4. 推算尾窗：至少保留 `growth × keepTurns`（刚跑完的一轮别被切掉）、至少 `tailMinTokens`，上限 `tailMaxRatio × 消息预算` 且不超过阈值的 60%。
5. 把这份结果写成该 `provider/model` 的策略条目（保留你为该模型显式配置的摘要路由等字段），再交给原后端照常执行。

防抖：刚压缩完的下一步，若表层还没回到 `threshold × thrashMargin`（默认 1.15），这一步不压，避免"压一压、涨一点、再压一压"。

## 配置

行挂在 Agent 预设的 `compaction` 组里，替换原来的 `compaction-basic`：

```yaml
- id: compaction-adaptive
  name: 'dsh-compaction-adaptive'
  config:
    mode: adaptive            # adaptive（默认）| fixed（完全等于原后端行为）
    profile: balanced         # economy | balanced | quality
    turnsAhead: 3             # 想给"再聊几轮"留出余量
    growthAlpha: 0.35         # 增长速度的 EMA 权重
    floorRatio: 0.35          # 触发点下限（占窗口）
    ceilRatio: 0.9            # 触发点上限（占窗口）
    headroomMinRatio: 0.06    # 余量下限（占窗口）
    headroomMaxRatio: 0.4     # 余量上限（占窗口）
    tailRatio: 0.1            # 尾窗基准（占消息预算）
    tailMinTokens: 4096       # 尾窗绝对下限
    tailMaxRatio: 0.22        # 尾窗上限
    keepTurns: 1              # 至少保证"一轮"的 token 量留在原文
    cooldownSteps: 1          # 压缩后至少隔几步再评估
    thrashMargin: 1.15        # 冷却期允许压缩的额外余量
    verbose: false            # true 时每步都打印推算结果
    # 以下字段与 compaction-basic 同名同义，作为回退值与摘要控制
    summarizationProvider: deepseek-account
    summarizationModel: deepseek-flash
    maxTokens: 12000
    compactionRetries: 2
    maxOverflowRetries: 2
    modelPolicies:
      - provider: strata-local
        model: iq3_xxs
        summarizationProvider: strata-local
        summarizationModel: iq3_xxs
    # 按主机设"成本上限"：本机 prefill 慢，窗口再大也别顶满
    routes:
      - provider: strata-mi50
        model: deepseek-v4.1-flash-2.25bpw
        ceilRatio: 0.25        # 1M 窗口 → 262K 就压
        profile: economy
    # 单次摘要请求过大时分块：预算由"摘要模型自己的窗口"推算，不是写死的字节数
    chunking: auto
    chunkSizing: adaptive
    chunkSingleShotRatio: 0.7   # 一次发送最多占摘要模型可用容量的 70%
    chunkTokenRatio: 0.45       # 每块最多占 45%
    chunkTriggerBytes: 2400000  # 传输层兜底（字节），与此同效的还有 token 预算
    chunkBytes: 700000          # 每块字节上限
    chunkConcurrency: 2
    chunkMaxTokens: 4000        # 每块笔记的输出上限
    mergeMaxTokens: 6000        # 折叠检查点的输出上限
    chunkRetries: 1             # 单次调用的重试次数
    chunkShrinkAttempts: 2      # 被判定"请求太大"后整体缩容重排的次数
    chunkShrinkFactor: 0.6      # 每次缩容比例
    chunkRecoverFactor: 1.15    # 成功后逐步恢复比例
    chunkMinScale: 0.25         # 缩容下限
```

`modelPolicies` 与 `routes` 分工不同，不要混：

| 字段 | 归属 | 作用 |
| --- | --- | --- |
| `modelPolicies` | 被复用引擎 | 摘要路由/摘要上限等原样字段，自适应不会覆盖 |
| `routes` | 本插件 | 只放自适应参数（`ceilRatio`、`profile`、`turnsAhead`…），可只写想改的键 |

`routes` 里只写一部分键时，其余键继续用顶层自适应设置；若只把 `ceilRatio` 压得比默认 `floorRatio`（0.35）还低，下限会自动收到上限处，不会因为"下限高于上限"报错。

## profile 三档

`profile` 是三档预设乘数，不想逐个调字段时用：

| profile | turnsAhead 乘数 | 尾窗乘数 | 余量乘数 |
| --- | --- | --- | --- |
| economy | 0.6 | 0.6 | 0.9 |
| balanced | 1 | 1 | 1 |
| quality | 1.75 | 1.4 | 1.15 |

`mode: fixed` 时插件只做转发，行为与 `compaction-basic` 一致，方便逐模型对比。

## 怎么确认它在工作

启动日志（插件激活时）：

```
[compaction-adaptive] adaptive mode, balanced profile, 3 turn(s) of headroom, tail >= 4096 tokens
```

每次自动判定（`verbose: true` 或发生压缩时）：

```
[compaction-adaptive] strata-local/iq3_xxs window=524288 budget=491520 growth=12400 threshold=403200 (76.9%) tail=39321
[compaction-adaptive] shadowed 14 nodes (~268430 tokens)
```

压缩本身仍由原后端写下 `compaction/*` 事件，`/compact` 的手动路径不变。

## 分块摘要（单次请求太大时）

自适应决定的是**何时压**；这条决定的是**压不完怎么办**。

### 预算从哪来

不写死字节数，而是问"要来做摘要的那个模型一次能吃多少"：

1. `llm.resolveModelInfo(摘要路由)` 拿到它的真实窗口；
2. 扣掉它为本请求预留的输出（`maxTokens`）和固定开销（系统提示 + 折叠指令 + 工具 schema 的 token 估计）；
3. 剩下的容量里，一次发送最多用 `chunkSingleShotRatio`（默认 70%），每块最多用 `chunkTokenRatio`（默认 45%）；
4. 字节上限（`chunkTriggerBytes` / `chunkBytes`）作为**传输层**的第二道闸：token 与字节任一越线都算超限。

token 估计取「tokenMeter 启发式」与「UTF-8 字节 ÷ 3」的较大者：前者按字符密度算，遇到中文会低估约 3 倍；后者对中文精确、对 ASCII 只悲观约 1/3，是"决定能不能装下"时该偏的方向。

### 学习曲线

每条摘要路由有一个容量乘数（初始 1.0）：

- 请求被判定为"太大"（`CONTEXT_WINDOW_EXCEEDED`、`MAX_TOKENS`、`413`、`payload too large` 等）→ 乘数 × `chunkShrinkFactor`（默认 0.6，下限 `chunkMinScale` 0.25），按更小的块**重排重试**，最多 `chunkShrinkAttempts` 次；
- 成功一次 → 乘数 × `chunkRecoverFactor`（默认 1.15，上限 1.0），逐步恢复到模型声明的容量。

所以它不是"猜一次"，而是跟着真实反馈收敛：小窗口本地模型第一次就会分得很细，大窗口云端模型继续一次性发送；某个中转悄悄收紧限额时，下一次压缩会自动变小并记住。

### 流程

1. 把被压缩区间投影成文本（丢掉 reasoning 块），按当前乘数下的 token / 字节双预算装箱；
2. 每块一次调用产出该段工程笔记（`chunkMaxTokens`，并发 `chunkConcurrency`，失败按 `chunkRetries` 重试）；
3. 笔记本身若超过折叠预算，先分组再摘要一轮（最多 3 轮），最后折叠成一份符合 harness 结构的检查点（`mergeMaxTokens`）。

调用次数 > 1 时返回值里**不带** `llmStreamCall` 标记（该标记的语义就是"恰好一次 `ctx.llm.stream()` 调用"），落盘记录只保留 `rawOutput`，所以日志、回放、`/compact` 的语义都不变。

日志：

```
[compaction-adaptive] chunked summary (20043 tokens > 12822 budget): 2 parts <= 8243 tokens / 700000 B each, concurrency 2, capacity scale 100%
[compaction-adaptive] sum/sum-small rejected a chunked request (chunk summarization: the maximum context length is 32768 tokens); shrinking capacity to 60% and retrying
[compaction-adaptive] chunked summary done: 3 digests folded into 3120 chars
```

`chunking: off` 关掉这条路径，永远单次发送；`chunkSizing: fixed` 则退回"把整段容量当预算"的老口径（不做 70%/45% 缩放），便于对比。

## 边界

- 窗口未知的路由（适配器没有声明 `contextWindow`）不参与 token 推算：只剩字节闸门决定是否分块，不会凭空造出一个 token 上限。
- 分块只解决"摘要请求太大"，不改变区间选择：单个不可分的表层节点（一张巨大的工具结果、一个超大的非工具消息）仍然压不下——那是 `compaction-basic` 的范围规则，工具结果裁剪（`tool-result-pruner`）仍然先行。
- 分块摘要会丢弃 reasoning 块（不发给摘要模型）；需要保留推理过程的场景请用 `chunking: off` 并自行控制上限。
- 容量乘数是运行期学习状态，不写日志，重启后从 1.0 重新收敛（第一次略保守或略乐观，最多多试一轮）。
- 本插件占用 `ctx.compaction`，一个 realm 只能挂一个压缩后端：替换该行即等于停用原后端，不要同时挂两个。
- 会话内观测（增长速度）是派生缓存，不写日志，重启后从零开始重新估计（前几步回落到 `headroomMinRatio` 的保守值）。
