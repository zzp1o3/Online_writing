import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import type { BranchGraph, BranchNode, BranchEdge } from "../models/branch-graph.js";

/**
 * Branch Manager（设计文档 §7）
 * ---------------------------------------------------------------------------
 * AI 生成/更新分支图谱：
 *   1. 根据主线进度与剧情素材，提议新的分支节点（含灰度主线节点 mergeIntoId）
 *   2. 砍分支影响评估：给定分支节点，返回受影响章节区间与重写建议
 * 用户与 AI 都有权砍分支；砍分支由 branch-store.cutBranch 执行（本 Agent 只做评估）。
 */

export interface BranchProposal {
  /** 新分支节点（type 固定为 branch） */
  readonly node: {
    readonly title: string;
    readonly description: string;
    readonly chapterRange: readonly [number, number];
    /** 从哪条主线/分支分出 */
    readonly parentId: string;
    /** 关联角色卡 id（用于戏份监控） */
    readonly characterIds: ReadonlyArray<string>;
  };
  /** 灰度主线节点（分支汇入主线处） */
  readonly grayNode: {
    readonly title: string;
    readonly description: string;
    readonly chapterRange: readonly [number, number];
    /** 汇入的主线节点 id */
    readonly mergeIntoId: string;
    readonly parentId: string;
  };
  /** 新增边 */
  readonly edges: ReadonlyArray<{
    readonly kind: "parent" | "merge";
    readonly from: string;
    readonly to: string;
  }>;
  /** 建议理由（供用户/守护审阅） */
  readonly rationale: string;
}

export interface BranchCutAssessment {
  readonly nodeId: string;
  /** 受影响章节区间 [min, max]，用于回滚重写 */
  readonly affectedChapterRange: { readonly min: number; readonly max: number } | null;
  /** 被砍节点 id（含子分支） */
  readonly cutNodeIds: ReadonlyArray<string>;
  /** 重写建议 */
  readonly rewriteSuggestion: string;
  /** 砍掉后受影响的伏笔/卡片提醒 */
  readonly sideEffects: ReadonlyArray<string>;
}

export interface BranchManagerInput {
  readonly book: Pick<BookConfig, "title" | "genre" | "language">;
  readonly bookDir: string;
  readonly graph: BranchGraph;
  /** 当前章节号（通常为下一章） */
  readonly currentChapter: number;
  /** 主线大纲摘要（可选，帮助 AI 判断何时分支） */
  readonly outlineContext?: string;
  readonly language?: "zh" | "en";
  readonly maxBranches?: number;
}

export interface BranchManagerRunResult {
  readonly proposal: BranchProposal | null;
  readonly tokenUsage?: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number };
}

function renderGraphForPrompt(graph: BranchGraph): string {
  if (graph.nodes.length === 0) return "（暂无分支图谱）";
  return graph.nodes.map((n) => {
    const range = n.chapterRange[1] > 0 ? `${n.chapterRange[0]}-${n.chapterRange[1]}` : `${n.chapterRange[0]}`;
    return `- [${n.id}] ${n.type}「${n.title}」章节${range} 状态:${n.status}${n.parentId ? ` 父节点:${n.parentId}` : ""}${n.mergeIntoId ? ` 汇入:${n.mergeIntoId}` : ""}`;
  }).join("\n");
}

function buildProposePrompt(input: BranchManagerInput, activeBranches: number): string {
  const isEnglish = input.language === "en";
  const outlineBlock = input.outlineContext ? `\n\n## 主线大纲摘要\n${input.outlineContext}` : "";
  if (isEnglish) {
    return `You are the Branch Manager. The story is at chapter ${input.currentChapter} with ${activeBranches}/${input.maxBranches} active branches.
Decide whether a NEW branch (a side storyline that must merge back into the mainline) is worth opening now.
Book: ${input.book.title} (${input.book.genre})

## Current branch graph
${renderGraphForPrompt(input.graph)}
${outlineBlock}

Rules:
- Only propose a branch if the mainline has enough momentum (usually 8+ chapters since last branch).
- Each branch MUST end at a gray node merging back into a mainline node (set mergeIntoId).
- Do not exceed maxBranches (${input.maxBranches}).
- Focus the branch on existing side characters; reuse characterIds from the graph.
- If no new branch is warranted, output {"proposal":null}.

Output JSON only:
{"proposal":{"node":{"title":"...","description":"...","chapterRange":[start,end],"parentId":"...","characterIds":["..."]},"grayNode":{"title":"...","description":"...","chapterRange":[start,end],"mergeIntoId":"...","parentId":"..."},"edges":[{"kind":"parent|merge","from":"...","to":"..."}],"rationale":"..."},"tokenUsage":null}`;
  }
  return `你是分支管理 Agent。故事进行到第 ${input.currentChapter} 章，当前活跃分支 ${activeBranches}/${input.maxBranches}。
判断现在是否值得开一条新分支（支线剧情，最终必须汇入主线）。
书籍：${input.book.title}（${input.book.genre}）

## 当前分支图谱
${renderGraphForPrompt(input.graph)}
${outlineBlock}

规则：
- 只有主线势头足够（通常距上一条分支 8 章以上）才提议分支。
- 每条分支末端必须是灰度节点（gray），并设置 mergeIntoId 汇入主线节点。
- 不得超过 maxBranches（${input.maxBranches}）。
- 分支应聚焦已有支线角色，characterIds 复用图谱中的角色。
- 如果当前不值得开新分支，输出 {"proposal":null}。

只输出 JSON：
{"proposal":{"node":{"title":"分支标题","description":"描述","chapterRange":[start,end],"parentId":"父节点id","characterIds":["角色id"]},"grayNode":{"title":"灰度节点标题","description":"描述","chapterRange":[start,end],"mergeIntoId":"主线节点id","parentId":"父节点id"},"edges":[{"kind":"parent|merge","from":"起点id","to":"终点id"}],"rationale":"建议理由"},"tokenUsage":null}`;
}

function parseProposalJson(content: string): { proposal: BranchProposal | null } | null {
  const jsonMatch = content.match(/\{[\s\S]*\}/u);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { proposal?: BranchProposal | null };
    return { proposal: parsed.proposal ?? null };
  } catch {
    return null;
  }
}

export class BranchManagerAgent extends BaseAgent {
  override get name(): string {
    return "branch-manager";
  }

  /**
   * 提议新分支（设计文档 §7：AI 生成分支）。
   * 返回 null 表示当前不值得开新分支。
   */
  async proposeBranch(input: BranchManagerInput): Promise<BranchManagerRunResult> {
    const activeBranches = input.graph.nodes.filter((n) => n.type === "branch" && n.status === "active").length;
    const maxBranches = input.maxBranches ?? input.graph.maxBranches;
    if (activeBranches >= maxBranches) {
      this.log?.info?.(`[branch-manager] 分支已满 ${activeBranches}/${maxBranches}，跳过提议`);
      return { proposal: null };
    }

    const prompt = buildProposePrompt(input, activeBranches);
    try {
      const response = await this.chat([
        { role: "system", content: "你输出严格 JSON，不要包含多余文本。" },
        { role: "user", content: prompt },
      ], { temperature: 0.4 });
      const parsed = parseProposalJson(response.content);
      if (!parsed) {
        this.log?.warn?.("[branch-manager] 输出无法解析，返回 null");
        return { proposal: null, tokenUsage: response.usage };
      }
      return { proposal: parsed.proposal, tokenUsage: response.usage };
    } catch (error) {
      this.log?.warn?.(`[branch-manager] LLM 调用失败: ${String(error)}`);
      return { proposal: null };
    }
  }

  /**
   * 砍分支影响评估（设计文档 §7：AI 与用户都有权砍分支，砍前评估受影响章节）。
   * 确定性计算受影响章节区间（基于节点 chapterRange），LLM 提供重写建议。
   */
  async assessCut(input: {
    readonly book: Pick<BookConfig, "title" | "genre">;
    readonly graph: BranchGraph;
    readonly nodeId: string;
    readonly reason: string;
    readonly language?: "zh" | "en";
  }): Promise<BranchCutAssessment> {
    const target = input.graph.nodes.find((n) => n.id === input.nodeId);
    if (!target) {
      throw new Error(`Branch node not found: ${input.nodeId}`);
    }

    // 确定性：收集被砍节点（含子分支）的章节区间
    const cutIds = new Set<string>([input.nodeId]);
    const stack = [input.nodeId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const edge of input.graph.edges) {
        if (edge.from === id && edge.kind === "parent" && !cutIds.has(edge.to)) {
          cutIds.add(edge.to);
          stack.push(edge.to);
        }
      }
    }
    const affected = input.graph.nodes
      .filter((n) => cutIds.has(n.id))
      .map((n) => n.chapterRange)
      .filter((r) => r[1] > 0);
    const affectedChapterRange = affected.length > 0
      ? { min: Math.min(...affected.map((r) => r[0])), max: Math.max(...affected.map((r) => r[1])) }
      : null;

    // LLM 重写建议（失败时给通用建议，不阻塞）
    let rewriteSuggestion = "";
    let sideEffects: ReadonlyArray<string> = [];
    try {
      const isEnglish = input.language === "en";
      const prompt = isEnglish
        ? `The branch "${target.title}" is being cut. Reason: ${input.reason}
Affected chapters: ${affectedChapterRange ? `${affectedChapterRange.min}-${affectedChapterRange.max}` : "none yet written"}.
Give a concise rewrite suggestion for those chapters and any side effects on foreshadowing/cards.
Output JSON: {"rewriteSuggestion":"...","sideEffects":["..."]}`
        : `分支「${target.title}」将被砍掉。原因：${input.reason}
受影响章节：${affectedChapterRange ? `${affectedChapterRange.min}-${affectedChapterRange.max}` : "尚未写"}。
给出一段简短的重写建议，以及砍掉后对伏笔/卡片的副作用提醒。
只输出 JSON：{"rewriteSuggestion":"重写建议","sideEffects":["副作用1"]}`;
      const response = await this.chat([
        { role: "system", content: "你输出严格 JSON。" },
        { role: "user", content: prompt },
      ], { temperature: 0.3 });
      const jsonMatch = response.content.match(/\{[\s\S]*\}/u);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { rewriteSuggestion?: string; sideEffects?: string[] };
        rewriteSuggestion = parsed.rewriteSuggestion ?? "";
        sideEffects = parsed.sideEffects ?? [];
      }
    } catch (error) {
      this.log?.warn?.(`[branch-manager] 砍分支评估 LLM 失败: ${String(error)}`);
      rewriteSuggestion = "受影响的章节建议回滚重写：回到分支汇入前的最后一个主线节点，让后续章节从主线延续。";
    }

    return {
      nodeId: input.nodeId,
      affectedChapterRange,
      cutNodeIds: [...cutIds],
      rewriteSuggestion,
      sideEffects,
    };
  }
}

export function applyBranchProposal(
  graph: BranchGraph,
  proposal: BranchProposal,
  now = new Date(),
): BranchGraph {
  const nodeId = proposal.node.title
    .replace(/[/\\:*?"<>|]/g, "_")
    .trim()
    .slice(0, 40) || `branch-${Date.now().toString(36)}`;
  const grayId = `${nodeId}-gray`;
  const branchNode: BranchNode = {
    id: nodeId,
    type: "branch",
    title: proposal.node.title,
    description: proposal.node.description,
    chapterRange: [proposal.node.chapterRange[0], proposal.node.chapterRange[1]],
    status: "active",
    parentId: proposal.node.parentId,
    characterIds: [...proposal.node.characterIds],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const grayNode: BranchNode = {
    id: grayId,
    type: "gray",
    title: proposal.grayNode.title,
    description: proposal.grayNode.description,
    chapterRange: [proposal.grayNode.chapterRange[0], proposal.grayNode.chapterRange[1]],
    status: "active",
    parentId: proposal.node.parentId,
    mergeIntoId: proposal.grayNode.mergeIntoId,
    characterIds: [...proposal.node.characterIds],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const edges: BranchEdge[] = [
    { id: `${nodeId}-parent`, from: proposal.node.parentId, to: nodeId, kind: "parent" },
    { id: `${nodeId}-to-gray`, from: nodeId, to: grayId, kind: "parent" },
    { id: `${grayId}-merge`, from: grayId, to: proposal.grayNode.mergeIntoId, kind: "merge" },
  ];
  return {
    ...graph,
    nodes: [...graph.nodes, branchNode, grayNode],
    edges: [...graph.edges, ...edges],
    updatedAt: now.toISOString(),
  };
}
