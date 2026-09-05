/**
 * Embedding Provider（R4）。
 *
 * 抽象：
 *  - HashEmbeddingProvider：本地确定性字符 n-gram 哈希向量。**非语义模型**，
 *    仅用于零外部依赖的端到端向量链路；相似度捕捉词形/子串重合。
 *  - HttpEmbeddingProvider：OpenAI 兼容 /embeddings 端点（如 DeepSeek/
 *    兼容网关），embedText 失败会抛 EmbeddingError，由调用方决定降级。
 *
 * 真实语义 embedding 受宿主机能力（端点/密钥）约束；沙箱不可达时宿主配置
 * 保持 hash 默认并在 /api/config 暴露 provider.available=false。
 */

export type EmbeddingKind = "local-hash" | "http";

export interface EmbeddingHealth {
  available: boolean;
  kind: EmbeddingKind;
  modelId?: string;
  dimension?: number;
  reason?: string;
}

export interface EmbeddingProvider {
  readonly kind: EmbeddingKind;
  readonly modelId: string;
  readonly dimension: number;
  health(): EmbeddingHealth;
  embedText(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface HttpEmbeddingConfig {
  /** 兼容端点根，如 https://api.deepseek.com（不含 /embeddings 路径则自动拼接） */
  baseUrl: string;
  /** /v1/embeddings 兼容模型名 */
  model: string;
  apiKey?: string;
  /** 期望向量维度；与向量表一致。缺省以首次响应为准（需与存储配置一致） */
  dimension?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

/** 生成子串特征：ASCII 词整体+bigram、CJK 单字+相邻两字。 */
function collectFeatures(text: string): string[] {
  const lower = text.toLowerCase();
  const pieces = lower.match(/[a-z0-9]+|[\u4e00-\u9fa5]+/g) ?? [];
  const set = new Set<string>();
  for (const piece of pieces) {
    if (/^[a-z0-9]+$/.test(piece)) {
      set.add(piece);
      for (let i = 0; i + 1 < piece.length; i += 1) {
        if (/[a-z0-9]/.test(piece[i]!) && /[a-z0-9]/.test(piece[i + 1]!)) {
          set.add(piece.slice(i, i + 2));
        }
      }
    } else {
      for (let i = 0; i < piece.length; i += 1) {
        set.add(piece[i]!);
        if (i + 1 < piece.length) set.add(piece.slice(i, i + 2));
      }
    }
  }
  return [...set];
}

/** FNV-1a 32 位散列。 */
function fnv1a(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 特征 → 有符号累加向量 → L2 归一化。零特征返回全零（无相似度贡献）。 */
function hashVector(text: string, dimension: number): number[] {
  const vec = new Array<number>(dimension).fill(0);
  for (const feature of collectFeatures(text)) {
    const idx = fnv1a(`i:${feature}`) % dimension;
    const sign = (fnv1a(`s:${feature}`, 0x84222325) & 1) === 0 ? -1 : 1;
    vec[idx] = (vec[idx] ?? 0) + sign;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** 本地确定性字符 n-gram 哈希 embedding（离线；词形相关，非语义）。 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly kind: EmbeddingKind = "local-hash";
  readonly modelId: string;
  readonly dimension: number;

  constructor(dimension = 128, modelId = "hash-ngram-v1") {
    if (!Number.isInteger(dimension) || dimension < 2) {
      throw new Error(`dimension 必须为 >=2 的整数，收到 ${dimension}`);
    }
    this.dimension = dimension;
    this.modelId = modelId;
  }

  health(): EmbeddingHealth {
    return { available: true, kind: this.kind, modelId: this.modelId, dimension: this.dimension };
  }

  embedText(text: string): Promise<number[]> {
    return Promise.resolve(hashVector(text, this.dimension));
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => hashVector(t, this.dimension)));
  }
}

export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}

/** HTTP/OpenAI 兼容 embedding（真实语义模型；失败抛 EmbeddingError）。 */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly kind: EmbeddingKind = "http";
  readonly modelId: string;
  readonly dimension: number;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(cfg: HttpEmbeddingConfig) {
    this.modelId = cfg.model;
    this.dimension = cfg.dimension ?? 0;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.maxRetries = cfg.maxRetries ?? 2;
  }

  health(): EmbeddingHealth {
    if (this.baseUrl.length === 0 || this.modelId.length === 0) {
      return {
        available: false,
        kind: this.kind,
        modelId: this.modelId || undefined,
        dimension: this.dimension || undefined,
        reason: "baseUrl/model 未配置",
      };
    }
    return {
      available: true,
      kind: this.kind,
      modelId: this.modelId,
      dimension: this.dimension || undefined,
    };
  }

  private async fetchOne(text: string): Promise<number[]> {
    const endpoint = this.baseUrl.endsWith("/embeddings")
      ? this.baseUrl
      : `${this.baseUrl}/embeddings`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ input: text, model: this.modelId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new EmbeddingError(`embedding HTTP ${res.status}`, {
          cause: await res.text().catch(() => ""),
        });
      }
      const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
      const vector = body.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new EmbeddingError("embedding 响应缺少 data[0].embedding");
      }
      return vector;
    } finally {
      clearTimeout(timer);
    }
  }

  async embedText(text: string): Promise<number[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const vec = await this.fetchOne(text);
        if (this.dimension > 0 && vec.length !== this.dimension) {
          throw new EmbeddingError(
            `维度不符：期望 ${this.dimension}，实际 ${vec.length}`,
          );
        }
        return vec;
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new EmbeddingError(`embedding 请求超时（${this.timeoutMs}ms）`, {
            cause: err,
          });
        }
      }
    }
    throw new EmbeddingError(`embedding 请求失败：${(lastErr as Error).message}`, {
      cause: lastErr,
    });
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) out.push(await this.embedText(t));
    return out;
  }
}

export type EmbeddingConfig = {
  provider: "hash";
  dimension?: number;
  modelId?: string;
} | {
  provider: "http";
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimension?: number;
  timeoutMs?: number;
  maxRetries?: number;
};

/** 依据配置创建 embedding 提供方；非法 http 配置在 health() 报不可用而非抛错。 */
export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider {
  if (cfg.provider === "http") {
    return new HttpEmbeddingProvider({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey,
      dimension: cfg.dimension,
      timeoutMs: cfg.timeoutMs,
      maxRetries: cfg.maxRetries,
    });
  }
  return new HashEmbeddingProvider(cfg.dimension ?? 128, cfg.modelId);
}
