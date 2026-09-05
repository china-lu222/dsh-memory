/**
 * Error Intelligence（R5，Q053–Q056，Q063）。
 *  - 分类：确定性规则（无 LLM），从错误文本/命令输出识别类别与信号词；
 *  - 检索：信号词在 experience 记忆上做 token 匹配；
 *  - 分层建议：Q56 四档 Recommendation Tier，Applicability 由
 *    命中强度 + experience_phase 决定（verified/validated 可信档、其余降档）；
 *  - 诊断顺序：类别对应的无模型排查步骤。
 */

import type { SqlDatabase } from "../store/sqlite.js";
import { listAllMemoryItems } from "../store/repository.js";
import type {
  ErrorCategory,
  ExperiencePhase,
  RecommendationTier,
} from "../schema/enums.js";

const SIGNALS: ReadonlyArray<{ category: ErrorCategory; pattern: RegExp }> = [
  { category: "memory", pattern: /out of memory|heap|allocation failed|segmentation fault|asan/ },
  { category: "timeout", pattern: /timed? ?out|timeout|deadline exceeded|ETIMEDOUT/ },
  { category: "dependency", pattern: /no module named|module not found|not installed|cannot find module|could not resolve|could not find|eresolve|missing dependency|依赖|缺少.*包/ },
  { category: "import", pattern: /import.*(fail|error)|export.*not found|could not (?:resolve|find) ['"][^'"]+['"]/ },
  { category: "database", pattern: /sqlite|sqlstate|no such table|duplicate key|database is locked|postgres|mysql|syntax error in sql|数据库/ },
  { category: "network", pattern: /econnrefused|enotfound|getaddrinfo|socket hang up|fetch failed|network|连接失败|offline|unreachable/ },
  { category: "permission", pattern: /eacces|eperm|permission denied|access is denied|chmod|权限/ },
  { category: "shell", pattern: /command not found|not recognized|spawn .*enoent|找不到.*命令/ },
  { category: "type", pattern: /type error|ts(?:2[0-9]{3})|not assignable|typescript|类型不匹配/ },
  { category: "syntax", pattern: /syntaxerror|unexpected token|invalid syntax|unexpected character|语法错误/ },
  { category: "compile", pattern: /failed to compile|compiler|tsc |transpil|build failed|编译失败/ },
  { category: "build", pattern: /build error|rollup|vite build|webpack.*fail|esbuild/ },
  { category: "test", pattern: /test suite|vitest|jest|failed to run|expect\(|测试失败/ },
  { category: "lint", pattern: /eslint|prettier|lint/ },
  { category: "config", pattern: /invalid.*(json|yaml|toml|config)|\.yaml|\.toml|configuration error|配置/ },
  { category: "runtime", pattern: /unhandled|referenceerror|typeerror|at .*\.(js|ts|mjs|py):/ },
];

const STOPWORDS = new Set([
  "the", "and", "for", "with", "was", "are", "not", "but", "you", "your",
  "this", "that", "from", "have", "been", "has", "had", "will", "would",
  "error", "errors", "exception", "failed", "failure", "fail", "check",
  "please", "when", "what", "into", "should", "more", "out", "some",
]);

/** 从错误文本提取低噪声信号词（模块名/标识符优先）。 */
export function extractSignalTerms(text: string): string[] {
  const raw = (text.match(/[A-Za-z][A-Za-z0-9_./-]{2,}/g) ?? [])
    .map((t) => t.toLowerCase())
    .filter((t) => !STOPWORDS.has(t.split("/")[0]!))
    .map((t) => t.replace(/^[./-]+/, "").replace(/[./-]+$/, ""));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (t.length >= 3 && t.length <= 40 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= 6) break;
  }
  return out;
}

/** 分类错误文本；返回 category 与首行信号。 */
export function classifyError(text: string): {
  category: ErrorCategory;
  signal: string;
} {
  const signal =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.slice(0, 160) ?? "";
  for (const { category, pattern } of SIGNALS) {
    if (pattern.test(text)) return { category, signal };
  }
  return { category: "other", signal };
}

export interface AdviceMatch {
  id: string;
  summary: string;
  tier: RecommendationTier;
  ratio: number;
  phase: ExperiencePhase | null;
  projectId: string | null;
}

export interface ErrorAdvice {
  category: ErrorCategory;
  signal: string;
  terms: string[];
  diagnosisOrder: string[];
  matches: AdviceMatch[];
}

/** 各错误类别的基础排查步骤（无模型模板；经验命中作为可操作细节补充）。 */
export function diagnosisOrderFor(category: ErrorCategory): string[] {
  const steps: Record<ErrorCategory, string[]> = {
    build: ["复现最小构建命令", "对比最近通过的构建配置", "清理缓存后重建"],
    runtime: ["取完整堆栈首帧", "确认触发路径与最近改动", "在最小样例中复现"],
    compile: ["读取第一条编译器错误", "检查类型签名与导入", "分段注释定位"],
    syntax: ["定位第一个语法错误行", "检查括号/引号配对", "用 formatter 修复"],
    import: ["确认目标模块存在与导出名", "检查相对路径与扩展名", "验证打包/运行环境解析规则"],
    module: ["检查模块安装与版本", "确认入口字段与 exports 映射", "对比 lockfile 状态"],
    network: ["本地连通性测试", "检查代理/DNS/证书", "确认目标服务可达与限流"],
    dependency: ["检查依赖是否声明", "核对版本冲突与 lockfile", "在干净环境重装"],
    test: ["定位首个失败断言", "隔离该用例复现", "检查测试环境差异"],
    lint: ["按规则定位违规代码", "查看规则文档的修复建议", "必要时调整规则配置"],
    shell: ["确认命令存在于 PATH", "检查可执行位与调用路径", "以绝对路径复现"],
    database: ["检查连接串与库状态", "核对表结构与迁移版本", "单独执行该 SQL 复现"],
    config: ["校验配置语法与必填项", "对照示例配置逐项检查", "确认加载的配置文件路径"],
    permission: ["检查文件/目录权限位", "确认运行账号角色", "最小化所需权限后放行"],
    memory: ["确认进程内存上限", "定位增长点与引用泄漏", "分批处理降低峰值"],
    timeout: ["检查超时配置与重试", "确认远端处理耗时", "分片或异步化规避"],
    type: ["读取类型不匹配的两端", "收窄联合/泛型边界", "必要时显式标注"],
    other: ["提取完整错误与上下文", "搜索同类别已知案例", "在最小样例复现后再解决"],
  };
  return steps[category];
}

/**
 * 对给定错误给出分层建议（Q56 四档）。
 * 经验 phase 决定可信档：verified/validated 全档适用；solution-found 降一档；
 * candidate/investigating 仅 possible-low-confidence；
 * 归档（historical）单独归入 historical-failure。
 */
export function recommendExperiences(
  db: SqlDatabase,
  errorText: string,
  opts: { projectId?: string; limit?: number } = {},
): ErrorAdvice {
  const { category, signal } = classifyError(errorText);
  const terms = extractSignalTerms(errorText);
  const matches: AdviceMatch[] = [];
  if (terms.length > 0) {
    const experiences = listAllMemoryItems(db).filter(
      (row) => row.type === "experience" && row.hidden === 0,
    );
    for (const exp of experiences) {
      if (opts.projectId !== undefined && exp.projectId !== opts.projectId) {
        continue;
      }
      const tokens = new Set(
        `${exp.content} ${exp.summary ?? ""}`
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 3),
      );
      if (tokens.size === 0) continue;
      const hits = terms.filter((t) => tokens.has(t)).length;
      const ratio = hits / terms.length;
      if (ratio < 0.3) continue;
      const phase = exp.experiencePhase;
      let tier: RecommendationTier;
      if (exp.temporalState === "historical") {
        tier = "historical-failure";
      } else if (
        (phase === "verified" || phase === "validated") &&
        ratio >= 0.6
      ) {
        tier = "verified-highly-applicable";
      } else if (
        (phase === "verified" || phase === "validated") ||
        (phase === "solution-found" && ratio >= 0.6)
      ) {
        tier = "verified-conditional";
      } else {
        tier = "possible-low-confidence";
      }
      matches.push({
        id: exp.id,
        summary: exp.content,
        tier,
        ratio,
        phase,
        projectId: exp.projectId,
      });
    }
  }
  const tierOrder: Record<RecommendationTier, number> = {
    "verified-highly-applicable": 0,
    "verified-conditional": 1,
    "possible-low-confidence": 2,
    "historical-failure": 3,
  };
  matches.sort(
    (x, y) => tierOrder[x.tier] - tierOrder[y.tier] || y.ratio - x.ratio,
  );
  const limit = opts.limit ?? 5;
  return {
    category,
    signal,
    terms,
    diagnosisOrder: diagnosisOrderFor(category),
    matches: matches.slice(0, limit),
  };
}
