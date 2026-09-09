import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { api, type GraphData } from '../api'

/* ---------- React Flow 自定义节点（附状态徽章与类型化句柄） ---------- */

interface FlowData {
  label: string
  state: 'active' | 'inactive' | 'error'
  layer: string | null
  hot: boolean
}

function FlowNode({ data }: NodeProps): ReactNode {
  const d = data as unknown as FlowData
  return (
    <div className={`flow-node ${d.state}`} title={`${d.label}${d.layer ? ` · ${d.layer}` : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-name">{d.label.replace(/^@geewiki\//, '')}</div>
      <div className="flow-node-meta">
        <span className={`badge badge-${d.state}`}>
          {d.state === 'active' ? '●' : d.state === 'error' ? '✕' : '○'}{' '}
          {d.state === 'active' ? '运行' : d.state === 'error' ? '异常' : '未启用'}
        </span>
        {d.layer && <span className={`badge badge-${d.layer}`}>{d.layer === 'base' ? '基础层' : '会话层'}</span>}
        <span className={`badge ${d.hot ? 'badge-hot' : 'badge-cold'}`}>{d.hot ? '热' : '冷'}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { flow: FlowNode }

/* ---------- 简易分层布局（无外部图算法依赖）：被依赖方在左，边右指向依赖方 ---------- */

function layoutGraph(g: GraphData): { nodes: Node[]; edges: Edge[] } {
  const ids = g.nodes.map((n) => n.id)
  const idSet = new Set(ids)
  // 边引用清理（防脏数据）
  const edges = g.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target)
  const incoming = new Map<string, string[]>()
  for (const e of edges) {
    const list = incoming.get(e.target) ?? []
    list.push(e.source)
    incoming.set(e.target, list)
  }
  // level[node] = 0（无依赖）或 max(level[依赖方])+1；循环推进直至稳定（含环兜底）
  const level = new Map<string, number>(ids.map((id) => [id, 0]))
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false
    for (const e of edges) {
      const want = (level.get(e.source) ?? 0) + 1
      if (want > (level.get(e.target) ?? 0)) {
        level.set(e.target, want)
        changed = true
      }
    }
    if (!changed) break
  }
  // 按层分组的纵向排布：同层按节点原始顺序均匀错开
  const byLevel = new Map<number, string[]>()
  for (const id of ids) {
    const l = level.get(id) ?? 0
    const list = byLevel.get(l) ?? []
    list.push(id)
    byLevel.set(l, list)
  }
  const colW = 250
  const rowH = 96
  const nodes: Node[] = g.nodes.map((n) => {
    const l = level.get(n.id) ?? 0
    const siblings = byLevel.get(l) ?? []
    const idx = siblings.indexOf(n.id)
    const maxH = Math.max(1, siblings.length)
    const y = 30 + idx * rowH + (siblings.length > 1 ? 0 : 0) // 单节点纵向居中
    return {
      id: n.id,
      type: 'flow',
      position: { x: 20 + l * colW, y: siblings.length > 1 ? y : Math.max(y, 60) },
      data: {
        label: n.label,
        state: n.state,
        layer: n.layer,
        hot: n.hotReloadable,
      } satisfies FlowData,
    }
  })
  return { nodes, edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, markerEnd: { type: 'arrowclosed' } })) }
}

/* ---------- 页面 ---------- */

export function GraphPage(): ReactNode {
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [err, setErr] = useState('')

  const load = (): void => {
    setErr('')
    api
      .graph()
      .then((r) => setGraph(r.graph))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const { nodes, edges } = useMemo(() => (graph ? layoutGraph(graph) : { nodes: [], edges: [] }), [graph])

  return (
    <div className="page page-graph">
      <div className="page-head">
        <h1>插件依赖图</h1>
        <div className="page-actions">
          {err && <span className="notice err">{err}</span>}
          <button className="btn" onClick={load}>↻ 重新布局</button>
        </div>
      </div>
      <div className="legend">
        <span><i className="dot active" />运行中</span>
        <span><i className="dot inactive" />未启用</span>
        <span><i className="dot error" />异常</span>
        <span className="muted">· 边 = requires 依赖方向（被依赖方 → 依赖方），来源: GET /api/plugins/graph</span>
      </div>
      <div className="graph-canvas">
        {graph === null && !err && <div className="empty">加载中…</div>}
        {err && <div className="empty err-text">依赖图加载失败：{err}</div>}
        {graph && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            nodesDraggable
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}
