window.__ModuleLoader__.load({
  id: 'dsh-compaction-adaptive',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Projection key published by the host row. */
    const KEY = 'compaction-adaptive/insight'
    /** Right-sidebar tab type id. */
    const TYPE = 'compaction-insight'
    /** Host route serving the same data to a root-scoped page. */
    const ROUTE = 'compaction-adaptive/insight'

    const COLORS = {
      ink: 'var(--dsw-alias-text-primary, #e7e8ea)',
      muted: 'var(--dsw-alias-text-secondary, #9aa0a8)',
      line: 'var(--dsw-alias-border, #2b2d31)',
      card: 'var(--dsw-alias-surface, #1c1d20)',
      ok: '#42c58a',
      warn: '#e0a63c',
      bad: '#e5534b',
    }

    const TOTALS = [
      ['自动', (totals) => totals.automatic],
      ['手动', (totals) => totals.manual],
      ['失败', (totals) => totals.failed],
      ['影子', (totals) => `${Math.round(totals.shadowedTokens / 1000)}K`],
    ]

    /**
     * The session the panel should describe.
     *
     * A `main` panel is root-scoped: it gets no `sessionId` prop, so — the way
     * `dsh-context` resolves its own page — read the global `useSessions` state
     * when it exposes a current session, and fall back to the same
     * `dsh.sessions.current` record the shell writes.
     * @param {object} props - slot props.
     * @returns {string | undefined} the session id, when known.
     */
    function currentSessionId(props) {
      try {
        if (typeof props.useSessions === 'function') {
          const fromStore = props.useSessions((state) => state?.currentSessionId
            ?? state?.current?.id
            ?? state?.selectedSessionId)
          if (typeof fromStore === 'string' && fromStore !== '') return fromStore
        }
      } catch {
        // The shell's list shape is not part of this plugin's contract; fall through.
      }
      try {
        const raw = window.localStorage.getItem('dsh.sessions.current')
        const parsed = raw === null ? null : JSON.parse(raw)
        const id = parsed?.sessionId
        if (typeof id === 'string' && id !== '') return id
      } catch {
        // Storage can be disabled; the page then reports that it has no session.
      }
      return undefined
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
      h('span', { style: { color: COLORS.muted, font: '11px/1 ui-monospace, monospace' } }, when),
      h('span', { style: { fontSize: 12, lineHeight: 1.6 } },
        `${record.manual ? '手动 /compact' : '自动'} · 影子 `,
        h('b', null, record.shadowedTokenCount === undefined
          ? '—'
          : `${Math.round(record.shadowedTokenCount / 1000)}K`),
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

    /** Totals strip shared by the tab and the page. */
    function Totals({ totals }) {
      return h('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 },
      }, ...TOTALS.map(([label, read]) => h('div', {
        key: label,
        style: { background: COLORS.card, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: '7px 9px' },
      },
      h('div', { style: { color: COLORS.muted, fontSize: 11 } }, label),
      h('div', { style: { font: '16px/1.3 ui-monospace, monospace' } },
        totals === undefined ? '—' : String(read(totals))))))
    }

    /** Transaction list shared by the tab and the page. */
    function Records({ view, empty }) {
      const records = view?.transactions ?? []
      if (records.length === 0) {
        return h('div', { style: { color: COLORS.muted, fontSize: 12, padding: '10px 0' } },
          view === null || view === undefined ? '读取中…' : empty)
      }
      return h('div', null, ...records.map((record) => h(Row, { key: record.compactionId, record })))
    }

    /** Right-sidebar tab body: session-scoped, reads the projection directly. */
    function Panel(props) {
      const view = typeof props.useProjection === 'function' ? props.useProjection(KEY) : undefined
      return h('div', { style: { padding: '12px 14px', color: COLORS.ink, fontSize: 13 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 } },
          h('div', { style: { fontWeight: 650 } }, '压缩洞察'),
          h('span', { style: { marginLeft: 'auto', color: COLORS.muted, fontSize: 11 } },
            view?.totals === undefined ? '读取中…' : `本会话 ${view.totals.total} 次`)),
        h(Totals, { totals: view?.totals }),
        h(Records, { view, empty: '本会话还没有压缩记录。' }),
        h('div', { style: { color: COLORS.muted, fontSize: 11, marginTop: 10 } },
          '数据来自会话投影（compaction/* 事件折叠），不含未落盘的状态。'))
    }

    /** Tab title. */
    function Title() {
      return h('span', { style: { fontSize: 12 } }, '压缩洞察')
    }

    /**
     * The `main` page behind the left-sidebar entry.
     *
     * Root-scoped slots get no session props, so the host serves the page's data
     * over HTTP and this component asks for the session the shell currently has.
     */
    function Page(props) {
      const [state, setState] = React.useState({ status: 'loading' })
      const sessionId = currentSessionId(props)
      const load = React.useCallback(() => {
        if (sessionId === undefined) {
          setState({ status: 'no-session' })
          return
        }
        setState({ status: 'loading' })
        const url = new URL(ROUTE, document.baseURI)
        url.searchParams.set('sessionId', sessionId)
        fetch(url, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((view) => { setState({ status: 'ready', view }) })
          .catch((error) => { setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }) })
      }, [sessionId])
      React.useEffect(() => { load() }, [load])

      return h('div', { style: { padding: '22px 26px', color: COLORS.ink, fontSize: 13, maxWidth: 760 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 } },
          h('div', { style: { fontSize: 15, fontWeight: 650 } }, '压缩洞察'),
          h('button', {
            type: 'button',
            onClick: load,
            style: {
              marginLeft: 'auto', background: 'transparent', color: COLORS.muted,
              border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: '3px 10px', cursor: 'pointer', fontSize: 12,
            },
          }, '刷新')),
        h('div', { style: { color: COLORS.muted, marginBottom: 14 } },
          sessionId === undefined ? '未找到当前会话。' : `会话 ${sessionId.slice(0, 18)}… 的压缩事务`),
        h(Totals, { totals: state.view?.totals }),
        state.status === 'no-session'
          ? h('div', { style: { color: COLORS.muted } }, '请先在左侧打开一个会话，再回到这里刷新。')
          : state.status === 'error'
            ? h('div', { style: { color: COLORS.bad } }, `读取失败：${state.message}`)
            : h(Records, { view: state.status === 'ready' ? state.view : null, empty: '本会话还没有压缩记录。' }))
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
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
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

        ctx.effect(() => step('main page', () => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: id,
        }, Page))), 'dsh-compaction-adaptive: main page')

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
            description: () => '查看压缩事务、影子区间与摘要路由',
          }],
        })), 'dsh-compaction-adaptive: tab type')

        ctx.effect(() => step('tab body', () => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: id },
          Panel,
        ))), 'dsh-compaction-adaptive: tab body')

        ctx.effect(() => step('tab title', () => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: id },
          Title,
        ))), 'dsh-compaction-adaptive: tab title')
      },
    }
  },
})
