/**
 * Auto Long-Term Memory — 内容分类（阶段 2）。
 *
 * 对「remember 整句」或规则候选做确定性 type 分类与瞬时判定：
 * 项目语境 → project_knowledge；用户自述/偏好 → personal；
 * 技术上下文中的失败/报错 → negative；无信号则默认 personal。
 * 不猜测、不引入阶段 2 不存在的枚举值；判定依据只在可见文本。
 */

import type { ClassifyVerdict } from "./types.js";

const TRANSIENT =
  /^(?:目前|现在|当前|暂时|临时|这会儿|此刻|right now|currently|for now|at the moment|as of now|status\s+right\s+now)\b/i;

const SELF_PREFIX = /^(?:i|my|me|we|our|us)\b|^(?:我|我们|本人|我的)/i;
const PREFERENCE = /(?:prefer(?:s|red)?|favorite|favourite|like to|喜欢|偏好|偏爱|主要用|常用|最爱|喜欢用|习惯用|倾向)/i;

const PROJECT_FRAME =
  /(?:本项目|该项目|我们项目|工作项目|公司项目|repo|repository|codebase|代码库|仓库|the (?:project|application|service|api|plugin|app|platform)|our (?:project|application|service|api|plugin|app|platform|team|stack|codebase|repo))/i;

const TECH =
  /(?:npm|pnpm|yarn|node\b|bun\b|deno\b|typescript|tsc\b|python|docker|react\b|vue\b|rust\b|sqlite|postgres|mysql|redis|linux|windows|macos|kubernetes|\bci\b|\bcd\b|deploy|部署|构建|build|编译|依赖|dependency|架构|architecture|schema|database|数据库|接口|api\b|endpoint|server|服务|framework|框架|library|插件|plugin|编译器|editor\b|ide\b|测试|test|lint|调试|debug|版本|version|配置|config)/i;

const NEGATION =
  /(?:失败|报错|error|bug|exception|异常|堆栈|broken|fail\w*|cannot|can'?t|must\s+not|mustn'?t|不要|禁止|不能|拒绝|avoid|never|坑|踩坑|问题)/i;

/**
 * 对内容做 type/瞬时分类。
 * @param text 归一化后的单条事实内容
 */
export function classifyContent(text: string): ClassifyVerdict {
  const t = text.replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();
  if (t.length === 0) {
    return { type: "personal", signal: "empty content", transient: false };
  }
  if (TRANSIENT.test(lower)) {
    return { type: "personal", signal: "transient state statement", transient: true };
  }
  // 用户自述/偏好优先于技术词（“我用 React 写前端”仍是 personal）。
  if (SELF_PREFIX.test(lower) && (PREFERENCE.test(lower) || NEGATION.test(lower))) {
    return {
      type: "personal",
      signal: SELF_PREFIX.test(lower) && NEGATION.test(lower) ? "self constraint statement" : "self preference statement",
      transient: false,
    };
  }
  // 技术上下文中的失败经验。
  if (NEGATION.test(lower) && TECH.test(lower)) {
    return { type: "negative", signal: "technical failure statement", transient: false };
  }
  if (PROJECT_FRAME.test(lower) || TECH.test(lower)) {
    return { type: "project_knowledge", signal: "project or technical context", transient: false };
  }
  if (SELF_PREFIX.test(lower)) {
    return { type: "personal", signal: "self factual statement", transient: false };
  }
  return { type: "personal", signal: "default personal fact", transient: false };
}
