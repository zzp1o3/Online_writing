import { z } from "zod";

/**
 * 章节人工审批（设计文档 §9）
 * ---------------------------------------------------------------------------
 * 状态机：
 *   draft → ai_reviewed → human_pending → approved
 *                                      ├─ rejected_whole（整章重来）
 *                                      └─ rejected_partial（局部重启）
 * 写入模式（设计文档 §9）：direct（直接写入）/ approve（点头生效）
 */

export const ApprovalStateSchema = z.enum([
  "draft",
  "ai_reviewed",
  "human_pending",
  "approved",
  "rejected_whole",
  "rejected_partial",
]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

/** 局部重启任务：用户划定范围 + 写入描述，Agent 从全局视角重写但聚焦该段落 */
export const PartialRestartSpecSchema = z.object({
  /** 章节内字符区间 [start, end]（按正文 UTF-16 偏移） */
  range: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  /** 用户对修改方向的描述 */
  instruction: z.string().min(1),
  /** 生成后该任务的状态 */
  status: z.enum(["pending", "running", "done", "failed"]).default("pending"),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  resultNote: z.string().optional(),
});
export type PartialRestartSpec = z.infer<typeof PartialRestartSpecSchema>;

export const ApprovalEventSchema = z.object({
  state: ApprovalStateSchema,
  at: z.string().datetime(),
  by: z.enum(["ai", "user", "system"]),
  note: z.string().default(""),
});
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

export const ChapterApprovalSchema = z.object({
  chapterNumber: z.number().int().min(1),
  state: ApprovalStateSchema,
  /** 审判报告摘要（Judge 输出） */
  judgeSummary: z.string().default(""),
  /** 最近一次局部重启 */
  partialRestart: PartialRestartSpecSchema.optional(),
  events: z.array(ApprovalEventSchema).default([]),
  updatedAt: z.string().datetime(),
});
export type ChapterApproval = z.infer<typeof ChapterApprovalSchema>;

export const ApprovalLedgerSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  chapters: z.array(ChapterApprovalSchema).default([]),
});
export type ApprovalLedger = z.infer<typeof ApprovalLedgerSchema>;

export function emptyApprovalLedger(): ApprovalLedger {
  return { schemaVersion: 1, chapters: [] };
}

export function newChapterApproval(
  chapterNumber: number,
  now = new Date(),
): ChapterApproval {
  return {
    chapterNumber,
    state: "draft",
    judgeSummary: "",
    events: [{ state: "draft", at: now.toISOString(), by: "system", note: "章节草稿生成" }],
    updatedAt: now.toISOString(),
  };
}
