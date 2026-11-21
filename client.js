window.__ModuleLoader__.load({
  id: 'dsh-compaction-adaptive',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Projection key published by the host row (`insight-host.js`). */
    const KEY = 'compaction-adaptive/insight'
    const TYPE = 'compaction-insight'

    const COLORS = {
      ink: 'var(--dsw-alias-text-primary, #e7e8ea)',
      muted: 'var(--dsw-alias-text-secondary, #9aa0a8)',
      line: 'var(--dsw-alias-border, #2b2d31)',
      card: 'var(--dsw-alias-surface, #1c1d20)',
      ok: '#42c58a',
      warn: '#e0a63c',
      bad: '#e5534b',
      accent: '#4c8dff',
    }

    /** One transaction row: time, cause, shadowed span, route, outcome. */
    function Row({ record }) {
      const status = record.status ?? 'running'
      const tone = status === 'ok' ? COLORS.ok : status === 'failed' ? COLORS.bad : COLORS.warn
      const when = record.startedAt === undefined ? '—' : new Date(record.startedAt).toLocaleTimeString()
      return h('div', {
        style: {
          display: 'grid', gridTemplateColumns: '66px 1fr auto', gap: 10,
          alignItems: 'baseline', padding: '7px 0', borderBottom: `1px dashed ${COLORS.line}`,
        },
      },
      h('span', { style: { color: COLORS.muted, font: '11px/1 ui-monospace, monospace' } }, when),
      h('span', { style: { fontSize: 12 } },
        `${record.manual ? '手动 /compact' : '自动'} · 影子 `,
        h('b', null, record.shadowedTokenCount === undefined ? '—' : `${Math.round(record.shadowedTokenCount / 1000)}K`),
        record.shadowedNodes === undefined ? '' : ` · ${record.shadowedNodes} 节点`,
        h('br'),
        h('span', { style: { color: COLORS.muted, fontSize: 11 } },
          `${record.provider ?? '—'} · 摘要 ${record.summaryChars ?? 0} 字符`,
          record.durationMs === null || record.durationMs === undefined ? '' : ` · ${(record.durationMs / 1000).toFixed(1)}s`,
          record.error === undefined ? '' : ` · ${record.error}`),
      ),
      h('span', {
        style: {
          color: tone, border: `1px solid ${tone}44`, background: `${tone}18`,
          borderRadius: 6, padding: '2px 6px', font: '600 10px/1 ui-monospace, monospace',
        },
      }, status === 'ok' ? '成功' : status === 'failed' ? '失败' : '进行中'))
    }

    /** The tab body. */
    function Panel(props) {
      const raw = props.useProjection === undefined ? undefined : props.useProjection(KEY)
      const view = raw?.data ?? raw?.value ?? raw ?? null
      const totals = view?.totals
      const records = view?.transactions ?? []

      return h('div', { style: { padding: '12px 14px', color: COLORS.ink, fontSize: 13 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 } },
          h('div', { style: { fontWeight: 650 } }, '压缩洞察'),
          h('span', { style: { marginLeft: 'auto', color: COLORS.muted, fontSize: 11 } },
            totals === undefined ? '读取中…' : `本会话 ${totals.total} 次`)),

        h('div', {
          style: {
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10,
          },
        }, ...[
          ['自动', totals?.automatic ?? 0],
          ['手动', totals?.manual ?? 0],
          ['失败', totals?.failed ?? 0],
          ['影子', totals === undefined ? '—' : `${Math.round(totals.shadowedTokens / 1000)}K`],
        ].map(([label, value]) => h('div', {
          key: label,
          style: { background: COLORS.card, border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: '7px 9px' },
        },
        h('div', { style: { color: COLORS.muted, fontSize: 11 } }, label),
        h('div', { style: { font: '16px/1.3 ui-monospace, monospace' } }, String(value))))),

        records.length === 0
          ? h('div', { style: { color: COLORS.muted, fontSize: 12, padding: '10px 0' } },
            view === null ? '等待宿主投影…' : '本会话还没有压缩记录。')
          : h('div', null, ...records.map((record) => h(Row, { key: record.compactionId, record }))),

        h('div', { style: { color: COLORS.muted, fontSize: 11, marginTop: 10 } },
          '预算与分块卡需要引擎的实时状态，下一版接入；这里只显示日志能证明的事实。'),
      )
    }

    /** Tab title: the type's own label. */
    function Title() {
      return h('span', { style: { fontSize: 12 } }, '压缩洞察')
    }

    /**
     * Left-sidebar list icon. `sidebar.panellist` renders the component passed
     * as the registration's second argument, and hands it a `size`.
     */
    function PanelIcon({ size }) {
      const px = typeof size === 'number' ? size : 16
      return h('svg', {
        width: px, height: px, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      },
      h('path', { d: 'M2.5 3.5h11M2.5 8h7M2.5 12.5h4' }),
      h('path', { d: 'M11 7.5v5M9 10l2 2 2-2', opacity: 0.85 }))
    }

    /**
     * The `main` panel behind the left-sidebar entry.
     *
     * `main` is a root-scoped slot, so it receives no session props and cannot
     * read the session projection. Rather than show stale or fabricated numbers,
     * it reveals the real panel in the right sidebar, where the projection is in
     * scope, and reports what happened if that call is unavailable.
     */
    function PanelPage(props) {
      const [note, setNote] = React.useState('')
      React.useEffect(() => {
        try {
          props.openPanel()
        } catch (error) {
          setNote(`无法自动打开右侧栏面板：${error instanceof Error ? error.message : String(error)}`)
        }
      }, [])
      return h('div', { style: { padding: '22px 26px', color: COLORS.ink, fontSize: 13, lineHeight: 1.7 } },
        h('div', { style: { fontSize: 15, fontWeight: 650, marginBottom: 6 } }, '压缩洞察'),
        h('div', { style: { color: COLORS.muted } },
          '面板在右侧栏打开：本会话的压缩事务、影子区间、摘要路由与耗时。'),
        note === '' ? null : h('div', { style: { color: COLORS.bad, marginTop: 10 } }, note))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const id = TYPE

        // One type, one tab per session: opening it again reveals it.
        ctx.effect(() => ctx.sidebarRightTabs.register({
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
        }), 'dsh-compaction-adaptive: tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: id },
          Panel,
        )), 'dsh-compaction-adaptive: tab body')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: id },
          Title,
        )), 'dsh-compaction-adaptive: tab title')

        // Left-sidebar entry: the same id as the tab type, so the entry and the
        // panel share one identity. `main` must exist for the entry to switch to,
        // hence PanelPage; it forwards to the right sidebar.
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: id,
          inject: () => ({
            openPanel: () => {
              ctx.sidebarRight.openTab(TYPE, {})
            },
          }),
        }, PanelPage)), 'dsh-compaction-adaptive: main panel')

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id,
          order: 30,
          label: () => '压缩洞察',
        }, PanelIcon)), 'dsh-compaction-adaptive: sidebar entry')
      },
    }
  },
})
