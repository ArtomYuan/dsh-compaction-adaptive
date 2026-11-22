# 开发文档：代码地图

面向要改这个包的人（包括未来的我）。回答四个问题：**哪个文件负责什么、数据怎么流动、哪里不能动、出问题怎么查**。
使用者文档见 `README.md`，配置与算法细节见 `DETAIL.md`。

---

## 1. 两个半边，两种作用域

DSH 插件不是"一个东西"，而是两个独立加载的半边，作用域也不同：

| 半边 | 入口 | 谁加载 | 作用域 | 备注 |
| --- | --- | --- | --- | --- |
| **host（宿主）** | `index.js`（包根） | profile 行 `compaction-insight`（由本包 `cordis.patch.yml` 插入） | 进程级 | 注册会话投影 + 两条 JSON 路由 |
| **host（压缩后端）** | `lib/index.js` | **Agent preset** 的 `compaction` 组内一行，名字是 `dsh-compaction-adaptive/engine` | preset 的隔离 realm | 提供 `ctx.compaction` 服务 |
| **browser（客户端）** | `client.js` | Web 应用按 `package.json` 的 `dsh.client` 声明加载 | 浏览器 | 注册会话内 tab + 左侧总览页 |

**为什么后端要单独一个子路径**：包根必须留给"投影宿主"，因为**客户端 bundle 只对"行名是精确包名"的行加载**（见 §4 第 1 条）。所以引擎不能让包根当入口。

---

## 2. 文件职责表

| 文件 | 职责 | 不该放什么 |
| --- | --- | --- |
| `index.js` | 包根 host 半边：挂投影（`attachInsightProjection`）+ 两条路由（`/compaction-adaptive/insight`、`/compaction-adaptive/overview`）+ 响应序列化 | 压缩决策逻辑 |
| `insight-host.js` | 0.3 之前包根入口的兼容别名，内部同样调 `attachInsightProjection` | 新功能 |
| `lib/index.js` | **压缩后端本体**：`AdaptiveCompactionEngine extends BasicCompactionEngine`。覆写 `compactIfNeeded`（按路由装自适应策略 + 抖动守卫）、`summarize`（单发 / 分块）、`insight()`（给面板用的快照）；构造时解析配置 | HTTP、DOM |
| `lib/policy.js` | **纯函数**：窗口/增长/阈值/尾窗的推算式。`PROFILES`、`resolveAdaptiveConfig`、`resolveRoutes`、`planPolicy`、`describePlan` | 任何 `ctx` / IO |
| `lib/chunking.js` | **纯函数**：分块预算推导、`packChunks`、摘要与折叠提示词、`mapLimit` 并发、`isSizeFailure`/`nextScale` 容量学习 | 任何 `ctx` / IO |
| `lib/insight.js` | **纯函数**：把引擎内存态投影成面板字段（`budgetSnapshot`、`chunkSnapshot`、`summarizeCompactions`） | 事件折叠（那是 projection 的活） |
| `lib/projection.js` | **会话投影**：`compaction/*` 事件 → 事务表；`wire.view` 输出面板载荷；zod schema；**`summary: false`** | 实时数字（投影必须可回放） |
| `lib/projection-host.js` | 把上面那个投影注册到 `ctx.sessionProjections`，生命周期挂在行上 | 业务逻辑 |
| `lib/live.js` | **进程内注册表**（上限 64）：每个会话最近一次规划快照。预算/尾窗/阈值/分块容量只能从这里拿 | 持久化 |
| `lib/aggregate.js` | **跨会话聚合**：`sessionQuery.listSessions()` 枚举 + `observeSession` 读投影，产出 KPI 与会话行，15 秒缓存 | 实时数字 |
| `lib/shrink.js` | **自适应收缩规划**：收益门槛、派生预算、重试阶梯、按路由学比例 | IO / ctx |
| `client.js` | 浏览器半边：`conversation.view` 会话内 tab（`Detail`）+ `sidebar.panellist` 入口与 root 页（`Overview`）；`fetchJson` 取数；UI 组件与样式 | 业务判定 |
| `cordis.patch.yml` | bundle 层：插入 `compaction-insight` 行（**行名必须是包根**） | 引擎行（那是 preset 的事） |
| `locale/*.json`、`icon.svg` | 插件元信息与图标 | — |
| `test/*.test.mjs` | 纯函数与投影的单测（见 §6） | 需要宿主环境的测试 |

---

## 3. 数据流

### 3.1 耐久的一半：事件 → 投影 → 面板

```
会话日志 compaction/start · summary · end
        ↓  applyInsight(state, event)            纯函数，非 compaction 事件返回同一引用
   投影 state { transactions[] }                最多 40 条
        ↓  wire.view → viewInsight(state)        加 duration/status，算 totals
   客户端 useProjection('compaction-adaptive/insight')
```

- 投影是**可回放的**：`apply` 只能读事件，不能读引擎内存。
- `wire.summary: false`：投影不随会话 summary 下发。**这一条是安全底线**（§4 第 2 条）。

### 3.2 实时的一半：规划 → 注册表 → 路由 → 页面

```
compactIfNeeded → _observe() 得到 { measurement, plan }
        ↓  publishLive(sessionId, { at, trigger, provider, model, measurement, plan, chunk })
   lib/live.js（进程内 Map，上限 64）
        ↓  GET /compaction-adaptive/insight?sessionId=…
   { live, view, cold }  →  会话内 tab（预算条 / 三格 / 分块卡）
        ↓  GET /compaction-adaptive/overview
   { sessions: [...] }   →  左侧总览页（按 cwd 分组）
```

窗口、阈值、尾窗、增长、分块容量**都不是事件**，所以只能放在 `live.js`。代价：进程重启后清空，总览页面会说明这一限制。

---

## 4. 四条不能动的契约（每条都是踩出来的）

1. **profile 行的 `name` 必须是精确包名。**
   `dsh-client-modules` 用 `exactPackageSpecifier()` 判定行是不是 "client 行"：无 `@` 前缀且含 `/` → `undefined` → 该行的 `./client` **永不加载**。所以投影行叫 `dsh-compaction-adaptive`，引擎行才叫 `dsh-compaction-adaptive/engine`。

2. **投影必须 `wire.summary: false`，且 `apply`/`view` 不许抛。**
   进了会话 summary 的投影会在**加载会话时**执行；抛错 → resume 失败 → 宿主 dispose 会话 → 前端把该行删掉（"点开就消失"）。两个函数都包了 try/catch，`view` 失败返回空载荷。

3. **客户端插件返回的 `inject` 要列全它读的服务。**
   Cordis 会直接抛 `cannot get property "X" without inject`，**整个浏览器半边**在第一次访问时挂掉，什么都不会注册。当前：`['slots', 'uiWorkspace']`。
   注意区分：`package.json` 的 `dsh.client.inject` 管**模块到达**，插件的 `inject` 管**服务访问**。

4. **安装形态：只能从包安装，不能 `link:`。**
   `link:` 不装依赖 → `import '@deepseek-ai/dsh-compaction-basic'` 解析失败 → preset 行不激活 → realm 没有 `compaction` 服务 → **每个会话都初始化失败**。开发时用 `pnpm pack` + 装 tarball。同理，`zod` 必须在 `dependencies`，不能在 `devDependencies`（0.2.0 就栽在这）。

### 面板位置的选择理由

- 会话内 → `conversation.view` 列表槽（session 作用域）：与「轨迹」「编队」同级，拿得到 `sessionId`。
- 左侧入口 → `sidebar.panellist` + `main`（root 作用域）：只能做**跨会话总览**，因为 root 作用域拿不到会话 props，也拿不到右侧栏所需的"会话面"（强行 `openTab` 会报 `no session surface is mounted`）。

---

## 5. 常见改动落在哪

| 想改什么 | 改哪里 |
| --- | --- |
| 阈值 / 尾窗推算式 | `lib/policy.js` 的 `planPolicy`（配 `PROFILES`） |
| 某模型/路由的成本上限 | profile patch 的 `routes` 条目（`ceilRatio`/`profile`），解析在 `resolveRoutes` |
| 分块触发条件、单块大小、并发 | `lib/chunking.js` 的 `CHUNK_DEFAULTS` + `planChunking` |
| 容量学习（遇到过大的失败后收缩） | `isSizeFailure` / `nextScale` / 引擎里的 `_withRetries` |
| 摘要提示词 | `chunking.js` 的 `chunkInstruction` / `mergeInstruction` |
| 面板显示哪些字段 | 先看 `lib/insight.js`（内存态）与 `lib/projection.js`（事件态），再到 `index.js` 路由和 `client.js` 组件 |
| 面板版式 / 样式 | `client.js`：`BudgetBar`、`Stat`、`Row`、`Detail`、`Overview` |
| 新增一条数据给 UI | 事件派 → 加进 `projection.js` 与 `viewSchema`；非事件派 → 加进 `publishLive` 的载荷和 `index.js` 路由 |

---

## 6. 测试与自查

```sh
node test/policy.test.mjs            # 推理式：阈值/尾窗
node test/chunking.test.mjs          # 分块：装箱、提示词、并发、容量
node test/adaptive-chunking.test.mjs # 模型预算、收缩/恢复
node test/insight.test.mjs           # 面板字段计算
node test/projection.test.mjs        # 投影折叠、wire 载荷、schema、40 条上限
node test/shrink.test.mjs            # 收缩规划：收益门槛、预算阶梯、比例学习
```

需要宿主环境的验证手段（不需要开 GUI）：

1. **路由**：`curl 'http://127.0.0.1:<port>/compaction-adaptive/overview?token=…'`，直接看 JSON。
2. **浏览器半是否加载**：启动参数 `--enable-logging=stderr` 的 Edge 抓渲染进程 console；插件注册失败会打 `[compaction-insight] <步骤> failed:`。
3. **行是否被当成 client 行**：启动文档里的 `__DSH_BOOT__` entries 是否包含包名。
4. **隔离实验**：`DSH_HOME=<临时目录>` 起一个独立 profile，装 `pnpm pack` 出来的 tarball，不碰主 profile。

---

## 7. 版本与发布

- 语义化版本；结构性改动（改行名、改槽位、改路由）算 minor。
- 打 `v*` tag → `.github/workflows/publish.yml` 跑三个测试 → `npm stage publish` → 在 npmjs.com 的 **Staged Packages** 手动批准。
- 已废弃的坑位版本：`0.5.0`（把会话内面板挂到了右侧栏，位置错误）。
