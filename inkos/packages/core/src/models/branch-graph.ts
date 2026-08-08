import { z } from "zod";

/**
 * 分支图谱（设计文档 §7）
 * ---------------------------------------------------------------------------
 * - 主线 1 条（mainline 节点链）
 * - 分支最多 N 条（N 可配置），每条分支末端必须是“灰度主线节点”（gray，分支汇入主线处）
 * - 生成与更新：Branch Manager（AI）与用户都有权砍分支
 * - 戏份监控：统计各角色出场占比，支线超主角判定为崩
 */

export const BranchNodeTypeSchema = z.enum(["mainline", "branch", "gray"]);
export type BranchNodeType = z.infer<typeof BranchNodeTypeSchema>;

export const BranchNodeStatusSchema = z.enum(["active", "planned", "cut"]);
export type BranchNodeStatus = z.infer<typeof BranchNodeStatusSchema>;

export const BranchNodeSchema = z.object({
  id: z.string().min(1),
  type: BranchNodeTypeSchema,
  title: z.string().min(1),
  description: z.string().default(""),
  /** 该节点覆盖的章节区间 [start, end] */
  chapterRange: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([0, 0]),
  status: BranchNodeStatusSchema.default("active"),
  /** branch / gray 节点的父节点（从哪条主线/分支分出） */
  parentId: z.string().optional(),
  /** gray 节点汇入的主线节点 id */
  mergeIntoId: z.string().optional(),
  /** 关联角色卡 id（用于戏份监控） */
  characterIds: z.array(z.string()).default([]),
  cutReason: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BranchNode = z.infer<typeof BranchNodeSchema>;

export const BranchEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["parent", "merge"]).default("parent"),
});
export type BranchEdge = z.infer<typeof BranchEdgeSchema>;

/** 戏份统计：角色出场占比（最近窗口内出场次数 / 总章节数等） */
export const ScreenTimeRecordSchema = z.object({
  characterId: z.string().min(1),
  /** 0-1 占比，1 = 主角级别戏份 */
  ratio: z.number().min(0).max(1),
  /** 最近一次统计的章节号 */
  lastUpdatedChapter: z.number().int().min(0),
  /** 该角色关联的分支节点 id（支线角色） */
  branchNodeId: z.string().optional(),
});
export type ScreenTimeRecord = z.infer<typeof ScreenTimeRecordSchema>;

export const BranchGraphSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  nodes: z.array(BranchNodeSchema).default([]),
  edges: z.array(BranchEdgeSchema).default([]),
  screenTime: z.array(ScreenTimeRecordSchema).default([]),
  /** 分支数量上限 N（可由项目配置覆盖） */
  maxBranches: z.number().int().min(1).default(5),
  updatedAt: z.string().datetime(),
});
export type BranchGraph = z.infer<typeof BranchGraphSchema>;

export function emptyBranchGraph(now = new Date()): BranchGraph {
  return {
    schemaVersion: 1,
    nodes: [],
    edges: [],
    screenTime: [],
    maxBranches: 5,
    updatedAt: now.toISOString(),
  };
}

/** 找出被砍分支的节点 id 集合（含其衍生子分支） */
export function collectCutSubtree(graph: BranchGraph, nodeId: string): ReadonlyArray<string> {
  const result: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    result.push(id);
    for (const edge of graph.edges) {
      if (edge.from === id && edge.kind === "parent") {
        visit(edge.to);
      }
    }
  };
  visit(nodeId);
  return result;
}

/** 校验图谱结构：主线至少 1 个节点；每条分支末端必须是 gray 节点；无孤儿节点 */
export function validateBranchGraph(graph: BranchGraph): ReadonlyArray<string> {
  const issues: string[] = [];
  const mainline = graph.nodes.filter((n) => n.type === "mainline");
  if (mainline.length === 0) {
    issues.push("分支图谱缺少主线（mainline）节点");
  }
  for (const node of graph.nodes) {
    if (node.type === "gray" && !node.mergeIntoId) {
      issues.push(`灰度节点 "${node.title}"（${node.id}）缺少汇入主线节点 mergeIntoId`);
    }
    if (node.type === "branch" && !node.parentId) {
      issues.push(`分支节点 "${node.title}"（${node.id}）缺少父节点 parentId`);
    }
  }
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from)) issues.push(`边 ${edge.id} 的起点 ${edge.from} 不存在`);
    if (!nodeIds.has(edge.to)) issues.push(`边 ${edge.id} 的终点 ${edge.to} 不存在`);
  }
  return issues;
}
