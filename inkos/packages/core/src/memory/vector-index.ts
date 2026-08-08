import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { EmbeddingConfig } from "../models/embedding.js";
import { embedTexts } from "./embedding-client.js";

/**
 * 向量索引（设计文档 §6.2 / §6.3）
 * ---------------------------------------------------------------------------
 * 分块颗粒度：
 *   - 正文：每章 1 个 chunk（正文 + 该章摘要）
 *   - 卷摘要：每卷 1 个 chunk
 *   - 设定：每张卡片 1 个 chunk
 *   - 分支图谱：每节点 1 个 chunk
 * 检索失败自动降级为关键词检索（inkos 现有 scoring 逻辑），不阻塞流水线。
 */

export const VectorSourceSchema = z.enum([
  "chapter",
  "chapter-summary",
  "volume-summary",
  "card",
  "branch",
]);
export type VectorSource = z.infer<typeof VectorSourceSchema>;

export const VectorEntrySchema = z.object({
  id: z.string().min(1),
  source: VectorSourceSchema,
  /** 章节号 / 卡片 id / 分支节点 id 等 */
  ref: z.string().min(1),
  text: z.string().min(1),
  embedding: z.array(z.number()).optional(),
  updatedAt: z.string().datetime(),
});
export type VectorEntry = z.infer<typeof VectorEntrySchema>;

export const VectorIndexSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  entries: z.array(VectorEntrySchema).default([]),
});
export type VectorIndex = z.infer<typeof VectorIndexSchema>;

export interface VectorSearchHit {
  readonly entry: VectorEntry;
  readonly score: number;
}

function indexPath(bookDir: string): string {
  return join(bookDir, "story", "vector_index.json");
}

export async function loadVectorIndex(bookDir: string): Promise<VectorIndex> {
  try {
    const raw = await readFile(indexPath(bookDir), "utf-8");
    const parsed = VectorIndexSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : { schemaVersion: 1, entries: [] };
  } catch {
    return { schemaVersion: 1, entries: [] };
  }
}

export async function saveVectorIndex(bookDir: string, index: VectorIndex): Promise<void> {
  const path = indexPath(bookDir);
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(path, JSON.stringify(index, null, 2), "utf-8");
}

/** 关键词检索（降级路径） */
export function keywordSearch(
  index: VectorIndex,
  query: string,
  topK: number,
  sourceFilter?: ReadonlyArray<VectorSource>,
): ReadonlyArray<VectorSearchHit> {
  const terms = extractTerms(query);
  const hits: VectorSearchHit[] = [];
  for (const entry of index.entries) {
    if (sourceFilter && sourceFilter.length > 0 && !sourceFilter.includes(entry.source)) continue;
    const text = `${entry.text} ${entry.ref}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (text.includes(term)) score += Math.max(4, term.length * 2);
    }
    if (score > 0) hits.push({ entry, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, topK);
}

function extractTerms(query: string): string[] {
  const raw = query.normalize("NFKC").trim().toLowerCase();
  if (!raw) return [];
  const terms = new Set<string>();
  for (const match of raw.matchAll(/[\p{L}\p{N}]{2,}/gu)) {
    terms.add(match[0]);
  }
  return [...terms].slice(0, 24);
}

function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 语义检索（带降级）。
 * - embedding 可用：向量相似度 topK
 * - embedding 不可用/失败：关键词检索
 * 返回 { hits, mode: "vector" | "keyword" }。
 */
export async function searchVectorIndex(params: {
  readonly bookDir: string;
  readonly query: string;
  readonly topK: number;
  readonly sourceFilter?: ReadonlyArray<VectorSource>;
  readonly embeddingConfig?: EmbeddingConfig;
  readonly signal?: AbortSignal;
}): Promise<{ readonly hits: ReadonlyArray<VectorSearchHit>; readonly mode: "vector" | "keyword" }> {
  const index = await loadVectorIndex(params.bookDir);
  if (index.entries.length === 0) {
    return { hits: [], mode: "keyword" };
  }

  const candidates = params.sourceFilter && params.sourceFilter.length > 0
    ? index.entries.filter((e) => params.sourceFilter!.includes(e.source))
    : index.entries;
  if (candidates.length === 0) {
    return { hits: [], mode: "keyword" };
  }

  if (params.embeddingConfig && params.embeddingConfig.enabled) {
    try {
      const [queryVector] = await embedTexts(params.embeddingConfig, [params.query], params.signal);
      const scored = candidates
        .filter((entry) => entry.embedding && entry.embedding.length > 0)
        .map((entry) => ({ entry, score: cosine(queryVector, entry.embedding!) }))
        .filter((hit) => hit.score > 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, params.topK);
      if (scored.length > 0) {
        return { hits: scored, mode: "vector" };
      }
      // 向量无结果时仍回退关键词，保证召回
    } catch {
      // 降级
    }
  }
  return { hits: keywordSearch(index, params.query, params.topK, params.sourceFilter), mode: "keyword" };
}

/** 批量写入/更新条目（自动向量化；向量失败则只存文本，检索自动降级） */
export async function upsertVectorEntries(params: {
  readonly bookDir: string;
  readonly entries: ReadonlyArray<Omit<VectorEntry, "embedding" | "updatedAt">>;
  readonly embeddingConfig?: EmbeddingConfig;
  readonly signal?: AbortSignal;
  readonly now?: Date;
}): Promise<void> {
  const index = await loadVectorIndex(params.bookDir);
  const now = (params.now ?? new Date()).toISOString();
  let embeddings: ReadonlyArray<number[]> | null = null;
  if (params.embeddingConfig && params.embeddingConfig.enabled && params.entries.length > 0) {
    try {
      embeddings = await embedTexts(
        params.embeddingConfig,
        params.entries.map((e) => e.text),
        params.signal,
      );
    } catch {
      embeddings = null;
    }
  }

  const next = [...index.entries];
  for (let i = 0; i < params.entries.length; i += 1) {
    const entry = params.entries[i]!;
    const existingIdx = next.findIndex((e) => e.id === entry.id);
    const full: VectorEntry = {
      ...entry,
      embedding: embeddings?.[i] ?? undefined,
      updatedAt: now,
    };
    if (existingIdx >= 0) {
      next[existingIdx] = full;
    } else {
      next.push(full);
    }
  }
  await saveVectorIndex(params.bookDir, { schemaVersion: 1, entries: next });
}

export async function removeVectorEntries(
  bookDir: string,
  predicate: (entry: VectorEntry) => boolean,
): Promise<void> {
  const index = await loadVectorIndex(bookDir);
  const next = index.entries.filter((e) => !predicate(e));
  if (next.length !== index.entries.length) {
    await saveVectorIndex(bookDir, { schemaVersion: 1, entries: next });
  }
}


/** 章节正文 + 摘要 → 单一 chunk 文本（设计文档 §6.2） */
export function buildChapterChunkText(content: string, summary = ""): string {
  return summary ? `${summary}\n\n${content}` : content;
}



