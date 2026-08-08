import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 设定基线锁定（设计文档 §11 设定工作台 / §12）
 * ---------------------------------------------------------------------------
 * 用户可对每份设定产出（outline/story_frame.md、outline/volume_map.md、
 * roles/*.md、book_rules.md 等）"锁定基线"——锁定后 AI 后续重生成不得改动，
 * 仅用户可解锁。
 * 落盘：<bookDir>/story/settings_baseline.json
 */

export interface SettingBaseline {
  readonly schemaVersion: 1;
  /** 已锁定基线的设定文件（story 目录相对路径，如 outline/story_frame.md） */
  readonly lockedFiles: ReadonlyArray<string>;
  readonly updatedAt: string;
}

function baselinePath(bookDir: string): string {
  return join(bookDir, "story", "settings_baseline.json");
}

export function emptySettingBaseline(now = new Date()): SettingBaseline {
  return { schemaVersion: 1, lockedFiles: [], updatedAt: now.toISOString() };
}

export async function loadSettingBaseline(bookDir: string): Promise<SettingBaseline> {
  try {
    const raw = await readFile(baselinePath(bookDir), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SettingBaseline>;
    return {
      schemaVersion: 1,
      lockedFiles: Array.isArray(parsed.lockedFiles) ? parsed.lockedFiles : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return emptySettingBaseline();
  }
}

export async function saveSettingBaseline(
  bookDir: string,
  baseline: SettingBaseline,
): Promise<void> {
  const path = baselinePath(bookDir);
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(path, JSON.stringify(baseline, null, 2), "utf-8");
}

/** 锁定 / 解锁一份设定文件 */
export async function setSettingLock(
  bookDir: string,
  file: string,
  locked: boolean,
  now = new Date(),
): Promise<SettingBaseline> {
  const baseline = await loadSettingBaseline(bookDir);
  const has = baseline.lockedFiles.includes(file);
  const next: SettingBaseline = {
    schemaVersion: 1,
    lockedFiles: locked
      ? (has ? baseline.lockedFiles : [...baseline.lockedFiles, file])
      : baseline.lockedFiles.filter((f) => f !== file),
    updatedAt: now.toISOString(),
  };
  await saveSettingBaseline(bookDir, next);
  return next;
}
