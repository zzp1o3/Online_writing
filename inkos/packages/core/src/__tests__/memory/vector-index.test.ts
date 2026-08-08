import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildChapterChunkText,
  keywordSearch,
  searchVectorIndex,
  upsertVectorEntries,
} from "../../memory/vector-index.js";
import { retrieveForTiming, renderRetrievalContext } from "../../memory/retrieval.js";

describe("vector index", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-vector-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("falls back to keyword search when embedding is unavailable", async () => {
    await upsertVectorEntries({
      bookDir: root,
      entries: [
        { id: "ch1", source: "chapter", ref: "1", text: buildChapterChunkText("林砚踏入落霞城，暗流涌动。", "第一章 入城") },
        { id: "ch2", source: "chapter", ref: "2", text: buildChapterChunkText("苏晚在码头归还钥匙。", "第二章 还钥") },
      ],
    });

    const result = await searchVectorIndex({ bookDir: root, query: "落霞城 暗流", topK: 2 });
    expect(result.mode).toBe("keyword");
    expect(result.hits[0]?.entry.ref).toBe("1");
  });

  it("filters by source", async () => {
    await upsertVectorEntries({
      bookDir: root,
      entries: [
        { id: "c1", source: "card", ref: "hero", text: "林砚：落霞城少主，冷静果决" },
        { id: "b1", source: "branch", ref: "b1", text: "旧案支线：第5-12章" },
      ],
    });
    const result = await searchVectorIndex({ bookDir: root, query: "旧案", topK: 5, sourceFilter: ["branch"] });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.entry.source).toBe("branch");
  });

  it("upsert replaces an existing entry", async () => {
    await upsertVectorEntries({
      bookDir: root,
      entries: [{ id: "c1", source: "card", ref: "hero", text: "旧版" }],
    });
    await upsertVectorEntries({
      bookDir: root,
      entries: [{ id: "c1", source: "card", ref: "hero", text: "新版：林砚已突破" }],
    });
    const result = await searchVectorIndex({ bookDir: root, query: "突破", topK: 5 });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.entry.text).toBe("新版：林砚已突破");
  });

  it("timing retrieval renders context blocks", async () => {
    await upsertVectorEntries({
      bookDir: root,
      entries: [
        { id: "v1", source: "volume-summary", ref: "卷1", text: "第一卷：落霞城风云" },
        { id: "v2", source: "volume-summary", ref: "卷2", text: "第二卷：京城棋局" },
      ],
    });
    const result = await retrieveForTiming({
      bookDir: root,
      timing: "chapter-plan",
      query: "京城 棋局",
    });
    expect(result.timing).toBe("chapter-plan");
    expect(result.hits.length).toBeGreaterThan(0);
    const context = renderRetrievalContext(result);
    expect(context).toContain("京城棋局");
  });
});

