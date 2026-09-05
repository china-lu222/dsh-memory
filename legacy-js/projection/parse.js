// Markdown → store parsing: the inverse of render.js.
//
// Aggregate buckets are bullet lists; each bullet may carry a stable identity
// marker rendered by the projector: `- {text} <!--mem:{id}-->`. User-added
// bullets have no marker and become new memories; bullets whose marker
// disappears mean the record was deleted; a changed text keeps its id and is
// applied as a user edit.
//
// Entry files (experiences, sessions) are single records: everything the store
// needs to round-trip lives in their frontmatter plus the `## Details` body.

import { parseFrontmatter } from './markdown.js'

/** Marker suffix rendered on aggregate bullets: `<!--mem:mem_x-->`. */
export const MEMBER_MARKER = /<!--mem:([A-Za-z0-9._-]+)-->\s*$/

/** @typedef {{ bullet: string, memoryId?: string }} BulletEntry */

/**
 * Split a text line into (bullet content, marker id). The marker never leaks
 * into stored content.
 * @param {string} line - a `- ...` list line from an aggregate file.
 * @returns {BulletEntry | undefined}
 */
export function parseBullet(line) {
  const match = /^-\s+(.*)$/.exec(line.trimEnd())
  if (!match) return undefined
  const marker = MEMBER_MARKER.exec(match[1])
  if (!marker) return { bullet: match[1].trim(), memoryId: undefined }
  const text = match[1].slice(0, marker.index).trimEnd()
  return { bullet: text, memoryId: marker[1] }
}

/**
 * All user-facing bullets in an aggregate body (skips the HTML comment footer,
 * headings and blank lines).
 * @param {string} text - full aggregate file content.
 * @returns {BulletEntry[]}
 */
export function aggregateBullets(text) {
  const { body } = parseFrontmatter(text)
  /** @type {BulletEntry[]} */
  const bullets = []
  for (const rawLine of body.split(/\r?\n/)) {
    const entry = parseBullet(rawLine)
    if (entry === undefined) continue
    if (entry.bullet.startsWith('<!--') || entry.bullet.includes('dsh-memory projection')) continue
    bullets.push(entry)
  }
  return bullets
}

/**
 * Extract store-visible fields from an entry file: frontmatter metadata plus
 * the `## Details` passage. Unknown or malformed values fall back to the file
 * identity only; the caller decides what a missing body means.
 * @param {string} text - full entry file content.
 * @returns {{ meta: Record<string, unknown>, content?: string, summary?: string }}
 */
export function parseEntry(text) {
  const { meta, body } = parseFrontmatter(text)
  const content = section(body, '## Details')
  const summary = section(body, '## Summary')
  return { meta, content, summary }
}

/** Text of a Markdown `## Section` up to the next heading / footer. */
function section(body, heading) {
  const marker = new RegExp(`^${heading}\\s*$`, 'm')
  const match = marker.exec(body)
  if (!match) return undefined
  const rest = body.slice(match.index + match[0].length)
  const next = /^#{1,6}\s/m.exec(rest.replace(/^\s*\r?\n/, ''))
  const segment = next ? rest.slice(0, rest.indexOf(next[0])) : rest
  return segment.replace(/\s*<!--[\s\S]*-->\s*$/, '').trim() || undefined
}

/**
 * Coerce a parsed scalar into the YAML-subset type used by the projector.
 * @param {unknown} value
 * @returns {string | number | boolean | undefined}
 */
export function scalarValue(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return undefined
}
