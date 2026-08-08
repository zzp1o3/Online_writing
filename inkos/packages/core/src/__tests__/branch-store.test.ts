import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cutBranch, loadBranchGraph, saveBranchGraph } from "../state/branch-store.js";
import { collectCutSubtree, emptyBranchGraph, validateBranchGraph, type BranchGraph, type BranchNode } from "../models/branch-graph.js";

describe("branch graph", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-branch-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const node = (id: string, type: BranchNode["type"], title: string, extra: Partial<BranchNode> = {}): BranchNode => ({
    id,
    type,
    title,
    description: "",
    chapterRange: [1, 1],
    status: "active",
    characterIds: [],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...extra,
  });

  it("persists and reloads a graph", async () => {
    const graph: BranchGraph = {
      ...emptyBranchGraph(),
      nodes: [
        node("m1", "mainline", "主线-初入江湖"),
        node("b1", "branch", "支线-旧案", { parentId: "m1", chapterRange: [5, 12] }),
        node("g1", "gray", "汇合点", { parentId: "b1", mergeIntoId: "m2" }),
        node("m2", "mainline", "主线-京城风云"),
      ],
      edges: [
        { id: "e1", from: "m1", to: "b1", kind: "parent" },
        { id: "e2", from: "b1", to: "g1", kind: "parent" },
        { id: "e3", from: "g1", to: "m2", kind: "merge" },
      ],
    };
    await saveBranchGraph(root, graph);
    const loaded = await loadBranchGraph(root);
    expect(loaded.nodes).toHaveLength(4);
    expect(loaded.nodes.find((n) => n.id === "b1")?.status).toBe("active");
    expect(validateBranchGraph(loaded)).toEqual([]);
  });

  it("collects the cut subtree including children", () => {
    const graph: BranchGraph = {
      ...emptyBranchGraph(),
      nodes: [
        node("b1", "branch", "A", { parentId: "m1" }),
        node("b2", "branch", "A1", { parentId: "b1" }),
        node("g1", "gray", "A汇合", { parentId: "b1" }),
      ],
      edges: [
        { id: "e1", from: "b1", to: "b2", kind: "parent" },
        { id: "e2", from: "b2", to: "g1", kind: "parent" },
      ],
    };
    expect([...collectCutSubtree(graph, "b1")].sort()).toEqual(["b1", "b2", "g1"].sort());
  });

  it("cuts a branch and marks the subtree", async () => {
    const graph: BranchGraph = {
      ...emptyBranchGraph(),
      nodes: [
        node("m1", "mainline", "主线", { chapterRange: [1, 3] }),
        node("b1", "branch", "支线", { parentId: "m1", chapterRange: [4, 9] }),
        node("b2", "branch", "支线子", { parentId: "b1", chapterRange: [10, 14] }),
      ],
      edges: [
        { id: "e1", from: "m1", to: "b1", kind: "parent" },
        { id: "e2", from: "b1", to: "b2", kind: "parent" },
      ],
    };
    await saveBranchGraph(root, graph);
    const result = await cutBranch(root, "b1", "支线失控，砍掉重写");
    expect([...result.cutNodeIds].sort()).toEqual(["b1", "b2"].sort());
    expect(result.affectedChapterRange).toEqual({ min: 4, max: 14 });
    const loaded = await loadBranchGraph(root);
    expect([...loaded.nodes.filter((n) => n.status === "cut").map((n) => n.id)].sort()).toEqual(["b1", "b2"].sort());
    expect(loaded.edges).toEqual([]);
  });

  it("reports validation issues for malformed graphs", () => {
    const graph: BranchGraph = {
      ...emptyBranchGraph(),
      nodes: [
        node("b1", "branch", "无父分支"),
        node("g1", "gray", "无汇入"),
      ],
      edges: [{ id: "e1", from: "ghost", to: "g1", kind: "parent" }],
    };
    const issues = validateBranchGraph(graph);
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});
