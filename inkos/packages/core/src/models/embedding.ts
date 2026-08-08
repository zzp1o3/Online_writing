import { z } from "zod";

/**
 * Embedding 配置（设计文档 §6.2）
 * 用户自配 OpenAI-compatible /v1/embeddings 端点（例如硅基流动 BAAI/bge-m3 等免费模型）。
 */

const EmbeddingConfigFieldsSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string(),
  /** embedding 模型名 */
  model: z.string().min(1),
  apiKey: z.string().default(""),
  /** 优先从环境变量读取密钥 */
  apiKeyEnv: z.string().optional(),
  /** 向量维度（部分端点需要显式声明） */
  dimensions: z.number().int().min(1).optional(),
  /** 单批最大条数 */
  batchSize: z.number().int().min(1).max(256).default(32),
});

/** 项目配置中为可选字段；缺省表示未启用 embedding */
export const EmbeddingConfigSchema = EmbeddingConfigFieldsSchema.optional();

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigFieldsSchema>;

export const EMBEDDING_NOT_CONFIGURED = Symbol("embedding-not-configured");

export function resolveEmbeddingApiKey(config: EmbeddingConfig): string {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyEnv) return process.env[config.apiKeyEnv] ?? "";
  return "";
}

export function isEmbeddingConfigured(config: EmbeddingConfig | undefined): boolean {
  return Boolean(config?.enabled && config.baseUrl && config.model && resolveEmbeddingApiKey(config));
}
