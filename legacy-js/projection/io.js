// Projection file I/O: safe relative-path read/write/delete + walker.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'

/** Relative files this projector owns carry this marker in the body. */
export const OWNER_MARK = 'dsh-memory projection'

export class ProjectionFs {
  /** @param {string} root - absolute projection root directory. */
  constructor(root) {
    if (typeof root !== 'string' || root.length === 0) throw new Error('projection root required')
    this.root = resolve(root)
  }

  /** Absolute path for a relative path (guards against traversal). */
  abs(rel) {
    const safe = this.safe(rel)
    return resolve(this.root, safe)
  }

  /** Validate/normalize a relative path; throws on escapes. */
  safe(rel) {
    if (typeof rel !== 'string' || rel.length === 0) throw new Error('projection path must be a non-empty string')
    const normalized = normalize(rel).replaceAll('\\', '/')
    const resolved = resolve(this.root, normalized)
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new Error(`projection path escapes root: ${rel}`)
    }
    return normalized
  }

  /** Read a relative file; undefined when missing/unreadable. */
  read(rel) {
    try {
      return readFileSync(this.abs(rel), 'utf8')
    } catch {
      return undefined
    }
  }

  /** Write a relative file, creating parent directories. */
  write(rel, text) {
    const abs = this.abs(rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text, 'utf8')
  }

  /** Delete a relative file if present. */
  unlink(rel) {
    rmSync(this.abs(rel), { force: true })
  }

  has(rel) {
    return existsSync(this.abs(rel))
  }

  /** File stats (size + mtimeMs) or undefined when missing. */
  stat(rel) {
    try {
      const s = statSync(this.abs(rel))
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return undefined
    }
  }

  /** All `.md` files under the root (recursive, relative paths, sorted). */
  walkMarkdown() {
    if (!existsSync(this.root)) return []
    return walkMarkdown(this.root)
  }
}

/** Depth-first `.md` collector; returns root-relative `/` paths. */
function walkMarkdown(dir) {
  const out = []
  const visit = (current, rel) => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      if (name.name.startsWith('.')) continue
      const childRel = rel === '' ? name.name : `${rel}/${name.name}`
      if (name.isDirectory()) visit(join(current, name.name), childRel)
      else if (name.name.endsWith('.md')) out.push(childRel)
    }
  }
  visit(dir, '')
  return out.sort()
}
