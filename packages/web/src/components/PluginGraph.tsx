/**
 * 插件依赖图的**画布**（React Flow 渲染层）。
 *
 * 职责边界（"插件管理与依赖图合并"后的拆法）：
 *   · 这里只负责"把图**画对**"——布局、连线、悬停高亮、点击回调；
 *   · 插件列表、启停、配置表单、临时变更等**管理逻辑**都在页面里（`pages/GraphPage.tsx`），
 *     点击节点后由页面打开详情/配置弹窗。
 *
 * 两条与用户反馈直接对应的设计：
 *
 *  1. **线不再交织**：分层只解决"被依赖方在左"，层内顺序才是交叉的来源。布局改用
 *     `lib/pluginGraphPlan.ts` 的重心法（barycenter）排序——层内顺序按邻居的平均位置排，
 *     左右交替扫几遍，每遍算交叉数、只留最好的一版（单调不劣）。原先直接沿用注册表顺序，
 *     于是同层里 A 的依赖方排在 B 的依赖方前面，两条边必然相交。
 *
 *  2. **悬停高亮一整条依赖链，只向前、不向后**：`upstreamClosure` 只沿"我依赖谁"的方向
 *     （图上向左）传递，**下游（依赖它的插件）一律不亮**——那是"停用它会影响谁"，
 *     属于另一个问题。链外的节点与边降到 40% 不透明度，链本身的边加粗，于是"这条链"
 *     在一堆线里一眼可辨。判定逻辑在 lib 里（有单测），这里只消费结果。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background,
  BaseEdge,
  ControlButton,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  getSmoothStepPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { Maximize, Minus, Plus } from 'lucide-react'
import type { GraphData } from '../api'
import { Badge } from '../ui'
import {
  LAYER_HUMAN,
  TONE_TEXT,
  estimateNodeWidth,
  labelSegments,
  pluginToneOf,
  type PluginTone,
} from '../lib/pluginDisplay'
import { planGraph, transitiveReduction, upstreamClosure, type GraphEdgeLike } from '../lib/pluginGraphPlan'

/**
 * 悬停时链外元素的压暗程度。
 *
 * 为什么是 0.28 而不是 0.4：高亮的**主要手段必须是正强调**（链上加环、加粗），
 * 压暗只是背景。0.4 时链内链外的差别不够一眼可辨——用户实测反馈"悬停高亮没有用"。
 * 又不取更暗：再暗一点其余节点就完全看不见了，会丢失"图整体还在"的空间感。
 */
const DIM_OPACITY = 0.28
/** 边比节点再暗一档：线更细，同样的不透明度下更不显眼 */
const DIM_EDGE_OPACITY = 0.22

/**
 * 五种状态在图上的视觉语言（与页面图例一一对应）：
 *   运行中 = 绿、临时启用 = 青、临时停用 = 紫、异常 = 琥珀、未启用 = 灰。
 */
const TONE_BORDER: Record<PluginTone, string> = {
  ok: 'border-ok-line bg-ok-bg/40',
  session: 'border-session-line bg-session-bg/50',
  suspended: 'border-suspended-line bg-suspended-bg/50',
  warn: 'border-warn-line bg-warn-bg',
  neutral: 'border-line',
}

/* ---------- 节点 ---------- */

interface FlowData extends Record<string, unknown> {
  /** 图上显示的**人读名**（manifest 的 `displayName`，缺失回退去 scope 短名） */
  label: string
  /** 完整标识（`@geewiki/wiki`）；节点上不显示，进 tooltip */
  fullName: string
  tone: PluginTone
  /** 状态徽章文案（"运行中"/"临时启用"/…），与页面图例共用一套措辞 */
  toneText: string
  /** 层说明：随启动加载 / 临时启用；未激活时为 null */
  layerText: string | null
  /** 悬停高亮时是否被压暗（链外） */
  dimmed: boolean
  /** 是否在悬停节点的依赖链上（链内要正强调，不能只是"没被压暗"） */
  inChain: boolean
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
  return (
    <div
      style={{ opacity: d.dimmed ? DIM_OPACITY : 1 }}
      className={[
        'rounded-lg border bg-surface px-3 py-2 shadow-sm',
        TONE_BORDER[d.tone],
        /*
         * 链内**正强调**：不是"把别人压暗、自己保持原样"，而是真的给自己加一圈强调环 + 抬投影。
         * 用户实测"悬停高亮没有用"的直接原因就是这个——压暗是背景手段，看不见"被高亮"这件事。
         */
        d.inChain ? 'ring-2 ring-accent/70 shadow-md' : '',
        selected ? 'border-accent ring-1 ring-accent' : '',
      ].join(' ')}
    >
      <Handle type="target" position={Position.Left} />
      {/*
        这里**刻意不用原生 `title`**（曾经用它与详情弹窗一起承载包名全称）。原生 tooltip 会弹出
        在光标附近，触发节点的 `mouseout` ⇒ 悬停态丢失 ⇒ tooltip 收起 ⇒ 再次弹出，表现为
        "鼠标一移动就不断闪烁"，而高亮也跟着一起丢失（headless 里量不出来：headless 不渲染原生
        tooltip，所以悬停态一直是稳的）。包名全称改由悬停时右上角的提示面板显示——它本来就在
        悬停时出现，位置也远离光标，不会产生这类自激。详情弹窗里同样有一份。
      */}
      <div className="text-note leading-snug font-medium break-normal text-ink">
        <BreakableLabel text={d.label} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Badge tone={d.tone}>{d.toneText}</Badge>
        {d.layerText !== null && <Badge tone="neutral">{d.layerText}</Badge>}
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
  dimmed: boolean
  /** 这条边是否在依赖链上（链上加粗上色） */
  inChain: boolean
}

/**
 * 自定义边：默认只画线，**hover 时**才显示「A 依赖 B」。
 *
 * 为什么不是常显标签：8 个插件就有 10 条边，常显文字会把图糊成一片；
 * 而"边到底表示什么"又是用户看这张图的首要疑问。hover 揭示是两者的折中。
 * 用 `EdgeLabelRenderer` + CSS `group-hover`（而不是 JS 状态），避免每条边都挂
 * 一个监听器导致拖动时重渲染。
 */
function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps): ReactNode {
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
    <g className="group" style={{ opacity: d.dimmed ? DIM_EDGE_OPACITY : 1 }}>
      {/*
        链上的边叠一条更粗的强调色：悬停时要能顺着线把整条链读下去，
        细线在压暗的其余边里仍不够显眼。被压暗的边不加粗（否则像被强调）。
      */}
      {d.inChain && <path d={path} fill="none" strokeWidth={3.5} className="stroke-accent/70" />}
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          className="pointer-events-none absolute z-[1] rounded-md border border-line bg-surface px-1.5 py-0.5 text-2xs whitespace-nowrap text-ink-soft opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
        >
          {d.from} 被 {d.to} 依赖
        </div>
      </EdgeLabelRenderer>
    </g>
  )
}

const nodeTypes = { flow: FlowNode }
const edgeTypes = { flow: FlowEdge }

/* ---------- 布局 ---------- */

/**
 * 节点宽度：在共享的 {@link estimateNodeWidth} 之上给**含 CJK** 的名字一个更高的下限。
 *
 * 为什么需要：`estimateNodeWidth` 按 8.2px/字符估算，那是 latin 字号的宽度；中文（CJK）在
 * 13px 字号下每字约 13px，故纯中文名会被估窄、折成两三行。这里只**抬高下限**（不改共享函数，
 * 以免影响其它消费方的既有表现），让「OpenAI 兼容模型」这类名字尽量排成一行。
 */
function nodeWidthFor(label: string): number {
  const base = estimateNodeWidth(label)
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(label) ? Math.max(base, 168) : base
}

/**
 * 分层 + 层内排序（重心法）→ 每个节点的坐标。
 *
 * 排序交给 `lib/pluginGraphPlan.ts`（有单测）：这里只把"层号 × 层内序号"换算成像素。
 * 列宽取该层最宽节点 + 固定间距——不这么做的话，长名字（"OpenAI 兼容模型"）会压住右列。
 */
function layoutPositions(
  ids: readonly string[],
  edges: readonly GraphEdgeLike[],
  labelOf: (id: string) => string,
): Map<string, { x: number; y: number }> {
  const GAP_X = 70
  const ROW_H = 86
  const { columns } = planGraph({ ids, edges })
  const widthOf = new Map(ids.map((id) => [id, nodeWidthFor(labelOf(id))]))
  const position = new Map<string, { x: number; y: number }>()
  let x = 24
  for (const col of columns) {
    const colWidth = Math.max(120, ...col.map((id) => widthOf.get(id) ?? 120))
    col.forEach((id, idx) => {
      position.set(id, { x, y: 24 + idx * ROW_H })
    })
    x += colWidth + GAP_X
  }
  return position
}

/* ---------- 视图控制条 ---------- */

/**
 * 放大 / 缩小 / 适应窗口。
 *
 * **为什么不用库自带的 `<Controls>`**：它把 `aria-label` 挂在**没有 role 的 `<div>`** 上
 * （React Flow 12.5 的 `ControlProps` 只收 `'aria-label'`、**不收 `role`**），而 ARIA 1.2
 * 规定 `generic` 角色**不支持可访问名称** ⇒ 该属性属 prohibited，会被 AT 忽略，axe 也报
 * `aria-prohibited-attr`。库文档给出的官方扩展路径正是"用 `Panel` + `ControlButton` 自己拼"，
 * 于是这里自己拼：`Panel` 的 props 是完整的 `HTMLAttributes<HTMLDivElement>`，可以给它
 * **正确的 `role="group"`**——控制条本来就是"一组按钮"，这是语义正确，而不是为消警告而加的假 ARIA。
 * 顺带把按钮名从库默认的英文（zoom in / zoom out / fit view）改成中文，与产品语言一致。
 *
 * 注意：`useReactFlow()` 必须在 `<ReactFlow>` 的 provider 之内调用，故本组件只作为
 * `<ReactFlow>` 的子元素渲染。
 */
function ViewControls(): ReactNode {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  return (
    <Panel
      position="bottom-left"
      role="group"
      aria-label="视图控制"
      className="!m-3 flex flex-col overflow-hidden rounded-md border border-line bg-surface shadow-sm"
    >
      <ControlButton onClick={() => void zoomIn()} aria-label="放大" title="放大">
        <Plus className="size-4" aria-hidden="true" />
      </ControlButton>
      <ControlButton onClick={() => void zoomOut()} aria-label="缩小" title="缩小">
        <Minus className="size-4" aria-hidden="true" />
      </ControlButton>
      <ControlButton onClick={() => void fitView({ padding: 0.2 })} aria-label="适应窗口" title="适应窗口">
        <Maximize className="size-4" aria-hidden="true" />
      </ControlButton>
    </Panel>
  )
}

/* ---------- 组件 ---------- */

export interface PluginGraphProps {
  graph: GraphData
  /** 图上与边上的显示名（人读名优先，缺失回退去 scope 短名） */
  labelOf: (id: string) => string
  /** 当前打开详情弹窗的节点；描边强调 */
  selectedId: string | null
  /** 点击节点：页面据此打开详情/配置弹窗 */
  onSelect: (id: string) => void
}

export function PluginGraph({ graph, labelOf, selectedId, onSelect }: PluginGraphProps): ReactNode {
  /** 当前悬停的节点；`null` = 没有高亮（一切原样，谁也不压暗） */
  const [hovered, setHovered] = useState<string | null>(null)

  /**
   * 离开的**防抖**：鼠标离开节点后 80ms 才清空高亮，期间若进入任一节点就取消。
   *
   * 为什么需要：悬停态是"鼠标位置"的派生物，任何一次伪 leave/enter 对都会让整张图闪一下。
   * 引起伪事件的那个根因（节点上的原生 `title` tooltip 弹出在光标附近、抢走 `mouseout`）已经
   * 按根因去掉了；这里是**第二道防线**——让功能对偶发事件免疫，而不是依赖"以后不会再出现伪事件"。
   * 80ms 的滞留在观感上无法察觉，却足以吃掉这类成对抖动。
   */
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelLeave = useCallback((): void => {
    if (leaveTimer.current !== null) {
      clearTimeout(leaveTimer.current)
      leaveTimer.current = null
    }
  }, [])
  const enterNode = useCallback(
    (id: string): void => {
      cancelLeave()
      setHovered(id)
    },
    [cancelLeave],
  )
  const leaveNode = useCallback((): void => {
    cancelLeave()
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null
      setHovered(null)
    }, 80)
  }, [cancelLeave])
  // 卸载时清掉待执行的定时器（否则组件已卸载还会 setState）
  useEffect(() => cancelLeave, [cancelLeave])

  /**
   * 上游链（"它依赖的插件"，含起点自身）。用原始拓扑（`graph.edges`），不是布局后的边。
   */
  const chain = useMemo(
    () => (hovered === null ? null : upstreamClosure(hovered, graph.edges as readonly GraphEdgeLike[])),
    [hovered, graph.edges],
  )

  const { nodes, edges } = useMemo(() => {
    const ids = graph.nodes.map((n) => n.id)
    const idSet = new Set(ids)
    const rawEdges = graph.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target)
    /*
     * **画线用传递归约后的边集**：某个直接依赖若已由另一个直接依赖（更上游）带来，就不再重复画。
     * 布局与交叉削减也用这同一份——优化目标当然应该是"实际会画出来的那些线"。
     * 注意可达性不变：分层、悬停链、详情弹窗里的"它依赖"清单全都还是原来的口径。
     */
    const drawnEdges = transitiveReduction(ids, rawEdges)
    const position = layoutPositions(ids, drawnEdges, labelOf)

    const nodeList: Node[] = graph.nodes.map((n) => {
      const tone = pluginToneOf({
        state: n.state,
        layer: n.layer,
        runtimeDisabled: n.runtimeDisabled === true,
      })
      return {
        id: n.id,
        type: 'flow',
        position: position.get(n.id) ?? { x: 24, y: 24 },
        style: { width: nodeWidthFor(labelOf(n.id)) },
        data: {
          label: labelOf(n.id),
          fullName: n.label,
          tone,
          toneText: TONE_TEXT[tone],
          // 层只对"正在跑"的插件有意义：未激活时说它属于哪一层会误导
          layerText: n.state === 'active' && n.layer !== null ? LAYER_HUMAN[n.layer] : null,
          dimmed: chain !== null && !chain.nodes.has(n.id),
          inChain: chain !== null && chain.nodes.has(n.id),
        } satisfies FlowData,
      }
    })

    const edgeList: Edge[] = drawnEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'flow',
      markerEnd: { type: 'arrowclosed' },
      // 加宽不可见命中区，否则细线几乎 hover 不到
      interactionWidth: 18,
      data: {
        from: labelOf(e.source),
        to: labelOf(e.target),
        // 两端都在链上才算"这条边属于这条链"
        dimmed: chain !== null && !(chain.nodes.has(e.source) && chain.nodes.has(e.target)),
        inChain: chain !== null && chain.nodes.has(e.source) && chain.nodes.has(e.target),
      } satisfies FlowEdgeData,
    }))
    return { nodes: nodeList, edges: edgeList }
  }, [graph, labelOf, chain])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      // 小图不许被放大到糊（maxZoom 1 = 最多原始尺寸）；大图靠 fitView 缩到装得下
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      nodesDraggable
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => onSelect(n.id)}
      onNodeMouseEnter={(_, n) => enterNode(n.id)}
      onNodeMouseLeave={leaveNode}
    >
      <Background gap={18} />
      <ViewControls />
      {chain !== null && (
        <Panel
          position="top-right"
          role="status"
          className="!m-3 max-w-[26ch] rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-soft shadow-sm"
        >
          <div className="font-medium text-ink">{labelOf(hovered as string)}</div>
          {/* 包名全称放这里（原先挂在节点的原生 title 上，那个 tooltip 正是闪烁的根因） */}
          <div className="font-mono text-2xs break-all text-muted">{hovered}</div>
          <div className="mt-0.5">
            {chain.nodes.size === 1
              ? '不依赖任何插件——它是依赖链的起点'
              : `依赖链：链上共 ${chain.nodes.size} 个插件（它自己 + 向左的 ${chain.nodes.size - 1} 个上游），不含依赖它的`}
          </div>
        </Panel>
      )}
    </ReactFlow>
  )
}
