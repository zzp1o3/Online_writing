import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CardMetaSchema,
  CardTypeSchema,
  CardsBundleSchema,
  CharacterCardSchema,
  FactionCardSchema,
  ItemCardSchema,
  LocationCardSchema,
  StoryCardSchema,
  type CardEditor,
  type CardsBundle,
  type CardType,
  type StoryCard,
  type StoredCard,
} from "../models/cards.js";

/**
 * 卡片存储（设计文档 §8）
 * 落盘：<bookDir>/story/cards/<type>.json（每类型一个文件，直接存 StoredCard 数组）
 * 权限：仅 guardian / user 可写；locked 卡片仅 user 可写。
 */

export class CardPermissionError extends Error {
  readonly code = "CARD_PERMISSION";

  constructor(message: string) {
    super(message);
    this.name = "CardPermissionError";
  }
}

const StoredCardArraySchema = z.array(z.object({
  card: StoryCardSchema,
  meta: CardMetaSchema,
}));

function cardsDir(bookDir: string): string {
  return join(bookDir, "story", "cards");
}

function cardFilePath(bookDir: string, type: CardType): string {
  return join(cardsDir(bookDir), `${type}.json`);
}

export function typeKey(type: CardType): "characters" | "locations" | "factions" | "items" {
  switch (type) {
    case "character": return "characters";
    case "location": return "locations";
    case "faction": return "factions";
    case "item": return "items";
  }
}

function parseStoredArray(raw: unknown): ReadonlyArray<StoredCard> {
  const parsed = StoredCardArraySchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

async function readTypeFile(bookDir: string, type: CardType): Promise<ReadonlyArray<StoredCard>> {
  try {
    const raw = await readFile(cardFilePath(bookDir, type), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parseStoredArray(parsed);
    }
    // 兼容整包结构 {"characters": [...]}
    const bundle = CardsBundleSchema.safeParse(parsed);
    if (bundle.success) return bundle.data[typeKey(type)];
    return [];
  } catch {
    return [];
  }
}

export async function loadCards(bookDir: string): Promise<CardsBundle> {
  const [characters, locations, factions, items] = await Promise.all([
    readTypeFile(bookDir, "character"),
    readTypeFile(bookDir, "location"),
    readTypeFile(bookDir, "faction"),
    readTypeFile(bookDir, "item"),
  ]);
  return { schemaVersion: 1, characters: [...characters], locations: [...locations], factions: [...factions], items: [...items] };
}

export async function saveCards(bookDir: string, bundle: CardsBundle): Promise<void> {
  const dir = cardsDir(bookDir);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(cardFilePath(bookDir, "character"), JSON.stringify(bundle.characters, null, 2), "utf-8"),
    writeFile(cardFilePath(bookDir, "location"), JSON.stringify(bundle.locations, null, 2), "utf-8"),
    writeFile(cardFilePath(bookDir, "faction"), JSON.stringify(bundle.factions, null, 2), "utf-8"),
    writeFile(cardFilePath(bookDir, "item"), JSON.stringify(bundle.items, null, 2), "utf-8"),
  ]);
}

export async function getCard(bookDir: string, cardId: string): Promise<StoredCard | null> {
  const bundle = await loadCards(bookDir);
  for (const list of [bundle.characters, bundle.locations, bundle.factions, bundle.items]) {
    const found = list.find((entry) => entry.card.id === cardId);
    if (found) return found;
  }
  return null;
}

export async function upsertCard(
  bookDir: string,
  card: StoryCard,
  editor: CardEditor,
  now = new Date(),
): Promise<StoredCard> {
  if (editor !== "guardian" && editor !== "user") {
    throw new CardPermissionError(`Unknown card editor: ${editor}`);
  }
  const bundle = await loadCards(bookDir);
  const list = bundle[typeKey(card.type)];
  const existing = list.find((entry) => entry.card.id === card.id);

  if (existing) {
    if (existing.meta.locked && editor !== "user") {
      throw new CardPermissionError(`Card "${card.id}" is locked; only the user can edit it`);
    }
    const updated: StoredCard = {
      card,
      meta: {
        ...existing.meta,
        version: existing.meta.version + 1,
        updatedBy: editor,
        updatedAt: now.toISOString(),
      },
    };
    bundle[typeKey(card.type)] = list.map((entry) => (entry.card.id === card.id ? updated : entry));
    await saveCards(bookDir, bundle);
    return updated;
  }

  const created: StoredCard = {
    card,
    meta: {
      version: 1,
      locked: false,
      updatedBy: editor,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  };
  bundle[typeKey(card.type)] = [...list, created];
  await saveCards(bookDir, bundle);
  return created;
}

export async function removeCard(
  bookDir: string,
  cardId: string,
  editor: CardEditor,
): Promise<boolean> {
  if (editor !== "guardian" && editor !== "user") {
    throw new CardPermissionError(`Unknown card editor: ${editor}`);
  }
  const bundle = await loadCards(bookDir);
  let removed = false;
  for (const type of CardTypeSchema.options) {
    const list = bundle[typeKey(type)];
    const existing = list.find((entry) => entry.card.id === cardId);
    if (!existing) continue;
    if (existing.meta.locked && editor !== "user") {
      throw new CardPermissionError(`Card "${cardId}" is locked; only the user can edit it`);
    }
    bundle[typeKey(type)] = list.filter((entry) => entry.card.id !== cardId);
    removed = true;
  }
  if (removed) await saveCards(bookDir, bundle);
  return removed;
}

export async function ensureCardsDirectory(bookDir: string): Promise<void> {
  await mkdir(cardsDir(bookDir), { recursive: true });
}

