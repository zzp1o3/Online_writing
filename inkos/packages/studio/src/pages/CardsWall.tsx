import { useEffect, useMemo, useState } from "react";
import { useApi, fetchJson, putApi } from "../hooks/use-api";
import { useColors } from "../hooks/use-colors";
import { tr } from "../lib/app-language";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import {
  Users,
  MapPin,
  Flag,
  Package,
  Lock,
  Unlock,
  Pencil,
  Plus,
  Search,
  Loader2,
  Check,
} from "lucide-react";

/**
 * 卡片墙（设计文档 §8 / §11）
 * ---------------------------------------------------------------------------
 * 角色 / 地点 / 势力 / 物品四类卡片，美观卡片墙排版。
 * 权限：仅 guardian（守护 Agent）与 user 可修改；writer/judge 只读。
 */

export interface CardMeta {
  readonly version: number;
  readonly locked: boolean;
  readonly updatedBy: "guardian" | "user";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoryCard {
  readonly id: string;
  readonly type: "character" | "location" | "faction" | "item";
  readonly name: string;
  readonly [key: string]: unknown;
}

export interface StoredCard {
  readonly card: StoryCard;
  readonly meta: CardMeta;
}

export interface CardsBundle {
  readonly characters: ReadonlyArray<StoredCard>;
  readonly locations: ReadonlyArray<StoredCard>;
  readonly factions: ReadonlyArray<StoredCard>;
  readonly items: ReadonlyArray<StoredCard>;
}

const TYPE_TABS: ReadonlyArray<{
  readonly type: StoryCard["type"];
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly accent: string;
}> = [
  { type: "character", label: tr("角色", "Characters"), icon: <Users size={15} />, accent: "bg-rose-500/15 text-rose-500 border-rose-500/30" },
  { type: "location", label: tr("地点", "Locations"), icon: <MapPin size={15} />, accent: "bg-sky-500/15 text-sky-500 border-sky-500/30" },
  { type: "faction", label: tr("势力", "Factions"), icon: <Flag size={15} />, accent: "bg-violet-500/15 text-violet-500 border-violet-500/30" },
  { type: "item", label: tr("物品", "Items"), icon: <Package size={15} />, accent: "bg-amber-500/15 text-amber-500 border-amber-500/30" },
];

/** 卡片字段的展示/编辑配置（中文展示名 + 键 + 是否可编辑） */
const FIELD_CONFIG: Record<StoryCard["type"], ReadonlyArray<{ readonly key: string; readonly label: string }>> = {
  character: [
    { key: "identity", label: "身份" },
    { key: "personality", label: "性格" },
    { key: "catchphrase", label: "口头禅" },
    { key: "relationToProtagonist", label: "与主角关系" },
    { key: "currentStatus", label: "当前状态" },
    { key: "growthArc", label: "成长弧" },
    { key: "notes", label: "备注" },
  ],
  location: [
    { key: "region", label: "区域" },
    { key: "description", label: "描述" },
    { key: "significance", label: "意义" },
    { key: "currentState", label: "当前状态" },
    { key: "notes", label: "备注" },
  ],
  faction: [
    { key: "goal", label: "目标" },
    { key: "structure", label: "结构" },
    { key: "relationToProtagonist", label: "与主角关系" },
    { key: "currentState", label: "当前状态" },
    { key: "notes", label: "备注" },
  ],
  item: [
    { key: "kind", label: "类别" },
    { key: "abilities", label: "能力" },
    { key: "owner", label: "持有者" },
    { key: "history", label: "来历" },
    { key: "currentLocation", label: "当前位置" },
    { key: "notes", label: "备注" },
  ],
};

function stringValue(card: StoryCard, key: string): string {
  const v = card[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join("、");
  return "";
}

function cardFieldLines(card: StoryCard): ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: string }> {
  const config = FIELD_CONFIG[card.type] ?? [];
  return config
    .map((f) => ({ ...f, value: stringValue(card, f.key) }))
    .filter((f) => f.value.trim().length > 0);
}

export default function CardsWall({
  bookId,
  nav,
  theme,
  t,
}: {
  bookId: string;
  nav: { toBook: (id: string) => void };
  theme: Theme;
  t: TFunction;
}) {
  const c = useColors(theme);
  const { data, loading, error, refetch } = useApi<CardsBundle>(`/books/${bookId}/cards`);
  const [activeType, setActiveType] = useState<StoryCard["type"]>("character");
  const [query, setQuery] = useState("");
  const [editingCard, setEditingCard] = useState<StoredCard | null>(null);
  const [editDraft, setEditDraft] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setActionError(null);
  }, [editingCard, creating]);

  // 类型单数 → 卡片 bundle 复数键名
  const typeKey = (type: StoryCard["type"]): "characters" | "locations" | "factions" | "items" =>
    type === "character" ? "characters"
    : type === "location" ? "locations"
    : type === "faction" ? "factions"
    : "items";

  const activeCards = data?.[typeKey(activeType)] ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return activeCards;
    return activeCards.filter((stored) =>
      (stored.card.name ?? "").toLowerCase().includes(q)
      || cardFieldLines(stored.card).some((f) => f.value.toLowerCase().includes(q))
    );
  }, [activeCards, query]);

  const counts: Record<StoryCard["type"], number> = {
    character: data?.characters.length ?? 0,
    location: data?.locations.length ?? 0,
    faction: data?.factions.length ?? 0,
    item: data?.items.length ?? 0,
  };

  const handleSave = async () => {
    if (!editingCard) return;
    setSaving(true);
    setActionError(null);
    try {
      const merged = { ...editingCard.card } as Record<string, unknown>;
      for (const f of FIELD_CONFIG[editingCard.card.type] ?? []) {
        merged[f.key] = (editDraft[f.key] ?? "").trim();
      }
      await putApi(`/books/${bookId}/cards/${editingCard.card.id}`, {
        card: merged,
        editor: "user",
      });
      setEditingCard(null);
      await refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!creating) return;
    setSaving(true);
    setActionError(null);
    try {
      const name = (editDraft.name ?? "").trim();
      if (!name) {
        setActionError(tr("卡片名称必填", "Card name is required"));
        return;
      }
      const base = {
        id: `${activeType}-${Date.now().toString(36)}`,
        type: activeType,
        name,
      } as StoryCard;
      const merged = { ...base } as Record<string, unknown>;
      for (const f of FIELD_CONFIG[activeType] ?? []) {
        merged[f.key] = (editDraft[f.key] ?? "").trim();
      }
      await putApi(`/books/${bookId}/cards/${base.id}`, {
        card: merged,
        editor: "user",
      });
      setCreating(false);
      setEditDraft({});
      await refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (stored: StoredCard) => {
    setEditingCard(stored);
    setEditDraft({});
  };

  const startCreate = () => {
    setCreating(true);
    setEditingCard(null);
    setEditDraft({});
  };

  if (loading && !data) return <div className="flex items-center justify-center py-32"><Loader2 className="animate-spin text-primary" size={24} /></div>;
  if (error) return <div className={`p-8 rounded-xl border ${c.error}`}>{t("common.error")}: {error}</div>;

  return (
    <div className="flex flex-col min-h-full gap-5 px-6 py-8 max-w-7xl mx-auto w-full">
      {/* 头部 */}
      <div className="flex items-center gap-3 shrink-0">
        <button onClick={() => nav.toBook(bookId)} className={`text-sm ${c.link}`}>
          ← {t("bread.books")}
        </button>
        <h1 className="text-xl font-serif font-semibold">{tr("卡片墙", "Card Wall")}</h1>
        <span className="text-xs text-muted-foreground">
          {tr("仅守护 Agent 与用户可修改 · 写作/审判 Agent 只读", "Editable by Guardian & user only · writer/judge read-only")}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr("搜索卡片…", "Search cards…")}
              className={`w-52 rounded-md pl-8 pr-3 py-1.5 text-sm outline-none ${c.input}`}
            />
          </div>
          <button
            onClick={startCreate}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm ${c.btnPrimary}`}
          >
            <Plus size={14} />
            {tr("新建卡片", "New card")}
          </button>
        </div>
      </div>

      {/* 类型页签 */}
      <div className="flex gap-2 shrink-0">
        {TYPE_TABS.map((tab) => (
          <button
            key={tab.type}
            onClick={() => setActiveType(tab.type)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm transition-all ${
              activeType === tab.type
                ? `${tab.accent} font-medium shadow-sm`
                : "border-border bg-card text-muted-foreground hover:text-foreground hover:border-border/70"
            }`}
          >
            {tab.icon}
            {tab.label}
            <span className={`text-xs ${activeType === tab.type ? "" : "text-muted-foreground/50"}`}>({counts[tab.type]})</span>
          </button>
        ))}
      </div>

      {/* 新建卡片表单 */}
      {creating && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-3 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{tr("新建卡片", "New card")}</span>
            <span className="text-xs text-muted-foreground">({activeType})</span>
          </div>
          <input
            value={editDraft.name ?? ""}
            onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={tr("名称 *", "Name *")}
            className={`w-full rounded-md px-3 py-1.5 text-sm outline-none ${c.input}`}
          />
          {FIELD_CONFIG[activeType].map((f) => (
            <textarea
              key={f.key}
              value={editDraft[f.key] ?? ""}
              onChange={(e) => setEditDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              placeholder={f.label}
              rows={2}
              className={`w-full rounded-md px-3 py-1.5 text-sm outline-none resize-y ${c.input}`}
            />
          ))}
          {actionError && <div className={`rounded-md border px-3 py-2 text-xs ${c.error}`}>{actionError}</div>}
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setCreating(false); setEditDraft({}); }} className={`px-3 py-1.5 rounded-md text-sm ${c.btnSecondary}`}>
              {tr("取消", "Cancel")}
            </button>
            <button onClick={() => void handleCreate()} disabled={saving} className={`px-3 py-1.5 rounded-md text-sm inline-flex items-center gap-1.5 ${c.btnPrimary} disabled:opacity-50`}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {tr("保存", "Save")}
            </button>
          </div>
        </div>
      )}

      {/* 卡片网格 */}
      {filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-24 text-sm text-muted-foreground">
          {query ? tr("没有匹配的卡片", "No matching cards") : tr("还没有卡片，点击右上角新建", "No cards yet — create one")}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((stored) => (
            <CardTile
              key={stored.card.id}
              stored={stored}
              accent={TYPE_TABS.find((tab) => tab.type === stored.card.type)?.accent ?? ""}
              onEdit={() => openEdit(stored)}
            />
          ))}
        </div>
      )}

      {/* 编辑对话框 */}
      {editingCard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-card shadow-xl p-6 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-lg font-serif font-semibold">{editingCard.card.name}</span>
              <span className="text-xs text-muted-foreground">({editingCard.card.type})</span>
              <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                {editingCard.meta.locked
                  ? <><Lock size={12} /> {tr("已锁定", "Locked")}</>
                  : <><Unlock size={12} /> {tr("未锁定", "Unlocked")}</>}
              </div>
            </div>
            <input
              value={editDraft.name ?? editingCard.card.name ?? ""}
              onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder={tr("名称", "Name")}
              className={`w-full rounded-md px-3 py-1.5 text-sm outline-none ${c.input}`}
            />
            {FIELD_CONFIG[editingCard.card.type].map((f) => (
              <div key={f.key} className="space-y-1">
                <label className="text-xs text-muted-foreground">{f.label}</label>
                <textarea
                  value={editDraft[f.key] ?? stringValue(editingCard.card, f.key)}
                  onChange={(e) => setEditDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  rows={2}
                  className={`w-full rounded-md px-3 py-1.5 text-sm outline-none resize-y ${c.input}`}
                />
              </div>
            ))}
            {actionError && <div className={`rounded-md border px-3 py-2 text-xs ${c.error}`}>{actionError}</div>}
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={() => setEditingCard(null)} className={`px-3 py-1.5 rounded-md text-sm ${c.btnSecondary}`}>
                {tr("取消", "Cancel")}
              </button>
              <button onClick={() => void handleSave()} disabled={saving} className={`px-3 py-1.5 rounded-md text-sm inline-flex items-center gap-1.5 ${c.btnPrimary} disabled:opacity-50`}>
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {tr("保存", "Save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CardTile({ stored, accent, onEdit }: {
  stored: StoredCard;
  accent: string;
  onEdit: () => void;
}) {
  const card = stored.card;
  const lines = cardFieldLines(card);
  const updatedAt = stored.meta.updatedAt ? new Date(stored.meta.updatedAt) : null;

  return (
    <div className="group rounded-xl border border-border bg-card hover:border-primary/30 hover:shadow-md transition-all p-4 flex flex-col gap-2 relative">
      <div className="flex items-start gap-2">
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${accent}`}>
          {card.type === "character" ? "角色" : card.type === "location" ? "地点" : card.type === "faction" ? "势力" : "物品"}
        </span>
        {stored.meta.locked && <Lock size={12} className="text-muted-foreground/50 mt-1" />}
        <button
          onClick={onEdit}
          className="ml-auto p-1 rounded-md text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-secondary/50 transition-all"
          aria-label={tr("编辑卡片", "Edit card")}
        >
          <Pencil size={13} />
        </button>
      </div>
      <div className="font-serif text-base font-semibold leading-tight">{card.name}</div>
      {lines.length > 0 ? (
        <div className="space-y-1 text-xs text-muted-foreground flex-1">
          {lines.slice(0, 3).map((line) => (
            <div key={line.key} className="line-clamp-2">
              <span className="text-foreground/60">{line.label}：</span>
              {line.value}
            </div>
          ))}
          {lines.length > 3 && (
            <div className="text-[11px] text-muted-foreground/50">
              {tr(`还有 ${lines.length - 3} 项…`, `+${lines.length - 3} more…`)}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 text-xs text-muted-foreground/40 italic">{tr("暂无详情", "No details")}</div>
      )}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground/40 pt-1 border-t border-border/40">
        <span>v{stored.meta.version}</span>
        <span>{updatedAt ? formatDate(updatedAt) : ""}</span>
      </div>
    </div>
  );
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
