/**
 * Extractor：确定性提取规则，把一条用户自述变成候选记忆。
 *
 * Accuracy-first：只在显式自述（“我用 X” / “my favorite editor is X”）触发，
 * 不从“可能/大概”猜测，不把项目话语当个人偏好；每条命中附带原句 quote。
 * 规则逐句互斥（first match wins），同一自述只产出一条候选。
 *
 * R2 版本把 legacy 的 kind='profile' 对齐到 TS Schema 的 type='personal'。
 */

import type { MemoryType } from "../schema/enums.js";

export interface ExtractionCandidate {
  type: MemoryType;
  content: string;
  summary?: string;
  quote: string;
  confidence: number;
}

const EN_STOP_WORDS = new Set([
  "for", "as", "on", "in", "to", "and", "with", "because", "when", "but",
  "not", "via", "using", "mainly", "mostly", "also", "my", "is", "are", "the",
]);

/** 剔除明显不是具体技术/名称的短语。 */
function cleanTechPhrase(phrase: string): string | null {
  const cut = phrase.trim().split(/[。，、；,;.!！?？:：]/)[0]!.trim();
  if (cut.length < 1) return null;
  if (/^(?:就是|一下|的了|的|这个|那个|它|什么|哪个|着|写代码|做开发|干活|那|这些|那些)$/.test(cut)) return null;
  if (/^的/.test(cut)) return null;
  if (cut.length > 80) return null;
  return cut;
}

/** 取 rest 前导 token 直到第一个英文停用词。 */
function takeTechTokens(rest: string): string | null {
  const tokens = rest.trim().split(/\s+/);
  const parts: string[] = [];
  for (const token of tokens) {
    const clean = token
      .replace(/^[,.;:!?，。！？]+/, "")
      .replace(/[.。,;:!！?？]+$/, "")
      .trim();
    if (clean.length === 0) continue;
    if (EN_STOP_WORDS.has(clean.toLowerCase())) break;
    parts.push(token);
  }
  return cleanTechPhrase(parts.join(" "));
}

/** R1 (zh): 我(主要|平时…)用 X… */
function ruleChineseUserUses(sentence: string): ExtractionCandidate | null {
  const m = /^我(?:主要|平时|平常|日常|一般|经常|一直|工作里|项目里|写代码时)?(?:都)?用(?<tech>.+)$/.exec(sentence);
  if (!m) return null;
  const tech = cleanTechPhrase(m.groups?.tech ?? "");
  if (!tech || tech.length < 2) return null;
  return { type: "personal", content: `User mainly uses ${tech}`, summary: `主要使用 ${tech}`, quote: sentence, confidence: 0.9 };
}

/** R2 (en): I (mainly|…) use X. */
function ruleEnglishUserUses(sentence: string): ExtractionCandidate | null {
  const m = /^\s*I\s+(?:mainly|mostly|primarily|usually|always|sometimes)?\s*(?:use|work\s+with|code\s+in)\s+(?<rest>.+)$/i.exec(sentence);
  if (!m) return null;
  const tech = takeTechTokens(m.groups?.rest ?? "");
  if (!tech) return null;
  return { type: "personal", content: `User mainly uses ${tech}`, summary: `Mainly uses ${tech}`, quote: sentence, confidence: 0.9 };
}

/** R3 (zh): 我(最)喜欢/偏爱/偏好 [的] X. */
function ruleChinesePreference(sentence: string): ExtractionCandidate | null {
  const m = /^我(?:的)?(?:最)?(?:喜欢|偏爱|偏好)(?:的)?(?<what>编程语言|语言|编辑器|框架|工具|IDE|操作系统|技术栈)?(?:是|为)?[:：]?\s*(?<tech>.+)$/.exec(sentence);
  if (!m) return null;
  const tech = cleanTechPhrase(m.groups?.tech ?? "");
  if (!tech || tech.length < 1) return null;
  const whatRaw = m.groups?.what?.trim();
  const whatLabel = whatRaw
    ? ({ 编程语言: "programming language", 语言: "language", 编辑器: "editor", 框架: "framework", 工具: "tool", IDE: "IDE", 操作系统: "operating system", 技术栈: "technology stack" } as Record<string, string>)[whatRaw] ?? whatRaw
    : "technology";
  const summary = whatRaw ? `偏好${whatRaw} ${tech}` : `偏好 ${tech}`;
  return { type: "personal", content: `User prefers ${whatLabel} ${tech}`, summary, quote: sentence, confidence: 0.9 };
}

/** R4 (en): my favorite/preferred X is Y | I prefer Y as my X. */
function ruleEnglishPreference(sentence: string): ExtractionCandidate | null {
  const whatNames = "(?<what>programming language|language|editor|text editor|framework|tool|ide|operating system|os|stack)";
  const m = new RegExp(`^\\s*my\\s+(?:favourite|favorite|preferred|main|primary)\\s+${whatNames}\\s+is\\s+(?<tech>.+)$`, "i").exec(sentence);
  if (m) {
    const tech = cleanTechPhrase(m.groups?.tech ?? "");
    const what = (m.groups?.what ?? "tool").toLowerCase();
    if (tech) return { type: "personal", content: `User prefers ${what} ${tech}`, summary: `Prefers ${what}: ${tech}`, quote: sentence, confidence: 0.9 };
  }
  const m2 = /^\s*I\s+(?:really\s+)?prefer\s+(?<tech>[A-Za-z0-9+#.]+(?:\s+[A-Za-z0-9+#.]+)*?)\s+as\s+my\s+(?<what>editor|text editor|language|programming language|tool|ide|operating system|os)\s*[.,;:]?$/i.exec(sentence);
  if (m2) {
    const tech = cleanTechPhrase(m2.groups?.tech ?? "");
    const what = (m2.groups?.what ?? "editor").toLowerCase();
    if (tech) return { type: "personal", content: `User prefers ${what} ${tech}`, summary: `Prefers ${what}: ${tech}`, quote: sentence, confidence: 0.9 };
  }
  return null;
}

const RULES = [
  ruleChinesePreference,
  ruleChineseUserUses,
  ruleEnglishPreference,
  ruleEnglishUserUses,
];

/**
 * 对一段用户文本逐句运行有序规则，返回候选（逐句互斥短路，
 * 同 content 去重）。
 */
export function extractCandidates(text: string): ExtractionCandidate[] {
  const out: ExtractionCandidate[] = [];
  const lines = text.split(/\n+/).filter((l) => l.trim().length > 0);
  for (const line of lines.slice(0, 20)) {
    const sentence = line.trim();
    if (sentence.length > 300) continue;
    for (const rule of RULES) {
      try {
        const hit = rule(sentence);
        if (!hit) continue;
        if (out.some((c) => c.content === hit.content)) continue;
        out.push(hit);
        break;
      } catch {
        // 单条规则异常不阻断摄取热路径。
      }
    }
  }
  return out;
}
