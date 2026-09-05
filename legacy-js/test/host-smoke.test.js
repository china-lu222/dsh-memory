import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceTmp = join(here, '.tmp')

/**
 * Build a stub host context that satisfies the surfaces apply() touches:
 * systemPrompt.section, inject(['webServer']), root event bus, logger and the
 * ctx.on('dispose') hook.
 */
function stubContext() {
  const sections = []
  const routes = []
  const bus = new Map()
  const disposeHandlers = []
  const root = {
    on: (name, handler) => {
      const list = bus.get(name) ?? []
      list.push(handler)
      bus.set(name, list)
    },
    inject: () => {},
  }
  const ctx = {
    root,
    inject: (services, callback) => {
      if (services.includes('webServer')) {
        callback({
          webServer: {
            register: (route) => routes.push(route),
          },
        })
      }
    },
    systemPrompt: {
      section: (entry) => {
        sections.push(entry)
        return () => {
          const i = sections.indexOf(entry)
          if (i >= 0) sections.splice(i, 1)
        }
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    on: (name, handler) => {
      if (name === 'dispose') disposeHandlers.push(handler)
      return () => {}
    },
    get: () => undefined,
  }
  return {
    ctx,
    sections,
    routes,
    bus,
    dispose() {
      for (const handler of disposeHandlers) handler()
    },
  }
}

function makeHandler(route) {
  return async (method, path) => {
    const req = {
      method,
      url: path,
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve({ done: true, value: undefined }) }
      },
    }
    let status = 0
    let body = ''
    const res = {
      writeHead: (code) => {
        status = code
      },
      end: (payload) => {
        body = payload
      },
    }
    await route.handler(req, res)
    return { status, json: body ? JSON.parse(body) : null }
  }
}

async function waitForStore(healthRoute) {
  for (let i = 0; i < 50; i += 1) {
    const res = await makeHandler(healthRoute)('GET', '/dsh-memory-personal/api/health')
    if (res.status === 200 && res.json.data.storeOpen) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

function makeTempDir() {
  mkdirSync(workspaceTmp, { recursive: true })
  return mkdtempSync(join(workspaceTmp, 'dsh-memory-personal-'))
}

test('apply wires systemPrompt section, webServer routes and the event bus', async () => {
  const dir = makeTempDir()
  const { ctx, sections, routes, bus, dispose } = stubContext()
  try {
    apply(ctx, { dataDir: dir })

    const healthRoute = routes.find((r) => r.path === '/dsh-memory-personal/api/health')
    assert.ok(healthRoute, 'health route registered')
    const ready = await waitForStore(healthRoute)
    assert.equal(ready, true, 'store opened and health reports ready')

    assert.ok(sections.some((s) => s.name === 'plugin:dsh-memory-personal'), 'agent guidance announced')
    assert.ok(routes.length >= 8, `expected >=8 routes, got ${routes.length}`)
    for (const event of ['session/event', 'session/flush', 'session/disposed']) {
      assert.ok(bus.has(event), `listening to ${event}`)
    }
  } finally {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('overview and timeline aggregate endpoints reflect persisted data', async () => {
  const dir = makeTempDir()
  const { ctx, routes, dispose } = stubContext()
  try {
    apply(ctx, { dataDir: dir })
    const healthRoute = routes.find((r) => r.path === '/dsh-memory-personal/api/health')
    const ready = await waitForStore(healthRoute)
    assert.equal(ready, true, 'store opened')

    const postRoute = routes.find((r) => r.path === '/dsh-memory-personal/api/memories' && r.kind === 'exact')
    const payload = JSON.stringify({
      id: 'mem_test_overview', scope: 'global', kind: 'fact',
      content: 'Overview endpoint sees this record', importance: 0.6, confidence: 1,
    })
    const chunks = [Buffer.from(payload)]
    const reqWithBody = {
      method: 'POST',
      url: '/dsh-memory-personal/api/memories',
      [Symbol.asyncIterator]() {
        let i = 0
        return { next: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }
      },
    }
    await postRoute.handler(reqWithBody, { writeHead() {}, end() {} })

    const overviewRoute = routes.find((r) => r.path === '/dsh-memory-personal/api/overview')
    const overview = await makeHandler(overviewRoute)('GET', '/dsh-memory-personal/api/overview')
    assert.equal(overview.status, 200)
    assert.equal(overview.json.data.storeOpen, true)
    assert.ok(overview.json.data.counts.total >= 1, JSON.stringify(overview.json))
    assert.ok(overview.json.data.counts.active >= 1)
    assert.ok(overview.json.data.counts.userEdited >= 1)
    assert.ok(Array.isArray(overview.json.data.byKind), 'byKind is an array')
    const kindGlobal = overview.json.data.byScope.find((d) => d.key === 'global')
    assert.ok(kindGlobal && kindGlobal.count >= 1, 'global bucket counts the record')

    const timelineRoute = routes.find((r) => r.path === '/dsh-memory-personal/api/timeline')
    const timeline = await makeHandler(timelineRoute)('GET', '/dsh-memory-personal/api/timeline?limit=50')
    assert.equal(timeline.status, 200)
    const created = timeline.json.data.events.find((e) => e.type === 'memory' && e.memoryId === 'mem_test_overview')
    assert.ok(created, 'timeline exposes the create event')
    assert.equal(created.action, 'create')
    assert.equal(created.content, 'Overview endpoint sees this record')

    const listRoute = routes.find((r) => r.path === '/dsh-memory-personal/api/memories/' && r.kind === 'prefix')
    const paged = await makeHandler(listRoute)('GET', '/dsh-memory-personal/api/memories/?q=Overview&status=active&limit=50&offset=0')
    assert.equal(paged.status, 200)
    assert.equal(paged.json.data.rows.length, 1, 'list honors q/status/offset filters')
    assert.equal(paged.json.data.rows[0].id, 'mem_test_overview')
    const emptyPage = await makeHandler(listRoute)('GET', '/dsh-memory-personal/api/memories/?q=Overview&status=active&limit=50&offset=50')
    assert.equal(emptyPage.json.data.rows.length, 0, 'offset beyond data returns an empty page')
  } finally {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory create route persists a user record and exposes it via search', async () => {
  const dir = makeTempDir()
  const { ctx, routes, dispose } = stubContext()
  try {
    apply(ctx, { dataDir: dir })

    const healthRoute = routes.find((r) => r.path === '/dsh-memory-personal/api/health')
    const ready = await waitForStore(healthRoute)
    assert.equal(ready, true, 'store opened')

    const postRoute = routes.find((r) => r.path === '/dsh-memory-personal/api/memories' && r.kind === 'exact')
    const payload = JSON.stringify({
      scope: 'global', kind: 'fact', content: 'The team uses pnpm workspaces', importance: 0.6, confidence: 1,
    })
    const chunks = [Buffer.from(payload)]
    const reqWithBody = {
      method: 'POST',
      url: '/dsh-memory-personal/api/memories',
      [Symbol.asyncIterator]() {
        let i = 0
        return { next: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }
      },
    }
    const postRes = await postRoute.handler(reqWithBody, { writeHead() {}, end() {} })
    void postRes

    const searchRoute = routes.find((r) => r.path === '/dsh-memory-personal/api/search')
    const searchRes = await makeHandler(searchRoute)('GET', '/dsh-memory-personal/api/search?q=pnpm+workspaces')
    assert.equal(searchRes.status, 200)
    assert.ok(searchRes.json.data.count >= 1, JSON.stringify(searchRes.json))
    assert.equal(searchRes.json.data.rows[0].userEdited, true)
  } finally {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
