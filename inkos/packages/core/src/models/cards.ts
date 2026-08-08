import { z } from "zod";

/**
 * 结构化卡片系统（设计文档 §8）
 * ---------------------------------------------------------------------------
 * 卡片是长篇创作中角色 / 地点 / 势力 / 物品的“单一事实来源”。
 * 权限：仅守护 Agent 与用户可修改；写作 / 审判 Agent 只读。
 */

export const CardTypeSchema = z.enum(["character", "location", "faction", "item"]);
export type CardType = z.infer<typeof CardTypeSchema>;

export const CardEditorSchema = z.enum(["guardian", "user"]);
export type CardEditor = z.infer<typeof CardEditorSchema>;

export const CARD_TYPE_LABELS: Record<CardType, { readonly zh: string; readonly en: string }> = {
  character: { zh: "角色", en: "Character" },
  location: { zh: "地点", en: "Location" },
  faction: { zh: "势力", en: "Faction" },
  item: { zh: "物品", en: "Item" },
};

/**
 * 角色卡（设计文档 §8 示例字段）。
 * 字段均为宽松字符串/字符串数组，便于 Agent 与用户共同维护。
 */
export const CharacterCardSchema = z.object({
  id: z.string().min(1),
  type: z.literal("character"),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  identity: z.string().default(""),
  personality: z.string().default(""),
  catchphrase: z.string().default(""),
  relationToProtagonist: z.string().default(""),
  goals: z.array(z.string()).default([]),
  growthArc: z.string().default(""),
  currentStatus: z.string().default(""),
  /** 出场章节区间 [start, end|null]，end 为 null 表示仍在出场 */
  chapterRange: z.tuple([z.number().int().min(0), z.number().int().min(0).nullable()]).default([0, null]),
  notes: z.string().default(""),
});

export const LocationCardSchema = z.object({
  id: z.string().min(1),
  type: z.literal("location"),
  name: z.string().min(1),
  region: z.string().default(""),
  description: z.string().default(""),
  significance: z.string().default(""),
  currentState: z.string().default(""),
  firstAppearanceChapter: z.number().int().min(0).default(0),
  notes: z.string().default(""),
});

export const FactionCardSchema = z.object({
  id: z.string().min(1),
  type: z.literal("faction"),
  name: z.string().min(1),
  goal: z.string().default(""),
  structure: z.string().default(""),
  members: z.array(z.string()).default([]),
  relationToProtagonist: z.string().default(""),
  currentState: z.string().default(""),
  notes: z.string().default(""),
});

export const ItemCardSchema = z.object({
  id: z.string().min(1),
  type: z.literal("item"),
  name: z.string().min(1),
  kind: z.string().default(""),
  abilities: z.string().default(""),
  owner: z.string().default(""),
  history: z.string().default(""),
  currentLocation: z.string().default(""),
  notes: z.string().default(""),
});

export const StoryCardSchema = z.discriminatedUnion("type", [
  CharacterCardSchema,
  LocationCardSchema,
  FactionCardSchema,
  ItemCardSchema,
]);
export type StoryCard = z.infer<typeof StoryCardSchema>;

/** 卡片共同元数据（与类型化字段分开存储，保持校验简单） */
export const CardMetaSchema = z.object({
  /** 乐观锁版本号，每次修改 +1 */
  version: z.number().int().min(1).default(1),
  /** 锁定后仅用户可改（用户锁定 = 该卡片不再被守护 Agent 自动更新） */
  locked: z.boolean().default(false),
  updatedBy: CardEditorSchema.default("guardian"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type CardMeta = z.infer<typeof CardMetaSchema>;

/** 存储形态：类型化卡片 + 元数据 */
export const StoredCardSchema = z.object({
  card: StoryCardSchema,
  meta: CardMetaSchema,
});
export type StoredCard = z.infer<typeof StoredCardSchema>;

/** 全书卡片集（按类型分组，落盘 story/cards/*.json） */
export const CardsBundleSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  characters: z.array(StoredCardSchema).default([]),
  locations: z.array(StoredCardSchema).default([]),
  factions: z.array(StoredCardSchema).default([]),
  items: z.array(StoredCardSchema).default([]),
});
export type CardsBundle = z.infer<typeof CardsBundleSchema>;

/** 卡片墙展示用的扁平视图 */
export interface CardView {
  readonly id: string;
  readonly type: CardType;
  readonly name: string;
  readonly summary: string;
  readonly meta: CardMeta;
}

export function emptyCardsBundle(): CardsBundle {
  return { schemaVersion: 1, characters: [], locations: [], factions: [], items: [] };
}

/** 从类型化卡片生成检索/展示用摘要文本 */
export function cardSummaryText(card: StoryCard): string {
  const parts: string[] = [card.name];
  switch (card.type) {
    case "character":
      parts.push(
        card.identity, card.personality, card.catchphrase,
        card.relationToProtagonist, card.currentStatus,
        ...card.goals, card.growthArc,
      );
      break;
    case "location":
      parts.push(card.region, card.description, card.significance, card.currentState);
      break;
    case "faction":
      parts.push(card.goal, card.structure, card.relationToProtagonist, card.currentState, ...card.members);
      break;
    case "item":
      parts.push(card.kind, card.abilities, card.owner, card.history, card.currentLocation);
      break;
  }
  return parts.filter(Boolean).join(" | ");
}
