// dsh-memory-personal — deterministic extraction rules that turn a user statement into
// a candidate memory fact.
//
// Accuracy-first: these rules only fire on EXPLICIT self-statements ("我用
// TypeScript", "my favorite editor is X"). They never guess from "probably",
// never treat project chatter as a personal profile fact, and always attach
// the exact quoted sentence as evidence. Rules are MUTUALLY EXCLUSIVE per
// sentence (first match wins), so a single self-statement yields a single
// memory, never duplicates.

/**
 * One matched extraction candidate.
 * @typedef {{
 *   kind: 'profile' | 'fact',
 *   content: string,
 *   summary?: string,
 *   quote: string,
 *   confidence: number,
 * }} ExtractionCandidate
 */

/** English filler words that terminate a tech/name phrase. */
const EN_STOP_WORDS = new Set([
  'for', 'as', 'on', 'in', 'to', 'and', 'with', 'because', 'when', 'but',
  'not', 'via', 'using', 'mainly', 'mostly', 'also', 'my', 'is', 'are', 'the',
])

/** Reject phrases that are clearly not a concrete technology/name. */
function cleanTechPhrase(phrase) {
  // A tech phrase ends at the first sentence punctuation in either script:
  // "TypeScript，平时也写…" → "TypeScript", "Rust for my backend." → "Rust…"
  // is handled by takeTechTokens before reaching here.
  const cut = phrase.trim().split(/[。，、；,;.!！?？:：]/)[0].trim()
  if (cut.length < 1) return null
  // Pure demonstratives / filler ("就是", "的那个", "这个") are never memory.
  if (/^(?:就是|一下|的了|的|这个|那个|它|什么|哪个|着|写代码|做开发|干活|那|这些|那些)$/.test(cut)) return null
  if (/^的/.test(cut)) return null
  // Tech phrases are short; refuse sentence fragments.
  if (cut.length > 80) return null
  return cut
}

/** Take the leading tokens of `rest` up to the first English stop word. */
function takeTechTokens(rest) {
  const tokens = rest.trim().split(/\s+/)
  const parts = []
  for (const token of tokens) {
    const clean = token.replace(/^[,.;:!?，。！？]+/, '').replace(/[.。,;:!！?？]+$/, '').trim()
    if (clean.length === 0) continue
    if (EN_STOP_WORDS.has(clean.toLowerCase())) break
    parts.push(token)
  }
  return cleanTechPhrase(parts.join(' '))
}

// ---- ordered rules (first match wins per sentence) -------------------------

/** R1 (zh): 我(主要|平时…)用 X… */
function ruleChineseUserUses(sentence) {
  const m = /^我(?:主要|平时|平常|日常|一般|经常|一直|工作里|项目里|写代码时)?(?:都)?用(?<tech>.+)$/.exec(sentence)
  if (!m) return null
  const tech = cleanTechPhrase(m.groups?.tech ?? '')
  if (!tech || tech.length < 2) return null
  return { kind: 'profile', content: `User mainly uses ${tech}`, summary: `主要使用 ${tech}` }
}

/** R2 (en): I (mainly|…) use X, X bounded by English stop words. */
function ruleEnglishUserUses(sentence) {
  const m = /^\s*I\s+(?:mainly|mostly|primarily|usually|always|sometimes)?\s*(?:use|work\s+with|code\s+in)\s+(?<rest>.+)$/i.exec(sentence)
  if (!m) return null
  const tech = takeTechTokens(m.groups?.rest ?? '')
  if (!tech) return null
  return { kind: 'profile', content: `User mainly uses ${tech}`, summary: `Mainly uses ${tech}` }
}

/** R3 (zh): 我(最)喜欢/偏爱/偏好 [的] X [编辑器/语言] */
function ruleChinesePreference(sentence) {
  const m = /^我(?:的)?(?:最)?(?:喜欢|偏爱|偏好)(?:的)?(?<what>编程语言|语言|编辑器|框架|工具|IDE|操作系统|技术栈)?(?:是|为)?[:：]?\s*(?<tech>.+)$/.exec(sentence)
  if (!m) return null
  const tech = cleanTechPhrase(m.groups?.tech ?? '')
  if (!tech || tech.length < 1) return null
  const whatRaw = m.groups?.what?.trim()
  const whatLabel = whatRaw
    ? ({ 编程语言: 'programming language', 语言: 'language', 编辑器: 'editor', 框架: 'framework', 工具: 'tool', IDE: 'IDE', 操作系统: 'operating system', 技术栈: 'technology stack' })[whatRaw] ?? whatRaw
    : 'technology'
  const summary = whatRaw ? `偏好${whatRaw} ${tech}` : `偏好 ${tech}`
  return { kind: 'profile', content: `User prefers ${whatLabel} ${tech}`, summary }
}

/** R4 (en): my favorite/preferred X is Y | I prefer Y as my X */
function ruleEnglishPreference(sentence) {
  const whatNames = '(?<what>programming language|language|editor|text editor|framework|tool|ide|operating system|os|stack)'
  const m = new RegExp(`^\\s*my\\s+(?:favourite|favorite|preferred|main|primary)\\s+${whatNames}\\s+is\\s+(?<tech>.+)$`, 'i').exec(sentence)
  if (m) {
    const tech = cleanTechPhrase(m.groups?.tech ?? '')
    const what = (m.groups?.what ?? 'tool').toLowerCase()
    if (tech) return { kind: 'profile', content: `User prefers ${what} ${tech}`, summary: `Prefers ${what}: ${tech}` }
  }
  const m2 = /^\s*I\s+(?:really\s+)?prefer\s+(?<tech>[A-Za-z0-9+#.]+(?:\s+[A-Za-z0-9+#.]+)*?)\s+as\s+my\s+(?<what>editor|text editor|language|programming language|tool|ide|operating system|os)\s*[.,;:]?$/i.exec(sentence)
  if (m2) {
    const tech = cleanTechPhrase(m2.groups?.tech ?? '')
    const what = (m2.groups?.what ?? 'editor').toLowerCase()
    if (tech) return { kind: 'profile', content: `User prefers ${what} ${tech}`, summary: `Prefers ${what}: ${tech}` }
  }
  return null
}

const RULES = [
  ruleChinesePreference,
  ruleChineseUserUses,
  ruleEnglishPreference,
  ruleEnglishUserUses,
]

/**
 * Run the ordered rules against one user utterance. Returns at most one hit
 * per line (mutually exclusive short-circuit); identical content never repeats.
 * @param {string} text - the user message text.
 * @returns {ExtractionCandidate[]}
 */
export function extractCandidates(text) {
  const out = []
  const lines = text.split(/\n+/).filter((l) => l.trim().length > 0)
  for (const line of lines.slice(0, 20)) {
    const sentence = line.trim()
    if (sentence.length > 300) continue
    for (const rule of RULES) {
      try {
        const hit = rule(sentence)
        if (!hit) continue
        if (out.some((c) => c.content === hit.content)) continue
        out.push({ ...hit, quote: sentence, confidence: 0.9 })
        break
      } catch {
        // A misbehaving rule must never break the ingest hot path.
      }
    }
  }
  return out
}
