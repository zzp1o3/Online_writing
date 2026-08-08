import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BranchGraphSchema,
  collectCutSubtree,
  emptyBranchGraph,
  type BranchGraph,
} from "../models/branch-graph.js";

/**
 * 分支图谱存储（设计文档 §7）
 * 落盘：<bookDir>/story/branch_graph.json
 */

function branchGraphPath(bookDir: string): string {
  return join(bookDir, "story", "branch_graph.json");
}

export async function loadBranchGraph(bookDir: string): Promise<BranchGraph> {
  try {
    const raw = await readFile(branchGraphPath(bookDir), "utf-8");
    const parsed = BranchGraphSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : emptyBranchGraph();
  } catch {
    return emptyBranchGraph();
  }
}

export async function saveBranchGraph(bookDir: string, graph: BranchGraph): Promise<void> {
  const path = branchGraphPath(bookDir);
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(path, JSON.stringify(graph, null, 2), "utf-8");
}

export interface CutBranchResult {
  readonly graph: BranchGraph;
  /** 被砍节点 id 集合（含子分支） */
  readonly cutNodeIds: ReadonlyArray<string>;
  /** 受影响章节区间 [min,max]，用于回滚重写提示 */
  readonly affectedChapterRange: { readonly min: number; readonly max: number } | null;
}

export async function cutBranch(
  bookDir: string,
  nodeId: string,
  reason: string,
  now = new Date(),
): Promise<CutBranchResult> {
  const graph = await loadBranchGraph(bookDir);
  const target = graph.nodes.find((n) => n.id === nodeId);
  if (!target) {
    throw new Error(`Branch node not found: ${nodeId}`);
  }
  const cutIds = new Set(collectCutSubtree(graph, nodeId));
  const next: BranchGraph = {
    ...graph,
    nodes: graph.nodes.map((n) => (cutIds.has(n.id)
      ? { ...n, status: "cut" as const, cutReason: reason, updatedAt: now.toISOString() }
      : n)),
    edges: graph.edges.filter((e) => !cutIds.has(e.from) && !cutIds.has(e.to)),
    updatedAt: now.toISOString(),
  };
  await saveBranchGraph(bookDir, next);

  const affected = graph.nodes
    .filter((n) => cutIds.has(n.id))
    .map((n) => n.chapterRange)
    .filter((range) => range[1] > 0);
  const affectedChapterRange = affected.length > 0
    ? {
        min: Math.min(...affected.map((r) => r[0])),
        max: Math.max(...affected.map((r) => r[1])),
      }
    : null;

  return {
    graph: next,
    cutNodeIds: [...cutIds],
    affectedChapterRange,
  };
}
