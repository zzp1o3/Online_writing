import { useEffect, useMemo, useState } from "react";
import { useApi, fetchJson } from "../hooks/use-api";
import { useColors } from "../hooks/use-colors";
import { tr } from "../lib/app-language";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { Loader2, Lock, Unlock, FileText, ScrollText, Users, ShieldCheck, BookOpen } from "lucide-react";

/**
 * 设定工作台（设计文档 §11）
 * ---------------------------------------------------------------------------
 * Architect 产出逐项展示（世界观 / 主线大纲 / 角色 / 规则），
 * 用户可修改（跳转 TruthFiles 编辑）并锁定基线——锁定后 AI 不得再改动。
 */

interface TruthEntry {
  readonly name: string;
  readonly size: number;
  readonly preview: string;
  readonly legacy?: true;
  readonly readonly?: true;
  readonly readonlyReason?: string;
}

interface SettingBaseline {
  readonly lockedFiles: ReadonlyArray<string>;
}

interface Nav {
  toBook: (id: string) => void;
  toTruth: (bookId: string) => void;
}

/** 设定文件分组：按目录归类并给出友好标题 */
const CATEGORY_LABELS: ReadonlyArray<{ readonly key: string; readonly label: string; readonly icon: React.ReactNode; readonly match: (f: string) => boolean }> = [
  { key: "outline", label: tr("世界观与大纲", "World & Outline"), icon: <BookOpen size={14} />, match: (f) => f.startsWith("outline/") },
  { key: "roles", label: tr("角色设定", "Character sheets"), icon: <Users size={14} />, match: (f) => f.startsWith("roles/") },
  { key: "rules", label: tr("规则与正典", "Rules & canon"), icon: <ShieldCheck size={14} />, match: (f) => f === "book_rules.md" || f === "story_bible.md" || f === "current_state.md" || f === "pending_hooks.md" },
  { key: "other", label: tr("其他", "Other"), icon: <FileText size={14} />, match: () => true },
];

export default function SettingWorkbench({
  bookId,
  nav,
  theme,
  t,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const c = useColors(theme);
  const { data: filesData, loading, error, refetch: refetchFiles } = useApi<{ files: ReadonlyArray<TruthEntry> }>(`/books/${bookId}/truth`);
  const { data: baseline, refetch: refetchBaseline } = useApi<SettingBaseline>(`/books/${bookId}/settings-baseline`);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const lockedSet = useMemo(() => new Set(baseline?.lockedFiles ?? []), [baseline]);

  const files = filesData?.files ?? [];

  const grouped = useMemo(() => {
    const visible = files.filter((f) => !f.readonly && !f.name.startsWith("runtime/"));
    return CATEGORY_LABELS.map((cat) => ({
      ...cat,
      files: visible.filter((f) => cat.match(f.name)),
    })).filter((g) => g.files.length > 0);
  }, [files]);

  const toggleLock = async (file: string, locked: boolean) => {
    setToggling(file);
    setActionError(null);
    try {
      await fetchJson(`/books/${bookId}/settings-baseline/${encodeURIComponent(file)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked }),
      });
      await refetchBaseline();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(null);
    }
  };

  if (loading && files.length === 0) return <div className="flex items-center justify-center py-32"><Loader2 className="animate-spin text-primary" size={24} /></div>;
  if (error) return <div className={`p-8 rounded-xl border ${c.error}`}>{t("common.error")}: {error}</div>;

  return (
    <div className="flex flex-col min-h-full gap-5 px-6 py-8 max-w-5xl mx-auto w-full" data-testid="setting-workbench">
      <div className="flex items-center gap-3 shrink-0">
        <button onClick={() => nav.toBook(bookId)} className={`text-sm ${c.link}`}>
          ← {t("bread.books")}
        </button>
        <h1 className="text-xl font-serif font-semibold">{tr("设定工作台", "Setting Workbench")}</h1>
        <span className="text-xs text-muted-foreground">
          {tr("锁定基线后 AI 不再改动 · 点击条目进入编辑器", "Lock a baseline so AI won't change it · click an entry to edit")}
        </span>
        <button onClick={() => { void refetchFiles(); void refetchBaseline(); }} className={`ml-auto text-xs ${c.btnSecondary} px-3 py-1.5 rounded-md`}>
          {tr("刷新", "Refresh")}
        </button>
      </div>

      {actionError && <div className={`rounded-lg border px-3 py-2 text-xs ${c.error} shrink-0`}>{actionError}</div>}

      {grouped.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-24 text-sm text-muted-foreground">
          {tr("还没有设定文件，先生成基础设定", "No setting files yet — generate a foundation first")}
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <div key={group.key} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 text-sm font-medium">
                {group.icon}
                {group.label}
                <span className="text-xs text-muted-foreground">({group.files.length})</span>
              </div>
              <div className="divide-y divide-border/40">
                {group.files.map((file) => {
                  const locked = lockedSet.has(file.name);
                  return (
                    <div key={file.name} className="flex items-center gap-3 px-4 py-2.5">
                      <button
                        onClick={() => nav.toTruth(bookId)}
                        className="min-w-0 flex-1 text-left"
                        title={tr("编辑此文件", "Edit this file")}
                      >
                        <div className="flex items-center gap-2 text-sm">
                          <ScrollText size={13} className="shrink-0 text-muted-foreground" />
                          <span className="truncate font-mono">{file.name}</span>
                          {file.legacy && (
                            <span className="shrink-0 rounded bg-amber-500/15 text-amber-500 px-1.5 py-0.5 text-[10px]">
                              {tr("兼容指针", "legacy shim")}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 pl-5 text-xs text-muted-foreground/60 truncate">
                          {file.preview || tr("（空）", "(empty)")}
                        </div>
                      </button>
                      <button
                        onClick={() => void toggleLock(file.name, !locked)}
                        disabled={toggling === file.name}
                        className={`shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                          locked
                            ? "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25"
                            : "bg-secondary/50 text-muted-foreground hover:text-foreground"
                        }`}
                        title={locked ? tr("解锁（AI 可再改）", "Unlock (AI may change again)") : tr("锁定基线（AI 不得改动）", "Lock baseline (AI won't change)")}
                      >
                        {toggling === file.name ? <Loader2 size={12} className="animate-spin" /> : locked ? <Lock size={12} /> : <Unlock size={12} />}
                        {locked ? tr("已锁定", "Locked") : tr("锁定基线", "Lock")}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
