import { useEffect, useMemo, useState } from "react";
import { useApi, postApi, fetchJson } from "../hooks/use-api";
import { useColors } from "../hooks/use-colors";
import { tr } from "../lib/app-language";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import {
  Loader2,
  Play,
  ShieldCheck,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Hourglass,
  GitBranch,
  Boxes,
  TerminalSquare,
  Sparkles,
} from "lucide-react";

/**
 * 流水线控制台（设计文档 §11）
 * ---------------------------------------------------------------------------
 * 阶段进度（阶段 0 输入 → 阶段 1 设定 → 阶段 2 逐章 → 阶段 3 分支 → 阶段 4 导出）、
 * 章节队列与审批状态、运行日志（SSE）、触发写下一章 / 守护检查。
 */

interface Nav {
  toBook: (id: string) => void;
  toChapterApproval: (bookId: string, chapterNumber: number) => void;
  toBranchGraph: (bookId: string) => void;
  toCards: (bookId: string) => void;
  toSettingWorkbench: (bookId: string) => void;
}

interface BookDetail {
  readonly book: { readonly id: string; readonly title: string; readonly genre: string; readonly status: string; readonly chaptersWritten: number };
  readonly chapters: ReadonlyArray<{ readonly number: number; readonly title: string; readonly status: string; readonly wordCount?: number }>;
  readonly nextChapter: number;
}

interface GuardianReport {
  readonly report: {
    readonly chapterNumber: number;
    readonly passed: boolean;
    readonly summary: string;
    readonly issues: ReadonlyArray<{ readonly severity: string; readonly category: string; readonly description: string; readonly suggestion: string }>;
    readonly reminders: ReadonlyArray<string>;
  };
  readonly screenTime: ReadonlyArray<{ readonly characterId: string; readonly name: string; readonly mentionCount: number; readonly ratio: number }>;
}

const APPROVAL_STATE_COLOR: Record<string, string> = {
  approved: "bg-emerald-500/15 text-emerald-500",
  human_pending: "bg-amber-500/15 text-amber-500",
  ai_reviewed: "bg-sky-500/15 text-sky-500",
  draft: "bg-muted text-muted-foreground",
  rejected_whole: "bg-rose-500/15 text-rose-500",
  rejected_partial: "bg-violet-500/15 text-violet-500",
};

export default function PipelineConsole({
  bookId,
  nav,
  theme,
  t,
  sse,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const c = useColors(theme);
  const { data: book, loading, error, refetch } = useApi<BookDetail>(`/books/${bookId}`);
  const [running, setRunning] = useState<"write" | "draft" | "guardian" | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [guardianResult, setGuardianResult] = useState<GuardianReport | null>(null);
  const [logLines, setLogLines] = useState<ReadonlyArray<{ at: string; kind: string; text: string }>>([]);

  // 订阅写章节相关 SSE
  useEffect(() => {
    const recent = sse.messages;
    if (recent.length === 0) return;
    const last = recent[recent.length - 1];
    if (!last || typeof last !== "object") return;
    const event = String(last.event ?? "");
    const payload = last.data && typeof last.data === "object"
      ? last.data as Record<string, unknown>
      : {};
    if (String(payload.bookId) !== bookId) return;
    const now = new Date().toISOString();
    if (event === "write:start" || event === "draft:start") {
      setRunning(event === "write:start" ? "write" : "draft");
      setLogLines((prev) => [...prev, { at: now, kind: "info", text: event === "write:start" ? "写下一章开始" : "起草开始" }]);
    } else if (event === "write:complete" || event === "draft:complete") {
      setRunning(null);
      setLogLines((prev) => [...prev, {
        at: now,
        kind: "success",
        text: `第 ${payload.chapterNumber} 章完成（${payload.title}，${payload.wordCount} 字）`,
      }]);
      void refetch();
    } else if (event === "write:error" || event === "draft:error") {
      setRunning(null);
      setLogLines((prev) => [...prev, { at: now, kind: "error", text: String(payload.error ?? "未知错误") }]);
    }
  }, [sse.messages, bookId, refetch]);

  const approvalStates = useApi<{ chapters: ReadonlyArray<{ chapterNumber: number; state: string }> }>(`/books/${bookId}/approval-ledger`);

  const chapterQueue = useMemo(() => {
    if (!book) return [];
    return book.chapters.slice().sort((a, b) => a.number - b.number);
  }, [book]);

  const approvalByChapter = useMemo(() => {
    const map = new Map<number, string>();
    if (approvalStates.data) {
      for (const ch of approvalStates.data.chapters) map.set(ch.chapterNumber, ch.state);
    }
    return map;
  }, [approvalStates.data]);

  const pendingCount = chapterQueue.filter((ch) => {
    const st = approvalByChapter.get(ch.number);
    return st === "human_pending" || st === "draft" || st === "ai_reviewed" || st === undefined;
  }).length;

  const triggerWrite = async () => {
    setRunError(null);
    setRunning("write");
    try {
      await postApi(`/books/${bookId}/write-next`);
    } catch (e) {
      setRunning(null);
      setRunError(e instanceof Error ? e.message : String(e));
    }
  };

  const triggerGuardian = async () => {
    setRunError(null);
    setRunning("guardian");
    try {
      const target = book?.nextChapter ?? 1;
      const result = await fetchJson<GuardianReport>(`/books/${bookId}/guardian-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapterNumber: target }),
      });
      setGuardianResult(result);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  if (loading && !book) return <div className="flex items-center justify-center py-32"><Loader2 className="animate-spin text-primary" size={24} /></div>;
  if (error) return <div className={`p-8 rounded-xl border ${c.error}`}>{t("common.error")}: {error}</div>;

  const stages = [
    { key: "input", label: tr("阶段 0 · 输入", "Stage 0 · Input"), icon: <FileText size={14} />, done: true },
    { key: "setting", label: tr("阶段 1 · 设定生成", "Stage 1 · Setting"), icon: <Boxes size={14} />, done: book ? book.chapters.length > 0 || book.book.status !== "drafting" : false },
    { key: "chapters", label: tr("阶段 2 · 逐章流水线", "Stage 2 · Chapters"), icon: <FileText size={14} />, done: book ? chapterQueue.some((ch) => approvalByChapter.get(ch.number) === "approved") : false },
    { key: "branch", label: tr("阶段 3 · 分支管理", "Stage 3 · Branches"), icon: <GitBranch size={14} />, done: false },
    { key: "export", label: tr("阶段 4 · 导出", "Stage 4 · Export"), icon: <Sparkles size={14} />, done: false },
  ];

  return (
    <div className="flex flex-col min-h-full gap-5 px-6 py-8 max-w-6xl mx-auto w-full" data-testid="pipeline-console">
      <div className="flex items-center gap-3 shrink-0">
        <button onClick={() => nav.toBook(bookId)} className={`text-sm ${c.link}`}>
          ← {t("bread.books")}
        </button>
        <h1 className="text-xl font-serif font-semibold">{tr("流水线控制台", "Pipeline Console")}</h1>
        <span className="text-xs text-muted-foreground">
          {book?.book.title}（{book?.book.genre}）
        </span>
      </div>

      {runError && <div className={`rounded-lg border px-3 py-2 text-xs ${c.error} shrink-0`}>{runError}</div>}

      {/* 阶段进度 */}
      <div className="rounded-xl border border-border bg-card p-5 shrink-0">
        <div className="text-sm font-medium mb-3">{tr("流水线阶段", "Pipeline stages")}</div>
        <div className="grid gap-2 sm:grid-cols-5">
          {stages.map((stage, i) => (
            <div key={stage.key} className={`rounded-lg border px-3 py-2.5 ${stage.done ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-muted/30"}`}>
              <div className="flex items-center gap-1.5 text-sm">
                {stage.icon}
                {stage.done ? <CheckCircle2 size={13} className="text-emerald-500" /> : <Hourglass size={13} className="text-muted-foreground" />}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{stage.label}</div>
              {i < stages.length - 1 && (
                <div className="mt-1.5 h-0.5 rounded bg-border relative overflow-hidden">
                  <div className={`absolute inset-y-0 left-0 transition-all ${stage.done ? "w-full bg-emerald-500/50" : "w-0"}`} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 章节队列 + 操作 */}
      <div className="grid gap-4 lg:grid-cols-[1fr_300px] items-start">
        <div className="space-y-4 min-w-0">
          {/* 章节队列 */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 text-xs text-muted-foreground">
              <TerminalSquare size={13} />
              {tr("章节队列", "Chapter queue")}
              <span className="ml-auto flex items-center gap-1">
                <span className="text-amber-500">{pendingCount}</span> {tr("待审批", "pending")}
              </span>
            </div>
            {chapterQueue.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                {tr("还没有章节，点击右侧「写下一章」开始", "No chapters yet — click Write next chapter")}
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {chapterQueue.slice().reverse().map((ch) => {
                  const state = approvalByChapter.get(ch.number) ?? "draft";
                  const stateColor = APPROVAL_STATE_COLOR[state] ?? APPROVAL_STATE_COLOR.draft;
                  return (
                    <button
                      key={ch.number}
                      onClick={() => nav.toChapterApproval(bookId, ch.number)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40 transition-colors"
                    >
                      <span className="text-muted-foreground text-xs w-8">#{String(ch.number).padStart(3, "0")}</span>
                      <span className="flex-1 truncate text-sm">{ch.title || `第 ${ch.number} 章`}</span>
                      {typeof ch.wordCount === "number" && <span className="text-xs text-muted-foreground/50">{ch.wordCount} 字</span>}
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${stateColor}`}>
                        {state === "approved" ? "已通过" : state === "human_pending" ? "待审批" : state === "ai_reviewed" ? "AI 已审" : state === "rejected_whole" ? "整章重来" : state === "rejected_partial" ? "局部重启" : "草稿"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 守护检查结果 */}
          {guardianResult && (
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck size={13} />
                {tr("守护检查 · 第", "Guardian · Ch")} {guardianResult.report.chapterNumber} 章
                <span className={`ml-auto inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${guardianResult.report.passed ? "bg-emerald-500/15 text-emerald-500" : "bg-rose-500/15 text-rose-500"}`}>
                  {guardianResult.report.passed ? "通过" : "存在问题"}
                </span>
              </div>
              {guardianResult.report.summary && <div className="text-sm text-foreground/90">{guardianResult.report.summary}</div>}
              {guardianResult.report.issues.length > 0 && (
                <div className="space-y-1.5">
                  {guardianResult.report.issues.map((issue, i) => (
                    <div key={i} className={`rounded-lg border px-3 py-2 text-xs ${issue.severity === "critical" ? "border-rose-500/40 bg-rose-500/5 text-rose-600 dark:text-rose-300" : issue.severity === "warning" ? "border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-300" : "border-border bg-muted/30 text-muted-foreground"}`}>
                      <div className="flex items-start gap-1.5">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        <div>
                          <div>{issue.description}</div>
                          <div className="opacity-80 mt-0.5">{issue.suggestion}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 运行日志 */}
          {logLines.length > 0 && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 text-xs text-muted-foreground">
                <TerminalSquare size={13} />
                {tr("运行日志", "Run log")}
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-border/30">
                {logLines.slice().reverse().map((line, i) => (
                  <div key={i} className={`px-4 py-1.5 text-xs font-mono ${line.kind === "error" ? "text-rose-500" : line.kind === "success" ? "text-emerald-500" : "text-muted-foreground"}`}>
                    <span className="opacity-50">{line.at.slice(11, 19)}</span> {line.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 操作面板 */}
        <div className="space-y-4 shrink-0">
          <div className="rounded-xl border border-border bg-card p-4 space-y-2">
            <div className="text-xs text-muted-foreground">{tr("触发任务", "Triggers")}</div>
            <button
              onClick={() => void triggerWrite()}
              disabled={running !== null}
              className={`w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm ${c.btnPrimary} disabled:opacity-50`}
            >
              {running === "write" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {tr("写下一章", "Write next chapter")}
            </button>
            <button
              onClick={() => void triggerGuardian()}
              disabled={running !== null}
              className={`w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm ${c.btnSecondary} disabled:opacity-50`}
            >
              {running === "guardian" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              {tr("运行守护检查", "Run guardian check")}
            </button>
          </div>

          <div className="rounded-xl border border-border bg-card p-4 space-y-1.5">
            <div className="text-xs text-muted-foreground">{tr("工作台", "Workbench")}</div>
            <button onClick={() => nav.toBranchGraph(bookId)} className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-muted/40 transition-colors">
              <GitBranch size={14} className="text-violet-500" />
              {tr("分支图谱", "Branch graph")}
            </button>
            <button onClick={() => nav.toCards(bookId)} className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-muted/40 transition-colors">
              <Boxes size={14} className="text-amber-500" />
              {tr("卡片墙", "Card wall")}
            </button>
            <button onClick={() => nav.toSettingWorkbench(bookId)} className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-muted/40 transition-colors">
              <FileText size={14} className="text-sky-500" />
              {tr("设定工作台", "Setting workbench")}
            </button>
          </div>

          {book && (
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="text-xs text-muted-foreground">{tr("概览", "Overview")}</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-muted/30 px-3 py-2">
                  <div className="text-xs text-muted-foreground">{tr("已写章节", "Chapters")}</div>
                  <div className="text-lg font-semibold">{chapterQueue.length}</div>
                </div>
                <div className="rounded-lg bg-muted/30 px-3 py-2">
                  <div className="text-xs text-muted-foreground">{tr("下一章", "Next")}</div>
                  <div className="text-lg font-semibold">{book.nextChapter}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
