// dsh-memory-personal — browser half (served at /plugins/dsh-memory-personal/client.js).
//
// Memory Center: a navigation-style management surface rendered inside the
// settings section via the official DSH UI slot. It only talks to the loopback
// host routes /dsh-memory-personal/api/* (the ONLY source of memory rows) and never
// touches SQLite or memory files. React renders all text (no innerHTML).
//
// Layout is driven by docs/UI-PLAN.md. Batch A pages (real data, no shells):
//   Dashboard / Memories / Search Explorer (first level) / Timeline / Settings
//   + a Detail view (record fields + evidence + audit + edit + delete confirm).
// Everything else in the 25-section spec is shown in the sidebar as a planned
// page gated by its backend Phase (UI-PLAN §2, §6).

window.__ModuleLoader__.load({
  id: 'dsh-memory-personal',
  factory: (require) => {
    'use strict'

    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback, useSyncExternalStore } = React
    require('@deepseek-ai/dsh-client-runtime/client')

    const API = '/dsh-memory-personal/api'
    const PAGE_SIZE = 50
    /** Planned pages: spec section maps to a Memory Core Phase. */
    const PLANNED_PAGES = [
      { key: 'evidence', phase: '2' },
      { key: 'profile', phase: '2+5' },
      { key: 'projects', phase: '2/3' },
      { key: 'projectState', phase: '3' },
      { key: 'experiences', phase: '4' },
      { key: 'errors', phase: '4' },
      { key: 'quarantine', phase: '5' },
      { key: 'conflicts', phase: '5' },
      { key: 'knowledge', phase: '5' },
      { key: 'graph', phase: '6' },
      { key: 'backup', phase: '7' },
      { key: 'health', phase: '7' },
      { key: 'analytics', phase: '8' },
    ]

    const zh = {
      centerTitle: '记忆中心',
      centerSubtitle: '记忆系统操作中心：理解、控制、修正与验证你的记忆。',
      nav: {
        dashboard: '概览', memories: '记忆库', search: '检索调试',
        timeline: '活动时间线', settings: '设置',
      },
      planned: '规划页面',
      plannedHint: '以下功能仍在规划中，就绪后会出现在侧栏导航里。',
      plannedTag: '规划中',
      // shared state
      loading: '加载中…',
      error: '出错',
      retry: '重试',
      refresh: '刷新',
      export: '导出 JSON',
      close: '关闭',
      // dashboard
      overviewTitle: 'Memory 概览',
      cardTotal: '记忆总数',
      cardActive: '活跃',
      cardQuarantined: '隔离',
      cardArchived: '已归档',
      cardLowConf: '低置信度',
      cardUserEdited: '用户保护',
      distributionTitle: '分布',
      distScope: '按作用域',
      distKind: '按类型',
      healthTitle: '存储健康',
      storeOpen: '已连接',
      storeClosed: '未连接',
      evidenceTotal: '证据总数',
      sessionTotal: '会话转写',
      recentTitle: '最近动态',
      noRecent: '暂无活动',
      viewAll: '查看全部',
      // memories
      memoriesTitle: '记忆库',
      memoriesDesc: '搜索、筛选与浏览全部记忆；点击行查看详情。',
      searchPh: '搜索记忆…',
      searchBtn: '搜索',
      allOption: '全部',
      filterScope: '作用域',
      filterKind: '类型',
      filterStatus: '状态',
      noneYet: '暂无记忆',
      noMatch: '没有匹配的记忆',
      prev: '上一页',
      next: '下一页',
      pageInfo: '{from}–{to} / {total}',
      // fields / detail
      back: '返回',
      details: '记忆详情',
      importance: '重要度',
      confidence: '置信度',
      source: '来源',
      scope: '作用域',
      kind: '类型',
      status: '状态',
      createdAt: '创建',
      updatedAt: '更新',
      summary: '摘要',
      tags: '标签',
      fieldContent: '内容',
      edit: '编辑',
      save: '保存',
      cancel: '取消',
      saving: '保存中…',
      delete: '删除',
      deleteHint: '删除该记忆（审计保留）',
      userProtected: '用户保护：AI 不会自动覆盖此记忆。',
      // evidence
      evidenceTitle: '证据',
      evidenceEmpty: '该记忆暂无引证证据。',
      evQuote: '原文引用',
      evObserved: '观测于',
      refSession: '会话',
      refTool: '工具调用',
      refPath: '路径',
      // audit
      auditTitle: '审计',
      auditEmpty: '暂无审计记录。',
      auditAt: '由 {actor} 于 {time}',
      showBefore: '查看变更前',
      showAfter: '查看变更后',
      actionDeletedRecord: '删除的旧内容',
      // confirm
      confirmTitle: '操作确认',
      confirmDeleteHeading: '删除这条记忆？',
      confirmDeleteBody: '将删除 1 条记忆。影响范围：{evidence} 条证据将被一并删除，{audit} 条审计记录会保留用于追溯。此操作不可撤销。',
      confirmOk: '确认删除',
      // timeline
      timelineTitle: '活动时间线',
      timelineDesc: '记忆变更与会话活动的统一事件流（来自审计与会话记录）。',
      timelineEmpty: '暂无活动事件。',
      evtCreate: '创建',
      evtUpdate: '更新',
      evtDelete: '删除',
      evtStatusChange: '状态变更',
      evtMerge: '合并',
      evtUserEdit: '用户编辑',
      evtRestore: '恢复',
      evtSession: '会话活动',
      sessionLine: '会话 {turns} 轮 · {cwd}',
      // settings
      settingsTitle: '设置',
      settingsMemory: 'Memory',
      agent: 'Agent 协作',
      agentHint: '在系统提示中声明本插件，让智能体在相关时参考记忆。',
      settingsStorage: '存储',
      storagePath: '存储位置',
      storageState: '存储状态',
      settingsData: '数据维护',
      exportHint: '下载全部记忆、证据与元数据的 JSON 备份。',
      plannedInSettings: '规划中的页面',
      roadmapLines: '其余页面与设置项会随对应能力开发完成逐步开放。',
      searchDesc: '当前为子串检索（naive）。完整多步检索（理解→门控→召回→重排→精选→上下文）随阶段 3 启用。',
      value: {
        status: { active: '活跃', quarantined: '隔离', superseded: '已取代', archived: '已归档' },
        scope: { global: '全局', project: '项目', session: '会话', generalized: '泛化' },
        kind: {
          profile: '个人档案', fact: '事实', state: '状态', transcript: '对话转写',
          'tool-result': '工具结果', 'user-edit': '用户编辑', file: '文件', observation: '观测',
        },
        source: { user: '用户', agent: '智能体', system: '系统' },
        actor: { user: '用户', agent: '智能体', system: '系统' },
      },
      pg: {
        evidence: '证据', profile: '个人档案', projects: '项目', projectState: '项目状态',
        experiences: '经验', errors: '错误洞察', quarantine: '隔离区', conflicts: '冲突',
        knowledge: '知识', graph: '图谱', backup: '备份', health: '健康', analytics: '统计',
      },
      pageNo: '第 {page} 页',
      rowsThisPage: '本页 {n} 条',
    }

    const en = {
      centerTitle: 'Memory Center',
      centerSubtitle: 'Operation center for your memory system: understand, control, correct and verify.',
      nav: {
        dashboard: 'Dashboard', memories: 'Memories', search: 'Search Explorer',
        timeline: 'Timeline', settings: 'Settings',
      },
      planned: 'Planned pages',
      plannedHint: 'These sections are on the roadmap and appear in the nav once built.',
      plannedTag: 'Planned',
      loading: 'Loading…',
      error: 'Error',
      retry: 'Retry',
      refresh: 'Refresh',
      export: 'Export JSON',
      close: 'Close',
      overviewTitle: 'Memory Overview',
      cardTotal: 'Total memories',
      cardActive: 'Active',
      cardQuarantined: 'Quarantined',
      cardArchived: 'Archived',
      cardLowConf: 'Low confidence',
      cardUserEdited: 'User-protected',
      distributionTitle: 'Distribution',
      distScope: 'By scope',
      distKind: 'By kind',
      healthTitle: 'Storage health',
      storeOpen: 'connected',
      storeClosed: 'not connected',
      evidenceTotal: 'Evidence entries',
      sessionTotal: 'Session transcripts',
      recentTitle: 'Recent activity',
      noRecent: 'No activity yet',
      viewAll: 'View all',
      memoriesTitle: 'Memories',
      memoriesDesc: 'Search, filter and browse every memory; click a row for details.',
      searchPh: 'Search memory…',
      searchBtn: 'Search',
      allOption: 'All',
      filterScope: 'Scope',
      filterKind: 'Kind',
      filterStatus: 'Status',
      noneYet: 'No memories yet',
      noMatch: 'No matching memories',
      prev: 'Previous',
      next: 'Next',
      pageInfo: '{from}–{to} / {total}',
      back: 'Back',
      details: 'Memory details',
      importance: 'Importance',
      confidence: 'Confidence',
      source: 'Source',
      scope: 'Scope',
      kind: 'Kind',
      status: 'Status',
      createdAt: 'Created',
      updatedAt: 'Updated',
      summary: 'Summary',
      tags: 'Tags',
      fieldContent: 'Content',
      edit: 'Edit',
      save: 'Save',
      cancel: 'Cancel',
      saving: 'Saving…',
      delete: 'Delete',
      deleteHint: 'Delete this memory (audit trail is kept)',
      userProtected: 'User-protected: the AI will not overwrite this memory automatically.',
      evidenceTitle: 'Evidence',
      evidenceEmpty: 'No evidence backs this memory yet.',
      evQuote: 'Quote',
      evObserved: 'Observed',
      refSession: 'Session',
      refTool: 'Tool call',
      refPath: 'Path',
      auditTitle: 'Audit',
      auditEmpty: 'No audit entries yet.',
      auditAt: 'by {actor} at {time}',
      showBefore: 'Show previous value',
      showAfter: 'Show new value',
      actionDeletedRecord: 'Deleted old content',
      confirmTitle: 'Confirm action',
      confirmDeleteHeading: 'Delete this memory?',
      confirmDeleteBody: 'Deletes 1 memory. Impact: {evidence} evidence entries are removed with it; {audit} audit entries stay for traceability. This cannot be undone.',
      confirmOk: 'Delete',
      timelineTitle: 'Timeline',
      timelineDesc: 'Unified activity feed of memory changes and session activity.',
      timelineEmpty: 'No events yet.',
      evtCreate: 'Created',
      evtUpdate: 'Updated',
      evtDelete: 'Deleted',
      evtStatusChange: 'Status change',
      evtMerge: 'Merged',
      evtUserEdit: 'User edit',
      evtRestore: 'Restored',
      evtSession: 'Session activity',
      sessionLine: 'session, {turns} turns · {cwd}',
      settingsTitle: 'Settings',
      settingsMemory: 'Memory',
      agent: 'Agent collaboration',
      agentHint: 'Announce this plugin in the system prompt so the agent can consult memory when relevant.',
      settingsStorage: 'Storage',
      storagePath: 'Store path',
      storageState: 'Store state',
      settingsData: 'Data',
      exportHint: 'Download a JSON backup of all memories, evidence and metadata.',
      plannedInSettings: 'Upcoming pages',
      roadmapLines: 'Remaining pages and settings open up as their capabilities are built.',
      searchDesc: 'Naive substring retrieval for now. The full multi-step pipeline (understand→gate→retrieve→rerank→select→context) lands with Phase 3.',
      value: {
        status: { active: 'Active', quarantined: 'Quarantined', superseded: 'Superseded', archived: 'Archived' },
        scope: { global: 'Global', project: 'Project', session: 'Session', generalized: 'Generalized' },
        kind: {
          profile: 'Profile', fact: 'Fact', state: 'State', transcript: 'Transcript',
          'tool-result': 'Tool result', 'user-edit': 'User edit', file: 'File', observation: 'Observation',
        },
        source: { user: 'User', agent: 'Agent', system: 'System' },
        actor: { user: 'User', agent: 'Agent', system: 'System' },
      },
      pg: {
        evidence: 'Evidence', profile: 'Profile', projects: 'Projects', projectState: 'Project State',
        experiences: 'Experiences', errors: 'Error Intelligence', quarantine: 'Quarantine', conflicts: 'Conflicts',
        knowledge: 'Knowledge', graph: 'Graph', backup: 'Backup', health: 'Health', analytics: 'Analytics',
      },
      pageNo: 'Page {page}',
      rowsThisPage: '{n} rows on this page',
    }

    // ------------------------------------------------------------------
    // i18n / plumbing (same as Phase 1 panel)
    // ------------------------------------------------------------------
    let localeService
    function attachLocale(service) {
      localeService = service
    }
    function activeLocale() {
      return localeService?.getSnapshot()?.active ?? (typeof navigator !== 'undefined' ? navigator.language : '') ?? 'en'
    }
    function t(key, params) {
      const dict = activeLocale().toLowerCase().startsWith('zh') ? zh : en
      // Resolve dotted keys through nested dict sections (nav.*, value.*, pg.*).
      let text = key.split('.').reduce((node, part) => (node == null ? node : node[part]), dict) ?? key
      if (params !== void 0) {
        for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
      }
      return text
    }
    /** Localize a stored enum value (scope/status/kind); unknown values pass through verbatim. */
    function valueText(group, value) {
      if (value == null || value === '') return String(value ?? '—')
      const text = t('value.' + group + '.' + value)
      return text.startsWith('value.') ? String(value) : text
    }
    /** Localize a planned-page section name; fall back to its canonical key when untranslated. */
    function plannedLabel(key) {
      const text = t('pg.' + key)
      return text.startsWith('pg.') ? key : text
    }
    function useLocale() {
      return useSyncExternalStore(
        (cb) => (localeService ? localeService.subscribe(cb) : () => {}),
        () => activeLocale(),
        () => 'en',
      )
    }

    async function api(path, options) {
      const response = await fetch(API + path, options)
      const payload = await response.json()
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status)
      }
      return payload.data
    }

    function formatTime(ts) {
      if (!Number.isFinite(ts)) return '—'
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return d.toLocaleDateString() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    /** Keep the render tree short: h('div', {..}, child1, child2) */
    const h = React.createElement

    function useFetch(path) {
      const [state, setState] = useState({ data: null, error: '', loading: true })
      const [tick, setTick] = useState(0)
      useEffect(() => {
        let alive = true
        setState({ data: null, error: '', loading: true })
        api(path)
          .then((data) => { if (alive) setState({ data, error: '', loading: false }) })
          .catch((err) => { if (alive) setState({ data: null, error: String(err?.message ?? err), loading: false }) })
        return () => { alive = false }
      }, [path, tick])
      return { ...state, reload: useCallback(() => setTick((n) => n + 1), []) }
    }

    // Small presentational primitives -------------------------------------
    function badge(text, tone) {
      return h('span', { className: 'dsh-mc-badge dsh-mc-tone-' + (tone ?? 'dim') }, text)
    }

    function statusTone(status) {
      if (status === 'active') return 'ok'
      if (status === 'quarantined') return 'warn'
      if (status === 'archived' || status === 'superseded') return 'dim'
      return 'dim'
    }
    function scopeTone(scope) {
      if (scope === 'global') return 'info'
      if (scope === 'project') return 'info'
      return 'dim'
    }

    function RowBadges({ row }) {
      const scope = valueText('scope', row.scope)
      const kind = valueText('kind', row.kind)
      const status = valueText('status', row.status)
      const items = [
        h('span', { title: String(row.scope ?? ''), className: 'dsh-mc-badge dsh-mc-tone-' + scopeTone(row.scope) }, scope),
        h('span', { title: String(row.kind ?? ''), className: 'dsh-mc-badge dsh-mc-tone-dim' }, kind),
        h('span', { title: String(row.status ?? ''), className: 'dsh-mc-badge dsh-mc-tone-' + statusTone(row.status) }, status),
      ]
      if (row.userEdited) items.push(badge(t('cardUserEdited'), 'accent'))
      return h('span', { className: 'dsh-mc-badges' }, ...items)
    }

    function ErrBox({ message, onRetry }) {
      return h('div', { className: 'dsh-mc-block dsh-mc-err' },
        h('span', null, t('error') + ': ' + message),
        onRetry ? h('button', { type: 'button', className: 'dsh-mc-btn', onClick: onRetry }, t('retry')) : null,
      )
    }

    function EmptyBox({ text }) {
      return h('div', { className: 'dsh-mc-empty' }, text)
    }

    function Card({ title, action, children }) {
      return h('section', { className: 'dsh-mc-card' },
        h('header', { className: 'dsh-mc-card-head' },
          h('h4', null, title),
          action ? h('div', null, action) : null,
        ),
        children,
      )
    }

    // ------------------------------------------------------------------
    // action/tone maps shared by Dashboard recent activity and Timeline
    // ------------------------------------------------------------------
    const ACTION_KEYS = {
      create: 'evtCreate',
      update: 'evtUpdate',
      delete: 'evtDelete',
      'status-change': 'evtStatusChange',
      merge: 'evtMerge',
      'user-edit': 'evtUserEdit',
      restore: 'evtRestore',
    }
    const ACTION_TONES = {
      create: 'ok',
      update: 'warn',
      delete: 'danger',
      'status-change': 'warn',
      merge: 'info',
      'user-edit': 'accent',
      restore: 'ok',
    }

    /** One timeline event row (memory change or session activity). */
    function EventRow({ event, onOpen }) {
      const time = h('time', { className: 'dsh-mc-event-time' }, formatTime(event.at))
      if (event.type === 'session') {
        return h('div', { className: 'dsh-mc-event' },
          badge(t('evtSession'), 'info'),
          h('span', { className: 'dsh-mc-event-text' },
            t('sessionLine', { turns: event.turnCount, cwd: event.cwd || '—' })),
          h('span', { className: 'dsh-mc-event-state' }, event.status ?? ''),
          time,
        )
      }
      const label = t(ACTION_KEYS[event.action] ?? event.action)
      const tone = ACTION_TONES[event.action] ?? 'dim'
      const clickable = Boolean(onOpen && event.memoryId)
      const text = event.content || event.memoryId || '—'
      return h('div', { className: 'dsh-mc-event' },
        badge(label, tone),
        clickable
          ? h('button', {
              type: 'button',
              className: 'dsh-mc-event-text dsh-mc-event-link',
              onClick: () => onOpen(event.memoryId),
              title: text,
            }, text)
          : h('span', { className: 'dsh-mc-event-text' }, text),
        h('span', { className: 'dsh-mc-event-actor' }, event.actor ? valueText('actor', event.actor) : ''),
        time,
      )
    }

    /** A single memory in list views. */
    function MemoryListItem({ row, onOpen }) {
      const meta =
        formatTime(row.updatedAt) +
        ' · ' + (row.source ? valueText('source', row.source) : '') +
        ' · ' + t('importance') + ' ' + row.importance.toFixed(2) +
        ' · ' + t('confidence') + ' ' + row.confidence.toFixed(2)
      return h('div', { className: 'dsh-mc-item' },
        h('button', {
          type: 'button',
          className: 'dsh-mc-item-body',
          onClick: () => onOpen(row.id),
          title: t('details'),
        },
          h('div', { className: 'dsh-mc-item-content' }, row.content),
          row.summary ? h('div', { className: 'dsh-mc-item-summary' }, row.summary) : null,
        ),
        h('div', { className: 'dsh-mc-item-foot' },
          h(RowBadges, { row }),
          h('span', { className: 'dsh-mc-item-meta' }, meta),
        ),
      )
    }

    /** Build the memories-list route with applied filters + offset. */
    function listPath(filters, offset) {
      const p = new URLSearchParams()
      p.set('limit', String(PAGE_SIZE))
      p.set('offset', String(offset))
      if (filters.q) p.set('q', filters.q)
      if (filters.scope) p.set('scope', filters.scope)
      if (filters.kind) p.set('kind', filters.kind)
      if (filters.status) p.set('status', filters.status)
      // trailing slash matches the registered prefix route /dsh-memory-personal/api/memories/
      return '/memories/?' + p.toString()
    }

    // ------------------------------------------------------------------
    // Dashboard page
    // ------------------------------------------------------------------
    function DistBars({ title, rows, group }) {
      const max = Math.max(1, ...rows.map((r) => r.count))
      return h(Card, { title },
        rows.length === 0
          ? h('div', { className: 'dsh-mc-dist-empty' }, '—')
          : h('div', { className: 'dsh-mc-dist' },
              rows.map((r) => h('div', { key: r.key, className: 'dsh-mc-dist-row' },
                h('span', { className: 'dsh-mc-dist-name' }, group ? valueText(group, r.key) : r.key),
                h('span', { className: 'dsh-mc-dist-track' },
                  h('span', { className: 'dsh-mc-dist-fill', style: { width: Math.max(2, (r.count / max) * 100) + '%' } }),
                ),
                h('span', { className: 'dsh-mc-dist-count' }, String(r.count)),
              )),
            ),
      )
    }

    function DashboardPage({ openMemory, go }) {
      useLocale()
      const overview = useFetch('/overview')
      const recent = useFetch('/timeline?limit=8')
      if (overview.loading) return h('div', { className: 'dsh-mc-page-hint' }, t('loading'))
      if (overview.error) return ErrBox({ message: overview.error, onRetry: overview.reload })
      const data = overview.data
      const c = data.counts
      const cards = [
        [t('cardTotal'), c.total, 'ok'],
        [t('cardActive'), c.active, 'ok'],
        [t('cardQuarantined'), c.quarantined, 'warn'],
        [t('cardArchived'), c.archived, 'dim'],
        [t('cardLowConf'), c.lowConfidence, 'warn'],
        [t('cardUserEdited'), c.userEdited, 'accent'],
      ]
      const scopeRows = data.byScope ?? []
      const kindRows = data.byKind ?? []
      const open = data.storeOpen === true
      return h('div', { className: 'dsh-mc-page' },
        h('h3', { className: 'dsh-mc-page-title' }, t('overviewTitle')),
        h('div', { className: 'dsh-mc-cards' },
          cards.map(([label, value, tone]) => h('div', { key: label, className: 'dsh-mc-card-item' },
            h('span', { className: 'dsh-mc-card-value ' + 'dsh-mc-tone-' + tone }, String(value)),
            h('span', { className: 'dsh-mc-card-label' }, label),
          )),
        ),
        h('div', { className: 'dsh-mc-dash-grid' },
          h('div', null,
            h(DistBars, { title: t('distributionTitle') + ' · ' + t('distScope'), rows: scopeRows, group: 'scope' }),
            h(DistBars, { title: t('distributionTitle') + ' · ' + t('distKind'), rows: kindRows, group: 'kind' }),
          ),
          h('div', null,
            h(Card, { title: t('healthTitle') },
              h('div', { className: 'dsh-mc-health' },
                h('span', { className: 'dsh-mc-dot ' + (open ? 'dsh-mc-dot-ok' : 'dsh-mc-dot-off') }),
                h('span', { className: 'dsh-mc-health-label' }, open ? t('storeOpen') : t('storeClosed')),
              ),
              h('div', { className: 'dsh-mc-health-grid' },
                h('div', null, h('span', { className: 'dsh-mc-health-num' }, String(data.evidenceCount ?? 0)), h('span', null, t('evidenceTotal'))),
                h('div', null, h('span', { className: 'dsh-mc-health-num' }, String(data.sessionCount ?? 0)), h('span', null, t('sessionTotal'))),
              ),
              h('div', { className: 'dsh-mc-path' },
                h('span', { className: 'dsh-mc-path-key' }, t('storagePath')), h('span', { className: 'dsh-mc-path-val' }, data.storePath || '—'),
              ),
            ),
            h(Card, {
              title: t('recentTitle'),
              action: h('button', { type: 'button', className: 'dsh-mc-link', onClick: () => go('timeline') }, t('viewAll')),
            },
              recent.loading
                ? h('div', { className: 'dsh-mc-page-hint' }, t('loading'))
                : recent.error
                  ? ErrBox({ message: recent.error, onRetry: recent.reload })
                  : (recent.data?.events?.length ?? 0) === 0
                    ? EmptyBox({ text: t('noRecent') })
                    : h('div', { className: 'dsh-mc-events' },
                        recent.data.events.map((event, i) => h(EventRow, { key: i, event, onOpen: openMemory })),
                      ),
            ),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // Memories (browse/search) page
    // ------------------------------------------------------------------
    function MemoriesPage({ openMemory }) {
      useLocale()
      const [draft, setDraft] = useState({ q: '', scope: '', kind: '', status: '' })
      const [offset, setOffset] = useState(0)
      const path = listPath(draft, offset)
      const { data, error, loading, reload } = useFetch(path)
      const rows = data?.rows ?? []
      const runSearch = () => { setOffset(0); reload() }
      const changeFilter = (patch) => { setDraft((d) => ({ ...d, ...patch })); setOffset(0) }
      const page = Math.floor(offset / PAGE_SIZE) + 1
      const hasPrev = offset > 0
      const hasNext = rows.length === PAGE_SIZE
      return h('div', { className: 'dsh-mc-page' },
        h('div', { className: 'dsh-mc-page-head' },
          h('div', null,
            h('h3', { className: 'dsh-mc-page-title' }, t('memoriesTitle')),
            h('p', { className: 'dsh-mc-page-desc' }, t('memoriesDesc')),
          ),
          h('div', { className: 'dsh-mc-head-actions' },
            h('button', { type: 'button', className: 'dsh-mc-btn', onClick: reload }, t('refresh')),
          ),
        ),
        h('div', { className: 'dsh-mc-toolbar' },
          h('input', {
            type: 'search', className: 'dsh-mc-input dsh-mc-input-grow',
            placeholder: t('searchPh'), value: draft.q,
            onChange: (e) => setDraft({ ...draft, q: e.target.value }),
            onKeyDown: (e) => { if (e.key === 'Enter') runSearch() },
          }),
          h('button', { type: 'button', className: 'dsh-mc-btn dsh-mc-btn-primary', onClick: runSearch }, t('searchBtn')),
          h('select', { className: 'dsh-mc-input', value: draft.scope, onChange: (e) => changeFilter({ scope: e.target.value }) },
            h('option', { value: '' }, t('allOption') + ' · ' + t('filterScope')),
            ['global', 'project', 'session', 'generalized'].map((s) => h('option', { key: s, value: s }, valueText('scope', s))),
          ),
          h('select', { className: 'dsh-mc-input', value: draft.status, onChange: (e) => changeFilter({ status: e.target.value }) },
            h('option', { value: '' }, t('allOption') + ' · ' + t('filterStatus')),
            ['active', 'quarantined'].map((s) => h('option', { key: s, value: s }, valueText('status', s))),
          ),
          h('input', {
            type: 'text', className: 'dsh-mc-input dsh-mc-input-kind',
            placeholder: t('filterKind'), value: draft.kind,
            onChange: (e) => changeFilter({ kind: e.target.value }),
          }),
        ),
        loading
          ? h('div', { className: 'dsh-mc-page-hint' }, t('loading'))
          : error
            ? ErrBox({ message: error, onRetry: reload })
            : rows.length === 0
              ? EmptyBox({ text: draft.q || draft.scope || draft.kind || draft.status ? t('noMatch') : t('noneYet') })
              : h('div', { className: 'dsh-mc-list' },
                  rows.map((row) => h(MemoryListItem, { key: row.id, row, onOpen: openMemory })),
                ),
        !loading && !error && rows.length > 0
          ? h('div', { className: 'dsh-mc-pager' },
              h('button', { type: 'button', className: 'dsh-mc-btn', disabled: !hasPrev, onClick: () => setOffset(Math.max(0, offset - PAGE_SIZE)) }, t('prev')),
              h('span', { className: 'dsh-mc-pager-info' },
                t('pageNo', { page }) + ' · ' + t('rowsThisPage', { n: rows.length }),
              ),
              h('button', { type: 'button', className: 'dsh-mc-btn', disabled: !hasNext, onClick: () => setOffset(offset + PAGE_SIZE) }, t('next')),
            )
          : null,
      )
    }

    // ------------------------------------------------------------------
    // Search Explorer page (first level; pipeline lands with Phase 3)
    // ------------------------------------------------------------------
    function SearchPage({ openMemory }) {
      useLocale()
      const [query, setQuery] = useState('')
      const [ran, setRan] = useState(null) // snapshot of last submitted query
      const path = ran ? '/search?q=' + encodeURIComponent(ran) + '&limit=50' : '/health'
      const result = useFetch(path)
      const rows = result.data?.rows ?? []
      const run = () => { if (query.trim().length > 0) setRan(query.trim()) }
      return h('div', { className: 'dsh-mc-page' },
        h('div', { className: 'dsh-mc-page-head' },
          h('div', null,
            h('h3', { className: 'dsh-mc-page-title' }, t('nav.search')),
            h('p', { className: 'dsh-mc-page-desc' }, t('searchDesc')),
          ),
        ),
        h('div', { className: 'dsh-mc-toolbar' },
          h('input', {
            type: 'search', className: 'dsh-mc-input dsh-mc-input-grow',
            placeholder: t('searchPh'), value: query, autoFocus: true,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') run() },
          }),
          h('button', { type: 'button', className: 'dsh-mc-btn dsh-mc-btn-primary', onClick: run, disabled: query.trim().length === 0 }, t('searchBtn')),
        ),
        ran === null
          ? EmptyBox({ text: t('searchPh') })
          : result.loading
            ? h('div', { className: 'dsh-mc-page-hint' }, t('loading'))
            : result.error
              ? ErrBox({ message: result.error, onRetry: result.reload })
              : rows.length === 0
                ? EmptyBox({ text: t('noMatch') })
                : h('div', { className: 'dsh-mc-list' },
                    h('div', { className: 'dsh-mc-page-desc dsh-mc-query-note' }, '“' + ran + '” · ' + rows.length + ' hits'),
                    rows.map((row) => h(MemoryListItem, { key: row.id, row, onOpen: openMemory })),
                  ),
      )
    }

    // ------------------------------------------------------------------
    // Timeline page
    // ------------------------------------------------------------------
    function TimelinePage({ openMemory }) {
      useLocale()
      const feed = useFetch('/timeline?limit=200')
      if (feed.loading) return h('div', { className: 'dsh-mc-page-hint' }, t('loading'))
      if (feed.error) return ErrBox({ message: feed.error, onRetry: feed.reload })
      const events = feed.data?.events ?? []
      return h('div', { className: 'dsh-mc-page' },
        h('div', { className: 'dsh-mc-page-head' },
          h('div', null,
            h('h3', { className: 'dsh-mc-page-title' }, t('timelineTitle')),
            h('p', { className: 'dsh-mc-page-desc' }, t('timelineDesc')),
          ),
          h('div', { className: 'dsh-mc-head-actions' },
            h('button', { type: 'button', className: 'dsh-mc-btn', onClick: feed.reload }, t('refresh')),
          ),
        ),
        events.length === 0
          ? EmptyBox({ text: t('timelineEmpty') })
          : h('div', { className: 'dsh-mc-events dsh-mc-events-page' },
              events.map((event, i) => h(EventRow, { key: i, event, onOpen: openMemory })),
            ),
      )
    }

    // ------------------------------------------------------------------
    // Detail page: record fields / evidence / audit / edit / delete
    // ------------------------------------------------------------------
    const STATUS_OPTIONS = ['active', 'quarantined', 'superseded', 'archived']
    const SCOPE_OPTIONS = ['global', 'project', 'session', 'generalized']

    function MetaValue({ label, value }) {
      return h('div', { className: 'dsh-mc-meta-row' },
        h('span', { className: 'dsh-mc-meta-key' }, t(label)),
        h('span', { className: 'dsh-mc-meta-val' }, value ?? '—'),
      )
    }

    function EvidenceBlock({ rows }) {
      if (rows.length === 0) return EmptyBox({ text: t('evidenceEmpty') })
      return h('div', { className: 'dsh-mc-list' },
        rows.map((ev) => {
          const ref = ev.ref || {}
          const refLine = [
            ref.sessionId ? t('refSession') + ' ' + String(ref.sessionId) : '',
            ref.toolCallId ? t('refTool') + ' ' + String(ref.toolCallId) : '',
            ref.path ? t('refPath') + ' ' + String(ref.path) : '',
          ].filter(Boolean).join(' · ')
          return h('div', { key: ev.id, className: 'dsh-mc-evid' },
            h('div', { className: 'dsh-mc-item-content' }, ev.quote ?? ev.content ?? ''),
            h('div', { className: 'dsh-mc-item-foot' },
              h('span', { className: 'dsh-mc-badges' },
                badge(valueText('kind', ev.kind ?? 'evidence'), 'info'),
                ev.observedAt ? badge(t('evObserved') + ' ' + formatTime(ev.observedAt), 'dim') : null,
              ),
              refLine ? h('span', { className: 'dsh-mc-item-meta dsh-mc-truncate' }, refLine) : null,
            ),
          )
        }),
      )
    }

    function AuditBlock({ rows }) {
      if (rows.length === 0) return EmptyBox({ text: t('auditEmpty') })
      return h('div', { className: 'dsh-mc-list' },
        rows.map((a) => {
          const before = a.before && Object.keys(a.before).length ? a.before : null
          const after = a.after && Object.keys(a.after).length ? a.after : null
          return h('div', { key: a.id, className: 'dsh-mc-audit' },
            h('div', { className: 'dsh-mc-event' },
              badge(t(ACTION_KEYS[a.action] ?? a.action), ACTION_TONES[a.action] ?? 'dim'),
              h('span', { className: 'dsh-mc-audit-at' }, t('auditAt', { actor: valueText('actor', a.actor ?? '—'), time: formatTime(a.at) })),
            ),
            before || after
              ? h('details', { className: 'dsh-mc-debug' },
                  h('summary', null, [before ? t('showBefore') : null, after ? t('showAfter') : null].filter(Boolean).join(' · ')),
                  h('div', { className: 'dsh-mc-debug-body' },
                    before ? h('pre', null, JSON.stringify(before, null, 2)) : null,
                    after ? h('pre', null, JSON.stringify(after, null, 2)) : null,
                  ),
                )
              : null,
          )
        }),
      )
    }

    function DetailPage({ id, onBack }) {
      useLocale()
      const fetch = useFetch('/memories/' + encodeURIComponent(id))
      const [editing, setEditing] = useState(false)
      const [form, setForm] = useState(null)
      const [saving, setSaving] = useState(false)
      const [actionError, setActionError] = useState('')
      const [confirmDelete, setConfirmDelete] = useState(false)
      const [busy, setBusy] = useState(false)

      if (fetch.loading) return h('div', { className: 'dsh-mc-page-hint' }, t('loading'))
      if (fetch.error) return ErrBox({ message: fetch.error, onRetry: fetch.reload })

      const { record, evidence, audit } = fetch.data
      const evidenceRows = evidence ?? []
      const auditRows = audit ?? []

      const beginEdit = () => {
        setForm({
          content: record.content,
          kind: record.kind,
          scope: record.scope,
          status: record.status,
          importance: String(record.importance),
          confidence: String(record.confidence),
          summary: record.summary ?? '',
          tags: (record.tags ?? []).join(', '),
        })
        setEditing(true)
        setActionError('')
      }
      const setField = (patch) => setForm((f) => ({ ...f, ...patch }))

      const save = async () => {
        if (!form || saving || form.content.trim().length === 0) return
        setSaving(true)
        setActionError('')
        try {
          const tags = form.tags.split(',').map((s) => s.trim()).filter(Boolean)
          await api('/memories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: record.id, content: form.content, kind: form.kind, scope: form.scope, status: form.status,
              importance: Number(form.importance), confidence: Number(form.confidence),
              summary: form.summary.trim(), tags,
            }),
          })
          setEditing(false)
          fetch.reload()
        } catch (error) {
          setActionError(String(error?.message ?? error))
        } finally {
          setSaving(false)
        }
      }

      const performDelete = async () => {
        if (busy) return
        setBusy(true)
        setActionError('')
        try {
          await api('/memories/' + encodeURIComponent(record.id), { method: 'DELETE' })
          onBack()
        } catch (error) {
          setActionError(String(error?.message ?? error))
          setBusy(false)
        }
      }

      return h('div', { className: 'dsh-mc-page' },
        h('button', { type: 'button', className: 'dsh-mc-link dsh-mc-back', onClick: onBack }, '← ' + t('back')),
        h('div', { className: 'dsh-mc-page-head' },
          h('div', null,
            h('h3', { className: 'dsh-mc-page-title' }, t('details')),
            h('div', { className: 'dsh-mc-detail-badges' }, h(RowBadges, { row: record })),
          ),
          h('div', { className: 'dsh-mc-head-actions' },
            h('button', { type: 'button', className: 'dsh-mc-btn', onClick: beginEdit, disabled: editing }, t('edit')),
            h('button', { type: 'button', className: 'dsh-mc-btn dsh-mc-btn-danger', onClick: () => setConfirmDelete(true), disabled: busy }, t('delete')),
          ),
        ),
        record.userEdited ? h('div', { className: 'dsh-mc-note' }, t('userProtected')) : null,
        editing
          ? h('div', { className: 'dsh-mc-card dsh-mc-form' },
              h('label', { className: 'dsh-mc-form-row' },
                h('span', { className: 'dsh-mc-form-label' }, t('fieldContent')),
                h('textarea', { className: 'dsh-mc-input', rows: 3, value: form.content, onChange: (e) => setField({ content: e.target.value }) }),
              ),
              h('div', { className: 'dsh-mc-form-grid' },
                h('label', { className: 'dsh-mc-form-row' },
                  h('span', { className: 'dsh-mc-form-label' }, t('kind')),
                  h('input', { className: 'dsh-mc-input', value: form.kind, onChange: (e) => setField({ kind: e.target.value }) }),
                ),
                h('label', { className: 'dsh-mc-form-row' },
                  h('span', { className: 'dsh-mc-form-label' }, t('scope')),
                  h('select', { className: 'dsh-mc-input', value: form.scope, onChange: (e) => setField({ scope: e.target.value }) },
                    SCOPE_OPTIONS.map((s) => h('option', { key: s, value: s }, valueText('scope', s)))),
                ),
                h('label', { className: 'dsh-mc-form-row' },
                  h('span', { className: 'dsh-mc-form-label' }, t('status')),
                  h('select', { className: 'dsh-mc-input', value: form.status, onChange: (e) => setField({ status: e.target.value }) },
                    STATUS_OPTIONS.map((s) => h('option', { key: s, value: s }, valueText('status', s)))),
                ),
                h('label', { className: 'dsh-mc-form-row' },
                  h('span', { className: 'dsh-mc-form-label' }, t('importance') + ' (0–1)'),
                  h('input', { type: 'number', min: 0, max: 1, step: 0.05, className: 'dsh-mc-input', value: form.importance, onChange: (e) => setField({ importance: e.target.value }) }),
                ),
                h('label', { className: 'dsh-mc-form-row' },
                  h('span', { className: 'dsh-mc-form-label' }, t('confidence') + ' (0–1)'),
                  h('input', { type: 'number', min: 0, max: 1, step: 0.05, className: 'dsh-mc-input', value: form.confidence, onChange: (e) => setField({ confidence: e.target.value }) }),
                ),
                h('label', { className: 'dsh-mc-form-row' },
                  h('span', { className: 'dsh-mc-form-label' }, t('tags')),
                  h('input', { className: 'dsh-mc-input', value: form.tags, placeholder: 'a, b, c', onChange: (e) => setField({ tags: e.target.value }) }),
                ),
              ),
              h('label', { className: 'dsh-mc-form-row' },
                h('span', { className: 'dsh-mc-form-label' }, t('summary')),
                h('textarea', { className: 'dsh-mc-input', rows: 2, value: form.summary, onChange: (e) => setField({ summary: e.target.value }) }),
              ),
              actionError ? h('div', { className: 'dsh-mc-inline-err' }, actionError) : null,
              h('div', { className: 'dsh-mc-actions' },
                h('button', { type: 'button', className: 'dsh-mc-btn dsh-mc-btn-primary', onClick: save, disabled: saving }, saving ? t('saving') : t('save')),
                h('button', { type: 'button', className: 'dsh-mc-btn', onClick: () => setEditing(false), disabled: saving }, t('cancel')),
              ),
            )
          : h('div', { className: 'dsh-mc-card' },
              h('div', { className: 'dsh-mc-item-content dsh-mc-detail-content' }, record.content),
              h('div', { className: 'dsh-mc-meta-grid' },
                h(MetaValue, { label: 'importance', value: record.importance.toFixed(2) }),
                h(MetaValue, { label: 'confidence', value: record.confidence.toFixed(2) }),
                h(MetaValue, { label: 'source', value: valueText('source', record.source) }),
                h(MetaValue, { label: 'scope', value: valueText('scope', record.scope) }),
                h(MetaValue, { label: 'kind', value: valueText('kind', record.kind) }),
                h(MetaValue, { label: 'status', value: valueText('status', record.status) }),
                h(MetaValue, { label: 'createdAt', value: formatTime(record.createdAt) }),
                h(MetaValue, { label: 'updatedAt', value: formatTime(record.updatedAt) }),
                h(MetaValue, { label: 'summary', value: record.summary }),
                h(MetaValue, { label: 'tags', value: (record.tags ?? []).join(', ') }),
              ),
            ),
        h(Card, { title: t('evidenceTitle') }, h(EvidenceBlock, { rows: evidenceRows })),
        h(Card, { title: t('auditTitle') }, h(AuditBlock, { rows: auditRows })),
        confirmDelete
          ? h('div', { className: 'dsh-mc-overlay' },
              h('div', { role: 'dialog', 'aria-modal': 'true', className: 'dsh-mc-modal' },
                h('h4', { className: 'dsh-mc-modal-title' }, t('confirmDeleteHeading')),
                h('p', { className: 'dsh-mc-modal-text' }, t('confirmDeleteBody', { evidence: evidenceRows.length, audit: auditRows.length })),
                actionError ? h('div', { className: 'dsh-mc-inline-err' }, actionError) : null,
                h('div', { className: 'dsh-mc-actions' },
                  h('button', { type: 'button', className: 'dsh-mc-btn dsh-mc-btn-danger', onClick: performDelete, disabled: busy }, busy ? t('loading') : t('confirmOk')),
                  h('button', { type: 'button', className: 'dsh-mc-btn', onClick: () => { setConfirmDelete(false); setActionError('') }, disabled: busy }, t('cancel')),
                ),
              ),
            )
          : null,
      )
    }

    // ------------------------------------------------------------------
    // Settings page
    // ------------------------------------------------------------------
    function exportJson() {
      fetch(API + '/export')
        .then((response) => response.json())
        .then((payload) => {
          if (!payload || payload.ok !== true) throw new Error(payload?.error || 'export failed')
          const blob = new Blob([JSON.stringify(payload.data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = 'dsh-memory-personal-export-' + new Date().toISOString().slice(0, 10) + '.json'
          document.body.appendChild(link)
          link.click()
          link.remove()
          URL.revokeObjectURL(url)
        })
        .catch(() => {})
    }

    function SettingsPage() {
      useLocale()
      const health = useFetch('/health')
      const [agentOn, setAgentOn] = useState(null)
      const [agentBusy, setAgentBusy] = useState(false)
      useEffect(() => {
        let alive = true
        api('/config')
          .then((d) => { if (alive) setAgentOn(Boolean(d.announceToAgent)) })
          .catch(() => { if (alive) setAgentOn(false) })
        return () => { alive = false }
      }, [])
      const toggleAgent = async (next) => {
        setAgentBusy(true)
        const prev = agentOn
        setAgentOn(next)
        try {
          const data = await api('/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ announceToAgent: next }),
          })
          setAgentOn(Boolean(data.announceToAgent))
        } catch (error) {
          setAgentOn(prev)
        } finally {
          setAgentBusy(false)
        }
      }
      const store = health.data
      const open = store?.storeOpen === true
      return h('div', { className: 'dsh-mc-page' },
        h('div', { className: 'dsh-mc-page-head' },
          h('div', null, h('h3', { className: 'dsh-mc-page-title' }, t('settingsTitle'))),
        ),
        h('div', { className: 'dsh-mc-settings-grid' },
          h(Card, { title: t('settingsMemory') },
            h('div', { className: 'dsh-mc-settings-row' },
              h('div', null,
                h('div', { className: 'dsh-mc-settings-label' }, t('agent')),
                h('div', { className: 'dsh-mc-settings-hint' }, t('agentHint')),
              ),
              h('input', { type: 'checkbox', checked: agentOn === true, disabled: agentBusy || agentOn === null, onChange: (e) => toggleAgent(e.target.checked) }),
            ),
          ),
          h(Card, { title: t('settingsStorage') },
            h('div', { className: 'dsh-mc-health' },
              h('span', { className: 'dsh-mc-dot ' + (open ? 'dsh-mc-dot-ok' : 'dsh-mc-dot-off') }),
              h('span', { className: 'dsh-mc-health-label' }, open ? t('storeOpen') : t('storeClosed')),
            ),
            h('div', { className: 'dsh-mc-path' },
              h('span', { className: 'dsh-mc-path-key' }, t('storagePath')),
              h('span', { className: 'dsh-mc-path-val' }, store?.storePath ?? '—'),
            ),
          ),
          h(Card, { title: t('settingsData') },
            h('div', { className: 'dsh-mc-settings-row' },
              h('div', null,
                h('div', { className: 'dsh-mc-settings-label' }, t('export')),
                h('div', { className: 'dsh-mc-settings-hint' }, t('exportHint')),
              ),
              h('button', { type: 'button', className: 'dsh-mc-btn', onClick: exportJson }, t('export')),
            ),
            h('div', { className: 'dsh-mc-settings-row' },
              h('div', null,
                h('div', { className: 'dsh-mc-settings-label' }, t('plannedInSettings')),
                h('div', { className: 'dsh-mc-settings-hint' }, t('roadmapLines')),
              ),
              h('div', { className: 'dsh-mc-planned-chips' },
                PLANNED_PAGES.map((p) => h('span', { key: p.key, className: 'dsh-mc-badge dsh-mc-tone-dim' }, plannedLabel(p.key))),
              ),
            ),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // Memory Center root: brand + nav + page
    // ------------------------------------------------------------------
    const NAV_KEYS = ['dashboard', 'memories', 'search', 'timeline', 'settings']

    function MemoryCenter() {
      useLocale()
      const [route, setRoute] = useState({ page: 'dashboard' })
      const go = useCallback((page) => setRoute({ page }), [])
      const openMemory = useCallback((id) => setRoute({ page: 'detail', id }), [])
      const current = route.page

      let content
      if (current === 'detail') {
        content = h(DetailPage, { id: route.id, onBack: () => go('memories') })
      } else if (current === 'memories') {
        content = h(MemoriesPage, { openMemory })
      } else if (current === 'search') {
        content = h(SearchPage, { openMemory })
      } else if (current === 'timeline') {
        content = h(TimelinePage, { openMemory })
      } else if (current === 'settings') {
        content = h(SettingsPage, {})
      } else {
        content = h(DashboardPage, { openMemory, go })
      }

      return h('div', { className: 'dsh-mc-center' },
        h('aside', { className: 'dsh-mc-aside' },
          h('div', { className: 'dsh-mc-brand' }, t('centerTitle')),
          h('div', { className: 'dsh-mc-brand-sub' }, t('centerSubtitle')),
          h('nav', { className: 'dsh-mc-nav', 'aria-label': t('centerTitle') },
            NAV_KEYS.map((key) => h('button', {
              type: 'button', key,
              className: 'dsh-mc-nav-btn' + (current === key ? ' dsh-mc-nav-btn-active' : ''),
              onClick: () => go(key),
            }, t('nav.' + key))),
          ),
          h('div', { className: 'dsh-mc-nav-group' },
            h('div', { className: 'dsh-mc-nav-label' }, t('planned')),
            h('p', { className: 'dsh-mc-nav-hint' }, t('plannedHint')),
            h('ul', { className: 'dsh-mc-nav-planned' },
              PLANNED_PAGES.map((p) => h('li', { key: p.key, className: 'dsh-mc-nav-planned-item' },
                h('span', { className: 'dsh-mc-nav-planned-name' }, plannedLabel(p.key)),
                h('span', { className: 'dsh-mc-badge dsh-mc-tone-dim' }, t('plannedTag')),
              )),
            ),
          ),
        ),
        h('main', { className: 'dsh-mc-main' }, content),
      )
    }

    const inject = ['slots', 'locale']

    // ------------------------------------------------------------------
    // styles (theme-aware; injected once)
    // ------------------------------------------------------------------
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-memory-personal-ui-style')) return
      const style = document.createElement('style')
      style.id = 'dsh-memory-personal-ui-style'
      style.textContent = `
.dsh-mc-center{display:flex;gap:18px;align-items:flex-start;width:100%;color:var(--dsw-alias-label-primary,inherit)}
.dsh-mc-aside{flex:none;width:196px;display:flex;flex-direction:column;gap:6px;position:sticky;top:0}
.dsh-mc-brand{font:600 15px/22px var(--dsw-font-family,system-ui,sans-serif)}
.dsh-mc-brand-sub{font:11px/16px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888);margin-bottom:6px}
.dsh-mc-nav{display:flex;flex-direction:column;gap:2px}
.dsh-mc-nav-btn{border:none;background:none;text-align:left;padding:6px 10px;border-radius:8px;cursor:pointer;font:13px/20px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-secondary,#666)}
.dsh-mc-nav-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.dsh-mc-nav-btn-active{color:var(--dsw-alias-button-primary-label,#fff);background:var(--dsw-alias-button-primary-fill,#4176e6)}
.dsh-mc-nav-group{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
.dsh-mc-nav-label{font:600 11px/16px var(--dsw-font-family,system-ui,sans-serif);text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-nav-hint{margin:2px 0 4px;font:10px/14px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#999)}
.dsh-mc-nav-planned{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dsh-mc-nav-planned-item{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 4px;opacity:.72}
.dsh-mc-nav-planned-name{font:12px/18px var(--dsw-font-family,system-ui,sans-serif)}
.dsh-mc-main{flex:1;min-width:0;display:flex;flex-direction:column}
@media(max-width:760px){.dsh-mc-center{flex-direction:column}.dsh-mc-aside{position:static;width:100%}.dsh-mc-nav{flex-direction:row;flex-wrap:wrap}}
.dsh-mc-page{display:flex;flex-direction:column;gap:10px;width:100%;min-width:0}
.dsh-mc-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.dsh-mc-page-title{margin:0;font:600 16px/24px var(--dsw-font-family,system-ui,sans-serif)}
.dsh-mc-page-desc{margin:2px 0 0;font:12px/18px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-head-actions{display:flex;gap:8px;align-items:center}
.dsh-mc-page-hint{padding:24px 8px;font:12px/18px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-err{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;border:1px solid var(--dsw-alias-state-error-border,rgba(229,72,77,.4));border-radius:10px;font:12px/18px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-mc-empty{padding:22px 8px;text-align:center;font:12px/18px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.dsh-mc-card-item{display:flex;flex-direction:column;gap:2px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:12px;background:var(--dsw-alias-bg-layer-3,transparent)}
.dsh-mc-card-value{font:600 22px/30px var(--dsw-font-family,system-ui,sans-serif);font-variant-numeric:tabular-nums}
.dsh-mc-card-label{font:11px/16px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-dash-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:10px;align-items:start}
@media(max-width:980px){.dsh-mc-dash-grid{grid-template-columns:1fr}}
.dsh-mc-card{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:12px;background:var(--dsw-alias-bg-layer-3,transparent);min-width:0}
.dsh-mc-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-mc-card-head h4{margin:0;font:600 13px/20px var(--dsw-font-family,system-ui,sans-serif)}
.dsh-mc-dist{display:flex;flex-direction:column;gap:6px}
.dsh-mc-dist-row{display:flex;align-items:center;gap:8px}
.dsh-mc-dist-name{flex:none;width:84px;overflow:hidden;text-overflow:ellipsis;font:11px/16px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-secondary,#666)}
.dsh-mc-dist-track{flex:1;height:8px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));overflow:hidden}
.dsh-mc-dist-fill{display:block;height:100%;border-radius:99px;background:var(--dsw-alias-state-business-primary,#4176e6)}
.dsh-mc-dist-count{flex:none;font:11px/16px var(--dsw-font-family,system-ui,sans-serif);font-variant-numeric:tabular-nums}
.dsh-mc-dist-empty{font:11px/16px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#999)}
.dsh-mc-health{display:flex;align-items:center;gap:8px}
.dsh-mc-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#999}
.dsh-mc-dot-ok{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsh-mc-dot-off{background:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-mc-health-label{font:12px/18px var(--dsw-font-family,system-ui,sans-serif)}
.dsh-mc-health-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dsh-mc-health-num{display:block;font:600 16px/22px var(--dsw-font-family,system-ui,sans-serif);font-variant-numeric:tabular-nums}
.dsh-mc-path{display:flex;flex-direction:column;gap:2px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
.dsh-mc-path-key{font:10px/14px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-path-val{font:11px/16px var(--dsw-font-family,system-ui,sans-serif);word-break:break-all}
.dsh-mc-link{border:none;background:none;padding:0;cursor:pointer;font:12px/18px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-state-business-primary,#4176e6)}
.dsh-mc-back{margin-bottom:2px;align-self:flex-start}
.dsh-mc-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;padding:4px 12px;font:12px/1.6 var(--dsw-font-family,system-ui,sans-serif);cursor:pointer;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent)}
.dsh-mc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.dsh-mc-btn:disabled{opacity:.5;cursor:default}
.dsh-mc-btn-primary{color:var(--dsw-alias-button-primary-label,#fff);background:var(--dsw-alias-button-primary-fill,#4176e6);border-color:transparent}
.dsh-mc-btn-danger{color:var(--dsw-alias-button-danger-label,#fff);background:var(--dsw-alias-state-error-primary,#e5484d);border-color:transparent}
.dsh-mc-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-mc-input{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;padding:4px 8px;font:12px/1.6 var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent)}
.dsh-mc-input-grow{flex:1;min-width:160px}
.dsh-mc-input-kind{flex:none;width:110px}
.dsh-mc-list{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-mc-item{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:12px;background:var(--dsw-alias-bg-layer-3,transparent);display:flex;flex-direction:column}
.dsh-mc-item-body{border:none;background:none;text-align:left;padding:10px 12px 4px;cursor:pointer;min-width:0}
.dsh-mc-item-content{font:13px/20px var(--dsw-font-family,system-ui,sans-serif);white-space:pre-wrap;word-break:break-word}
.dsh-mc-item-summary{margin-top:2px;font:11px/16px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-item-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:4px 12px 8px}
.dsh-mc-item-meta{font:11px/16px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888);min-width:0}
.dsh-mc-badges{display:inline-flex;gap:4px;flex-wrap:wrap}
.dsh-mc-badge{display:inline-block;padding:1px 7px;border-radius:99px;font:10px/1.7 var(--dsw-font-family,system-ui,sans-serif);border:1px solid transparent}
.dsh-mc-tone-ok{color:var(--dsw-alias-state-success-label,#16a34a);background:var(--dsw-alias-state-success-bg,rgba(34,197,94,.12))}
.dsh-mc-tone-warn{color:var(--dsw-alias-state-warn-label,#b45309);background:var(--dsw-alias-state-warn-bg,rgba(229,165,10,.14))}
.dsh-mc-tone-danger{color:var(--dsw-alias-state-error-label,#dc2626);background:var(--dsw-alias-state-error-bg,rgba(229,72,77,.12))}
.dsh-mc-tone-info{color:var(--dsw-alias-state-business-primary,#4176e6);background:rgba(65,118,230,.12)}
.dsh-mc-tone-accent{color:var(--dsw-alias-state-warn-label,#b45309);border-color:currentColor}
.dsh-mc-tone-dim{color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1))}
.dsh-mc-pager{display:flex;align-items:center;justify-content:center;gap:12px}
.dsh-mc-pager-info{font:12px/18px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-events{display:flex;flex-direction:column;gap:4px}
.dsh-mc-events-page{gap:8px}
.dsh-mc-event{display:flex;align-items:center;gap:8px;min-width:0;padding:3px 0}
.dsh-mc-event-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/18px var(--dsw-font-family,system-ui,sans-serif)}
.dsh-mc-event-link{cursor:pointer;color:var(--dsw-alias-label-primary,inherit);background:none;border:none;text-align:left;padding:0;font:inherit}
.dsh-mc-event-link:hover{color:var(--dsw-alias-state-business-primary,#4176e6)}
.dsh-mc-event-actor,.dsh-mc-event-state{flex:none;font:10px/14px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-event-time{flex:none;font:10px/14px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums}
.dsh-mc-query-note{margin:0 0 6px!important}
.dsh-mc-detail-badges{margin-top:4px}
.dsh-mc-detail-content{font-size:14px}
.dsh-mc-note{padding:8px 12px;border-radius:10px;font:12px/18px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-state-warn-label,#b45309);background:var(--dsw-alias-state-warn-bg,rgba(229,165,10,.12))}
.dsh-mc-meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px 12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
.dsh-mc-meta-row{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-mc-meta-key{font:10px/14px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-meta-val{font:12px/18px var(--dsw-font-family,system-ui,sans-serif);word-break:break-word}
.dsh-mc-evid,.dsh-mc-audit{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));padding:4px 2px}
.dsh-mc-audit{display:flex;flex-direction:column;gap:2px}
.dsh-mc-audit-at{font:11px/16px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-debug summary{cursor:pointer;font:11px/16px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-state-business-primary,#4176e6)}
.dsh-mc-debug-body{display:flex;flex-direction:column;gap:4px}
.dsh-mc-debug-body pre{max-height:150px;overflow:auto;margin:2px 0;padding:6px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08));font:10px/14px ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
.dsh-mc-form{display:flex;flex-direction:column;gap:8px}
.dsh-mc-form-row{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsh-mc-form-label{font:11px/16px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-secondary,#666)}
.dsh-mc-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}
.dsh-mc-actions{display:flex;gap:8px;justify-content:flex-end}
.dsh-mc-inline-err{font:12px/18px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-mc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
.dsh-mc-modal{width:100%;max-width:430px;background:var(--dsw-alias-bg-layer-3,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px}
.dsh-mc-modal-title{margin:0;font:600 15px/22px var(--dsw-font-family,system-ui,sans-serif)}
.dsh-mc-modal-text{margin:0;font:13px/20px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-secondary,#666)}
.dsh-mc-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;align-items:start}
.dsh-mc-settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0}
.dsh-mc-settings-label{font:13px/20px var(--dsw-font-family,system-ui,sans-serif)}
.dsh-mc-settings-hint{font:11px/16px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary,#888)}
.dsh-mc-planned-chips{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
.dsh-mc-settings-row input[type=checkbox]{flex:none;accent-color:var(--dsw-alias-button-primary-fill,#4176e6)}
.dsh-mc-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`
      document.head.appendChild(style)
    }

    function apply(ctx) {
      if (typeof ctx.slots?.inject !== 'function') return
      if (ctx.locale) attachLocale(ctx.locale)
      ensureStyles()
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-memory-personal',
        order: 60,
        label: () => t('settingsTitle'),
      }, MemoryCenter))
    }

    exports.apply = apply
    exports.inject = inject
    // Pure helpers for tests; the loader contract ignores them.
    exports._internals = { t, formatTime, listPath, EventRow, MemoryListItem, DistBars }
    return module.exports
  },
})
