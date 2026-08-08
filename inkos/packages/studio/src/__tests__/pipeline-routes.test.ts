import { describe, it, expect } from "vitest";
import { parseHash, routeToHash } from "../hooks/use-hash-route";

// 长篇创作流水线路由（设计文档 §11）
describe("pipeline routes", () => {
  it("parses #/book/:id/branch-graph", () => {
    expect(parseHash("#/book/b1/branch-graph")).toEqual({ page: "branch-graph", bookId: "b1" });
  });

  it("parses #/book/:id/cards", () => {
    expect(parseHash("#/book/b1/cards")).toEqual({ page: "cards", bookId: "b1" });
  });

  it("parses #/book/:id/chapters/:n/approval", () => {
    expect(parseHash("#/book/b1/chapters/3/approval")).toEqual({ page: "chapter-approval", bookId: "b1", chapterNumber: 3 });
  });

  it("parses #/book/:id/pipeline", () => {
    expect(parseHash("#/book/b1/pipeline")).toEqual({ page: "pipeline-console", bookId: "b1" });
  });

  it("parses #/book/:id/workbench", () => {
    expect(parseHash("#/book/b1/workbench")).toEqual({ page: "setting-workbench", bookId: "b1" });
  });

  it("round-trips each pipeline route", () => {
    expect(routeToHash({ page: "branch-graph", bookId: "b1" })).toBe("#/book/b1/branch-graph");
    expect(routeToHash({ page: "cards", bookId: "b1" })).toBe("#/book/b1/cards");
    expect(routeToHash({ page: "chapter-approval", bookId: "b1", chapterNumber: 3 })).toBe("#/book/b1/chapters/3/approval");
    expect(routeToHash({ page: "pipeline-console", bookId: "b1" })).toBe("#/book/b1/pipeline");
    expect(routeToHash({ page: "setting-workbench", bookId: "b1" })).toBe("#/book/b1/workbench");
  });

  it("does not shadow the plain book route", () => {
    expect(parseHash("#/book/b1")).toEqual({ page: "book", bookId: "b1" });
    expect(parseHash("#/book/b1/settings")).toEqual({ page: "book-settings", bookId: "b1" });
  });
});
