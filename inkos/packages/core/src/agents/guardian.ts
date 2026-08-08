import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import type { StoredCard } from "../models/cards.js";
import { loadCards } from "../state/card-store.js";
import { loadBranchGraph } from "../state/branch-store.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parsePendingHooksMarkdown } from "../utils/story-markdown.js";
import type { StoredHook } from "../state/memory-db.js";

/**
 * 守护 Agent（设计文档 §5 / §6.3 T3）
 * ---------------------------------------------------------------------------
 * 每章开头检查：
 *   1. 伏笔铺/收：该铺的伏笔有没有铺、该收的线有没有丢、到期伏笔提醒
 *   2. 卡片一致性：卡片与正典状态/章节摘要核对
 *   3. 戏份监控：支线角色出场占比是否超过主角（超过判定为崩）
 * 仅守护 Agent 与用户可修改卡片（设计文档 §8）。
 */

export interface GuardianIssue {
  readonly severity: "critical" | "warning" | "info";
  readonly category: "hook" | "card" | "screen-time" | "consistency";
  readonly description: string;
  readonly suggestion: string;
}

export interface GuardianReport {
  readonly chapterNumber: number;
  readonly issues: ReadonlyArray<GuardianIssue>;
  readonly reminders: ReadonlyArray<string>;
  /** 建议更新的卡片（仅提示，不直接写入；由调用方决定是否落盘） */
  readonly suggestedCardUpdates: ReadonlyArray<{ readonly cardId: string; readonly field: string; readonly value: string; readonly reason: string }>;
  readonly passed: boolean;
  readonly summary: string;
}

export interface ScreenTimeSample {
  readonly characterId: string;
  readonly name: string;
  readonly mentionCount: number;
  readonly ratio: number;
}

const DEFAULT_SCREEN_TIME_WINDOW = 20;

/** 确定性戏份统计：统计最近 N 章正文中每个角色的名字出现次数（不依赖 LLM） */
export async function computeScreenTime(
  bookDir: string,
  cards: ReadonlyArray<StoredCard>,
  windowChapters = DEFAULT_SCREEN_TIME_WINDOW,
): Promise<ReadonlyArray<ScreenTimeSample>> {
  const chaptersDir = join(bookDir, "chapters");
  let files: string[];
  try {
    files = await readdir(chaptersDir);
  } catch {
    return [];
  }
  const chapterFiles = files
    .filter((f) => /^\d{4}_.+\.md$/u.test(f) || /^\d{1,4}_/.test(f))
    .sort();
  const recent = chapterFiles.slice(-windowChapters);
  const texts: string[] = [];
  for (const file of recent) {
    try {
      texts.push(await readFile(join(chaptersDir, file), "utf-8"));
    } catch {
      // 忽略读取失败
    }
  }
  const corpus = texts.join("\n");
  const samples: ScreenTimeSample[] = [];
  for (const stored of cards) {
    if (stored.card.type !== "character") continue;
    const name = stored.card.name;
    if (!name) continue;
    const pattern = new RegExp(escapeRegExp(name), "gu");
    const mentions = corpus.match(pattern)?.length ?? 0;
    samples.push({
      characterId: stored.card.id,
      name,
      mentionCount: mentions,
      ratio: corpus.length > 0 ? mentions / (corpus.length / 100) : 0,
    });
  }
  return samples.sort((a, b) => b.mentionCount - a.mentionCount);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface GuardianInput {
  readonly book: Pick<BookConfig, "title" | "genre">;
  readonly bookDir: string;
  readonly chapterNumber: number;
  /** 下一章创作意图（Planner 输出，可为空） */
  readonly chapterIntent?: string;
  /** 支线戏份阈值：支线占比超过该阈值视为崩（默认 0.3 提醒 / 0.4 告警） */
  readonly sideCharacterThresholds?: { readonly warn: number; readonly critical: number };
  readonly language?: "zh" | "en";
}

export interface GuardianRunResult {
  readonly report: GuardianReport;
  readonly screenTime: ReadonlyArray<ScreenTimeSample>;
  readonly hooks: ReadonlyArray<StoredHook>;
  readonly cards: CardsSnapshot;
  readonly tokenUsage?: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number };
}

export interface CardsSnapshot {
  readonly bundle: Awaited<ReturnType<typeof loadCards>>;
}

function buildGuardianPrompt(input: GuardianInput, hooksText: string, cardsText: string, branchText: string, screenTimeText: string): string {
  const isEnglish = input.language === "en";
  const intentBlock = input.chapterIntent ? `\n- 本章创作意图：${input.chapterIntent}` : "";
  return isEnglish
    ? `You are the Story Guardian. Before chapter ${input.chapterNumber} is written, check:
1. Hook plant/payoff: are due hooks about to be paid off? Are promised plants missing?
2. Card consistency: do cards match the current canon state?
3. Screen time: does any side character's share exceed the protagonist's (that is a collapse)?
Book: ${input.book.title} (${input.book.genre})${intentBlock}

## Pending hooks
${hooksText || "(none)"}

## Cards
${cardsText || "(none)"}

## Branch graph
${branchText || "(none)"}

## Screen time (last window)
${screenTimeText || "(none)"}

Output JSON only:
{"issues":[{"severity":"critical|warning|info","category":"hook|card|screen-time|consistency","description":"...","suggestion":"..."}],"reminders":["..."],"suggestedCardUpdates":[{"cardId":"...","field":"...","value":"...","reason":"..."}],"passed":true|false,"summary":"..."}`
    : `你是故事守护 Agent。在写第 ${input.chapterNumber} 章之前，请检查：
1. 伏笔铺/收：该铺的伏笔有没有铺、该收的线有没有丢、到期伏笔是否即将回收
2. 卡片一致性：卡片内容与当前正典状态是否一致（角色状态、地点状态等）
3. 戏份监控：是否有支线角色戏份占比超过主角（超过即崩）
书籍：${input.book.title}（${input.book.genre}）${intentBlock}

## 待处理伏笔
${hooksText || "（无）"}

## 卡片
${cardsText || "（无）"}

## 分支图谱
${branchText || "（无）"}

## 近期戏份统计
${screenTimeText || "（无）"}

只输出 JSON：
{"issues":[{"severity":"critical|warning|info","category":"hook|card|screen-time|consistency","description":"问题描述","suggestion":"建议"}],"reminders":["提醒1"],"suggestedCardUpdates":[{"cardId":"卡片id","field":"字段","value":"新值","reason":"原因"}],"passed":true|false,"summary":"总结"}`;
}

export class GuardianAgent extends BaseAgent {
  override get name(): string {
    return "guardian";
  }

  async guard(input: GuardianInput): Promise<GuardianRunResult> {
    const [cards, branchGraph, hooksMarkdown] = await Promise.all([
      loadCards(input.bookDir),
      loadBranchGraph(input.bookDir),
      readFile(join(input.bookDir, "story", "pending_hooks.md"), "utf-8").catch(() => ""),
    ]);
    const hooks = parsePendingHooksMarkdown(hooksMarkdown);
    const allCards = [
      ...cards.characters, ...cards.locations, ...cards.factions, ...cards.items,
    ];
    const screenTime = await computeScreenTime(input.bookDir, allCards);

    const cardsText = renderCardsText(allCards);
    const branchText = renderBranchText(branchGraph.nodes.map((n) => n));
    const screenTimeText = renderScreenTimeText(screenTime);
    const thresholds = input.sideCharacterThresholds ?? { warn: 0.3, critical: 0.4 };

    // 确定性检查（不依赖 LLM）：戏份告警
    const deterministicIssues: GuardianIssue[] = [];
    const protagonist = allCards.find((c) => c.card.type === "character" && c.card.relationToProtagonist === "主角");
    const protagonistSample = protagonist
      ? screenTime.find((s) => s.characterId === protagonist.card.id)
      : undefined;
    const protagonistCount = protagonistSample?.mentionCount ?? 0;
    for (const sample of screenTime) {
      if (sample.characterId === protagonist?.card.id) continue;
      if (protagonistCount === 0) continue;
      const sideRatio = sample.mentionCount / Math.max(1, protagonistCount);
      if (sideRatio >= thresholds.critical) {
        deterministicIssues.push({
          severity: "critical",
          category: "screen-time",
          description: `支线角色「${sample.name}」戏份占比达到主角的 ${Math.round(sideRatio * 100)}%，超过告警阈值 ${Math.round(thresholds.critical * 100)}%`,
          suggestion: "收敛该支线戏份，将笔墨还给主角主线",
        });
      } else if (sideRatio >= thresholds.warn) {
        deterministicIssues.push({
          severity: "warning",
          category: "screen-time",
          description: `支线角色「${sample.name}」戏份占比达到主角的 ${Math.round(sideRatio * 100)}%，超过提醒阈值 ${Math.round(thresholds.warn * 100)}%`,
          suggestion: "留意支线膨胀，下一章优先推进主线",
        });
      }
    }

    // LLM 综合检查
    const prompt = buildGuardianPrompt(input, hooksMarkdown, cardsText, branchText, screenTimeText);
    let llmIssues: GuardianIssue[] = [];
    let reminders: string[] = [];
    let suggestedCardUpdates: GuardianReport["suggestedCardUpdates"] = [];
    let summary = "";
    let passed = deterministicIssues.length === 0;
    let tokenUsage: GuardianRunResult["tokenUsage"];

    try {
      const response = await this.chat([
        { role: "system", content: "你输出严格 JSON，不要包含多余文本。" },
        { role: "user", content: prompt },
      ], { temperature: 0.2 });
      tokenUsage = response.usage;
      const parsed = parseGuardianJson(response.content);
      if (parsed) {
        llmIssues = parsed.issues ?? [];
        reminders = parsed.reminders ?? [];
        suggestedCardUpdates = parsed.suggestedCardUpdates ?? [];
        summary = parsed.summary ?? "";
        passed = deterministicIssues.length === 0 && (parsed.passed ?? true);
      } else {
        summary = "（守护 Agent 输出无法解析，仅采用确定性检查结果）";
      }
    } catch (error) {
      this.log?.warn(`[guardian] LLM check failed: ${String(error)}; using deterministic checks only`);
      summary = "（守护 Agent LLM 检查失败，仅采用确定性检查结果）";
    }

    const issues = [...deterministicIssues, ...llmIssues];
    return {
      report: {
        chapterNumber: input.chapterNumber,
        issues,
        reminders,
        suggestedCardUpdates,
        passed: passed && issues.filter((i) => i.severity === "critical").length === 0,
        summary,
      },
      screenTime,
      hooks,
      cards: { bundle: cards },
      tokenUsage,
    };
  }
}

function renderCardsText(cards: ReadonlyArray<StoredCard>): string {
  return cards.map((stored) => {
    const c = stored.card;
    const summary = [
      c.name, c.type,
      ...(c.type === "character" ? [c.identity, c.personality, c.catchphrase, c.relationToProtagonist, c.currentStatus] : []),
      ...(c.type === "location" ? [c.region, c.description, c.currentState] : []),
      ...(c.type === "faction" ? [c.goal, c.structure, c.relationToProtagonist, c.currentState] : []),
      ...(c.type === "item" ? [c.kind, c.abilities, c.owner, c.currentLocation] : []),
    ].filter(Boolean).join(" | ");
    return `- [${c.id}] ${summary}${stored.meta.locked ? "（锁定）" : ""}`;
  }).join("\n");
}

function renderBranchText(nodes: ReadonlyArray<{ id: string; type: string; title: string; chapterRange: readonly [number, number]; status: string }>): string {
  return nodes.map((n) => `- [${n.id}] ${n.type} ${n.title} 章节${n.chapterRange[0]}-${n.chapterRange[1]} 状态:${n.status}`).join("\n");
}

function renderScreenTimeText(samples: ReadonlyArray<ScreenTimeSample>): string {
  return samples.map((s) => `- ${s.name} (${s.characterId}): ${s.mentionCount} 次`).join("\n");
}

function parseGuardianJson(content: string): {
  issues?: GuardianIssue[];
  reminders?: string[];
  suggestedCardUpdates?: GuardianReport["suggestedCardUpdates"];
  passed?: boolean;
  summary?: string;
} | null {
  const jsonMatch = content.match(/\{[\s\S]*\}/u);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as ReturnType<typeof parseGuardianJson>;
  } catch {
    return null;
  }
}

