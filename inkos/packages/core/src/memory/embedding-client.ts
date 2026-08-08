import { resolveEmbeddingApiKey, isEmbeddingConfigured, type EmbeddingConfig } from "../models/embedding.js";

/**
 * OpenAI-compatible embeddings 客户端（设计文档 §6.2）
 * POST {baseUrl}/embeddings  →  { data: [{ embedding: number[] }] }
 * 失败抛错，由调用方降级为关键词检索。
 */

export class EmbeddingError extends Error {
  readonly code = "EMBEDDING_ERROR";
}

export async function embedTexts(
  config: EmbeddingConfig,
  texts: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<ReadonlyArray<number[]>> {
  if (!isEmbeddingConfigured(config)) {
    throw new EmbeddingError("Embedding 未配置（enabled/baseUrl/model/apiKey 缺失）");
  }
  const normalized = config.baseUrl.replace(/\/+$/, "");
  const url = normalized.endsWith("/embeddings") ? normalized : `${normalized}/embeddings`;
  const apiKey = resolveEmbeddingApiKey(config);
  const out: number[][] = [];
  const batchSize = config.batchSize ?? 32;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          input: batch,
          ...(config.dimensions ? { dimensions: config.dimensions } : {}),
        }),
        signal,
      });
    } catch (error) {
      throw new EmbeddingError(`Embedding 请求失败: ${String(error)}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new EmbeddingError(`Embedding API ${response.status}: ${body.slice(0, 300)}`);
    }
    const json = await response.json() as { data?: ReadonlyArray<{ embedding?: unknown }> };
    const rows = json.data ?? [];
    const embeddings = rows.map((row) => {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        throw new EmbeddingError("Embedding API 返回空向量");
      }
      return row.embedding as number[];
    });
    if (embeddings.length !== batch.length) {
      throw new EmbeddingError(`Embedding API 返回条数不符：期望 ${batch.length}，实际 ${embeddings.length}`);
    }
    out.push(...embeddings);
  }
  return out;
}
