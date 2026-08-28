import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, Maximize2, Minus, Plus, Search } from "lucide-react";
import {
  approveActionProposal,
  ApiError,
  clearStoredWorkspaceToken,
  createWorkspace,
  editBuyerMessage,
  getBootstrap,
  getBuyers,
  getConversation,
  getConversationTrace,
  getConversations,
  getCustomerMemories,
  getKnowledge,
  getKnowledgeCandidates,
  getKnowledgeConflicts,
  getProductLearningJobs,
  getOrders,
  getProducts,
  isWorkspaceCredentialError,
  messageText,
  recallBuyerMessage,
  regenerateReply,
  resumeConversationAi,
  readStoredWorkspaceToken,
  resetCurrentWorkspace,
  setConversationMode,
  sendBuyerMessage,
  sendBuyerOrderCard,
  sendBuyerProductCard,
  sendConversationMessage,
  storeWorkspaceToken,
  takeoverConversation,
  createCustomerMemory,
  disableCustomerMemory,
  deleteCustomerMemory,
  draftRemainingMs,
  mergeCustomerMemoryMutation,
  updateCustomerMemory,
  commitKnowledgeImport,
  approveKnowledgeCandidate,
  classifyImportRows,
  deleteKnowledge,
  getIncidents,
  getQualityReviews,
  addIncidentRegression,
  concludeQualityReview,
  getScenarios,
  getUsageSummary,
  getWorkflow,
  getWorkflowRuns,
  getWorkflows,
  parseKnowledgeCsv,
  previewKnowledgeImport,
  reindexKnowledge,
  rejectKnowledgeCandidate,
  rejectActionProposal,
  resolveIncident,
  saveIncidentCorrection,
  saveIncidentRootCause,
  disableWorkflow,
  enableWorkflow,
  publishWorkflow,
  saveWorkflowDraft,
  startQualityReview,
  resolveKnowledgeConflict,
  resetScenario,
  runScenario,
  startProductLearning,
  syncProducts,
  type Buyer,
  type Conversation,
  type ExistingKnowledgeMatch,
  type KnowledgeImportPreview,
  type KnowledgeImportRow,
  type KnowledgeCandidate,
  type KnowledgeConflict,
  type KnowledgeConflictResolution,
  type KnowledgeItem,
  type ProductLearningJob,
  type ProductLearningStatus,
  type Message,
  type Order,
  type Product,
  type ReplyDraft,
  type CustomerMemory,
  type CustomerMemoryInputDto,
  type QualityReview,
  type QualityResult,
  type DeveloperTrace,
  type ReplyIncident,
  type Scenario,
  type SendOutbox,
  type ShopSummary,
  type UsageSummary,
  type Workflow,
  type WorkflowGraph,
  type WorkflowRun,
} from "../../api";
import {
  connectWorkspaceSocket,
  refreshConversationForWorkspaceEvent,
  type WorkspaceSocketEvent,
  type WorkspaceSocketStatus,
} from "../../workspace-socket";
import {
  buyerTextSubmissionEnabled,
  humanFinalSubmission,
} from "../../workbench-actions";
import {
  navIcons,
  navigationItems,
  resolveAppPath,
  type AppPath,
} from "../../app/routes";
import {
  EmptyState,
  ErrorState as Phase05ErrorState,
  LoadingState as Phase05LoadingState,
} from "../../components/ui/feedback";
import { ConfirmDialog } from "../../components/ui/primitives";
import {
  AdminPageHeader as Phase05AdminHeader,
  AdminTabs,
} from "../admin/AdminChrome";
import { DataPrivacyPage } from "../privacy/DataPrivacyPage";
import { UsageAdminPage } from "../usage/UsageAdminPage";
import type {
  Bootstrap as BootstrapPayload,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "@ai-customer-service/contracts";

import * as viewModel from "../shared/view-models";
const {
  defaultNavigationItem,
  readableTime,
  readableDate,
  shortId,
  buyerName,
  productName,
  orderName,
  statusLabel,
  errorMessage,
  modeLabel,
  connectionStateLabel,
  localDayKey,
  conversationTimestamp,
  metric,
  buildAdminOverviewSnapshot,
  buildConversationTrend,
  isConversationModeAllowed,
  conversationModeOptionLabel,
  replyJobStatusLabel,
  draftStatusLabel,
  sendOutboxStatusLabel,
  draftRemainingLabel,
  taskStatusLabel,
  tagsFromBuyer,
  firstSku,
  productPrice,
  productInventory,
  objectValue,
  redactTraceValue,
  redactDeveloperTracePayload,
  shouldLoadDeveloperTrace,
  traceRequestedBySearch,
  visibleDeveloperTraceEvents,
  isMessage,
  cardData,
  messageKindLabel,
  messageRoleLabel,
  messageSort,
  knowledgeScopeLabel,
  knowledgeSourceLabel,
  knowledgeBusinessLabel,
  knowledgeIndexLabel,
  knowledgeVersion,
  knowledgeStatusClass,
  learningStatusLabel,
  learningStatusClass,
  learningProgress,
  eventHasWorkspaceShape,
  isPhase03SnapshotEvent,
} = viewModel;
type FoundationState = viewModel.FoundationState;
type SharedViewProps = viewModel.SharedViewProps;
type AdminMetricSnapshot = viewModel.AdminMetricSnapshot;
type AdminOverviewSnapshot = viewModel.AdminOverviewSnapshot;
type ConversationTrendPoint = viewModel.ConversationTrendPoint;
type WorkbenchConversationMode = viewModel.WorkbenchConversationMode;

import {
  Avatar,
  MessageBubble,
  ShopRail,
  ContextProduct,
  ContextOrder,
  DeveloperTracePanel,
} from "../workbench/components";

export function phase05StatusClass(status?: string): string {
  if (["SUCCEEDED", "COMPLETED", "PASS", "RESOLVED"].includes(status ?? ""))
    return "is-positive";
  if (["FAILED", "FAIL", "OPEN"].includes(status ?? "")) return "is-danger";
  if (
    [
      "RUNNING",
      "PENDING",
      "WAITING_APPROVAL",
      "NEEDS_HUMAN",
      "CORRECTION_DRAFTED",
      "RESETTING",
    ].includes(status ?? "")
  )
    return "is-waiting";
  return "is-muted";
}

export const workflowEditorNodeTypes = new Set<WorkflowNodeType>([
  "TRIGGER",
  "CONDITION",
  "QUERY_PRODUCT",
  "QUERY_ORDER",
  "QUERY_LOGISTICS",
  "AI_GENERATE",
  "HUMAN_APPROVAL",
  "END",
]);
export const workflowEditorConfigKeys = new Set([
  "intent",
  "topN",
  "expression",
  "action",
]);

export function moveWorkflowNode(
  graph: WorkflowGraph,
  nodeId: string,
  position: { x: number; y: number },
): WorkflowGraph {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
    throw new Error("node position must be finite");
  if (!graph.nodes.some((node) => node.id === nodeId))
    throw new Error(`node ${nodeId} not found`);
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId ? { ...node, position: { ...position } } : node,
    ),
  };
}

export function addWorkflowNode(
  graph: WorkflowGraph,
  node: WorkflowNode,
): WorkflowGraph {
  if (!workflowEditorNodeTypes.has(node.type))
    throw new Error("node type is outside the V1 allowlist");
  if (!node.id || graph.nodes.some((entry) => entry.id === node.id))
    throw new Error("duplicate node id");
  if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y))
    throw new Error("node position must be finite");
  return {
    ...graph,
    nodes: [
      ...graph.nodes,
      { ...node, position: { ...node.position }, config: { ...node.config } },
    ],
  };
}

export function removeWorkflowNode(
  graph: WorkflowGraph,
  nodeId: string,
): WorkflowGraph {
  if (!graph.nodes.some((node) => node.id === nodeId))
    throw new Error(`node ${nodeId} not found`);
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: graph.edges.filter(
      (edge) => edge.source !== nodeId && edge.target !== nodeId,
    ),
  };
}

export function workflowHasPath(
  graph: WorkflowGraph,
  from: string,
  to: string,
): boolean {
  const visited = new Set<string>();
  const pending = [from];
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    if (current === to) return true;
    visited.add(current);
    for (const edge of graph.edges)
      if (edge.source === current) pending.push(edge.target);
  }
  return false;
}

export function addWorkflowEdge(
  graph: WorkflowGraph,
  edge: WorkflowEdge,
): WorkflowGraph {
  if (!edge.id || graph.edges.some((entry) => entry.id === edge.id))
    throw new Error("duplicate edge id");
  if (
    edge.source === edge.target ||
    !graph.nodes.some((node) => node.id === edge.source) ||
    !graph.nodes.some((node) => node.id === edge.target)
  )
    throw new Error("edge endpoint is missing");
  if (
    graph.edges.some(
      (entry) => entry.source === edge.source && entry.target === edge.target,
    )
  )
    throw new Error("duplicate edge");
  const sourceNode = graph.nodes.find((node) => node.id === edge.source);
  if (sourceNode?.type === "CONDITION") {
    if (edge.condition !== "true" && edge.condition !== "false")
      throw new Error("condition branch must be true or false");
    if (
      graph.edges.some(
        (entry) =>
          entry.source === edge.source && entry.condition === edge.condition,
      )
    )
      throw new Error("condition branch must be unique");
  } else if (edge.condition !== undefined) {
    throw new Error("condition is only valid for CONDITION branches");
  }
  if (workflowHasPath(graph, edge.target, edge.source))
    throw new Error("edge would create a cycle");
  return { ...graph, edges: [...graph.edges, { ...edge }] };
}

export function removeWorkflowEdge(
  graph: WorkflowGraph,
  edgeId: string,
): WorkflowGraph {
  if (!graph.edges.some((edge) => edge.id === edgeId))
    throw new Error(`edge ${edgeId} not found`);
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) };
}

export function updateWorkflowNodeConfig(
  graph: WorkflowGraph,
  nodeId: string,
  key: "intent" | "topN" | "expression" | "action",
  value: string | number,
): WorkflowGraph {
  if (!workflowEditorConfigKeys.has(key))
    throw new Error("config key is not editable in V1");
  if (!graph.nodes.some((node) => node.id === nodeId))
    throw new Error(`node ${nodeId} not found`);
  if (key === "topN") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 20
    )
      throw new Error("config value is invalid");
  } else if (typeof value !== "string" || !value.trim()) {
    throw new Error("config value is invalid");
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId
        ? { ...node, config: { ...node.config, [key]: value } }
        : node,
    ),
  };
}

export function updateWorkflowSettings(
  graph: WorkflowGraph,
  patch: Partial<WorkflowGraph["settings"]>,
): WorkflowGraph {
  const settings = { ...graph.settings, ...patch };
  if (
    !Number.isSafeInteger(settings.maxSteps) ||
    settings.maxSteps < 1 ||
    settings.maxSteps > 20 ||
    !Number.isSafeInteger(settings.timeoutMs) ||
    settings.timeoutMs < 1 ||
    settings.timeoutMs > 30_000
  )
    throw new Error("workflow settings are invalid");
  return { ...graph, settings };
}

export function workflowGraphEquals(
  left: WorkflowGraph,
  right: WorkflowGraph,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isActionProposalDecisionEnabled(status: string): boolean {
  return status === "WAITING_APPROVAL";
}

export const workflowNodeLabels: Record<string, string> = {
  TRIGGER: "触发器",
  CONDITION: "条件",
  QUERY_PRODUCT: "查询商品",
  QUERY_ORDER: "查询订单",
  QUERY_LOGISTICS: "查询物流",
  AI_GENERATE: "AI 生成",
  HUMAN_APPROVAL: "人工审批",
  END: "结束",
};

export function WorkflowGraphCanvas({
  graph,
  selectedNodeId,
  onSelectNode,
  onMoveNode,
}: {
  graph?: WorkflowGraph;
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
  onMoveNode?: (nodeId: string, position: { x: number; y: number }) => void;
}) {
  if (!graph)
    return (
      <EmptyState
        title="暂无 Graph 快照"
        detail="服务端尚未返回草稿或已发布版本的 Graph。"
      />
    );
  const maxX = Math.max(
    920,
    ...graph.nodes.map((node) => node.position.x + 190),
  );
  const maxY = Math.max(
    320,
    ...graph.nodes.map((node) => node.position.y + 92),
  );
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<
    { nodeId: string; offsetX: number; offsetY: number } | undefined
  >(undefined);
  const pointerPosition = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * maxX,
      y: ((event.clientY - rect.top) / rect.height) * maxY,
    };
  };
  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current || !onMoveNode) return;
    const position = pointerPosition(event);
    onMoveNode(dragRef.current.nodeId, {
      x: Math.max(0, Math.round(position.x - dragRef.current.offsetX)),
      y: Math.max(0, Math.round(position.y - dragRef.current.offsetY)),
    });
  };
  const handlePointerUp = () => {
    dragRef.current = undefined;
  };
  return (
    <div className="workflow-canvas-wrap">
      <svg
        ref={svgRef}
        className={`workflow-canvas ${onMoveNode ? "is-editable" : ""}`}
        viewBox={`0 0 ${maxX} ${maxY}`}
        role="img"
        aria-label="Workflow 节点与连线"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <defs>
          <marker
            id="workflow-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="#9ccfbd" />
          </marker>
        </defs>
        <g className="workflow-edges">
          {graph.edges.map((edge) => {
            const source = nodes.get(edge.source);
            const target = nodes.get(edge.target);
            if (!source || !target) return null;
            return (
              <line
                key={edge.id}
                x1={source.position.x + 82}
                y1={source.position.y + 36}
                x2={target.position.x}
                y2={target.position.y + 36}
                markerEnd="url(#workflow-arrow)"
              />
            );
          })}
        </g>
        <g className="workflow-nodes">
          {graph.nodes.map((node) => (
            <g
              key={node.id}
              className={selectedNodeId === node.id ? "is-selected" : ""}
              transform={`translate(${node.position.x},${node.position.y})`}
              onClick={() => onSelectNode?.(node.id)}
              onPointerDown={(event) => {
                if (!onMoveNode || !svgRef.current) return;
                event.stopPropagation();
                const position = pointerPosition(
                  event as unknown as React.PointerEvent<SVGSVGElement>,
                );
                dragRef.current = {
                  nodeId: node.id,
                  offsetX: position.x - node.position.x,
                  offsetY: position.y - node.position.y,
                };
              }}
            >
              <rect width="164" height="72" rx="10" />
              <text className="workflow-node-type" x="12" y="22">
                {workflowNodeLabels[node.type] ?? node.type}
              </text>
              <text className="workflow-node-id" x="12" y="46">
                {node.id}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <div className="workflow-canvas-footer">
        <span>
          节点 {graph.nodes.length} · 连线 {graph.edges.length}
        </span>
        <span>
          maxSteps {graph.settings.maxSteps} · timeout{" "}
          {graph.settings.timeoutMs}ms
        </span>
      </div>
    </div>
  );
}

export const workflowEditorNodeTypeList: WorkflowNodeType[] = [
  "TRIGGER",
  "CONDITION",
  "QUERY_PRODUCT",
  "QUERY_ORDER",
  "QUERY_LOGISTICS",
  "AI_GENERATE",
  "HUMAN_APPROVAL",
  "END",
];
export type WorkflowEditorConfigKey =
  | "intent"
  | "topN"
  | "expression"
  | "action";

export function autoLayoutWorkflowGraph(graph: WorkflowGraph): WorkflowGraph {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(
    graph.nodes.map((node) => [node.id, [] as string[]]),
  );
  for (const edge of graph.edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const level = new Map<string, number>();
  const queue = graph.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  queue.forEach((id) => level.set(id, 0));
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index]!;
    for (const target of outgoing.get(source) ?? []) {
      level.set(
        target,
        Math.max(level.get(target) ?? 0, (level.get(source) ?? 0) + 1),
      );
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  const rows = new Map<number, number>();
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const depth = level.get(node.id) ?? 0;
      const row = rows.get(depth) ?? 0;
      rows.set(depth, row + 1);
      return { ...node, position: { x: 60 + depth * 230, y: 50 + row * 120 } };
    }),
  };
}

export function WorkflowEditor({
  graph,
  dirty,
  onChange,
}: {
  graph: WorkflowGraph;
  dirty: boolean;
  onChange: (graph: WorkflowGraph) => void;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState(
    graph.nodes[0]?.id ?? "",
  );
  const [newNodeType, setNewNodeType] = useState<WorkflowNodeType>("CONDITION");
  const [newNodeId, setNewNodeId] = useState("");
  const [edgeId, setEdgeId] = useState("");
  const [edgeSource, setEdgeSource] = useState(graph.nodes[0]?.id ?? "");
  const [edgeTarget, setEdgeTarget] = useState(
    graph.nodes[1]?.id ?? graph.nodes[0]?.id ?? "",
  );
  const [edgeCondition, setEdgeCondition] = useState("");
  const [notice, setNotice] = useState("");
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!graph.nodes.some((node) => node.id === selectedNodeId))
      setSelectedNodeId(graph.nodes[0]?.id ?? "");
    if (!graph.nodes.some((node) => node.id === edgeSource))
      setEdgeSource(graph.nodes[0]?.id ?? "");
    if (!graph.nodes.some((node) => node.id === edgeTarget))
      setEdgeTarget(graph.nodes[1]?.id ?? graph.nodes[0]?.id ?? "");
  }, [edgeSource, edgeTarget, graph.nodes, selectedNodeId]);

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const report = (operation: () => WorkflowGraph) => {
    try {
      onChange(operation());
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "编辑操作失败");
    }
  };
  const addNode = (type: WorkflowNodeType = newNodeType) => {
    const id =
      newNodeId.trim() || `${type.toLowerCase()}-${graph.nodes.length + 1}`;
    report(() =>
      addWorkflowNode(graph, {
        id,
        type,
        position: {
          x: 60 + (graph.nodes.length % 4) * 220,
          y: 55 + Math.floor(graph.nodes.length / 4) * 120,
        },
        config: {},
      }),
    );
    setNewNodeId("");
    setSelectedNodeId(id);
  };
  const addEdge = () => {
    const id = edgeId.trim() || `edge-${graph.edges.length + 1}`;
    const sourceNode = graph.nodes.find((node) => node.id === edgeSource);
    report(() =>
      addWorkflowEdge(graph, {
        id,
        source: edgeSource,
        target: edgeTarget,
        ...(sourceNode?.type === "CONDITION"
          ? { condition: edgeCondition }
          : {}),
      }),
    );
    setEdgeId("");
    setEdgeCondition("");
  };
  const configValue = (key: WorkflowEditorConfigKey): string | number => {
    const value = selectedNode?.config[key];
    return typeof value === "string" || typeof value === "number" ? value : "";
  };
  const edgeSourceNode = graph.nodes.find((node) => node.id === edgeSource);
  const usedConditions = new Set(
    graph.edges
      .filter((edge) => edge.source === edgeSource)
      .map((edge) => edge.condition),
  );
  return (
    <section className="workflow-editor-panel panel-surface">
      <div className="table-heading">
        <div>
          <span className="overline">DRAFT EDITOR</span>
          <h3>流程画布</h3>
        </div>
        <span
          className={`status-badge ${dirty ? "is-waiting" : "is-positive"}`}
        >
          {dirty ? "草稿未保存" : "已保存"}
        </span>
      </div>
      <div className="workflow-editor-layout">
        <aside className="workflow-node-palette">
          <div className="workflow-editor-subheading">
            <span>节点库</span>
            <small>点击添加</small>
          </div>
          {workflowEditorNodeTypeList.map((type) => (
            <button key={type} onClick={() => addNode(type)} type="button">
              <span>{workflowNodeLabels[type]}</span>
              <small>{type}</small>
            </button>
          ))}
        </aside>
        <div className="workflow-editor-main">
          <div className="workflow-canvas-toolbar">
            <span>画布</span>
            <div>
              <button
                aria-label="缩小画布"
                onClick={() => setZoom((value) => Math.max(0.7, value - 0.1))}
                type="button"
              >
                <Minus size={14} />
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                aria-label="放大画布"
                onClick={() => setZoom((value) => Math.min(1.4, value + 0.1))}
                type="button"
              >
                <Plus size={14} />
              </button>
              <button onClick={() => setZoom(1)} type="button">
                <Maximize2 size={14} />
                适应
              </button>
              <button
                onClick={() => report(() => autoLayoutWorkflowGraph(graph))}
                type="button"
              >
                <LayoutGrid size={14} />
                自动排列
              </button>
            </div>
          </div>
          <div style={{ zoom }}>
            <WorkflowGraphCanvas
              graph={graph}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onMoveNode={(nodeId, position) =>
                report(() => moveWorkflowNode(graph, nodeId, position))
              }
            />
          </div>
          <div className="workflow-edge-list">
            <div className="workflow-editor-subheading">
              <span>连线</span>
              <small>source → target · V1 禁止循环</small>
            </div>
            {graph.edges.length === 0 ? (
              <div className="table-empty">暂无连线。</div>
            ) : (
              graph.edges.map((edge) => (
                <div className="workflow-edge-row" key={edge.id}>
                  <span>
                    {edge.source} <i>→</i> {edge.target}
                    {edge.condition ? <em>{edge.condition}</em> : null}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      report(() => removeWorkflowEdge(graph, edge.id))
                    }
                  >
                    删除
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        <aside className="workflow-editor-controls">
          <div className="workflow-editor-subheading">
            <span>节点</span>
            <small>仅 8 种 V1 类型</small>
          </div>
          <label className="compact-field">
            <span>当前节点</span>
            <select
              value={selectedNodeId}
              onChange={(event) => setSelectedNodeId(event.currentTarget.value)}
            >
              {graph.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.id} · {node.type}
                </option>
              ))}
            </select>
          </label>
          <div className="workflow-editor-inline">
            <input
              value={newNodeId}
              onChange={(event) => setNewNodeId(event.currentTarget.value)}
              placeholder="新节点 ID"
              aria-label="新节点 ID"
            />
            <select
              value={newNodeType}
              onChange={(event) =>
                setNewNodeType(event.currentTarget.value as WorkflowNodeType)
              }
              aria-label="新节点类型"
            >
              {workflowEditorNodeTypeList.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <button
              className="outline-button"
              type="button"
              onClick={() => addNode()}
            >
              添加
            </button>
          </div>
          <button
            className="workflow-danger-button"
            type="button"
            onClick={() =>
              selectedNode &&
              report(() => removeWorkflowNode(graph, selectedNode.id))
            }
            disabled={!selectedNode}
          >
            删除当前节点
          </button>
          <div className="workflow-editor-subheading">
            <span>节点参数</span>
            <small>{selectedNode?.type ?? "未选择"}</small>
          </div>
          {selectedNode ? (
            <div className="workflow-config-fields">
              {(
                [
                  "intent",
                  "topN",
                  "expression",
                  "action",
                ] as WorkflowEditorConfigKey[]
              ).map((key) => (
                <label className="compact-field" key={key}>
                  <span>{key}</span>
                  <input
                    type={key === "topN" ? "number" : "text"}
                    value={configValue(key)}
                    onChange={(event) =>
                      report(() =>
                        updateWorkflowNodeConfig(
                          graph,
                          selectedNode.id,
                          key,
                          key === "topN"
                            ? Number(event.currentTarget.value)
                            : event.currentTarget.value,
                        ),
                      )
                    }
                    placeholder="未设置"
                  />
                </label>
              ))}
            </div>
          ) : (
            <div className="table-empty">选择节点后编辑受控参数。</div>
          )}
          <div className="workflow-editor-subheading">
            <span>执行设置</span>
            <small>执行上限</small>
          </div>
          <div className="workflow-config-fields settings-fields">
            <label className="compact-field">
              <span>maxSteps</span>
              <input
                type="number"
                min="1"
                max="20"
                value={graph.settings.maxSteps}
                onChange={(event) =>
                  report(() =>
                    updateWorkflowSettings(graph, {
                      maxSteps: Number(event.currentTarget.value),
                    }),
                  )
                }
              />
            </label>
            <label className="compact-field">
              <span>timeoutMs</span>
              <input
                type="number"
                min="1"
                max="30000"
                value={graph.settings.timeoutMs}
                onChange={(event) =>
                  report(() =>
                    updateWorkflowSettings(graph, {
                      timeoutMs: Number(event.currentTarget.value),
                    }),
                  )
                }
              />
            </label>
          </div>
          <div className="workflow-editor-subheading">
            <span>新增连线</span>
            <small>
              {edgeSourceNode?.type === "CONDITION"
                ? "CONDITION · 必须选择 true / false"
                : "source → target"}
            </small>
          </div>
          <div className="workflow-edge-form">
            <input
              value={edgeId}
              onChange={(event) => setEdgeId(event.currentTarget.value)}
              placeholder="连线 ID"
              aria-label="连线 ID"
            />
            <select
              value={edgeSource}
              onChange={(event) => setEdgeSource(event.currentTarget.value)}
              aria-label="连线 source"
            >
              {graph.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.id}
                </option>
              ))}
            </select>
            <span>→</span>
            <select
              value={edgeTarget}
              onChange={(event) => setEdgeTarget(event.currentTarget.value)}
              aria-label="连线 target"
            >
              {graph.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.id}
                </option>
              ))}
            </select>
            {edgeSourceNode?.type === "CONDITION" && (
              <select
                value={edgeCondition}
                onChange={(event) =>
                  setEdgeCondition(event.currentTarget.value)
                }
                aria-label="连线 condition"
              >
                <option value="">选择分支…</option>
                <option value="true" disabled={usedConditions.has("true")}>
                  true
                </option>
                <option value="false" disabled={usedConditions.has("false")}>
                  false
                </option>
              </select>
            )}
            <button
              className="outline-button"
              type="button"
              onClick={addEdge}
              disabled={graph.nodes.length < 2}
            >
              添加
            </button>
          </div>
          {notice && (
            <div className="workflow-editor-notice" role="alert">
              {notice}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

export function WorkflowAdminPage({
  token,
  refreshKey,
}: Pick<SharedViewProps, "token" | "refreshKey">) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [workflowQuery, setWorkflowQuery] = useState("");
  const [selected, setSelected] = useState<Workflow>();
  const [draftGraph, setDraftGraph] = useState<WorkflowGraph>();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resourceError, setResourceError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [runError, setRunError] = useState("");
  const [action, setAction] = useState("");
  const [proposalAction, setProposalAction] = useState("");
  const [notice, setNotice] = useState("");
  const [localRefresh, setLocalRefresh] = useState(0);
  const [publishPending, setPublishPending] = useState(false);
  const [proposalPending, setProposalPending] = useState<{
    id: string;
    contextVersion?: number;
  }>();
  const workflowRequestChain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueWorkflowRequest = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      const queued = workflowRequestChain.current.then(operation, operation);
      workflowRequestChain.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setResourceError("");
    void enqueueWorkflowRequest(() => getWorkflows(token))
      .then((next) => {
        if (!mounted) return;
        setWorkflows(next);
        setSelectedId((current) =>
          current && next.some((workflow) => workflow.id === current)
            ? current
            : (next[0]?.id ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setWorkflows([]);
        setSelectedId("");
        setResourceError(errorMessage(error));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [enqueueWorkflowRequest, localRefresh, refreshKey, token]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(undefined);
      setDraftGraph(undefined);
      setRuns([]);
      return;
    }
    let mounted = true;
    setDetailLoading(true);
    setDetailError("");
    setRunError("");
    void enqueueWorkflowRequest(async () => {
      const detail = await getWorkflow(token, selectedId);
      try {
        return {
          detail,
          runs: await getWorkflowRuns(token, { workflowId: selectedId }),
          runError: "",
        };
      } catch (error) {
        return {
          detail,
          runs: [] as WorkflowRun[],
          runError: errorMessage(error),
        };
      }
    })
      .then(({ detail, runs: nextRuns, runError: nextRunError }) => {
        if (!mounted) return;
        setSelected(detail);
        const persistedGraph =
          detail.draftVersion?.graph ?? detail.activeVersion?.graph;
        setDraftGraph(
          persistedGraph
            ? (JSON.parse(JSON.stringify(persistedGraph)) as WorkflowGraph)
            : undefined,
        );
        setRuns(nextRuns);
        setRunError(nextRunError);
      })
      .catch((error) => {
        if (!mounted) return;
        setSelected(undefined);
        setDraftGraph(undefined);
        setDetailError(errorMessage(error));
      })
      .finally(() => {
        if (mounted) setDetailLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [enqueueWorkflowRequest, localRefresh, selectedId, token]);

  const runAction = async (kind: "save" | "publish" | "enable" | "disable") => {
    const persistedGraph =
      selected?.draftVersion?.graph ?? selected?.activeVersion?.graph;
    const graph = draftGraph ?? persistedGraph;
    const dirty = Boolean(
      draftGraph &&
        persistedGraph &&
        !workflowGraphEquals(draftGraph, persistedGraph),
    );
    if (!selected || (kind === "save" && (!draftGraph || !dirty))) return;
    setAction(kind);
    setNotice("");
    try {
      await enqueueWorkflowRequest(async () => {
        if (kind === "save" && draftGraph)
          await saveWorkflowDraft(token, selected.id, draftGraph);
        if (kind === "publish") {
          if (draftGraph && dirty)
            await saveWorkflowDraft(token, selected.id, draftGraph);
          await publishWorkflow(token, selected.id);
        }
        if (kind === "enable") await enableWorkflow(token, selected.id);
        if (kind === "disable") await disableWorkflow(token, selected.id);
      });
      setNotice(
        kind === "save"
          ? "草稿已提交保存"
          : kind === "publish"
            ? "发布请求已提交"
            : kind === "enable"
              ? "启用请求已提交"
              : "停用请求已提交",
      );
      setLocalRefresh((value) => value + 1);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setAction("");
    }
  };

  const decideProposal = async (
    proposalId: string,
    decision: "approve" | "reject",
    contextVersion?: number,
  ) => {
    setProposalAction(`${decision}:${proposalId}`);
    setNotice("");
    try {
      await enqueueWorkflowRequest(async () => {
        if (decision === "approve")
          await approveActionProposal(
            token,
            proposalId,
            contextVersion === undefined
              ? {}
              : { expectedContextVersion: contextVersion },
          );
        else await rejectActionProposal(token, proposalId, {});
      });
      setNotice(
        decision === "approve"
          ? "Proposal 批准请求已提交"
          : "Proposal 拒绝请求已提交",
      );
      setLocalRefresh((value) => value + 1);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setProposalAction("");
    }
  };

  const persistedGraph =
    selected?.draftVersion?.graph ?? selected?.activeVersion?.graph;
  const graph = draftGraph ?? persistedGraph;
  const dirty = Boolean(
    draftGraph &&
      persistedGraph &&
      !workflowGraphEquals(draftGraph, persistedGraph),
  );
  const latestRun = runs[0];
  const visibleWorkflows = workflows.filter((workflow) =>
    `${workflow.name ?? ""} ${workflow.status}`
      .toLocaleLowerCase("zh-CN")
      .includes(workflowQuery.trim().toLocaleLowerCase("zh-CN")),
  );
  return (
    <div className="admin-page phase05-page workflow-admin-page">
      {publishPending && (
        <ConfirmDialog
          busy={action === "publish"}
          confirmLabel="确认发布"
          description="发布后将生成不可变版本，并可能影响后续真实 Workflow Run。"
          onCancel={() => setPublishPending(false)}
          onConfirm={() =>
            void runAction("publish").finally(() => setPublishPending(false))
          }
          open
          title="发布 Workflow 版本"
        />
      )}
      {proposalPending && (
        <ConfirmDialog
          busy={proposalAction === `approve:${proposalPending.id}`}
          confirmLabel="确认批准"
          description="批准后将执行受控 Proposal；系统会在提交前重新校验 ContextVersion 与目标快照。"
          onCancel={() => setProposalPending(undefined)}
          onConfirm={() =>
            void decideProposal(
              proposalPending.id,
              "approve",
              proposalPending.contextVersion,
            ).finally(() => setProposalPending(undefined))
          }
          open
          title="批准高风险操作"
        />
      )}
      <AdminTabs active="workflows" />
      <Phase05AdminHeader
        overline="WORKFLOW CONTROL"
        title="工作流"
        description="使用固定节点搭建回复流程；草稿、发布版本、运行记录与人工审批均来自真实数据。"
      />
      {notice && (
        <div className="inline-notice" role="status">
          {notice}
        </div>
      )}
      {loading ? (
        <Phase05LoadingState label="正在读取工作流快照…" />
      ) : resourceError ? (
        <Phase05ErrorState message={resourceError} />
      ) : workflows.length === 0 ? (
        <EmptyState
          title="暂无工作流快照"
          detail="当前 Workspace 没有可展示的 Workflow 定义。"
        />
      ) : (
        <>
          <div className="workflow-workspace-layout">
            <aside
              aria-label="工作流列表"
              className="workflow-browser panel-surface"
            >
              <div className="workflow-browser-heading">
                <div>
                  <span className="overline">WORKFLOWS</span>
                  <h3>工作流</h3>
                </div>
                <span className="quiet-label">{workflows.length} 个</span>
              </div>
              <label className="workflow-browser-search">
                <Search aria-hidden="true" size={15} />
                <input
                  aria-label="搜索工作流"
                  onChange={(event) =>
                    setWorkflowQuery(event.currentTarget.value)
                  }
                  placeholder="搜索名称或状态"
                  value={workflowQuery}
                />
              </label>
              <div className="workflow-browser-list">
                {visibleWorkflows.length === 0 ? (
                  <div className="table-empty">没有匹配的工作流。</div>
                ) : (
                  visibleWorkflows.map((workflow) => (
                    <button
                      aria-pressed={workflow.id === selectedId}
                      className={workflow.id === selectedId ? "is-active" : ""}
                      key={workflow.id}
                      onClick={() => setSelectedId(workflow.id)}
                      type="button"
                    >
                      <span>
                        <strong>{workflow.name || shortId(workflow.id)}</strong>
                        <small>
                          {workflow.activeVersion
                            ? `已发布 v${workflow.activeVersion.version}`
                            : workflow.draftVersion
                              ? `草稿 v${workflow.draftVersion.version}`
                              : "暂无版本"}
                        </small>
                      </span>
                      <i className={phase05StatusClass(workflow.status)} />
                    </button>
                  ))
                )}
              </div>
              <div className="workflow-browser-note">
                选择左侧工作流后，在右侧编辑草稿、发布版本并检查运行记录。
              </div>
            </aside>
            <div className="workflow-workspace-main">
              <section className="workflow-toolbar panel-surface">
                <div className="workflow-toolbar-title">
                  <span className="overline">SELECTED WORKFLOW</span>
                  <strong>{selected?.name || shortId(selectedId)}</strong>
                </div>
                {selected && (
                  <>
                    <span
                      className={`status-badge ${phase05StatusClass(selected.status)}`}
                    >
                      {statusLabel(selected.status)}
                      {dirty ? " · Draft" : ""}
                    </span>
                    <button
                      className="outline-button"
                      type="button"
                      onClick={() => void runAction("save")}
                      disabled={action !== "" || !dirty}
                    >
                      {action === "save" ? "保存中…" : "保存草稿"}
                    </button>
                    <button
                      className="outline-button"
                      type="button"
                      onClick={() => setPublishPending(true)}
                      disabled={action !== "" || !graph}
                    >
                      {action === "publish" ? "发布中…" : "发布版本"}
                    </button>
                    <button
                      className="outline-button"
                      type="button"
                      onClick={() =>
                        void runAction(
                          selected.status === "PUBLISHED"
                            ? "disable"
                            : "enable",
                        )
                      }
                      disabled={action !== ""}
                    >
                      {action === "enable" || action === "disable"
                        ? "提交中…"
                        : selected.status === "PUBLISHED"
                          ? "停用"
                          : "启用"}
                    </button>
                  </>
                )}
              </section>
              {detailLoading ? (
                <Phase05LoadingState label="正在读取 Workflow 详情与运行日志…" />
              ) : detailError ? (
                <Phase05ErrorState message={detailError} />
              ) : (
                selected && (
                  <>
                    {graph ? (
                      <WorkflowEditor
                        graph={graph}
                        dirty={dirty}
                        onChange={setDraftGraph}
                      />
                    ) : (
                      <section className="workflow-canvas-panel panel-surface">
                        <WorkflowGraphCanvas graph={graph} />
                      </section>
                    )}
                    <section className="workflow-runtime-grid">
                      <div className="phase05-resource-list panel-surface">
                        <div className="phase05-list-heading">
                          <span className="overline">WORKFLOW RUNS</span>
                          <span className="quiet-label">{runs.length} 条</span>
                        </div>
                        {runError ? (
                          <div className="inline-notice">{runError}</div>
                        ) : runs.length === 0 ? (
                          <div className="table-empty">暂无 Run 快照。</div>
                        ) : (
                          runs.slice(0, 5).map((run) => (
                            <article className="phase05-list-row" key={run.id}>
                              <div>
                                <strong>{shortId(run.id)}</strong>
                                <small>
                                  {run.conversationId
                                    ? `Conversation · ${shortId(run.conversationId)}`
                                    : "Conversation —"}{" "}
                                  · {run.nodeRuns?.length ?? 0} NodeRun
                                </small>
                              </div>
                              <span
                                className={`status-badge ${phase05StatusClass(run.status)}`}
                              >
                                {statusLabel(run.status)}
                              </span>
                            </article>
                          ))
                        )}
                      </div>
                      <div className="phase05-resource-list panel-surface">
                        <div className="phase05-list-heading">
                          <span className="overline">NODE RUN / APPROVAL</span>
                          <span className="quiet-label">
                            {latestRun ? shortId(latestRun.id) : "—"}
                          </span>
                        </div>
                        {latestRun?.nodeRuns?.length ? (
                          latestRun.nodeRuns.map((nodeRun) => (
                            <article
                              className="phase05-list-row"
                              key={nodeRun.id}
                            >
                              <div>
                                <strong>{nodeRun.nodeId}</strong>
                                <small>
                                  retry {nodeRun.retryCount} ·{" "}
                                  {nodeRun.durationMs ?? "—"}ms
                                </small>
                              </div>
                              <span
                                className={`status-badge ${phase05StatusClass(nodeRun.status)}`}
                              >
                                {statusLabel(nodeRun.status)}
                              </span>
                            </article>
                          ))
                        ) : (
                          <div className="table-empty">暂无 NodeRun 快照。</div>
                        )}
                        {latestRun?.proposals?.map((proposal) => {
                          const decisionEnabled =
                            isActionProposalDecisionEnabled(proposal.status);
                          return (
                            <article
                              className="phase05-approval-row"
                              key={proposal.id}
                            >
                              <div className="phase05-approval-summary">
                                <strong>Approval · {proposal.type}</strong>
                                <span>
                                  {proposal.targetEntityType} ·{" "}
                                  {shortId(proposal.targetEntityId)} · 风险{" "}
                                  {proposal.riskLevel}
                                </span>
                                <small>
                                  依据：
                                  {proposal.evidenceIds?.join(", ") ||
                                    "未提供 evidence"}{" "}
                                  · context v{proposal.contextVersion}
                                </small>
                                <code>
                                  {JSON.stringify(proposal.payload ?? {})}
                                </code>
                              </div>
                              <span
                                className={`status-badge ${phase05StatusClass(proposal.status)}`}
                              >
                                {statusLabel(proposal.status)}
                              </span>
                              <div className="phase05-approval-actions">
                                <button
                                  className="primary-button"
                                  type="button"
                                  onClick={() =>
                                    setProposalPending({
                                      id: proposal.id,
                                      contextVersion: proposal.contextVersion,
                                    })
                                  }
                                  disabled={
                                    !decisionEnabled || proposalAction !== ""
                                  }
                                >
                                  {proposalAction === `approve:${proposal.id}`
                                    ? "提交中…"
                                    : "批准"}
                                </button>
                                <button
                                  className="outline-button"
                                  type="button"
                                  onClick={() =>
                                    void decideProposal(proposal.id, "reject")
                                  }
                                  disabled={
                                    !decisionEnabled || proposalAction !== ""
                                  }
                                >
                                  {proposalAction === `reject:${proposal.id}`
                                    ? "提交中…"
                                    : "拒绝"}
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  </>
                )
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
