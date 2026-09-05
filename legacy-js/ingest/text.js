// dsh-memory-personal — tolerant text extraction from DSH content-block messages.
//
// The plugin deliberately does NOT import @deepseek-ai/dsh-llm: it reads the
// event payload it is handed and walks content blocks defensively (unknown
// block types are skipped, nested tool-result content is visited). This keeps
// the store decoupled from the exact core type while never dropping text it
// can recognize.

/** Walk content blocks and return their visible text joined by newlines. */
export function extractMessageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const type = block.type
    switch (type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
        break
      case 'reasoning':
        // Reasoning is model-internal thought; it is not a user-visible
        // statement and never becomes memory content.
        break
      case 'tool-result': {
        if (Array.isArray(block.content)) {
          const nested = extractMessageText({ content: block.content })
          if (nested.length > 0) parts.push(nested)
        }
        break
      }
      case 'tool-call':
      case 'image':
      default:
        // Unrecognized / non-text blocks carry no plain text worth memorizing.
        break
    }
  }
  return parts.join('\n')
}

/**
 * Collapse a user-facing line for transcript storage: whitespace-normalized,
 * bounded. Keeps the transcript column small.
 * @param {string} text - source line.
 * @param {number} [max=2000] - max chars kept.
 * @returns {string}
 */
export function collapseLine(text, max = 2000) {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max)}…`
}
