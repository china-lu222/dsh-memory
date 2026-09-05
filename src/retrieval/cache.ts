/**
 * Query embedding 缓存（R4）。
 * 键含 retrievalVersion + modelId + dimension + 文本摘要：
 *   - 检索链路自身版本升级即失效；
 *   - embedding 模型/维度变化即失效（与向量索引重建规则一致）。
 */

import { createHash } from "node:crypto";

/** 检索链路语义版本：改变缓存/索引兼容判断时递增。 */
export const RETRIEVAL_VERSION = "r4-hybrid-v1";

export interface EmbeddingCache {
  get(text: string, modelId: string, dimension: number): number[] | undefined;
  set(text: string, modelId: string, dimension: number, vector: number[]): void;
  readonly hits: number;
  readonly misses: number;
  clear(): void;
}

function cacheKey(text: string, modelId: string, dimension: number): string {
  const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
  return `${RETRIEVAL_VERSION}:${modelId}:${dimension}:${digest}`;
}

/** 进程内 LRU embedding 缓存。 */
export class LruEmbeddingCache implements EmbeddingCache {
  private readonly capacity: number;
  private readonly map = new Map<string, number[]>();
  private hitCount = 0;
  private missCount = 0;

  constructor(capacity = 256) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }

  get(text: string, modelId: string, dimension: number): number[] | undefined {
    const key = cacheKey(text, modelId, dimension);
    const hit = this.map.get(key);
    if (hit === undefined) {
      this.missCount += 1;
      return undefined;
    }
    // LRU：删除后重插以刷新顺序。
    this.map.delete(key);
    this.map.set(key, hit);
    this.hitCount += 1;
    return hit;
  }

  set(text: string, modelId: string, dimension: number, vector: number[]): void {
    const key = cacheKey(text, modelId, dimension);
    this.map.delete(key);
    this.map.set(key, vector);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }
}
