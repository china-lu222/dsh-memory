/**
 * Vector Store 抽象与健康/命中类型（R4）。
 */

export interface VectorStoreHealth {
  available: boolean;
  /** 索引引擎标识，如 "sqlite-vec" */
  engine: string;
  modelId?: string;
  dimension?: number;
  /** 已索引记忆数 */
  count: number;
  /** 不可用原因（available=false 时） */
  reason?: string;
}

export interface VectorSearchHit {
  memoryId: string;
  /** L2 平方距离（越小越近） */
  distance: number;
  /** 1/(1+distance)，∈(0,1] */
  similarity: number;
}

/**
 * 向量索引。写操作为同步幂等（调用方按 id 覆盖/删除）；
 * search 返回按相似度降序的前 topK 命中，不做 filter —— filter 由
 * 检索编排层结合 memory_items 权威行完成（保证与关键词路径同语义）。
 */
export interface VectorStore {
  readonly id: string;
  health(): VectorStoreHealth;
  /** 覆盖写入一条向量（附 source version，供投影增量去重） */
  upsert(memoryId: string, embedding: number[], version?: number): void;
  /** 已索引条目的 source version；未索引返回 null */
  versionOf(memoryId: string): number | null;
  remove(memoryId: string): void;
  search(embedding: number[], topK: number): VectorSearchHit[];
  /** 全部已索引 memoryId（投影清理用） */
  ids(): string[];
  count(): number;
  /** 全量清空（模型/维度变更重建时） */
  clear(): void;
  close(): void;
}
