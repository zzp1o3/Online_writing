import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptySettingBaseline,
  loadSettingBaseline,
  setSettingLock,
} from "../state/setting-baseline.js";

describe("setting-baseline", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-baseline-"));
    roots.push(root);
    return root;
  }

  it("returns an empty baseline when no file exists", async () => {
    const root = await fixture();
    const baseline = await loadSettingBaseline(root);
    expect(baseline.lockedFiles).toEqual([]);
  });

  it("locks and unlocks a setting file", async () => {
    const root = await fixture();
    const locked = await setSettingLock(root, "outline/story_frame.md", true);
    expect(locked.lockedFiles).toContain("outline/story_frame.md");

    const reloaded = await loadSettingBaseline(root);
    expect(reloaded.lockedFiles).toEqual(["outline/story_frame.md"]);

    const unlocked = await setSettingLock(root, "outline/story_frame.md", false);
    expect(unlocked.lockedFiles).toEqual([]);
  });

  it("persists to story/settings_baseline.json", async () => {
    const root = await fixture();
    await setSettingLock(root, "roles/主角.md", true);
    const raw = JSON.parse(await readFile(join(root, "story", "settings_baseline.json"), "utf-8")) as { lockedFiles: string[] };
    expect(raw.lockedFiles).toEqual(["roles/主角.md"]);
  });

  it("keeps lock idempotent", async () => {
    const root = await fixture();
    await setSettingLock(root, "a.md", true);
    const again = await setSettingLock(root, "a.md", true);
    expect(again.lockedFiles.filter((f) => f === "a.md")).toHaveLength(1);
  });

  it("emptySettingBaseline has the expected shape", () => {
    const base = emptySettingBaseline(new Date("2026-01-01T00:00:00.000Z"));
    expect(base).toEqual({ schemaVersion: 1, lockedFiles: [], updatedAt: "2026-01-01T00:00:00.000Z" });
  });
});
