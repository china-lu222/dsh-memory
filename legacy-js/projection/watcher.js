// Optional live watcher: user edits to projected Markdown are adopted back
// into the store. Zero dependencies — node:fs.watch with recursive: true.
// Where the platform cannot watch recursively the watcher degrades to a no-op
// and the resync endpoint (/api/markdown/resync) remains the fallback.

import { watch } from 'node:fs'
import { sep } from 'node:path'

/**
 * Watch a projection root and debounce per-file change callbacks.
 * @param {string} root - absolute directory to watch (recursively).
 * @param {{
 *   onFile?: (rel: string) => void,
 *   isSelfWrite?: () => boolean,
 *   debounceMs?: number,
 *   log?: (message: string) => void,
 * }} options
 * @returns {() => void} - stop watching.
 */
export function watchMarkdown(root, options = {}) {
  const { onFile = () => {}, isSelfWrite = () => false, debounceMs = 200, log = () => {} } = options
  /** @type {import('node:fs').FSWatcher | undefined} */
  let watcher
  const timers = new Map()
  let closed = false
  try {
    watcher = watch(root, { recursive: true })
  } catch (error) {
    log(`markdown file watching unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return () => {}
  }
  watcher.on('change', (_event, filename) => {
    if (closed || isSelfWrite() || typeof filename !== 'string') return
    const rel = filename.split(sep).join('/')
    if (!rel.endsWith('.md')) return
    const prior = timers.get(rel)
    if (prior !== undefined) clearTimeout(prior)
    timers.set(
      rel,
      setTimeout(() => {
        timers.delete(rel)
        if (closed) return
        try {
          onFile(rel)
        } catch (error) {
          log(`markdown adoption failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }, debounceMs),
    )
  })
  watcher.on('error', (error) => {
    log(`markdown watcher error: ${error instanceof Error ? error.message : String(error)}`)
  })
  return () => {
    closed = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    watcher?.close()
  }
}
