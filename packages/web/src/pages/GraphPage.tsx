import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { AlertTriangle, Info, RefreshCw, Workflow } from 'lucide-react'
import { api, type GraphData, type GraphNodeInfo } from '../api'
import { Badge, Button, Dialog, DialogClose, DialogContent, Skeleton } from '../ui'
import {
  LAYER_HUMAN,
  LAYER_TECH,
  STATE_TEXT,
  estimateNodeWidth,
  labelSegments,
  plainName,
  stateTone,
} from '../lib/pluginDisplay'

/* ---------- 节点 ---------- */

interface FlowData extends Record<string, unknown> {
  /** 完整标识（`@geewiki/wiki`）；节点上显示的是去 scope 的短名，全名进 tooltip/详情 */
  fullName: string
  state: GraphNodeInfo['state']
  layer: string | null
  hot: boolean
  conflictGroup?: string
  /** 有几个插件依赖它（在详情里用；由 layoutGraph 预计算） */
  dependentCount: number
}

/**
 * 把标识符按**分隔符**切成可断行片段。
 *
 * 为什么这么做：原先节点名交给 CSS 折行，而 `@geewiki-plugin/hello` 这类标识符
 * **没有空格**，浏览器只能从词中间劈开——截图实测出现过 `@geewiki-plugin/hel` 折到
 * 下一行 `lo` 的情况。这里在 `-` `/` `_` `.` 之后插入 `<wbr>`，
 * 于是折行只会发生在语义边界；再配合 {@link estimateNodeWidth} 按最长片段给宽，
 * 常见名字根本不会折行。
 */
function BreakableLabel({ text }: { text: string }): ReactNode {
  const segs = labelSegments(text)
  return (
    <>
      {segs.map((s, i) => (
        <span key={`${s}:${i}`}>
          {s}
          {i < segs.length - 1 && <wbr />}
        </span>
      ))}
    </>
  )
}

function FlowNode({ data, selected }: NodeProps): ReactNode {
  const d = data as FlowData
  const short = plainName(d.fullName)
  return (
    <div
      className={[
        'rounded-lg border bg-surface px-3 py-2 shadow-sm transition-colors',
        selected ? 'border-accent ring-1 ring-accent' : 'border-line',
        d.state === 'error' ? 'border-warn-line bg-warn-bg' : '',
      ].join(' ')}
    >
      <Handle type="target" position={Position.Left} />
      {/* 全名放 tooltip 与详情对话框，节点上只显示可读短名（信息不丢，只是不挤在图上） */}
      <div className="text-[13px] leading-snug font-medium break-normal text-ink" title={d.fullName}>
        <BreakableLabel text={short} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Badge tone={stateTone(d.state)}>{STATE_TEXT[d.state]}</Badge>
        {d.layer !== null && <Badge tone="neutral">{LAYER_HUMAN[d.layer as 'base' | 'session']}</Badge>}
      </div>
      {/* 入/出句柄在左/右，箭头方向＝依赖方向 */}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

/* ---------- 边（hover 显示"谁依赖谁"） ---------- */

interface FlowEdgeData extends Record<string, unknown> {
  /** 被依赖方的显示名 */
  from: string
  /** 依赖方的显示名 */
  to: string
}

/**
 * 自定义边：默认只画线，**hover 时**才显示「A 依赖 B」。
 *
 * 为什么不是常显标签：8 个插件就有 10 条边，常显文字会把图糊成一片；
 * 而"边到底表示什么"又是用户看这张图的首要疑问。hover 揭示是两者的折中。
 * 用 `EdgeLabelRenderer` + CSS `group-hover`（而不是 JS 状态），避免每条边都挂
 * 一个监听器导致拖动时重渲染。
 */
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps): ReactNode {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  const d = (data ?? {}) as FlowEdgeData
  return (
    <g className="group">
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          className="pointer-events-none absolute z-[1] rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11px] whitespace-nowrap text-ink-soft opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
        >
          {d.from} 被 {d.to} 依赖
        </div>
      </EdgeLabelRenderer>
    </g>
  )
}

const nodeTypes = { flow: FlowNode }
const edgeTypes = { flow: FlowEdge }

/* ---------- 分层布局（无外部图算法依赖）：被依赖方在左，箭头指向依赖方 ---------- */

function layoutGraph(g: GraphData): { nodes: Node[]; edges: Edge[]; width: number } {
  const ids = g.nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  // 边引用清理（防脏数据）
  const rawEdges = g.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target)
  // level[node] = 0（无依赖）或 max(level[依赖方])+1；循环推进直至稳定（含环兜底）
  const level = new Map<string, number>(ids.map((id) => [id, 0]))
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false
    for (const e of rawEdges) {
      const want = (level.get(e.source) ?? 0) + 1
      if (want > (level.get(e.target) ?? 0)) {
        level.set(e.target, want)
        changed = true
      }
    }
    if (!changed) break
  }
  // 按层分组；列宽取该层最宽节点 + 固定间距（避免长名字互相压住）
  const byLevel = new Map<number, string[]>()
  for (const id of ids) {
    const l = level.get(id) ?? 0
    const list = byLevel.get(l) ?? []
    list.push(id)
    byLevel.set(l, list)
  }
  const GAP_X = 70
  const ROW_H = 86
  const widthOf = new Map(ids.map((id) => [id, estimateNodeWidth(plainName(id))]))
  const colWidth = new Map<number, number>()
  for (const [l, list] of byLevel) {
    colWidth.set(l, Math.max(120, ...list.map((id) => widthOf.get(id) ?? 120)))
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b)
  const colX = new Map<number, number>()
  let x = 24
  for (const l of levels) {
    colX.set(l, x)
    x += (colWidth.get(l) ?? 120) + GAP_X
  }
  const dependentCount = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const e of rawEdges) dependentCount.set(e.source, (dependentCount.get(e.source) ?? 0) + 1)

  const nodes: Node[] = g.nodes.map((n) => {
    const l = level.get(n.id) ?? 0
    const siblings = byLevel.get(l) ?? []
    const idx = siblings.indexOf(n.id)
    const w = widthOf.get(n.id) ?? 140
    return {
      id: n.id,
      type: 'flow',
      // 纵向均匀错开；单节点时给一个最小偏移，避免贴顶
      position: { x: colX.get(l) ?? 24, y: 24 + idx * ROW_H },
      style: { width: w },
      data: {
        fullName: n.label,
        state: n.state,
        layer: n.layer,
        hot: n.hotReloadable,
        conflictGroup: n.conflictGroup,
        dependentCount: dependentCount.get(n.id) ?? 0,
      } satisfies FlowData,
    }
  })
  const edges: Edge[] = rawEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'flow',
    markerEnd: { type: 'arrowclosed' },
    // 加宽不可见命中区，否则细线几乎 hover 不到
    interactionWidth: 18,
    data: {
      from: plainName(byId.get(e.source)?.label ?? e.source),
      to: plainName(byId.get(e.target)?.label ?? e.target),
    } satisfies FlowEdgeData,
  }))
  return { nodes, edges, width: x }
}

/* ---------- 页面 ---------- */

export function GraphPage(): ReactNode {
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<string | null>(null)

  const load = useCallback((): void => {
    setErr('')
    setLoading(true)
    api
      .graph()
      .then((r) => setGraph(r.graph))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  const { nodes, edges } = useMemo<{ nodes: Node[]; edges: Edge[] }>(
    () => (graph ? layoutGraph(graph) : { nodes: [], edges: [] }),
    [graph],
  )
  const detailNode = detail !== null ? (graph?.nodes.find((n) => n.id === detail) ?? null) : null

  return (
    <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-3 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-lg font-semibold text-ink">插件依赖图</h1>
          <p className="m-0 mt-0.5 text-xs text-muted">
            箭头从「被依赖的插件」指向「依赖它的插件」。点击任一插件查看详情。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {err !== '' && (
            <span role="status" className="rounded-md border border-danger-line bg-danger-bg px-2.5 py-1 text-xs text-danger-ink">
              {err}
            </span>
          )}
          <Button icon={<RefreshCw className="size-3.5" />} onClick={load} loading={loading}>
            重新布局
          </Button>
        </div>
      </header>

      {/* 图例：只用图上的视觉语言，不出现任何接口路径 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <i className="size-2 rounded-full bg-ok" aria-hidden="true" />
          {STATE_TEXT.active}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="size-2 rounded-full bg-line-strong" aria-hidden="true" />
          {STATE_TEXT.inactive}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="size-2 rounded-full bg-warn" aria-hidden="true" />
          {STATE_TEXT.error}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Info className="size-3.5" aria-hidden="true" />
          把鼠标移到一条线上，可以看到它表示哪两个插件之间的依赖
        </span>
      </div>

      <div className="h-[min(70vh,44rem)] overflow-hidden rounded-lg border border-line bg-sunken">
        {loading && graph === null && (
          <div className="grid h-full place-items-center p-6">
            <Skeleton className="h-full w-full rounded-md" />
          </div>
        )}
        {!loading && err !== '' && (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="flex flex-col items-center gap-2">
              <AlertTriangle className="size-6 text-warn" aria-hidden="true" />
              <p className="m-0 text-sm font-medium text-ink">依赖图加载失败</p>
              <p className="m-0 max-w-[46ch] text-xs text-muted">{err}</p>
              <Button size="sm" onClick={load}>
                重试
              </Button>
            </div>
          </div>
        )}
        {!loading && err === '' && graph !== null && graph.nodes.length === 0 && (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="flex flex-col items-center gap-2">
              <Workflow className="size-6 text-muted" aria-hidden="true" />
              <p className="m-0 text-sm font-medium text-ink">还没有可显示的插件</p>
              <p className="m-0 max-w-[46ch] text-xs text-muted">启用至少一个插件后，这里会画出它们之间的依赖关系。</p>
            </div>
          </div>
        )}
        {graph !== null && graph.nodes.length > 0 && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            nodesDraggable
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => setDetail(n.id)}
          >
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>

      {/* 节点详情：把全名与依赖关系讲清楚，避免"图上看不懂" */}
      <Dialog open={detailNode !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent
          title={detailNode ? plainName(detailNode.label) : ''}
          description={detailNode?.label}
          footer={
            <DialogClose asChild>
              <Button>关闭</Button>
            </DialogClose>
          }
        >
          {detailNode && (
            <dl className="m-0 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-xs text-muted">状态</dt>
              <dd className="m-0">
                <Badge tone={stateTone(detailNode.state)}>{STATE_TEXT[detailNode.state]}</Badge>
              </dd>
              <dt className="text-xs text-muted">所在层</dt>
              <dd className="m-0 text-xs text-ink-soft">
                {detailNode.layer !== null ? LAYER_TECH[detailNode.layer as 'base' | 'session'] : '当前未激活'}
              </dd>
              <dt className="text-xs text-muted">热插拔</dt>
              <dd className="m-0 text-xs text-ink-soft">
                {detailNode.hotReloadable ? '支持：改动立即生效，无需重启' : '不支持：改动需重启进程'}
              </dd>
              {detailNode.conflictGroup !== undefined && (
                <>
                  <dt className="text-xs text-muted">冲突组</dt>
                  <dd className="m-0 font-mono text-xs break-all text-ink-soft">{detailNode.conflictGroup}</dd>
                </>
              )}
              <dt className="text-xs text-muted">被依赖</dt>
              <dd className="m-0 text-xs text-ink-soft">
                {(graph?.edges.filter((e) => e.source === detailNode.id).length ?? 0) > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {graph?.edges
                      .filter((e) => e.source === detailNode.id)
                      .map((e) => (
                        <Badge key={e.id} tone="neutral">
                          {plainName(graph.nodes.find((n) => n.id === e.target)?.label ?? e.target)}
                        </Badge>
                      ))}
                  </span>
                ) : (
                  '没有插件依赖它'
                )}
              </dd>
              <dt className="text-xs text-muted">它依赖</dt>
              <dd className="m-0 text-xs text-ink-soft">
                {(graph?.edges.filter((e) => e.target === detailNode.id).length ?? 0) > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {graph?.edges
                      .filter((e) => e.target === detailNode.id)
                      .map((e) => (
                        <Badge key={e.id} tone="neutral">
                          {plainName(graph.nodes.find((n) => n.id === e.source)?.label ?? e.source)}
                        </Badge>
                      ))}
                  </span>
                ) : (
                  '不依赖其它插件'
                )}
              </dd>
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
