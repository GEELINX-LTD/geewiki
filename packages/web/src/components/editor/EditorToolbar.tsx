/**
 * 编辑器的**排版工具栏**。
 * ============================================================================
 *
 * ## 为什么要有它
 *
 * 编辑区对非 Markdown 用户太素：他们不知道 `**` 是加粗、`[]()` 是链接、`| --- |` 是表格。
 * 工具栏把"要写什么符号"变成"点哪个按钮"——**并且按钮如实反映当前状态**
 * （`aria-pressed`，见 `lib/markdownActions.ts` 的 `detectActiveFormats`），
 * 否则用户点了第二次发现字变了样，就不敢再点了。
 *
 * ## 三层来源，边界清楚
 *
 * - **格式动作**：`lib/markdownActions.ts` 的纯函数（CodeMirror 与降级 textarea 共用）；
 * - **模式切换**：`lib/editorModePlan.ts`（持久化在 localStorage，只影响"怎么画"）；
 * - **块权限**：`lib/editorBlocks.ts`（改的是正文里的 gated 标记，**不是**新端点）。
 *
 * 本组件**不发网络请求、不碰文档模型**：它只把用户的意图喊给宿主（`onAction`/`onTierChange`）。
 * 这与编辑器"绝不自己发请求"的既有约定一致。
 *
 * ## 关于按钮提示
 *
 * 每个按钮都有 `aria-label`（屏幕阅读器）+ `title`（鼠标悬停看得到快捷键）。
 * 这里**不用** `disabled` 来表达"这个能力不存在"——能力不存在时按钮根本不渲染
 * （例如没有附件上传能力的场景），只有"当前状态确实不可用"（如没有可撤销的历史）才禁用，
 * 且禁用时仍保留名称，读屏用户能听到它在、只是用不了。
 */
import type { ReactNode } from 'react'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Lock,
  Minus,
  Paperclip,
  Redo2,
  Quote,
  SquareCode,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react'
import { Button } from '../../ui/Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/DropdownMenu'
import { cn } from '../../ui/cn'
import { BLOCK_TIER_OPTIONS } from '../../lib/editorBlocks'
import { EDITOR_MODE_OPTIONS, type EditorMode } from '../../lib/editorModePlan'
import { isWiderThanPage, visibilityLabel } from '../../lib/accessPlan'
import type { BlockVisibility, PageVisibility } from '../../api'
import type { FormatAction } from '../../lib/markdownActions'

/** 块权限控件的输入 */
export interface BlockTierControl {
  /** 光标所在块的**自身**档位（`'public'` = 正文里没有标记，跟随页面） */
  current: BlockVisibility
  /** 所在受限区段覆盖的块数（>1 时提供"整段一起改"） */
  regionBlocks: number
  /** 页面档位；`null` = 新建页面还没落库（此时块档位仍可改，页面档位待保存后生效） */
  pageVisibility: PageVisibility | null
}

export interface EditorToolbarProps {
  mode: EditorMode
  onModeChange: (mode: EditorMode) => void
  /** 当前选区已处于哪些结构（按钮的 aria-pressed） */
  active: ReadonlySet<FormatAction>
  onAction: (action: FormatAction) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  /** `null` = 光标不在任何块上（此时权限控件禁用并说明原因，而不是消失） */
  tier: BlockTierControl | null
  onTierChange: (tier: BlockVisibility, whole: boolean) => void
  /**
   * 「授权给谁…」——为当前这一段管理**例外授予**（`granted` 档的唯一入口）。
   *
   * `null` = 本场景不提供（例如插件编辑器路径 / 页面还没保存）。**不是"授予没意义"**：
   * 段落档位设成「需单独授权」之后必须有人被授予才读得到，所以这个入口与档位控件是**一对**，
   * 缺了它那一档就成了"设得出来、没人能看"的死档（这正是它被补上的原因）。
   */
  onManageBlockGrants: (() => void) | null
  /** 附件上传入口；`null` = 本场景不支持（按钮不渲染，由宿主另行说明） */
  onPickFiles: (() => void) | null
  disabled: boolean
  /**
   * 降级态（懒加载 chunk 取不到时的纯文本编辑）：**不渲染**模式切换与撤销/重做。
   *
   * 为什么是"不渲染"而不是"渲染成禁用"：就地渲染需要语法树、撤销需要编辑器的历史栈，
   * 这两样在 `<textarea>` 上都不存在（浏览器原生撤销不走按钮，`execCommand` 已废弃）。
   * 一个按不动的按钮只会骗人；能力不存在就不给按钮，另用一行文字说明降级了什么
   * （见 `MarkdownEditorLazy.tsx` 的 FallbackEditor）。
   */
  degraded?: boolean
}

const FORMAT_BUTTONS: ReadonlyArray<{
  id: FormatAction
  label: string
  hint: string
  icon: ReactNode
}> = [
  { id: 'bold', label: '加粗', hint: '加粗（⌘/Ctrl+B）', icon: <Bold className="size-3.5" /> },
  { id: 'italic', label: '斜体', hint: '斜体（⌘/Ctrl+I）', icon: <Italic className="size-3.5" /> },
  { id: 'strike', label: '删除线', hint: '删除线', icon: <Strikethrough className="size-3.5" /> },
  { id: 'code', label: '行内代码', hint: '行内代码', icon: <Code className="size-3.5" /> },
  { id: 'link', label: '链接', hint: '插入链接（⌘/Ctrl+K）', icon: <LinkIcon className="size-3.5" /> },
  { id: 'h1', label: '一级标题', hint: '一级标题', icon: <Heading1 className="size-3.5" /> },
  { id: 'h2', label: '二级标题', hint: '二级标题', icon: <Heading2 className="size-3.5" /> },
  { id: 'h3', label: '三级标题', hint: '三级标题', icon: <Heading3 className="size-3.5" /> },
  { id: 'quote', label: '引用', hint: '引用', icon: <Quote className="size-3.5" /> },
  { id: 'bullet', label: '无序列表', hint: '无序列表', icon: <List className="size-3.5" /> },
  { id: 'ordered', label: '有序列表', hint: '有序列表（自动编号）', icon: <ListOrdered className="size-3.5" /> },
  { id: 'task', label: '任务列表', hint: '任务列表（可勾选清单）', icon: <ListTodo className="size-3.5" /> },
  { id: 'codeblock', label: '代码块', hint: '代码块（多行代码）', icon: <SquareCode className="size-3.5" /> },
  { id: 'table', label: '表格', hint: '插入三列表格', icon: <Table className="size-3.5" /> },
  { id: 'hr', label: '分隔线', hint: '插入分隔线', icon: <Minus className="size-3.5" /> },
]

/** 一条竖直分隔线（纯装饰，对读屏隐藏） */
function Divider(): ReactNode {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-line" />
}

/**
 * 块档位的标签。
 *
 * ⚠️ 未标记那档说「跟随页面档位」而不是「公开」：见 `BLOCK_TIER_OPTIONS` 的说明 ——
 * 服务端对未标记块回的是 `'public'`，但有效档位要与页面档位取更严的一方。
 */
function tierLabel(tier: BlockVisibility): string {
  return BLOCK_TIER_OPTIONS.find((o) => o.id === tier)?.label ?? visibilityLabel(tier)
}

export function EditorToolbar(props: EditorToolbarProps): ReactNode {
  const { tier, disabled } = props
  const modeHint = EDITOR_MODE_OPTIONS.find((o) => o.id === props.mode)?.hint ?? ''

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="group"
        aria-label="排版工具栏"
        className={cn(
          'flex flex-wrap items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-1',
        )}
      >
        {/* 模式：两个模式是**同一条正文**的两种画法，故用 aria-pressed 的切换按钮而不是 Tabs
            （Tabs 语义要求每个 tab 对应一块不同的面板，这里面板是同一个）。
            降级态没有"模式"这回事（纯 textarea 没法就地渲染），故整组不渲染。 */}
        {props.degraded !== true && (
          <>
            <div role="group" aria-label="编辑模式" className="flex items-center gap-0.5">
              {EDITOR_MODE_OPTIONS.map((o) => (
                <Button
                  key={o.id}
                  size="sm"
                  variant={props.mode === o.id ? 'primary' : 'ghost'}
                  aria-pressed={props.mode === o.id}
                  title={o.hint}
                  onClick={() => props.onModeChange(o.id)}
                >
                  {o.label}
                </Button>
              ))}
            </div>

            <Divider />
          </>
        )}

        {FORMAT_BUTTONS.map((b) => (
          <Button
            key={b.id}
            size="sm"
            variant={props.active.has(b.id) ? 'secondary' : 'ghost'}
            iconOnly
            icon={b.icon}
            aria-label={b.label}
            aria-pressed={props.active.has(b.id)}
            title={b.hint}
            disabled={disabled}
            onClick={() => props.onAction(b.id)}
          />
        ))}

        {props.onPickFiles !== null && (
          <>
            <Divider />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Paperclip className="size-3.5" />}
              aria-label="上传附件"
              title="上传附件（也可以直接粘贴截图或把文件拖进编辑区）"
              disabled={disabled}
              onClick={() => props.onPickFiles?.()}
            />
          </>
        )}

        <Divider />

        {/* 撤销/重做：降级态不渲染（浏览器原生撤销不走按钮，见 degraded 的说明） */}
        {props.degraded !== true && (
          <>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Undo2 className="size-3.5" />}
              aria-label="撤销"
              title="撤销（⌘/Ctrl+Z）"
              disabled={disabled || !props.canUndo}
              onClick={props.onUndo}
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Redo2 className="size-3.5" />}
              aria-label="重做"
              title="重做（⇧⌘/Ctrl+Z）"
              disabled={disabled || !props.canRedo}
              onClick={props.onRedo}
            />
            <Divider />
          </>
        )}

        {/*
          块权限：改的是**这一段正文里的 gated 标记**，与"谁能访问这一页"是两件事，
          故按钮文案说"这一段"，菜单里再给出"整段一起改"（一个区段可能覆盖好几段）。
          降级态（纯 textarea）没有正文模型，整块不渲染 —— 能力不存在就不给按钮。
        */}
        {props.degraded !== true && (
          <BlockTierMenu
            tier={tier}
            disabled={disabled}
            onTierChange={props.onTierChange}
            onManageBlockGrants={props.onManageBlockGrants}
          />
        )}
      </div>

      {/* 模式说明：常驻一行。工具栏的图标对非 Markdown 用户不是自解释的，
          把"当前模式在做什么"写出来比再加一个帮助弹窗更直接。
          降级态不显示（它没有模式，降级说明由 FallbackEditor 单独给）。 */}
      {props.degraded !== true && <p className="m-0 text-xs text-muted">{modeHint}</p>}
    </div>
  )
}

function BlockTierMenu({
  tier,
  disabled,
  onTierChange,
  onManageBlockGrants,
}: {
  tier: BlockTierControl | null
  disabled: boolean
  onTierChange: (tier: BlockVisibility, whole: boolean) => void
  onManageBlockGrants: (() => void) | null
}): ReactNode {
  const current = tier?.current ?? 'public'
  const wider =
    tier !== null && tier.pageVisibility !== null && isWiderThanPage(current, tier.pageVisibility)

  const trigger = (
    <Button
      size="sm"
      variant="ghost"
      icon={<Lock className="size-3.5" />}
      title={
        tier === null
          ? '把光标放到某一段里，才能改这一段的阅读权限'
          : '改这一段（或整个受限区段）的阅读权限：写入正文里的 gated 标记，保存后生效'
      }
      disabled={disabled}
      aria-label={
        tier === null
          ? '段落权限：光标不在任何段落里'
          : `段落权限：${tierLabel(current)}`
      }
    >
      {tier === null ? '段落权限' : `这一段：${tierLabel(current)}`}
    </Button>
  )

  /*
    光标不在块里时**不打开菜单**：菜单里每一项都会改写"当前块"，而此刻没有当前块。
    禁用按钮 + `title` 说明原因，比弹出一个点了没反应的菜单诚实。
  */
  if (tier === null) return trigger

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[19rem]">
        <DropdownMenuLabel>这一段的阅读权限</DropdownMenuLabel>
        {BLOCK_TIER_OPTIONS.map((o) => (
          <DropdownMenuItem key={o.id} active={o.id === current} onSelect={() => onTierChange(o.id, false)}>
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{o.label}</span>
              <span className="text-xs text-muted">{o.hint}</span>
            </span>
          </DropdownMenuItem>
        ))}

        {/*
          授予名单的入口。放在档位项**之后**、与它们同组：先选档位、再决定谁能读到 ——
          这正是"需单独授权"这一档的完整动作。current 是 granted 时它就是**唯一**能让
          这一段被读到的途径，故文案里有 `granted` 时额外说一句。
        */}
        {onManageBlockGrants !== null && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onManageBlockGrants()}>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">授权给谁…</span>
                <span className="text-xs text-muted">
                  {current === 'granted'
                    ? '这一段是「需单独授权」：现在没有授权对象能读到它，在这里指定谁能读。'
                    : '例外授予（放宽）：把组织外的人单独放进来读这一段。'}
                </span>
              </span>
            </DropdownMenuItem>
          </>
        )}

        {tier.regionBlocks > 1 && (
          <>
            <DropdownMenuSeparator />
            {/*
              一个受限区段覆盖多段时，逐段改会留下"区段被拆成几块"的结果（标记要重写）。
              想整段收紧/放开的人要的是**一次改完**，故这里显式提供，并写明覆盖几段。
            */}
            <DropdownMenuLabel>整段一起改（覆盖 {tier.regionBlocks} 段）</DropdownMenuLabel>
            {BLOCK_TIER_OPTIONS.map((o) => (
              <DropdownMenuItem key={`whole-${o.id}`} onSelect={() => onTierChange(o.id, true)}>
                整段改为「{o.label}」
              </DropdownMenuItem>
            ))}
          </>
        )}

        {wider && (
          <>
            <DropdownMenuSeparator />
            {/*
              比页面更宽 ≠ 放开：服务端按**更严**的一方判定（`tierFor` 取 max）。
              这句话必须出现，否则作者会以为"我改成跟随页面了，匿名就能看了"。
            */}
            <p className="m-0 px-2.5 py-1.5 text-xs text-muted">
              页面档位是「{visibilityLabel(tier.pageVisibility ?? 'private')}」，比这一段更窄 ——
              访客实际能读到的仍以页面为准（块档位只能更窄，不能放宽页面）。
            </p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
