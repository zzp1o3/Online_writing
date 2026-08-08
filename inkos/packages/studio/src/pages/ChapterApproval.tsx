import { useEffect, useMemo, useState } from "react";
import { useApi, fetchJson, postApi } from "../hooks/use-api";
import { useColors } from "../hooks/use-colors";
import { tr } from "../lib/app-language";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import {
  Loader2,
  Check,
  RotateCcw,
  Scissors,
  MessageSquare,
  History,
  ChevronLeft,
  ChevronRight,
  TerminalSquare,
} from "lucide-react";

/**
 * 章节审批面板（设计文档 §9 / §11）
 * ---------------------------------------------------------------------------
 * 正文阅读 + 审判报告 + 通过 / 整章重来 / 局部重启（划范围 + 指令）+ 留言。
 * 状态机：draft → ai_reviewed → human_pending → approved
 *                                   ├─ rejected_whole
 *                                   └─ rejected_partial
 */

export interface ChapterApproval {
  readonly chapterNumber: number;
  readonly state: "draft" | "ai_reviewed" | "human_pending" | "approved" | "rejected_whole" | "rejected_partial";
  readonly judgeSummary: string;
  readonly partialRestart?: {
    readonly range: readonly [number, number];
    readonly instruction: string;
    readonly status: string;
    readonly createdAt: string;
  };
  readonly events: ReadonlyArray<{ readonly state: string; readonly at: string; readonly by: string; readonly note: string }>;
  readonly updatedAt: string;
}

export interface ChapterContent {
  readonly chapterNumber: number;
  readonly filename: string;
  readonly content: string;
}

interface Nav {
  toBook: (id: string) => void;
  toChapter: (bookId: string, chapterNumber: number) => void;
}

const STATE_LABELS: Record<ChapterApproval["state"], { readonly zh: string; readonly en: string; readonly color: string }> = {
  draft: { zh: "草稿", en: "Draft", color: "bg-muted text-muted-foreground" },
  ai_reviewed: { zh: "AI 已审", en: "AI reviewed", color: "bg-sky-500/15 text-sky-500" },
  human_pending: { zh: "待人工审批", en: "Pending review", color: "bg-amber-500/15 text-amber-500" },
  approved: { zh: "已通过", en: "Approved", color: "bg-emerald-500/15 text-emerald-500" },
  rejected_whole: { zh: "整章重来", en: "Rejected", color: "bg-rose-500/15 text-rose-500" },
  rejected_partial: { zh: "局部重启", en: "Partial restart", color: "bg-violet-500/15 text-violet-500" },
};

export default function ChapterApprovalPage({
  bookId,
  chapterNumber,
  nav,
  theme,
  t,
}: {
  bookId: string;
  chapterNumber: number;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const c = useColors(theme);
  const { data: approval, loading: approvalLoading, error: approvalError, refetch: refetchApproval } = useApi<ChapterApproval>(`/books/${bookId}/chapters/${chapterNumber}/approval`);
  const { data: content, loading: contentLoading, error: contentError } = useApi<ChapterContent>(`/books/${bookId}/chapters/${chapterNumber}`);
  const [comment, setComment] = useState("");
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restartInstruction, setRestartInstruction] = useState("");
  const [restartRange, setRestartRange] = useState<readonly [number, number] | null>(null);
  const [selectionInfo, setSelectionInfo] = useState<string | null>(null);

  const [nextChapter, setNextChapter] = useState<number | null>(null);
  const [prevChapter, setPrevChapter] = useState<number | null>(null);
  const { data: chapters } = useApi<{ chapters: ReadonlyArray<{ number: number }> }>(`/books/${bookId}`);

  useEffect(() => {
    if (!chapters) return;
    const nums = chapters.chapters.map((ch) => ch.number).sort((a, b) => a - b);
    const idx = nums.indexOf(chapterNumber);
    setNextChapter(idx >= 0 && idx + 1 < nums.length ? nums[idx + 1] : null);
    setPrevChapter(idx > 0 ? nums[idx - 1] : null);
  }, [chapters, chapterNumber]);

  useEffect(() => {
    setActionError(null);
    setActionNote(null);
  }, [chapterNumber]);

  const body = useMemo(() => {
    if (!content) return "";
    const lines = content.content.split("\n");
    const titleLine = lines.find((l) => l.startsWith("# "));
    return lines.filter((l) => l !== titleLine).join("\n").trim();
  }, [content]);

  const title = useMemo(() => {
    if (!content) return "";
    const titleLine = content.content.split("\n").find((l) => l.startsWith("# "));
    return titleLine?.replace(/^#\s*/, "") ?? `第 ${chapterNumber} 章`;
  }, [content, chapterNumber]);

  const runAction = async (action: () => Promise<unknown>, successMsg: string) => {
    setActing(true);
    setActionError(null);
    setActionNote(null);
    try {
      await action();
      setActionNote(successMsg);
      await refetchApproval();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
    }
  };

  const handleApprove = () =>
    runAction(
      () => postApi(`/books/${bookId}/chapters/${chapterNumber}/approve`, { comment }),
      tr("已通过，正典已更新", "Approved — canon updated"),
    );

  const handleRejectWhole = () =>
    runAction(
      () => postApi(`/books/${bookId}/chapters/${chapterNumber}/reject`, { reason: comment }),
      tr("已整章重来，章节已回滚", "Rejected — chapter rolled back"),
    );

  const handlePartialRestart = () => {
    if (!restartRange || !restartInstruction.trim()) {
      setActionError(tr("请先在正文中选中一段文字，并填写修改指令", "Select a text range and write an instruction"));
      return;
    }
    return runAction(
      () => postApi(`/books/${bookId}/chapters/${chapterNumber}/partial-restart`, {
        range: [restartRange[0], restartRange[1]],
        instruction: restartInstruction.trim(),
      }),
      tr("局部重启任务已创建", "Partial restart queued"),
    );
  };

  const onTextSelection = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode?.parentElement) {
      setSelectionInfo(null);
      setRestartRange(null);
      return;
    }
    const text = sel.toString();
    if (!text.trim()) {
      setSelectionInfo(null);
      setRestartRange(null);
      return;
    }
    const container = sel.anchorNode.parentElement;
    const startNode = sel.anchorNode;
    const endNode = sel.focusNode;

    // 计算正文内偏移：把 DOM 文本位置映射回原字符串
    // 简化实现：搜索选中文本在 body 中的位置
    const idx = body.indexOf(text);
    if (idx >= 0) {
      const end = idx + text.length;
      setRestartRange([idx, end]);
      setSelectionInfo(tr(`已选中 ${text.length} 字（字符 ${idx}-${end}）`, `Selected ${text.length} chars (${idx}-${end})`));
    } else {
      setSelectionInfo(tr(`已选中 ${text.length} 字`, `Selected ${text.length} chars`));
    }
    void startNode; void endNode; void container;
  };

  const stateLabel = approval ? (STATE_LABELS[approval.state] ?? STATE_LABELS.draft) : null;

  if (contentLoading && !content) return <div className="flex items-center justify-center py-32"><Loader2 className="animate-spin text-primary" size={24} /></div>;
  if (contentError) return <div className={`p-8 rounded-xl border ${c.error}`}>{t("common.error")}: {contentError}</div>;

  return (
    <div className="flex flex-col min-h-full gap-4 px-6 py-8 max-w-5xl mx-auto w-full" data-testid="chapter-approval">
      {/* 顶部导航 */}
      <div className="flex items-center gap-3 shrink-0">
        <button onClick={() => nav.toBook(bookId)} className={`text-sm ${c.link}`}>
          ← {t("bread.books")}
        </button>
        <h1 className="text-xl font-serif font-semibold">{title}</h1>
        {stateLabel && (
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${stateLabel.color}`}>
            {stateLabel.zh}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {prevChapter && (
            <button onClick={() => nav.toChapter(bookId, prevChapter)} className={`p-1.5 rounded-md ${c.btnSecondary}`} aria-label={tr("上一章", "Prev chapter")}>
              <ChevronLeft size={15} />
            </button>
          )}
          {nextChapter && (
            <button onClick={() => nav.toChapter(bookId, nextChapter)} className={`p-1.5 rounded-md ${c.btnSecondary}`} aria-label={tr("下一章", "Next chapter")}>
              <ChevronRight size={15} />
            </button>
          )}
        </div>
      </div>

      {actionError && <div className={`rounded-lg border px-3 py-2 text-xs ${c.error} shrink-0`}>{actionError}</div>}
      {actionNote && <div className={`rounded-lg border px-3 py-2 text-xs ${c.info} shrink-0`}>{actionNote}</div>}

      <div className="grid gap-4 lg:grid-cols-[1fr_280px] items-start">
        {/* 正文阅读区 */}
        <div className="rounded-xl border border-border bg-card min-w-0">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 text-xs text-muted-foreground">
            <TerminalSquare size={13} />
            {tr("正文", "Content")}
            {selectionInfo && <span className="ml-auto text-primary">{selectionInfo}</span>}
          </div>
          <div
            className="px-6 py-5 prose prose-sm max-w-none dark:prose-invert whitespace-pre-wrap leading-relaxed select-text"
            onMouseUp={onTextSelection}
            onKeyUp={onTextSelection}
          >
            {body || tr("（本章暂无正文）", "(empty)")}
          </div>
        </div>

        {/* 审批操作区 */}
        <div className="space-y-4 shrink-0">
          {/* 审判报告 */}
          <div className="rounded-xl border border-border bg-card p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <History size={13} />
              {tr("审判报告", "Judge report")}
              {approvalLoading && <Loader2 size={12} className="animate-spin" />}
            </div>
            {approvalError && <div className={`text-xs ${c.error}`}>{approvalError}</div>}
            <div className="text-sm text-foreground/90 whitespace-pre-wrap">
              {approval?.judgeSummary || tr("（暂无审判报告）", "(no judge report)")}
            </div>
            {approval?.partialRestart && (
              <div className="rounded-lg bg-violet-500/10 border border-violet-500/30 px-3 py-2 text-xs text-violet-600 dark:text-violet-300">
                <div className="font-medium">{tr("上次局部重启", "Last partial restart")}</div>
                <div className="mt-1">[{approval.partialRestart.range[0]}-{approval.partialRestart.range[1]}] {approval.partialRestart.instruction}</div>
              </div>
            )}
          </div>

          {/* 审批操作 */}
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="text-xs text-muted-foreground">{tr("审批操作", "Approval actions")}</div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={tr("留言给 Agent / 原因…", "Comment / reason…")}
              rows={2}
              className={`w-full rounded-md px-3 py-1.5 text-sm outline-none resize-y ${c.input}`}
            />
            <div className="grid grid-cols-1 gap-2">
              <button
                onClick={() => void handleApprove()}
                disabled={acting}
                className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm ${c.btnSuccess} disabled:opacity-50`}
              >
                {acting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {tr("通过", "Approve")}
              </button>
              <button
                onClick={() => void handleRejectWhole()}
                disabled={acting}
                className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm ${c.btnDanger} disabled:opacity-50`}
              >
                <RotateCcw size={14} />
                {tr("整章重来", "Reject & redo")}
              </button>
              <button
                onClick={() => setRestartOpen((v) => !v)}
                className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm ${c.btnSecondary}`}
              >
                <Scissors size={14} />
                {tr("局部重启", "Partial restart")}
              </button>
            </div>
          </div>

          {/* 局部重启表单 */}
          {restartOpen && (
            <div className="rounded-xl border border-violet-500/40 bg-violet-500/5 p-4 space-y-2">
              <div className="text-xs text-violet-600 dark:text-violet-300 font-medium">
                {tr("局部重启：先在正文选中范围，再填写指令", "Select a range in the content, then write an instruction")}
              </div>
              <textarea
                value={restartInstruction}
                onChange={(e) => setRestartInstruction(e.target.value)}
                placeholder={tr("修改指令，例如：这段对话太拖沓，精简并加入冲突", "Instruction, e.g. tighten this dialogue and add conflict")}
                rows={3}
                className={`w-full rounded-md px-3 py-1.5 text-sm outline-none resize-y ${c.input}`}
              />
              <button
                onClick={() => void handlePartialRestart()}
                disabled={acting}
                className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 w-full`}
              >
                {acting ? <Loader2 size={14} className="animate-spin" /> : <Scissors size={14} />}
                {tr("生成局部重启任务", "Queue partial restart")}
              </button>
            </div>
          )}

          {/* 状态流转历史 */}
          {approval && approval.events.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <MessageSquare size={13} />
                {tr("状态流转", "History")}
              </div>
              <div className="space-y-1.5">
                {approval.events.slice().reverse().map((event, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="shrink-0 text-muted-foreground/60">{formatTime(event.at)}</span>
                    <span className="shrink-0 font-medium">{(STATE_LABELS[event.state as keyof typeof STATE_LABELS] ?? STATE_LABELS.draft).zh}</span>
                    <span className="shrink-0 text-muted-foreground/70">{event.by}</span>
                    {event.note && <span className="text-muted-foreground truncate">{event.note}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
