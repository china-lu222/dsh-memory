// dsh-memory-personal — host half.
//
// A durable, explainable memory layer for personal long-term use. It watches
// DSH session events (user / assistant / tool messages), keeps a per-session
// transcript in SQLite, extracts explicit user self-statements into memory
// records backed by quoted evidence, and exposes a small management surface:
//   - a memory agent-guide section (systemPrompt seat),
//   - /dsh-memory-personal/api/* JSON routes (search / list / get / update / audit /
//     export / recent-sessions) for the WebUI,
//   - a settings toggle to disable the systemPrompt announcement.
//
// Zero runtime dependencies: Node builtins (node:sqlite, node:fs, node:path,
// node:url) plus the platform fetch where used. Every dsh surface is
// feature-detected so SDK drift degrades to a no-op instead of a crash
// (same defensive style as the dsh-balance-display plugin).

import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from './store/sqlite.js'
import { SessionIngestPipeline, resolveProjectId } from './ingest/pipeline.js'
import { LIVE_STATUSES, makeId } from './model/types.js'
import { MarkdownProjectionService } from './projection/service.js'
import { watchMarkdown } from './projection/watcher.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Model-facing announcement: plugin presence and what the model may use. */
const SECTION_ORDER = 205
const AGENT_GUIDANCE = `本机已安装 dsh-memory-personal 记忆插件：它会自动记录你在会话中的显式偏好/自述（如「我用 TypeScript」），并把历史会话转写保存在本地 SQLite。用户询问「你记得我… / 我是不是说过…」时，可查询路由 /dsh-memory-personal/api/search?q=… 获取已记忆内容；用户可以要求「记住 X」，但未经用户明确的记忆不得写入 Profile；一切记忆可编辑、可删除、可审计。`

/** Required at apply time: the system-prompt section seat. */
export const inject = ['systemPrompt']

/** Defaults mirroring cordis.yml schema (loader validates; kept for hand-built ctx). */
const DEFAULT_CONFIG = {
  enabled: true,
  announceToAgent: true,
  dataDir: undefined,
  extractProfiles: true,
  maxTranscriptChars: 100_000,
  markdownEnabled: true,
  markdownDir: undefined,
  markdownWatch: true,
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - resolved plugin config.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  if (cfg.enabled === false) return

  let announce = cfg.announceToAgent !== false
  let disposeAnnounce
  const syncAnnounce = () => {
    if (disposeAnnounce !== undefined) {
      disposeAnnounce()
      disposeAnnounce = undefined
    }
    if (!announce) return
    if (typeof ctx.systemPrompt?.section !== 'function') return
    disposeAnnounce = ctx.systemPrompt.section({
      name: 'plugin:dsh-memory-personal',
      order: SECTION_ORDER,
      text: AGENT_GUIDANCE,
    })
  }
  syncAnnounce()

  // Resolve the store path once, before any async listener runs.
  const storePath = resolveStorePath(cfg.dataDir)
  if (storePath === undefined) {
    ctx.logger?.error?.('[dsh-memory-personal] dataDir resolution failed; plugin disabled')
    return
  }
  const markdownRoot = resolveMarkdownRoot(cfg.markdownDir, storePath)

  /** @type {import('./store/repository.js').MemoryRepository | undefined} */
  let repo

  /** @type {MarkdownProjectionService | undefined} */
  let projection

  /** @type {() => void} */
  let dispose = () => {}

  const start = async () => {
    try {
      repo = await openStore(storePath)
      const pipeline = new SessionIngestPipeline(repo, {
        enableProfileExtraction: cfg.extractProfiles !== false,
      })

      // Session event listeners: the dsh-session append feed is scope-filtered
      // and fans out from the root context (same bubble-up model used by
      // dsh-balance-display for credentials/updated). Listener failures are
      // contained: memory must never break chat.
      const root = ctx.root ?? ctx
      if (typeof root.on === 'function') {
        root.on('session/event', (session, event) => {
          try {
            pipeline.onSessionEvent(session, event)
          } catch (error) {
            ctx.logger?.warn?.('[dsh-memory-personal] session event ignored: %s', String(error?.message ?? error))
          }
        })
        root.on('session/flush', (session) => {
          try {
            pipeline.onSessionFlush(session)
          } catch (error) {
            ctx.logger?.warn?.('[dsh-memory-personal] session flush failed: %s', String(error?.message ?? error))
          }
        })
        root.on('session/disposed', (session) => {
          try {
            pipeline.onSessionDisposed(session)
          } catch (error) {
            ctx.logger?.warn?.('[dsh-memory-personal] session dispose handling failed: %s', String(error?.message ?? error))
          }
        })
      } else {
        ctx.logger?.warn?.('[dsh-memory-personal] no event bus; memory collection disabled')
      }

      // Markdown projection: files are written only by this service, and the
      // watcher adopts user edits back into the store (DB stays authoritative
      // while the Markdown stays human-editable). Opt-outs keep old behaviour.
      let stopWatch = () => {}
      if (cfg.markdownEnabled !== false) {
        projection = new MarkdownProjectionService({
          repo,
          root: markdownRoot,
          log: (message) => ctx.logger?.warn?.('[dsh-memory-personal] %s', message),
        }).attach()
        projection.resyncAll()
        if (cfg.markdownWatch !== false) {
          stopWatch = watchMarkdown(markdownRoot, {
            onFile: (rel) => {
              projection?.applyFileChange(rel)
            },
            isSelfWrite: () => (projection?.writing ?? 0) > 0,
            log: (message) => ctx.logger?.warn?.('[dsh-memory-personal] %s', message),
          })
        }
      }

      dispose = () => {
        if (disposeAnnounce !== undefined) disposeAnnounce()
        stopWatch()
        try {
          projection?.detach()
        } catch {
          /* projection already detached */
        }
        projection = undefined
        try {
          repo?.close()
        } catch {
          /* store already closed */
        }
        repo = undefined
      }
      ctx.logger?.info?.('[dsh-memory-personal] store ready at %s (markdown root %s)', storePath, markdownRoot)
    } catch (error) {
      ctx.logger?.error?.('[dsh-memory-personal] store startup failed: %s', String(error?.message ?? error))
      disposeAnnounce?.()
    }
  }

  // Start asynchronously but keep apply() synchronous (cordis apply contract).
  void start()

  // Host web surface: routes only exist on profiles that compose webServer.
  // Injectable lazily so headless profiles still load the plugin (no-op).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        registerRoutes(scope, {
          repo: () => repo,
          projection: () => projection,
          getConfig: () => ({
            announceToAgent: announce,
            enabled: cfg.enabled !== false,
            storePath,
            markdown: {
              enabled: cfg.markdownEnabled !== false,
              watch: cfg.markdownWatch !== false,
              root: markdownRoot,
            },
          }),
          setAnnounce: (value) => {
            if (typeof value === 'boolean' && value !== announce) {
              announce = value
              syncAnnounce()
            }
          },
          dataDir: storePath,
        })
      } catch (error) {
        ctx.logger?.error?.('[dsh-memory-personal] route registration failed: %s', String(error?.message ?? error))
      }
    })
  }

  // Guard against the plugin being hot-removed while the store is open.
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => dispose())
  }
}

/**
 * Resolve the SQLite store directory. When dataDir is configured it wins
 * (absolute or relative to the plugin dir); otherwise the store lives next to
 * the plugin so it stays inside the workspace (never on the system drive).
 * @param {string | undefined} dataDir
 * @returns {string | undefined}
 */
function resolveStorePath(dataDir) {
  try {
    const base = typeof dataDir === 'string' && dataDir.length > 0
      ? (isAbsolute(dataDir) ? dataDir : join(__dirname, '..', dataDir))
      : join(__dirname, '..', 'data')
    return join(base, 'memory.db')
  } catch {
    return undefined
  }
}

/**
 * Register the dsh-memory-personal JSON API.
 * @param {object} scope - scoped context carrying webServer.
 * @param {{
 *   repo: () => (import('./store/repository.js').MemoryRepository | undefined),
 *   projection: () => (import('./projection/service.js').MarkdownProjectionService | undefined),
 *   getConfig: () => object,
 *   setAnnounce: (value: boolean) => void,
 *   dataDir: string,
 * }} deps
 */
function registerRoutes(scope, deps) {
  const webServer = scope.webServer
  if (typeof webServer?.register !== 'function') return

  const sendJson = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const readBody = async (req, maxBytes = 64 * 1024) => {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > maxBytes) {
        const error = new Error('request body too large')
        error.code = 'TOO_LARGE'
        throw error
      }
      chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw.length === 0 ? {} : JSON.parse(raw)
  }

  // GET /dsh-memory-personal/api/health
  webServer.register({
    name: 'dsh-memory-personal-health',
    kind: 'exact',
    path: '/dsh-memory-personal/api/health',
    handler: (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const store = deps.repo()
      const counts = store?.overview().counts
      let markdown = { enabled: deps.getConfig().markdown.enabled, root: deps.getConfig().markdown.root, ready: false }
      const service = deps.projection()
      if (service !== undefined) {
        const snapshot = service.scanStatus()
        markdown = {
          ...markdown,
          ready: true,
          tracked: snapshot.summary.tracked,
          synced: snapshot.summary.synced,
          modified: snapshot.summary.modified,
          missing: snapshot.summary.missing,
          conflict: snapshot.summary.conflict,
          archived: snapshot.archived,
          unknown: snapshot.unknown.length,
        }
      }
      sendJson(res, 200, {
        ok: true,
        data: {
          enabled: true,
          storePath: deps.dataDir,
          storeOpen: store !== undefined,
          memoryCount: counts?.total ?? 0,
          markdown,
        },
      })
    },
  })

  // GET /dsh-memory-personal/api/config, POST /dsh-memory-personal/api/config
  webServer.register({
    name: 'dsh-memory-personal-config',
    kind: 'exact',
    path: '/dsh-memory-personal/api/config',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, data: deps.getConfig() })
      }
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const patch = await readBody(req, 1024)
        if (patch === null || typeof patch !== 'object') {
          return sendJson(res, 400, { ok: false, error: 'body must be a JSON object' })
        }
        const out = {}
        if ('announceToAgent' in patch) {
          if (typeof patch.announceToAgent !== 'boolean') {
            return sendJson(res, 400, { ok: false, error: 'announceToAgent must be boolean' })
          }
          deps.setAnnounce(patch.announceToAgent)
          out.announceToAgent = patch.announceToAgent
        }
        return sendJson(res, 200, { ok: true, data: { ...deps.getConfig(), ...out } })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  // GET /dsh-memory-personal/api/search?q=&scope=&kind=&limit=&offset=
  webServer.register({
    name: 'dsh-memory-personal-search',
    kind: 'exact',
    path: '/dsh-memory-personal/api/search',
    handler: (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const store = deps.repo()
      if (!store) return sendJson(res, 503, { ok: false, error: 'store not ready' })
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const query = url.searchParams.get('q') ?? ''
        const scope = url.searchParams.get('scope')
        const kind = url.searchParams.get('kind')
        const rows = store.list({
          query: query.length > 0 ? query : undefined,
          scopes: scope ? [scope] : undefined,
          kinds: kind ? [kind] : undefined,
          // Model-facing surface: only `active` memories enter the agent context.
          // v3 candidates/quarantined/verified/validated are not ready for use
          // until a human has confirmed and promoted them.
          statuses: ['active'],
          limit: Number(url.searchParams.get('limit') ?? 50),
          offset: Number(url.searchParams.get('offset') ?? 0),
        })
        sendJson(res, 200, { ok: true, data: { count: rows.length, rows } })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  // GET /dsh-memory-personal/api/memories (list all, optional filters),
  // GET /dsh-memory-personal/api/memories/:id (single with evidence+audit), and
  // DELETE /dsh-memory-personal/api/memories/:id share one prefix route: the
  // host webserver rejects a duplicate (kind, path), so a second register on
  // the same prefix would abort every later route in this file.
  webServer.register({
    name: 'dsh-memory-personal-memories',
    kind: 'prefix',
    path: '/dsh-memory-personal/api/memories/',
    handler: (req, res) => {
      const store = deps.repo()
      if (!store) return sendJson(res, 503, { ok: false, error: 'store not ready' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rest = url.pathname.slice('/dsh-memory-personal/api/memories/'.length)
      if (req.method === 'DELETE') {
        try {
          const id = decodeURIComponent(rest.split('/')[0])
          if (!id) return sendJson(res, 400, { ok: false, error: 'missing memory id' })
          const removed = store.delete(id, { actor: 'user' })
          return sendJson(res, 200, { ok: true, data: { removed } })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      }
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const statusParam = url.searchParams.get('status')
        const filters = {
          scopes: url.searchParams.get('scope') ? [url.searchParams.get('scope')] : undefined,
          kinds: url.searchParams.get('kind') ? [url.searchParams.get('kind')] : undefined,
          // Human management surface: default to every live status so fresh v3
          // candidates and quarantined rows stay visible until decided.
          statuses: statusParam ? [statusParam] : LIVE_STATUSES,
          query: url.searchParams.get('q') ? url.searchParams.get('q') : undefined,
          limit: Number(url.searchParams.get('limit') ?? 200),
          offset: Number(url.searchParams.get('offset') ?? 0),
        }
        if (rest.length > 0 && !rest.includes('/')) {
          const id = decodeURIComponent(rest)
          const record = store.get(id)
          if (!record) return sendJson(res, 404, { ok: false, error: 'memory not found' })
          return sendJson(res, 200, { ok: true, data: { record, evidence: store.evidence(id), audit: store.audit(id) } })
        }
        const rows = store.list(filters)
        sendJson(res, 200, { ok: true, data: { count: rows.length, rows } })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  // POST /dsh-memory-personal/api/memories  — create/update a memory record (user edits)
  webServer.register({
    name: 'dsh-memory-personal-memories-post',
    kind: 'exact',
    path: '/dsh-memory-personal/api/memories',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const store = deps.repo()
      if (!store) return sendJson(res, 503, { ok: false, error: 'store not ready' })
      try {
        const body = await readBody(req)
        const id = typeof body.id === 'string' && body.id ? body.id : makeId('mem', JSON.stringify(body.content ?? 'manual'))
        const record = {
          id,
          scope: body.scope ?? 'global',
          kind: body.kind ?? 'profile',
          content: body.content,
          ...body.summary !== undefined ? { summary: body.summary } : {},
          importance: body.importance ?? 0.7,
          confidence: body.confidence ?? 1,
          status: body.status ?? 'active',
          source: 'user',
          sourceIds: [],
          tags: Array.isArray(body.tags) ? body.tags : [],
          userEdited: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        const saved = store.put(record, { actor: 'user' })
        sendJson(res, 200, { ok: true, data: { record: saved } })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  // GET /dsh-memory-personal/api/audit?limit=
  webServer.register({
    name: 'dsh-memory-personal-audit',
    kind: 'exact',
    path: '/dsh-memory-personal/api/audit',
    handler: (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const store = deps.repo()
      if (!store) return sendJson(res, 503, { ok: false, error: 'store not ready' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      sendJson(res, 200, { ok: true, data: store.recentAudit(Number(url.searchParams.get('limit') ?? 50)) })
    },
  })

  // GET /dsh-memory-personal/api/sessions
  webServer.register({
    name: 'dsh-memory-personal-sessions',
    kind: 'exact',
    path: '/dsh-memory-personal/api/sessions',
    handler: (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const store = deps.repo()
      if (!store) return sendJson(res, 503, { ok: false, error: 'store not ready' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      sendJson(res, 200, { ok: true, data: store.listSessionRuns(Number(url.searchParams.get('limit') ?? 50)) })
    },
  })

  // GET /dsh-memory-personal/api/export
  webServer.register({
    name: 'dsh-memory-personal-export',
    kind: 'exact',
    path: '/dsh-memory-personal/api/export',
    handler: (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const store = deps.repo()
      if (!store) return sendJson(res, 503, { ok: false, error: 'store not ready' })
      try {
        const dump = store.exportJson()
        sendJson(res, 200, { ok: true, data: dump })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  // GET /dsh-memory-personal/api/overview — dashboard aggregate snapshot
  webServer.register({
    name: 'dsh-memory-personal-overview',
    kind: 'exact',
    path: '/dsh-memory-personal/api/overview',
    handler: (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const store = deps.repo()
      if (!store) return sendJson(res, 503, { ok: false, error: 'store not ready' })
      try {
        const snapshot = store.overview()
        sendJson(res, 200, {
          ok: true,
          data: {
            storeOpen: true,
            storePath: deps.dataDir,
            ...snapshot,
          },
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  // GET /dsh-memory-personal/api/timeline?limit= — unified activity feed
  webServer.register({
    name: 'dsh-memory-personal-timeline',
    kind: 'exact',
    path: '/dsh-memory-personal/api/timeline',
    handler: (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const store = deps.repo()
      if (!store) return sendJson(res, 503, { ok: false, error: 'store not ready' })
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const feed = store.timeline(Number(url.searchParams.get('limit') ?? 100))
        sendJson(res, 200, { ok: true, data: feed })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  // Markdown projection surface. Every handler is a thin pass-through to the
  // projection service; when projection is disabled (or still starting) the
  // routes answer 503 instead of failing the surrounding page.
  const proj = (res) => {
    const service = deps.projection()
    if (service === undefined) {
      sendJson(res, 503, { ok: false, error: 'markdown projection not ready' })
      return undefined
    }
    return service
  }

  // GET /dsh-memory-personal/api/markdown/status — sync health of the tree
  webServer.register({
    name: 'dsh-memory-personal-markdown-status',
    kind: 'exact',
    path: '/dsh-memory-personal/api/markdown/status',
    handler: (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const service = proj(res)
      if (service === undefined) return undefined
      try {
        const snapshot = service.scanStatus()
        sendJson(res, 200, {
          ok: true,
          data: {
            root: deps.getConfig().markdown.root,
            dbCount: deps.repo()?.overview().counts.total ?? 0,
            ...snapshot,
          },
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return undefined
    },
  })

  // GET /dsh-memory-personal/api/markdown/tree — every .md under the root
  webServer.register({
    name: 'dsh-memory-personal-markdown-tree',
    kind: 'exact',
    path: '/dsh-memory-personal/api/markdown/tree',
    handler: (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const service = proj(res)
      if (service === undefined) return undefined
      try {
        sendJson(res, 200, { ok: true, data: service.treeFiles() })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return undefined
    },
  })

  // GET /dsh-memory-personal/api/markdown/file?path=<rel> — raw file content
  webServer.register({
    name: 'dsh-memory-personal-markdown-file',
    kind: 'exact',
    path: '/dsh-memory-personal/api/markdown/file',
    handler: (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const service = proj(res)
      if (service === undefined) return undefined
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.searchParams.get('path') ?? ''
        if (!path) return sendJson(res, 400, { ok: false, error: 'missing path' })
        const file = service.readFile(path)
        if (file === undefined) return sendJson(res, 404, { ok: false, error: 'file not found' })
        sendJson(res, 200, { ok: true, data: { ...file, expected: service.expectedText(file.path) } })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
      return undefined
    },
  })

  // POST /dsh-memory-personal/api/markdown/apply — adopt one edited file
  webServer.register({
    name: 'dsh-memory-personal-markdown-apply',
    kind: 'exact',
    path: '/dsh-memory-personal/api/markdown/apply',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const service = proj(res)
      if (service === undefined) return undefined
      try {
        const body = await readBody(req, 2048)
        const path = typeof body?.path === 'string' ? body.path : ''
        if (!path) return sendJson(res, 400, { ok: false, error: 'missing path' })
        const result = service.applyFileChange(path)
        sendJson(res, 200, { ok: true, data: result })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
      return undefined
    },
  })

  // POST /dsh-memory-personal/api/markdown/restore — rewrite one file from DB
  webServer.register({
    name: 'dsh-memory-personal-markdown-restore',
    kind: 'exact',
    path: '/dsh-memory-personal/api/markdown/restore',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const service = proj(res)
      if (service === undefined) return undefined
      try {
        const body = await readBody(req, 2048)
        const path = typeof body?.path === 'string' ? body.path : ''
        if (!path) return sendJson(res, 400, { ok: false, error: 'missing path' })
        const result = service.restoreFile(path)
        sendJson(res, 200, { ok: true, data: result })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
      return undefined
    },
  })

  // POST /dsh-memory-personal/api/markdown/edit — save an edited file from the
  // Web UI (self-write + immediate adoption, the watcher minus the debounce).
  webServer.register({
    name: 'dsh-memory-personal-markdown-edit',
    kind: 'exact',
    path: '/dsh-memory-personal/api/markdown/edit',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const service = proj(res)
      if (service === undefined) return undefined
      try {
        const body = await readBody(req, 128 * 1024)
        const path = typeof body?.path === 'string' ? body.path : ''
        const text = typeof body?.text === 'string' ? body.text : ''
        if (!path) return sendJson(res, 400, { ok: false, error: 'missing path' })
        const result = service.saveUserEdit(path, text)
        sendJson(res, 200, { ok: true, data: result })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
      return undefined
    },
  })

  // POST /dsh-memory-personal/api/markdown/resync — DB authoritative reconcile
  webServer.register({
    name: 'dsh-memory-personal-markdown-resync',
    kind: 'exact',
    path: '/dsh-memory-personal/api/markdown/resync',
    handler: (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const service = proj(res)
      if (service === undefined) return undefined
      try {
        const result = service.resyncAll()
        sendJson(res, 200, { ok: true, data: { ...result, status: service.scanStatus().summary } })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return undefined
    },
  })
}

/**
 * Resolve the Markdown projection root. Explicit markdownDir wins (absolute,
 * or relative to the plugin directory); otherwise the tree lives next to the
 * store at `data/memory` so it stays inside the workspace.
 * @param {string | undefined} markdownDir
 * @param {string} storePath
 * @returns {string}
 */
function resolveMarkdownRoot(markdownDir, storePath) {
  const base = join(dirname(storePath), 'memory')
  try {
    if (typeof markdownDir === 'string' && markdownDir.length > 0) {
      return isAbsolute(markdownDir) ? markdownDir : join(__dirname, '..', markdownDir)
    }
  } catch {
    /* fall through to the store-adjacent default */
  }
  return base
}

export { resolveStorePath, resolveMarkdownRoot, resolveProjectId }
