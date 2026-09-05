/**
 * Profile Builder（R5，Q030/Q037/Q044）：为 personal 记忆分配 profile_category，
 * 并反向补正历史未分类的 personal 记忆。
 *
 * 确定性优先：抽取器产生的 content 是正常化英文句子，以信号词前缀分类最可靠；
 * 对任意文本（backfill / 命令手动分类）再用关键词信号补强，避免模型依赖。
 */

import type { SqlDatabase } from "../store/sqlite.js";
import {
  listAllMemoryItems,
  updateMemoryItem,
} from "../store/repository.js";
import type { ProfileCategory } from "../schema/enums.js";

const PREFIX_RULES: ReadonlyArray<{
  prefix: string;
  category: ProfileCategory;
}> = [
  // 抽取规则 R3/R4 产生的偏好句。
  { prefix: "user prefers", category: "preference" },
  // 抽取规则 R1/R2 产生的“主要使用某工具”记为客观事实而非偏好。
  { prefix: "user mainly uses", category: "fact" },
];

const KEYWORD_RULES: ReadonlyArray<{
  pattern: RegExp;
  category: ProfileCategory;
}> = [
  // 高特异性短语优先：工作风格句子常同时含 prefer/like，需先于通用偏好捕获。
  { pattern: /working style|prefer to work|like to (?:work|start|write)|做事风格|工作方式/, category: "working_style" },
  // 约束：禁止/必须/先决条件类（Q080 的 constraint 语义）。
  { pattern: /must(?: not)?|never|don'?t|do not|cannot|can'?t|require|mustn'?t|禁止|不能|不要|必须先|必须/, category: "constraint" },
  // 偏好补强：含 prefer/favorite/like 的描述。
  { pattern: /prefer|favourite|favorite|喜欢|偏好|偏爱/, category: "preference" },
  // 目标：明确的追求/学习/达成意图。
  { pattern: /(?:my )?goal|aim|aiming|want(?:s|ed)? to (?:learn|become|build|reach)|目标|计划.*学|打算学/, category: "goal" },
  // 技能：已有能力陈述。
  { pattern: /skill|proficien|good at|experienced|擅长|熟练|掌握/, category: "skill" },
];

/**
 * 把一段 personal 记忆文本归入 profile_category。
 * @param content personal 记忆内容（抽取器产物为正常化英文，或用户句）
 * @returns 分类；无信号时退回 fact
 */
export function classifyProfile(content: string): ProfileCategory {
  const lower = content.trim().toLowerCase();
  for (const { prefix, category } of PREFIX_RULES) {
    if (lower.startsWith(prefix)) return category;
  }
  for (const { pattern, category } of KEYWORD_RULES) {
    if (pattern.test(lower)) return category;
  }
  return "fact";
}

/** 分类可被空引用安全使用的 profile 信号源。 */
export const PROFILE_CATEGORY_NAMES: ReadonlyArray<{ value: ProfileCategory; zh: string }> = [
  { value: "preference", zh: "偏好" },
  { value: "fact", zh: "事实" },
  { value: "skill", zh: "技能" },
  { value: "goal", zh: "目标" },
  { value: "constraint", zh: "约束" },
  { value: "working_style", zh: "工作风格" },
];

/**
 * 反向补正：为所有未分类的 personal 记忆分配 profile_category。
 * 走 updateMemoryItem 公共通道（version+1 / audit / event 全保留）。
 * @param actor 审计主体（默认 user——手动补正轨迹）
 * @returns 更新条数
 */
export function backfillProfileCategories(
  db: SqlDatabase,
  actor = "user",
): number {
  const targets = listAllMemoryItems(db).filter(
    (row) => row.type === "personal" && row.profileCategory === null,
  );
  for (const row of targets) {
    const category = classifyProfile(row.content);
    updateMemoryItem(db, row.id, { profileCategory: category }, actor);
  }
  return targets.length;
}
