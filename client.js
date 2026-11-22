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

    /** Overview page: every session this process planned, grouped by workspace. */
    function Overview(props) {
      const [state, setState] = React.useState({ status: 'loading' })
      const load = React.useCallback(() => { fetchJson(OVERVIEW_ROUTE, {}, setState) }, [])
      React.useEffect(() => { load() }, [load])
      const sessions = state.data?.sessions ?? []

      // Workspace grouping mirrors the left sidebar: cwd from the shell's session list.
      const cwdOf = (id) => {
        try {
          const cwd = props.useSessions?.((list) => list?.byId?.[id]?.cwd)
          return typeof cwd === 'string' && cwd !== '' ? cwd : '未分组'
        } catch {
          return '未分组'
        }
      }
      const titleOf = (id) => {
        try {
          const title = props.useSessions?.((list) => list?.byId?.[id]?.title)
          return typeof title === 'string' && title !== '' ? title : id.slice(0, 18)
        } catch {
          return id.slice(0, 18)
        }
      }
      const open = (id) => {
        try {
          const workspace = props.ctxWorkspace ?? null
          if (workspace?.openSession) workspace.openSession(id)
        } catch {
          // Navigation is the shell's; a failed call leaves the page as it is.
        }
      }

      const groups = new Map()
      for (const session of sessions) {
        const key = cwdOf(session.sessionId)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(session)
      }

      return h('div', { style: { padding: '22px 26px', color: COLORS.ink, fontSize: 13, maxWidth: 980 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 } },
          h('div', { style: { fontSize: 15, fontWeight: 650 } }, '压缩洞察 · 总览'),
          h('span', { style: { color: COLORS.muted, fontSize: 11.5 } },
            `本进程规划过 ${sessions.length} 个会话`),
          h('button', {
            type: 'button',
            onClick: load,
            style: {
              marginLeft: 'auto', background: 'transparent', color: COLORS.muted, cursor: 'pointer',
              border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: '3px 10px', fontSize: 12,
            },
          }, '刷新')),
        h('div', { style: { color: COLORS.muted, fontSize: 11.5, marginBottom: 14 } },
          '只统计本进程实际做过规划的会话；没有实时数字的会话不在这里凭空出现。'),
        state.status === 'error' ? h('div', { style: { color: COLORS.bad } }, `读取失败：${state.message}`) : null,
        sessions.length === 0 && state.status === 'ready'
          ? h('div', { style: { color: COLORS.muted } }, '还没有会话触发过规划。先在会话里发一条消息，再回来刷新。')
          : null,
        ...[...groups.entries()].map(([cwd, rows]) => h('div', { key: cwd, style: { marginBottom: 18 } },
          h('div', { style: { color: COLORS.muted, fontSize: 11.5, marginBottom: 6 } }, cwd),
          h('div', { style: { border: `1px solid ${COLORS.line}`, borderRadius: 10, overflow: 'hidden' } },
            ...rows.map((row, index) => h('button', {
              key: row.sessionId,
              type: 'button',
              onClick: () => open(row.sessionId),
              style: {
                display: 'grid', width: '100%', textAlign: 'left', cursor: 'pointer', gap: 8,
                gridTemplateColumns: '1fr 92px 74px 82px 92px',
                alignItems: 'center', padding: '9px 12px', background: 'transparent',
                color: COLORS.ink, border: 'none',
                borderTop: index === 0 ? 'none' : `1px solid ${COLORS.line}`,
              },
            },
            h('span', { style: { fontSize: 12.5 } }, titleOf(row.sessionId)),
            h('span', { style: { font: MONO, color: COLORS.muted } }, `${row.provider ?? '—'}`),
            h('span', { style: { font: MONO } }, pct(row.thresholdShare)),
            h('span', { style: { font: MONO } }, tok(row.totalTokens)),
            h('span', { style: { font: MONO, color: COLORS.muted } },
              row.at === null ? '—' : new Date(row.at).toLocaleTimeString())))))))
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

    /** Tab title. */
    function Title() {
      return h('span', { style: { fontSize: 12 } }, '压缩洞察')
    }

    return {
      // Service injection, not module arrival: Cordis refuses to hand over a
      // property that is not declared here, and that failure took the whole
      // browser half down before it could register anything.
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace'],
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

        // Session-scoped detail tab: same numbers, scoped to the open conversation.
        ctx.effect(() => step('tab type', () => ctx.sidebarRightTabs.register({
          id,
          kind: TYPE,
          multiple: false,
          priority: 'extension',
          title: () => '压缩洞察',
          guide: [{
            id: 'open',
            order: 30,
            title: () => '压缩洞察',
            description: () => '查看压缩事务、预算条与分块容量',
          }],
        })), 'dsh-compaction-adaptive: tab type')

        ctx.effect(() => step('tab body', () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: id },
          (props) => h('div', { style: { padding: '12px 14px' } },
            h(Detail, { sessionId: props.sessionId })),
        ))), 'dsh-compaction-adaptive: tab body')

        ctx.effect(() => step('tab title', () => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: id },
          Title,
        ))), 'dsh-compaction-adaptive: tab title')
      },
    }
  },
})
