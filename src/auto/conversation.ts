/**
 * Auto Long-Term Memory — 会话事实规则（R8.1 阶段 1）。
 *
 * ingest 规则只覆盖「个人自述」（我使用 X / 我偏好 X）。真实聊天里同样值得长期
 * 保留的还有显式断言的技术事实与失败经验：项目/服务/模块构成、错误归因、
 * 「不支持/不兼容」这类约束。本模块按与 ingest 相同的口径补足它们：
 * 逐句、按序 first match wins、只认显式断言，不猜测、不从问句或指令里推断。
 *
 * 精度约束：
 *  - 已被 ingest 规则命中的句子不再产出（避免同句两条近似记忆）；
 *  - classifier 判定瞬时（transient）的句子丢弃；
 *  - 以第一人称起句的句子留给 ingest 个人规则，本模块不重复判定。
 */

import { extractCandidates } from "../ingest/rules.js";
import { collapseLine } from "../ingest/text.js";
import type { MemoryType } from "../schema/enums.js";
import { classifyContent } from "./classifier.js";
import type { AutoCandidate } from "./types.js";

/** 会话事实规则：命中即产出候选（content 保留原句，可核对）。 */
interface ConversationRule {
  /** 规则名（诊断与测试断言用）。 */
  readonly name: string;
  readonly pattern: RegExp;
  /** 规则声明的记忆类型；classifier 判定 negative 时以 negative 为准。 */
  readonly type: MemoryType;
  /** 规则初始置信（0–1）。 */
  readonly baseConfidence: number;
  /** 跳过以第一人称起句的句子（留给 ingest 个人规则）。 */
  readonly skipFirstPerson: boolean;
}

/** 内容/摘要长度上限（与 ingest 规则口径一致）。 */
const MAX_CONTENT = 300;
const MAX_SUMMARY = 180;
/** 低于该长度的句子不足以构成可核对事实。 */
const MIN_CHARS = 6;

const FIRST_PERSON = /^(?:我|我的|我们|本人|自己|i\b|my\b|we\b|our\b)/i;
const QUESTION = /[?？]\s*$/;
const INTERROGATIVE =
  /^(?:请帮我|帮我|能不能|可不可以|是否|如何|怎么|为什么|什么是|哪(?:个|些)|who|what|how|why|where|which|can you|could you)/i;

/** 项目/系统断言的显式主语框架（中英各一），避免把泛指句子当项目事实。 */
const PROJECT_SUBJECT =
  /^(?:(?:本|这|该|我们|我司)(?:个|台|套|款)?(?:项目|服务|系统|模块|应用|仓库|代码库|插件|平台|数据库|接口|服务端|客户端|网关|组件|脚本|表)|(?:this|the|our)\s+(?:project|service|system|module|app|application|repo|repository|codebase|plugin|platform|database|api|endpoint|server|client|gateway|component|script)\b)/i;

const RULES: readonly ConversationRule[] = [
  {
    name: "prohibition",
    pattern:
      /^(?:不要|禁止|严禁|请勿|切勿|千万别|千万不要|避免|别再|以后不要|不能)|^(?:do\s+not|don'?t|never|avoid|must\s+not)\b/i,
    type: "negative",
    baseConfidence: 0.85,
    skipFirstPerson: false,
  },
  {
    name: "failure-attribution",
    pattern:
      /(?:原因(?:是|在于|为)?|是因为|根因|because\s+of|caused\s+by|due\s+to|root\s+cause)/i,
    type: "negative",
    baseConfidence: 0.85,
    skipFirstPerson: true,
  },
  {
    name: "unsupported-limit",
    pattern: /(?:不兼容|不支持|无法|不可用|no\s+longer\s+support)/i,
    type: "negative",
    baseConfidence: 0.8,
    skipFirstPerson: true,
  },
  {
    name: "project-fact",
    pattern: PROJECT_SUBJECT,
    type: "project_knowledge",
    baseConfidence: 0.85,
    skipFirstPerson: true,
  },
  {
    name: "future-default",
    pattern:
      /^(?:以后|今后|后续|接下来|从今|默认|请默认|之后)\s*[^\s，,。！？!?]{0,12}?\s*(?:都|一律|统一|默认|优先)?\s*(?:使用|用|采用|走|选择)/,
    type: "personal",
    baseConfidence: 0.8,
    skipFirstPerson: false,
  },
  {
    name: "future-work-rule",
    pattern: /^(?:以后|今后|后续|接下来)(?:遇到|再遇到|碰到|如果|凡是|每次|优先)/,
    type: "personal",
    baseConfidence: 0.8,
    skipFirstPerson: false,
  },
];

/** 首条命中规则；无命中返回 null。 */
function matchRule(sentence: string): ConversationRule | null {
  if (sentence.length < MIN_CHARS) return null;
  if (QUESTION.test(sentence) || INTERROGATIVE.test(sentence)) return null;
  for (const rule of RULES) {
    if (rule.skipFirstPerson && FIRST_PERSON.test(sentence)) continue;
    if (rule.pattern.test(sentence)) return rule;
  }
  return null;
}

/**
 * 抽取会话中的技术事实与失败经验候选（不含 ingest 个人自述，两者不重叠）。
 * @param text 会话消息文本（换行分段）
 * @returns 候选列表；同 content 去重，已被 ingest 规则命中的句子跳过
 */
export function extractConversationFacts(text: string): AutoCandidate[] {
  const claimed = new Set(extractCandidates(text).map((hit) => hit.quote.trim()));
  const out: AutoCandidate[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\n+/).slice(0, 20)) {
    const sentence = line.trim();
    if (sentence.length === 0 || claimed.has(sentence)) continue;
    const rule = matchRule(sentence);
    if (rule === null) continue;
    const verdict = classifyContent(sentence);
    if (verdict.transient) continue;
    const content = collapseLine(sentence, MAX_CONTENT);
    if (content.length === 0 || seen.has(content)) continue;
    seen.add(content);
    out.push({
      type: verdict.type === "negative" ? "negative" : rule.type,
      content,
      summary: collapseLine(sentence, MAX_SUMMARY),
      baseConfidence: rule.baseConfidence,
      quote: sentence,
    });
  }
  return out;
}
