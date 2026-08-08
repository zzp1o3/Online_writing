import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ApprovalLedgerSchema,
  ChapterApprovalSchema,
  emptyApprovalLedger,
  newChapterApproval,
  type ApprovalEvent,
  type ApprovalState,
  type ChapterApproval,
  type PartialRestartSpec,
} from "../models/approval.js";

/**
 * 章节审批台账（设计文档 §9）
 * 落盘：<bookDir>/story/approvals.json
 */

function approvalPath(bookDir: string): string {
  return join(bookDir, "story", "approvals.json");
}

export async function loadApprovalLedger(bookDir: string): Promise<import("../models/approval.js").ApprovalLedger> {
  try {
    const raw = await readFile(approvalPath(bookDir), "utf-8");
    const parsed = ApprovalLedgerSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : emptyApprovalLedger();
  } catch {
    return emptyApprovalLedger();
  }
}

export async function saveApprovalLedger(
  bookDir: string,
  ledger: import("../models/approval.js").ApprovalLedger,
): Promise<void> {
  const path = approvalPath(bookDir);
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(path, JSON.stringify(ledger, null, 2), "utf-8");
}

export async function getChapterApproval(
  bookDir: string,
  chapterNumber: number,
): Promise<ChapterApproval> {
  const ledger = await loadApprovalLedger(bookDir);
  return ledger.chapters.find((c) => c.chapterNumber === chapterNumber)
    ?? newChapterApproval(chapterNumber);
}

function pushEvent(
  approval: ChapterApproval,
  state: ApprovalState,
  by: ApprovalEvent["by"],
  note: string,
  now: Date,
): ChapterApproval {
  const event: ApprovalEvent = { state, at: now.toISOString(), by, note };
  return {
    ...approval,
    state,
    events: [...approval.events, event],
    updatedAt: now.toISOString(),
  };
}

export async function transitionChapterApproval(
  bookDir: string,
  chapterNumber: number,
  state: ApprovalState,
  by: ApprovalEvent["by"],
  note = "",
  now = new Date(),
): Promise<ChapterApproval> {
  const ledger = await loadApprovalLedger(bookDir);
  const existing = ledger.chapters.find((c) => c.chapterNumber === chapterNumber)
    ?? newChapterApproval(chapterNumber, now);
  const next = pushEvent(existing, state, by, note, now);
  const chapters = ledger.chapters.some((c) => c.chapterNumber === chapterNumber)
    ? ledger.chapters.map((c) => (c.chapterNumber === chapterNumber ? next : c))
    : [...ledger.chapters, next];
  await saveApprovalLedger(bookDir, { ...ledger, chapters });
  return next;
}

export async function setJudgeSummary(
  bookDir: string,
  chapterNumber: number,
  summary: string,
  now = new Date(),
): Promise<ChapterApproval> {
  const ledger = await loadApprovalLedger(bookDir);
  const existing = ledger.chapters.find((c) => c.chapterNumber === chapterNumber)
    ?? newChapterApproval(chapterNumber, now);
  const next: ChapterApproval = {
    ...existing,
    judgeSummary: summary,
    updatedAt: now.toISOString(),
  };
  const chapters = ledger.chapters.some((c) => c.chapterNumber === chapterNumber)
    ? ledger.chapters.map((c) => (c.chapterNumber === chapterNumber ? next : c))
    : [...ledger.chapters, next];
  await saveApprovalLedger(bookDir, { ...ledger, chapters });
  return next;
}

export async function attachPartialRestart(
  bookDir: string,
  chapterNumber: number,
  spec: PartialRestartSpec,
  now = new Date(),
): Promise<ChapterApproval> {
  const ledger = await loadApprovalLedger(bookDir);
  const existing = ledger.chapters.find((c) => c.chapterNumber === chapterNumber)
    ?? newChapterApproval(chapterNumber, now);
  const next = pushEvent(
    { ...existing, partialRestart: spec },
    "rejected_partial",
    "user",
    `局部重启：${spec.instruction}`,
    now,
  );
  const chapters = ledger.chapters.some((c) => c.chapterNumber === chapterNumber)
    ? ledger.chapters.map((c) => (c.chapterNumber === chapterNumber ? next : c))
    : [...ledger.chapters, next];
  await saveApprovalLedger(bookDir, { ...ledger, chapters });
  return next;
}

/** 直接读取校验单个章节审批（供外部使用） */
export async function readChapterApproval(
  bookDir: string,
  chapterNumber: number,
): Promise<ChapterApproval | null> {
  try {
    const raw = await readFile(approvalPath(bookDir), "utf-8");
    const parsed = ApprovalLedgerSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return null;
    const found = parsed.data.chapters.find((c) => c.chapterNumber === chapterNumber);
    return found ? ChapterApprovalSchema.parse(found) : null;
  } catch {
    return null;
  }
}
