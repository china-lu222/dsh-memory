/**
 * Auto Long-Term Memory — 敏感信息过滤（阶段 2）。
 *
 * 在候选抽取之前拦截 API key / token / 私钥 / 口令等凭据与个人敏感标识，
 * 只留 audit 轨迹（不含原文），不让敏感内容进入 memory store。
 * 判定是确定性规则（first match wins），不做 LLM 判断。
 */

import type { SensitiveVerdict } from "./types.js";

interface SensitiveRule {
  /** 规则名（audit 留痕）。 */
  name: string;
  /** 人类可读的拦截理由模板（%s 为命中片段长度）。 */
  reason: string;
  re: RegExp;
}

const RULES: SensitiveRule[] = [
  {
    name: "pem-private-key",
    reason: "embedded private key block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: "sk-secret",
    reason: "API secret token (sk-…)",
    re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{16,}\b/,
  },
  {
    name: "aws-access-key",
    reason: "AWS access key id",
    re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    name: "github-token",
    reason: "GitHub personal/installation token",
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  },
  {
    name: "slack-token",
    reason: "Slack bot/user/app token",
    re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/,
  },
  {
    name: "labeled-secret",
    reason: "labeled secret/password value",
    re:
      /(?:(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|私钥|密钥|密码|口令)\s*(?::|：|=|是|is\s+))[A-Za-z0-9._\-/+=]{8,}/,
  },
  {
    name: "personal-id-number",
    reason: "personal identification / card number",
    re:
      /(?:身份证|id\s*card|ssn|credit\s*c?ard|银行卡)\s*[:：=]?\s*[0-9][0-9\s\-]{11,}/,
  },
];

/**
 * 检查输入是否包含敏感信息。
 * @param text 原始输入文本（未归一化；PEM 规则需保留换行）
 */
export function checkSensitive(text: string): SensitiveVerdict {
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m !== null) {
      return {
        blocked: true,
        rule: rule.name,
        reason: `${rule.reason} (matched ${m[0].length} chars)`,
      };
    }
  }
  return { blocked: false };
}
