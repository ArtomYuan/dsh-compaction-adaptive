window.__ModuleLoader__.load({
  id: 'dsh-compaction-adaptive',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Projection key published by the host row. */
    const KEY = 'compaction-adaptive/insight'
    /** Right-sidebar tab type id. */
    const TYPE = 'compaction-insight'
    /** One session: durable transactions + live plan. */
    const DETAIL_ROUTE = 'compaction-adaptive/insight'
    /** Every session this process planned. */
    const OVERVIEW_ROUTE = 'compaction-adaptive/overview'

    const COLORS = {
      ink: 'var(--dsw-alias-text-primary, #e7e8ea)',
      muted: 'var(--dsw-alias-text-secondary, #9aa0a8)',
      line: 'var(--dsw-alias-border, #2b2d31)',
      card: 'var(--dsw-alias-surface, #1c1d20)',
      track: 'var(--dsw-alias-surface-hover, #262a30)',
      ok: '#42c58a',
      warn: '#e0a63c',
      bad: '#e5534b',
      accent: '#4c8dff',
    }

    const MONO = '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace'

    /** Format a token count as `12.4K` / `1.02M`. */
    function tok(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
      if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
      return String(Math.round(value))
    }

    /** Percent with one decimal, from a 0..1 share. */
    function pct(share) {
      return typeof share !== 'number' || !Number.isFinite(share) ? '—' : `${(share * 100).toFixed(1)}%`
    }

    /** Small label above a value. */
    function Stat({ label, value, tone }) {
      return h('div', {
        style: { background: COLORS.card, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: '8px 10px' },
      },
      h('div', { style: { color: COLORS.muted, fontSize: 11, marginBottom: 2 } }, label),
      h('div', { style: { font: MONO, fontSize: 15, color: tone ?? COLORS.ink } }, value))
    }

    /**
     * Segmented budget bar from the mockup: used portion, retained tail, the
     * amber threshold tick, and the window end.
     */
    function BudgetBar({ live }) {
      const window = live?.windowTokens
      const used = live?.totalTokens
      const threshold = live?.thresholdTokens
      const tail = live?.tailTokens
      if (typeof window !== 'number' || window <= 0) {
        return h('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 10 } },
          '本进程还没为这个会话做过规划，预算条暂不可用。')
      }
      const share = (value) => `${Math.max(0, Math.min(100, (value / window) * 100))}%`
      const usedPct = typeof used === 'number' ? (used / window) * 100 : 0
      const tone = usedPct >= 90 ? COLORS.bad : usedPct >= 70 ? COLORS.warn : COLORS.accent
      return h('div', { style: { marginBottom: 12 } },
        h('div', {
          style: {
            position: 'relative', height: 12, borderRadius: 6, overflow: 'hidden',
            background: COLORS.track, border: `1px solid ${COLORS.line}`,
          },
        },
        h('div', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: share(used ?? 0), background: tone, opacity: 0.85 } }),
        typeof tail === 'number' && typeof threshold === 'number'
          ? h('div', {
            style: {
              position: 'absolute', top: 0, bottom: 0, left: share(threshold - tail),
              width: share(tail), background: COLORS.accent, opacity: 0.35,
            },
          })
          : null,
        typeof threshold === 'number'
          ? h('div', { style: { position: 'absolute', top: -2, bottom: -2, left: share(threshold), width: 2, background: COLORS.warn } })
          : null),
        h('div', { style: { display: 'flex', gap: 10, marginTop: 4, color: COLORS.muted, fontSize: 10.5, fontFamily: 'ui-monospace, monospace' } },
          h('span', null, `已用 ${tok(used)} / ${tok(window)}`),
          h('span', null, `阈值 ${tok(threshold)}`),
          h('span', null, `尾窗 ${tok(tail)}`),
          h('span', { style: { marginLeft: 'auto' } }, `还需约 ${live?.turnsToThreshold ?? '—'} 轮`)))
    }

    /** One transaction row. */
    function Row({ record }) {
      const status = record.status ?? 'running'
      const tone = status === 'ok' ? COLORS.ok : status === 'failed' ? COLORS.bad : COLORS.warn
      const when = record.startedAt === undefined ? '—' : new Date(record.startedAt).toLocaleTimeString()
      const duration = record.durationMs === null || record.durationMs === undefined
        ? ''
        : ` · ${(record.durationMs / 1000).toFixed(1)}s`
      return h('div', {
        style: {
          display: 'grid', gridTemplateColumns: '70px 1fr auto', gap: 10,
          alignItems: 'baseline', padding: '7px 0', borderBottom: `1px dashed ${COLORS.line}`,
        },
      },
      h('span', { style: { color: COLORS.muted, font: MONO } }, when),
      h('span', { style: { fontSize: 12, lineHeight: 1.6 } },
        `${record.manual ? '手动 /compact' : '自动'} · 影子 `,
        h('b', null, tok(record.shadowedTokenCount)),
        record.shadowedNodes === undefined ? '' : ` · ${record.shadowedNodes} 节点`,
        h('br'),
        h('span', { style: { color: COLORS.muted, fontSize: 11 } },
          `${record.provider ?? '—'} · 摘要 ${record.summaryChars ?? 0} 字符${duration}`,
          record.error === undefined ? '' : ` · ${record.error}`)),
      h('span', {
        style: {
          color: tone, border: `1px solid ${tone}44`, background: `${tone}18`,
          borderRadius: 6, padding: '2px 6px', font: '600 10px/1 ui-monospace, monospace',
        },
      }, status === 'ok' ? '成功' : status === 'failed' ? '失败' : '进行中'))
    }

    /** Shared fetch of one route returning JSON. */
    function fetchJson(path, query, onDone) {
      const url = new URL(path, document.baseURI)
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
      fetch(url, { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((data) => onDone({ status: 'ready', data }))
        .catch((error) => onDone({ status: 'error', message: error instanceof Error ? error.message : String(error) }))
    }

    /** Budget + chunk + transactions for one session. */
    function Detail({ sessionId, compact }) {
      const [state, setState] = React.useState({ status: 'loading' })
      const load = React.useCallback(() => { fetchJson(DETAIL_ROUTE, { sessionId }, setState) }, [sessionId])
      React.useEffect(() => { load() }, [load])
      const live = state.data?.live ?? null
      const view = state.data?.view
      const records = view?.transactions ?? []

      const chunkPill = h('span', {
        style: {
          marginLeft: 'auto', color: live?.chunk ? COLORS.ok : COLORS.muted,
          border: `1px solid ${COLORS.line}`, borderRadius: 999, padding: '1px 8px',
          fontSize: 10.5, fontFamily: 'ui-monospace, monospace',
        },
      }, live?.chunk ? `容量 ${Math.round((live.chunk.scale ?? 1) * 100)}%` : '未激活')
      const chunkHead = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('span', { style: { fontSize: 12, fontWeight: 600 } }, '分块摘要'),
        chunkPill)
      const chunkNote = h('div', { style: { color: COLORS.muted, fontSize: 11, marginTop: 3 } },
        live?.chunk
          ? `${live.chunk.mode} / ${live.chunk.sizing} · 并发 ${live.chunk.concurrency}`
          : '仅当单次摘要请求超出预算时启用')
      const chunkCard = h('div', {
        style: {
          background: COLORS.card, border: `1px solid ${COLORS.line}`,
          borderRadius: 10, padding: '8px 10px', marginBottom: 10,
        },
      }, chunkHead, chunkNote)
      const list = records.length === 0
        ? h('div', { style: { color: COLORS.muted, fontSize: 12, paddingTop: 8 } }, '本会话还没有压缩记录。')
        : h('div', null, ...records.map((record) => h(Row, { key: record.compactionId, record })))

      return h('div', { style: { color: COLORS.ink, fontSize: 13 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 } },
          h('div', { style: { fontWeight: 650 } }, '压缩洞察'),
          h('span', { style: { color: COLORS.muted, fontSize: 11 } },
            live === null ? '（无实时规划）' : `${live.provider}/${live.model}`),
          h('button', {
            type: 'button',
            onClick: load,
            style: {
              marginLeft: 'auto', background: 'transparent', color: COLORS.muted, cursor: 'pointer',
              border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: '2px 9px', fontSize: 11,
            },
          }, '刷新')),
        state.status === 'error'
          ? h('div', { style: { color: COLORS.bad, marginBottom: 8 } }, `读取失败：${state.message}`)
          : null,
        h(BudgetBar, { live }),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 } },
          h(Stat, { label: '已用占窗口', value: pct(live?.usedShare) }),
          h(Stat, { label: '阈值占窗口', value: pct(live?.thresholdShare) }),
          h(Stat, { label: '增长/轮', value: tok(live?.growthTokens) })),
        chunkCard,
        list)
    }

    /**
     * Overview page: the whole session corpus, archived included.
     *
     * Root-scoped, so the host answers with durable per-session aggregates
     * (`/compaction-adaptive/overview`); live planning numbers ride along for the
     * sessions this process measured.
     */
    function Overview(props) {
      const [state, setState] = React.useState({ status: 'loading' })
      const [page, setPage] = React.useState(0)
      const load = React.useCallback(() => {
        setState({ status: 'loading' })
        fetchJson(OVERVIEW_ROUTE, {}, setState)
      }, [])
      React.useEffect(() => { load() }, [load])

      const kpi = state.data?.kpi
      const rows = state.data?.sessions ?? []
      const PAGE = 12
      const pages = Math.max(1, Math.ceil(rows.length / PAGE))
      const visible = rows.slice(page * PAGE, page * PAGE + PAGE)

      const cwdOf = (id, fallback) => {
        if (typeof fallback === 'string' && fallback !== '') return fallback
        try {
          const cwd = props.useSessions?.((list) => list?.byId?.[id]?.cwd)
          return typeof cwd === 'string' && cwd !== '' ? cwd : '未分组'
        } catch {
          return '未分组'
        }
      }
      const open = (id) => {
        try {
          props.ctxWorkspace?.openSession?.(id)
        } catch {
          // Navigation is the shell's; a failure leaves the page as it is.
        }
      }

      const card = (label, value, note) => h('div', {
        key: label,
        style: { background: COLORS.card, border: `1px solid ${COLORS.line}`, borderRadius: 12, padding: '12px 14px' },
      },
      h('div', { style: { color: COLORS.muted, fontSize: 11 } }, label),
      h('div', { style: { font: MONO, fontSize: 20, margin: '3px 0 2px' } }, value),
      note === undefined ? null : h('div', { style: { color: COLORS.muted, fontSize: 10.5 } }, note))

      const sessionCard = (row) => {
        const totals = row.totals ?? { total: 0, automatic: 0, manual: 0, failed: 0, shadowedTokens: 0 }
        const live = row.live
        return h('button', {
          key: row.sessionId,
          type: 'button',
          onClick: () => open(row.sessionId),
          style: {
            textAlign: 'left', cursor: 'pointer', color: COLORS.ink, background: COLORS.card,
            border: `1px solid ${COLORS.line}`, borderRadius: 12, padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: 6, minHeight: 104,
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
          h('span', {
            style: { fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, row.title),
          h('span', { style: { marginLeft: 'auto', color: COLORS.muted, fontSize: 10 } },
            row.lastAt === null ? '' : new Date(row.lastAt).toLocaleDateString())),
        h('div', { style: { color: COLORS.muted, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          cwdOf(row.sessionId, row.cwd)),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 'auto' } },
          h('div', null,
            h('div', { style: { color: COLORS.muted, fontSize: 9.5 } }, '压缩'),
            h('div', { style: { font: MONO, fontSize: 13 } }, String(totals.total))),
          h('div', null,
            h('div', { style: { color: COLORS.muted, fontSize: 9.5 } }, '影子'),
            h('div', { style: { font: MONO, fontSize: 13 } }, tok(totals.shadowedTokens))),
          h('div', null,
            h('div', { style: { color: COLORS.muted, fontSize: 9.5 } }, '阈值'),
            h('div', { style: { font: MONO, fontSize: 13, color: live === null ? COLORS.muted : COLORS.ink } },
              live === null ? '—' : pct(live.thresholdShare)))),
        totals.failed === 0
          ? null
          : h('div', { style: { color: COLORS.bad, fontSize: 10 } }, `失败 ${totals.failed} 次`))
      }

      return h('div', { style: { padding: '20px 26px', color: COLORS.ink, fontSize: 13 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 } },
          h('div', { style: { fontSize: 16, fontWeight: 650 } }, '压缩洞察'),
          h('span', { style: { color: COLORS.muted, fontSize: 11.5 } },
            state.data === undefined ? '' : `扫描 ${rows.length} 个会话${state.data.skipped > 0 ? `，跳过 ${state.data.skipped} 个` : ''}${state.data.cached ? '（缓存）' : ''}`),
          h('button', {
            type: 'button',
            onClick: load,
            style: {
              marginLeft: 'auto', background: 'transparent', color: COLORS.muted, cursor: 'pointer',
              border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: '3px 10px', fontSize: 12,
            },
          }, '刷新')),

        state.status === 'error'
          ? h('div', { style: { color: COLORS.bad, marginBottom: 10 } }, `读取失败：${state.message}`)
          : null,

        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 16 } },
          card('压过的会话', kpi === undefined ? '—' : `${kpi.compactedSessions} / ${kpi.sessions}`),
          card('压缩次数', kpi === undefined ? '—' : String(kpi.transactions),
            kpi === undefined ? undefined : `自动 ${kpi.automatic} · 手动 ${kpi.manual}`),
          card('影子总量', kpi === undefined ? '—' : tok(kpi.shadowedTokens),
            kpi === undefined || kpi.averageShadowedTokens === null ? undefined : `平均 ${tok(kpi.averageShadowedTokens)}/次`),
          card('成功率', kpi === undefined || kpi.successRate === null ? '—' : pct(kpi.successRate),
            kpi === undefined ? undefined : `失败 ${kpi.failed} 次`)),

        rows.length === 0 && state.status === 'ready'
          ? h('div', { style: { color: COLORS.muted } }, '还没有压缩记录：会话触发过一次压缩后才会出现在这里。')
          : null,

        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 } },
          ...visible.map(sessionCard)),

        pages > 1
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, color: COLORS.muted, fontSize: 11.5 } },
            h('button', {
              type: 'button',
              disabled: page === 0,
              onClick: () => setPage(Math.max(0, page - 1)),
              style: { background: 'transparent', color: 'inherit', border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: '2px 9px', cursor: page === 0 ? 'default' : 'pointer' },
            }, '上一页'),
            h('span', null, `${page + 1} / ${pages}`),
            h('button', {
              type: 'button',
              disabled: page >= pages - 1,
              onClick: () => setPage(Math.min(pages - 1, page + 1)),
              style: { background: 'transparent', color: 'inherit', border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: '2px 9px', cursor: page >= pages - 1 ? 'default' : 'pointer' },
            }, '下一页'))
          : null)
    }

    /** Left-sidebar list icon. */
    function PanelIcon({ size }) {
      const px = typeof size === 'number' ? size : 16
      return h('svg', {
        width: px, height: px, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      },
      h('path', { d: 'M2.5 3.5h11M2.5 8h7M2.5 12.5h4' }),
      h('path', { d: 'M11 7.5v5M9 10l2 2 2-2', opacity: 0.85 }))
    }

    return {
      // Service injection, not module arrival: Cordis refuses to hand over a
      // property that is not declared here, and that failure took the whole
      // browser half down before it could register anything.
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        const id = TYPE
        const step = (label, run) => {
          try {
            return run()
          } catch (error) {
            console.error(`[compaction-insight] ${label} failed:`, error)
            return undefined
          }
        }

        ctx.effect(() => step('sidebar entry', () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id,
          order: 30,
          label: () => '压缩洞察',
        }, PanelIcon))), 'dsh-compaction-adaptive: sidebar entry')

        // Root-scoped overview page behind that entry.
        ctx.effect(() => step('overview page', () => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: id,
          inject: () => ({ ctxWorkspace: ctx.uiWorkspace }),
        }, Overview))), 'dsh-compaction-adaptive: overview page')

        // Session-scoped detail tab: the row above the conversation
        // (对话 / 轨迹 / 上下文 / 编队 …), which is the 'conversation.view' list
        // slot. Session scope means the tab receives sessionId and useProjection.
        ctx.effect(() => step('conversation tab', () => ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id,
          order: 40,
          label: () => '压缩洞察',
          inject: (sessionId) => ({ sessionId }),
        }, (props) => h('div', { style: { padding: '16px 20px' } },
          h(Detail, { sessionId: props.sessionId }))))), 'dsh-compaction-adaptive: conversation tab')
      },
    }
  },
})
