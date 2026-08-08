import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CardPermissionError,
  getCard,
  loadCards,
  removeCard,
  upsertCard,
} from "../state/card-store.js";
import { CharacterCardSchema, type StoryCard } from "../models/cards.js";

describe("card store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-cards-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const heroCard = (): StoryCard => ({
    id: "hero",
    type: "character",
    name: "林砚",
    aliases: ["砚哥"],
    identity: "落霞城少主",
    personality: "冷静果决",
    catchphrase: "有意思。",
    relationToProtagonist: "主角",
    goals: ["夺回传家宝"],
    growthArc: "从纨绔到执棋者",
    currentStatus: "身受内伤",
    chapterRange: [1, null],
    notes: "",
  });

  it("creates and reads back cards", async () => {
    await upsertCard(root, heroCard(), "guardian", new Date("2026-08-08T00:00:00.000Z"));
    const bundle = await loadCards(root);
    expect(bundle.characters).toHaveLength(1);
    expect(bundle.characters[0]?.card.name).toBe("林砚");
    expect(bundle.characters[0]?.meta.version).toBe(1);
    expect(bundle.characters[0]?.meta.updatedBy).toBe("guardian");

    const found = await getCard(root, "hero");
    expect(found?.card.type).toBe("character");
  });

  it("increments version on update and preserves updatedBy", async () => {
    await upsertCard(root, heroCard(), "guardian");
    await upsertCard(root, { ...CharacterCardSchema.parse(heroCard()), currentStatus: "伤势痊愈" }, "user");
    const found = await getCard(root, "hero");
    expect(found?.meta.version).toBe(2);
    expect(found?.meta.updatedBy).toBe("user");
    expect(found?.card.type === "character" && found.card.currentStatus).toBe("伤势痊愈");
  });

  it("rejects unknown editors", async () => {
    await expect(upsertCard(root, heroCard(), "writer" as never)).rejects.toThrow(CardPermissionError);
  });

  it("locked cards can only be edited by the user", async () => {
    await upsertCard(root, heroCard(), "user");
    // 用户锁定卡片
    const bundle = await loadCards(root);
    bundle.characters[0]!.meta.locked = true;
    const { saveCards } = await import("../state/card-store.js");
    await saveCards(root, bundle);

    await expect(upsertCard(root, { ...CharacterCardSchema.parse(heroCard()), currentStatus: "被守护改" }, "guardian"))
      .rejects.toThrow(CardPermissionError);
    await upsertCard(root, { ...CharacterCardSchema.parse(heroCard()), currentStatus: "被用户改" }, "user");
    const found = await getCard(root, "hero");
    expect(found?.card.type === "character" && found.card.currentStatus).toBe("被用户改");
  });

  it("removes cards and handles missing files gracefully", async () => {
    expect(await loadCards(root)).toEqual({ schemaVersion: 1, characters: [], locations: [], factions: [], items: [] });
    await upsertCard(root, heroCard(), "guardian");
    expect(await removeCard(root, "hero", "user")).toBe(true);
    expect(await removeCard(root, "hero", "user")).toBe(false);
    expect(await getCard(root, "hero")).toBeNull();
  });
});
