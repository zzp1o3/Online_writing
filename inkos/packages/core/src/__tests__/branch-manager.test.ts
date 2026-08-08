import { describe, expect, it } from "vitest";
import {
  applyBranchProposal,
  type BranchProposal,
} from "../agents/branch-manager.js";
import {
  emptyBranchGraph,
  type BranchGraph,
  type BranchNode,
} from "../models/branch-graph.js";

function graphWithMainline(): BranchGraph {
  const graph = emptyBranchGraph(new Date("2026-01-01T00:00:00.000Z"));
  const mainline: BranchNode = {
    id: "main-1",
    type: "mainline",
    title: "主线·卷一",
    description: "",
    chapterRange: [1, 20],
    status: "active",
    characterIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { ...graph, nodes: [mainline] };
}

const sampleProposal: BranchProposal = {
  node: {
    title: "支线·宗门试炼",
    description: "主角参加宗门试炼",
    chapterRange: [12, 18],
    parentId: "main-1",
    characterIds: ["char-2"],
  },
  grayNode: {
    title: "汇入·卷一收官",
    description: "试炼结束汇入主线",
    chapterRange: [18, 18],
    mergeIntoId: "main-1",
    parentId: "main-1",
  },
  edges: [
    { kind: "parent", from: "main-1", to: "branch-id" },
    { kind: "parent", from: "branch-id", to: "branch-id-gray" },
    { kind: "merge", from: "branch-id-gray", to: "main-1" },
  ],
  rationale: "主线势头充足，且配角的宗门线值得展开",
};

describe("applyBranchProposal", () => {
  it("adds branch + gray nodes and parent/merge edges", () => {
    const graph = graphWithMainline();
    const next = applyBranchProposal(graph, sampleProposal, new Date("2026-02-01T00:00:00.000Z"));

    expect(next.nodes).toHaveLength(3);
    const branch = next.nodes.find((n) => n.type === "branch")!;
    const gray = next.nodes.find((n) => n.type === "gray")!;

    expect(branch.title).toBe("支线·宗门试炼");
    expect(branch.parentId).toBe("main-1");
    expect(branch.chapterRange).toEqual([12, 18]);
    expect(branch.characterIds).toEqual(["char-2"]);

    expect(gray.mergeIntoId).toBe("main-1");
    expect(gray.parentId).toBe("main-1");

    // 三条边：分支分出 + 分支→灰度 + 灰度汇入主线
    expect(next.edges).toHaveLength(3);
    const mergeEdge = next.edges.find((e) => e.kind === "merge")!;
    expect(mergeEdge.from).toBe(gray.id);
    expect(mergeEdge.to).toBe("main-1");

    // 原图谱不被修改
    expect(graph.nodes).toHaveLength(1);
  });

  it("id is derived from title safely", () => {
    const graph = graphWithMainline();
    const proposal: BranchProposal = {
      ...sampleProposal,
      node: { ...sampleProposal.node, title: "支线/非法:字符" },
    };
    const next = applyBranchProposal(graph, proposal);
    const branch = next.nodes.find((n) => n.type === "branch")!;
    expect(branch.id).not.toContain("/");
    expect(branch.id).not.toContain(":");
  });
});
