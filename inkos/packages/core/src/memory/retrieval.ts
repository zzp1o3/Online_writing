import type { EmbeddingConfig } from "../models/embedding.js";
import {
  searchVectorIndex,
  type VectorSearchHit,
  type VectorSource,
} from "./vector-index.js";

/**
 * 检索时机调度（设计文档 §6.3）
 * ---------------------------------------------------------------------------
 * T1 章前规划   planner 生成章节意图前：卷摘要 + 近 N 章摘要 + 相关卡片 + 未回收伏笔
 * T2 写作前     writer 动笔前：最近正文 chunk + 角色/地点卡 + 相关伏笔
 * T3 伏笔检查   guardian 每章开头：未回收/到期伏笔 + 分支节点
 * T4 审判       judge 审计时：相关历史正文 + 设定卡
 * T5 分支操作   新建/砍分支：关联节点 + 受影响章节
 */

export const RetrievalTimingSchema = {
  chapterPlan: "chapter-plan",
  preWrite: "pre-write",
  guardianCheck: "guardian-check",
  judge: "judge",
  branchOp: "branch-op",
} as const;
export type RetrievalTiming = (typeof RetrievalTimingSchema)[keyof typeof RetrievalTimingSchema];

export interface TimingProfile {
  readonly sources: ReadonlyArray<VectorSource>;
  readonly topK: number;
}

export const TIMING_PROFILES: Record<RetrievalTiming, TimingProfile> = {
  "chapter-plan": { sources: ["volume-summary", "chapter-summary", "card"], topK: 8 },
  "pre-write": { sources: ["chapter", "card"], topK: 8 },
  "guardian-check": { sources: ["branch", "card", "chapter-summary"], topK: 6 },
  judge: { sources: ["chapter", "chapter-summary", "card"], topK: 8 },
  "branch-op": { sources: ["branch", "card"], topK: 6 },
};

export interface TimingRetrievalResult {
  readonly timing: RetrievalTiming;
  readonly query: string;
  readonly hits: ReadonlyArray<VectorSearchHit>;
  readonly mode: "vector" | "keyword";
}

/** 按时机检索（自动降级关键词） */
export async function retrieveForTiming(params: {
  readonly bookDir: string;
  readonly timing: RetrievalTiming;
  readonly query: string;
  readonly embeddingConfig?: EmbeddingConfig;
  readonly topK?: number;
  readonly sources?: ReadonlyArray<VectorSource>;
  readonly signal?: AbortSignal;
}): Promise<TimingRetrievalResult> {
  const profile = TIMING_PROFILES[params.timing];
  const result = await searchVectorIndex({
    bookDir: params.bookDir,
    query: params.query,
    topK: params.topK ?? profile.topK,
    sourceFilter: params.sources ?? profile.sources,
    embeddingConfig: params.embeddingConfig,
    signal: params.signal,
  });
  return {
    timing: params.timing,
    query: params.query,
    hits: result.hits,
    mode: result.mode,
  };
}

/** 拼接检索结果为提示词上下文块 */
export function renderRetrievalContext(result: TimingRetrievalResult, maxChars = 4000): string {
  if (result.hits.length === 0) return "";
  const lines: string[] = [`[检索时机: ${result.timing} | 模式: ${result.mode === "vector" ? "向量" : "关键词"}]`];
  let used = 0;
  for (const hit of result.hits) {
    const block = `\n## ${hit.entry.source} (${hit.entry.ref})\n${hit.entry.text}`;
    if (used + block.length > maxChars) break;
    lines.push(block);
    used += block.length;
  }
  return lines.join("\n");
}
