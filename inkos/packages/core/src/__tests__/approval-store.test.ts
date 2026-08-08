import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachPartialRestart,
  getChapterApproval,
  setJudgeSummary,
  transitionChapterApproval,
} from "../state/approval-store.js";

describe("chapter approval store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-approval-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a draft record by default", async () => {
    const approval = await getChapterApproval(root, 1);
    expect(approval.chapterNumber).toBe(1);
    expect(approval.state).toBe("draft");
  });

  it("transitions through the state machine and keeps history", async () => {
    await transitionChapterApproval(root, 1, "ai_reviewed", "ai", "审判通过");
    await setJudgeSummary(root, 1, "节奏良好，伏笔到位");
    await transitionChapterApproval(root, 1, "human_pending", "system", "等待人工审批");
    await transitionChapterApproval(root, 1, "approved", "user", "用户通过");

    const approval = await getChapterApproval(root, 1);
    expect(approval.state).toBe("approved");
    expect(approval.judgeSummary).toBe("节奏良好，伏笔到位");
    expect(approval.events.map((e) => e.state)).toEqual(["draft", "ai_reviewed", "human_pending", "approved"]);
  });

  it("attaches a partial restart spec", async () => {
    await attachPartialRestart(root, 2, {
      range: [100, 500],
      instruction: "这段打斗写得太平，要有反转",
      status: "pending",
      createdAt: "2026-08-08T00:00:00.000Z",
    });
    const approval = await getChapterApproval(root, 2);
    expect(approval.state).toBe("rejected_partial");
    expect(approval.partialRestart?.instruction).toContain("反转");
    expect(approval.events.at(-1)?.by).toBe("user");
  });

  it("approval records survive reload", async () => {
    await transitionChapterApproval(root, 3, "approved", "user", "OK");
    const { loadApprovalLedger } = await import("../state/approval-store.js");
    const ledger = await loadApprovalLedger(root);
    expect(ledger.chapters.find((c) => c.chapterNumber === 3)?.state).toBe("approved");
  });
});
