import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  applyNodeChanges,
  type NodeProps,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useApi, fetchJson } from "../hooks/use-api";
import { useColors } from "../hooks/use-colors";
import { tr } from "../lib/app-language";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { Loader2, Scissors, GitBranch } from "lucide-react";

/**
 * 分支图谱视图（设计文档 §7 / §11）
 * ---------------------------------------------------------------------------
 * ReactFlow：主线横向、分支纵向、灰度节点（gray）汇入主线；
 * 戏份热力：节点按关联角色戏份占比着色；
 * 砍分支：标记 cut → 返回受影响章节区间提示回滚。
 */

export interface BranchNodeData {
  readonly id: string;
  readonly type: "mainline" | "branch" | "gray";
  readonly title: string;
  readonly status: "active" | "planned" | "cut";
  readonly chapterRange: readonly [number, number];
  readonly parentId?: string;
  readonly heat?: number;
  readonly heatName?: string;
}

export interface BranchGraph {
  readonly nodes: ReadonlyArray<BranchNodeData & { readonly description?: string }>;
  readonly edges: ReadonlyArray<{ readonly id: string; readonly from: string; readonly to: string; readonly kind: "parent" | "merge" }>;
  readonly screenTime: ReadonlyArray<{ readonly characterId: string; readonly ratio: number; readonly branchNodeId?: string }>;
  readonly maxBranches: number;
  readonly updatedAt: string;
}

type RfNode = Node<{ data: BranchNodeData }, "branch">;
type RfEdge = Edge;

const NODE_STYLE: Record<string, string> = {
  mainline: "border-primary/60 bg-primary/10 text-foreground",
  branch: "border-violet-500/50 bg-violet-500/10 text-foreground",
  gray: "border-amber-500/60 bg-amber-500/10 text-foreground",
  cut: "border-destructive/50 bg-destructive/10 text-muted-foreground opacity-60",
};

const NODE_MINIMAP: Record<string, string> = {
  mainline: "#6366f1",
  branch: "#8b5cf6",
  gray: "#f59e0b",
  cut: "#ef4444",
};

function BranchFlowNode({ data }: NodeProps<RfNode>) {
  const d = data.data;
  const cls = d.status === "cut" ? NODE_STYLE.cut : (NODE_STYLE[d.type] ?? NODE_STYLE.mainline);
  const heatBg = d.heat !== undefined && d.heat > 0
    ? `linear-gradient(135deg, rgba(244,63,94,${Math.min(0.55, d.heat * 0.55)}) 0%, transparent 60%)`
    : undefined;

  return (
    <div
      className={`rounded-lg border text-xs ${cls}`}
      style={{ width: 180, minHeight: 70, padding: "8px 10px", boxSizing: "border-box", background: heatBg }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: d.type === "mainline" ? 0.6 : 0.9 }} />
      <div className="flex items-center gap-1 mb-1">
        <span className="text-[10px] uppercase tracking-wider opacity-70">
          {d.type === "mainline" ? "主线" : d.type === "branch" ? "分支" : "汇入"}
        </span>
        {d.status === "cut" && <span className="text-[10px] text-destructive font-semibold">已砍</span>}
      </div>
      <div className="font-medium leading-tight line-clamp-2">{d.title}</div>
      {d.chapterRange[1] > 0 && (
        <div className="text-[10px] opacity-60 mt-1">章节 {d.chapterRange[0]}-{d.chapterRange[1]}</div>
      )}
      {d.heatName && (
        <div className="text-[10px] text-rose-400 mt-0.5">戏份 {Math.round((d.heat ?? 0) * 100)}% · {d.heatName}</div>
      )}
      <Handle type="source" position={Position.Right} style={{ opacity: d.type === "mainline" ? 0.6 : 0.9 }} />
    </div>
  );
}

const nodeTypes = { branch: BranchFlowNode };

/** 简易纵向分层布局：主线横向排、分支在主线节点下方纵向展开 */
function layoutBranchGraph(graph: BranchGraph): { nodes: RfNode[]; edges: RfEdge[] } {
  const H_GAP = 60;
  const V_GAP = 70;
  const mainline = graph.nodes.filter((n) => n.type === "mainline").sort((a, b) => a.chapterRange[0] - b.chapterRange[0]);

  // 主线 x 坐标：按章节序
  const mainPos = new Map<string, XYPosition>();
  mainline.forEach((n, i) => mainPos.set(n.id, { x: i * (180 + H_GAP), y: 0 }));

  // 分支/汇入节点：挂在父节点下方，分支内纵向堆叠
  const branchNodes = graph.nodes.filter((n) => n.type !== "mainline");
  const placed = new Map<string, XYPosition>();
  const colHeights = new Map<string, number>(); // parentId -> 当前已用高度

  const parentOf = (id: string): string | undefined =>
    graph.nodes.find((n) => n.id === id)?.type === "branch"
      ? graph.nodes.find((n) => n.id === id)?.parentId
      : undefined;

  for (const node of branchNodes) {
    const parentId = parentOf(node.id);
    if (!parentId || !mainPos.has(parentId)) {
      // 找不到主线父节点，排到最后的主线节点下方
      const anchor = mainline.at(-1)?.id;
      if (!anchor) { placed.set(node.id, { x: 0, y: V_GAP }); continue; }
      const py = colHeights.get(anchor) ?? V_GAP;
      colHeights.set(anchor, py + 90 + V_GAP);
      placed.set(node.id, { x: mainPos.get(anchor)!.x, y: py });
      continue;
    }
    const base = mainPos.get(parentId)!;
    const py = colHeights.get(parentId) ?? V_GAP;
    colHeights.set(parentId, py + 90 + V_GAP);
    placed.set(node.id, { x: base.x, y: py });
  }

  const nodes: RfNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "branch",
    position: mainPos.get(n.id) ?? placed.get(n.id) ?? { x: 0, y: V_GAP },
    data: { data: n },
  }));

  const edges: RfEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    type: e.kind === "merge" ? "smoothstep" : "default",
    animated: e.kind === "merge",
    label: e.kind === "merge" ? "汇入" : undefined,
    style: {
      stroke: e.kind === "merge" ? "#f59e0b" : "#8b5cf6",
      strokeWidth: e.kind === "merge" ? 2 : 1.4,
      strokeDasharray: e.kind === "merge" ? "5 3" : undefined,
    },
    labelStyle: { fontSize: 9, fill: "#f59e0b" },
  }));

  return { nodes, edges };
}

export default function BranchGraphView({
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
  const { data: graph, loading, error, refetch } = useApi<BranchGraph>(`/books/${bookId}/branch-graph`);
  const [rfNodes, setRfNodes] = useNodesState<RfNode>([]);
  const [rfEdges, setRfEdges] = useEdgesState<RfEdge>([]);
  const [cutTarget, setCutTarget] = useState<string | null>(null);
  const [cutReason, setCutReason] = useState("");
  const [cutting, setCutting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cutResult, setCutResult] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);

  useEffect(() => {
    if (!graph) return;
    const layout = layoutBranchGraph(graph);
    setRfNodes(layout.nodes);
    setRfEdges(layout.edges);
  }, [graph, setRfNodes, setRfEdges]);

  const screenTimeByNode = useMemo(() => {
    const map = new Map<string, { ratio: number; name: string }>();
    if (!graph) return map;
    for (const record of graph.screenTime) {
      if (record.branchNodeId && !map.has(record.branchNodeId)) {
        map.set(record.branchNodeId, { ratio: record.ratio, name: record.characterId });
      }
    }
    return map;
  }, [graph]);

  // 将戏份热力合并进节点数据
  const hotNodes = useMemo(() => {
    if (!graph || screenTimeByNode.size === 0) return rfNodes;
    return rfNodes.map((n) => {
      const heat = screenTimeByNode.get(n.id);
      if (!heat) return n;
      return {
        ...n,
        data: {
          ...n.data,
          data: {
            ...n.data.data,
            heat: heat.ratio,
            heatName: heat.name,
          },
        },
      };
    });
  }, [rfNodes, graph, screenTimeByNode]);

  const onNodesChange = (changes: NodeChange<RfNode>[]) => {
    // 允许拖动，但禁止删除（分支图谱的节点结构由服务端决定）
    const safe = changes.filter((change) => change.type !== "remove");
    setRfNodes((prev) => applyNodeChanges(safe, prev));
  };

  const onEdgesChange = (changes: EdgeChange<RfEdge>[]) => {
    void changes;
    // 分支图谱的边由结构决定，前端只读
  };

  const stats = useMemo(() => {
    if (!graph) return null;
    const active = graph.nodes.filter((n) => n.status !== "cut").length;
    const branches = graph.nodes.filter((n) => n.type === "branch" && n.status !== "cut").length;
    const gray = graph.nodes.filter((n) => n.type === "gray").length;
    return { total: graph.nodes.length, active, branches, gray };
  }, [graph]);

  const runPropose = async () => {
    setProposing(true);
    setActionError(null);
    setCutResult(null);
    try {
      const result = await fetchJson<{ proposal: { node: { title: string }; rationale: string } | null } | null>(`/books/${bookId}/branch-graph/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!result?.proposal) {
        setCutResult(tr("AI 认为当前不值得开新分支", "AI sees no new branch worth opening now"));
      } else {
        setCutResult(tr(`已提议新分支「${result.proposal.node.title}」：${result.proposal.rationale}`, `Proposed branch "${result.proposal.node.title}": ${result.proposal.rationale}`));
      }
      await refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setProposing(false);
    }
  };

  const confirmCut = async () => {
    if (!cutTarget) return;
    setCutting(true);
    setActionError(null);
    setCutResult(null);
    try {
      const result = await fetchJson<{ ok: boolean; cutNodeIds: ReadonlyArray<string>; affectedChapterRange: { min: number; max: number } | null }>(`/books/${bookId}/branch-graph/cut`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: cutTarget, reason: cutReason || "用户砍分支" }),
      });
      if (result.affectedChapterRange) {
        setCutResult(
          tr(
            `已砍分支，影响第 ${result.affectedChapterRange.min}-${result.affectedChapterRange.max} 章，需回滚重写`,
            `Branch cut — chapters ${result.affectedChapterRange.min}-${result.affectedChapterRange.max} affected, need rewrite`,
          ),
        );
      } else {
        setCutResult(tr("分支已砍", "Branch cut"));
      }
      setCutTarget(null);
      setCutReason("");
      await refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setCutting(false);
    }
  };

  if (loading && !graph) return <div className="flex items-center justify-center py-32"><Loader2 className="animate-spin text-primary" size={24} /></div>;
  if (error) return <div className={`p-8 rounded-xl border ${c.error}`}>{t("common.error")}: {error}</div>;

  return (
    <div className="flex flex-col h-full min-h-0 gap-3 p-5" data-testid="branch-graph-view">
      <div className="flex items-center gap-3 shrink-0">
        <button onClick={() => nav.toBook(bookId)} className={`text-sm ${c.link}`}>
          ← {t("bread.books")}
        </button>
        <h1 className="text-lg font-serif font-semibold">{tr("分支图谱", "Branch Graph")}</h1>
        {stats && (
          <span className="text-xs text-muted-foreground">
            {tr(`节点 ${stats.total} · 活跃 ${stats.active} · 分支 ${stats.branches} · 汇入点 ${stats.gray}`, `Nodes ${stats.total} · Active ${stats.active} · Branches ${stats.branches} · Merge ${stats.gray}`)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void runPropose()}
            disabled={proposing}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs ${c.btnSecondary} disabled:opacity-50`}
            data-testid="branch-propose"
          >
            {proposing ? <Loader2 size={13} className="animate-spin" /> : <GitBranch size={13} />}
            {tr("AI 提议新分支", "Propose branch (AI)")}
          </button>
          <span className="text-xs text-muted-foreground">
            {tr("点击分支节点可砍分支", "Click a branch node to cut it")}
          </span>
        </div>
      </div>

      {cutResult && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${c.info} shrink-0`}>
          {cutResult}
        </div>
      )}
      {actionError && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${c.error} shrink-0`}>{actionError}</div>
      )}

      <div className="flex-1 min-h-0 border rounded-xl overflow-hidden">
        <ReactFlow
          nodes={hotNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          colorMode={theme === "dark" ? "dark" : "light"}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_evt, node) => {
            const d = node.data.data;
            if (d.type === "branch" && d.status !== "cut") {
              setCutTarget(d.id);
              setCutResult(null);
            }
          }}
        >
          <Background />
          <Controls />
          <MiniMap
            nodeColor={(node) => {
              const d = (node.data as { data: BranchNodeData }).data;
              return NODE_MINIMAP[d.status === "cut" ? "cut" : d.type] ?? "#6366f1";
            }}
            nodeBorderRadius={4}
          />
        </ReactFlow>
      </div>

      {/* 图例 */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
        <LegendSwatch color="bg-primary/40 border-primary" label={tr("主线", "Mainline")} />
        <LegendSwatch color="bg-violet-500/40 border-violet-500" label={tr("分支", "Branch")} />
        <LegendSwatch color="bg-amber-500/40 border-amber-500" label={tr("灰度汇入", "Gray merge")} />
        <LegendSwatch color="bg-destructive/40 border-destructive" label={tr("已砍", "Cut")} />
        <span className="ml-auto flex items-center gap-1">
          <Scissors size={13} /> {tr("点击分支节点砍分支", "Click branch node to cut")}
        </span>
      </div>

      {/* 砍分支确认 */}
      {cutTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card shadow-xl p-6 space-y-3">
            <div className="flex items-center gap-2">
              <Scissors size={16} className="text-destructive" />
              <span className="font-semibold">{tr("砍分支", "Cut Branch")}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {tr("确定要砍掉这个分支吗？受影响章节将回滚重写。", "Cut this branch? Affected chapters will be rolled back and rewritten.")}
            </p>
            <textarea
              value={cutReason}
              onChange={(e) => setCutReason(e.target.value)}
              placeholder={tr("砍分支原因（可选）", "Reason (optional)")}
              rows={2}
              className={`w-full rounded-md px-3 py-1.5 text-sm outline-none resize-y ${c.input}`}
            />
            {actionError && <div className={`rounded-md border px-3 py-2 text-xs ${c.error}`}>{actionError}</div>}
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setCutTarget(null); setCutReason(""); }} className={`px-3 py-1.5 rounded-md text-sm ${c.btnSecondary}`}>
                {tr("取消", "Cancel")}
              </button>
              <button onClick={() => void confirmCut()} disabled={cutting} className={`px-3 py-1.5 rounded-md text-sm inline-flex items-center gap-1.5 bg-destructive text-destructive-foreground disabled:opacity-50`}>
                {cutting ? <Loader2 size={14} className="animate-spin" /> : <Scissors size={14} />}
                {tr("确认砍分支", "Confirm cut")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-3 h-3 rounded-sm border ${color}`} />
      {label}
    </span>
  );
}
