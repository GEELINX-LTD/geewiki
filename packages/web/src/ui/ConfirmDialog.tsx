/**
 * ConfirmDialog —— 全站统一的**危险操作确认**（可展示富内容）。
 *
 * ## 为什么要有这一个组件，而不是各处继续用 `window.confirm`
 *
 * 原生 `confirm` 只能显示一行纯文本、**无法列出受影响的对象**。于是调用方只能把信息
 * 挤进标题里，或者干脆不说——而"删除这条页面会一并清掉它的 N 个历史快照""吊销这次登录
 * 会让对方立刻掉线"恰恰是用户在按下去之前必须知道的事。原生弹窗还无法表达"哪个是危险
 * 动作"（两个按钮长得一样），也无法表达"正在执行"。
 *
 * ## 无障碍由 Radix `Dialog` 提供，本组件只补四件事
 *
 * 焦点陷阱、背景惰性化、Escape 关闭、关闭后归还焦点都在 `ui/Dialog.tsx`（Radix）里，
 * 这里不重复实现，只钉住确认框特有的语义：
 * 1. **焦点落在确认按钮**（不是右上角关闭按钮）：键盘用户"一次 Enter 即生效、Esc 取消"；
 *    这是危险操作最少按键数的路径，也是浏览器原生 confirm 的既有习惯。
 * 2. **执行期间不许关**：`busy` 时取消按钮与关闭按钮同时 `disabled`，并且忽略
 *    `onOpenChange(false)`（Escape / 点遮罩 / 关闭按钮都走它）——否则会出现
 *    "对话框关了、请求还在跑"，用户无从知道到底生效没有。
 * 3. **确认按钮的语义由调用方给**：`danger` 决定是否用 danger 变体；`confirmLabel`
 *    必须是**明确动词**（「吊销会话」「删除页面」），禁用「确定」——"确定"不告诉用户
 *    会发生什么，正是误操作的来源。
 * 4. **执行结果不在这里弹提示**：本仓库没有 Toast 组件，成功/失败由调用方自己的
 *    notice / `role="status"` / 错误条呈现。`onConfirm` 若 reject，本组件**不显示任何东西**、
 *    也不关闭对话框（把"失败"留在屏幕上，而不是假装什么都没发生），只用
 *    `void run().catch(() => {})` 兜住它 —— 否则调用方漏了 catch 就是一个 unhandled
 *    rejection（控制台报错 + 界面完全静默，正是最难查的那种失败）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Dialog, DialogContent } from './Dialog'
import { Button } from './Button'

export interface ConfirmRequest {
  /** 标题：一句话说清"对什么做什么"，如「删除页面「入门」？」 */
  title: string
  /** 一行补充说明（可省略；纯文本） */
  description?: string
  /** 富内容：受影响对象清单等（纯文本说明请用 `description`） */
  body?: ReactNode
  /** 确认按钮文案：**明确动词**，禁用「确定」 */
  confirmLabel: string
  /** true → 确认按钮用 danger 变体（破坏性、不可撤销的操作） */
  danger?: boolean
  /** 执行体。由调用方负责报错与结果反馈；本组件只负责"确认之后才调用" */
  onConfirm: () => void | Promise<void>
}

/**
 * 确认框的状态与打开入口。
 *
 * 与 `ConfirmDialog` 分成两个导出，是为了让调用方能在**任意事件处理器**里发起确认：
 * `confirm({...})` 只是把请求放进 state，真正的执行发生在用户按下确认之后
 * （见 T3 的调用点：先 `confirm(...)`、再由 `onConfirm` 去调 api）。
 */
export function useConfirm(): {
  request: ConfirmRequest | null
  confirm: (r: ConfirmRequest) => void
  close: () => void
} {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const confirm = useCallback((r: ConfirmRequest): void => setRequest(r), [])
  const close = useCallback((): void => setRequest(null), [])
  return { request, confirm, close }
}

export function ConfirmDialog({
  request,
  onOpenChange,
}: {
  /** 当前请求；null = 不显示 */
  request: ConfirmRequest | null
  /** 关闭回调（Radix 的 onOpenChange）；执行期间本组件会拦下 false */
  onOpenChange: (open: boolean) => void
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  /*
   * 关闭时清掉 busy。不清的话下次打开会带着上一次的 busy，
   * 表现为"整个确认框一打开按钮就全是禁用的"，且无法自愈。
   */
  useEffect(() => {
    if (request === null) setBusy(false)
  }, [request])

  const handleOpenChange = useCallback(
    (open: boolean): void => {
      // 执行期间忽略一切关闭请求（Escape / 点遮罩 / 右上角关闭按钮）
      if (!open && busy) return
      onOpenChange(open)
    },
    [busy, onOpenChange],
  )

  /**
   * 执行确认动作。
   *
   * `onConfirm` reject 时**不关闭**对话框（`onOpenChange(false)` 在 await 之后，
   * 被跳过），错误呈现留给调用方；这里的唯一职责是别让 rejection 逃成
   * unhandled rejection —— 见文件头第 4 条。
   */
  const run = async (): Promise<void> => {
    if (request === null || busy) return
    setBusy(true)
    try {
      await request.onConfirm()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  if (request === null) return null

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        title={request.title}
        description={request.description}
        closeDisabled={busy}
        onOpenAutoFocus={(event) => {
          /*
           * Radix 默认把焦点给容器内第一个可 Tab 元素 —— 在本组件里是右上角的关闭按钮。
           * 危险操作确认要的是"Enter 即生效"，故接管焦点：preventDefault 掉 Radix 的默认
           * 落点，直接聚焦确认按钮（Esc 依然是取消，路径不变）。
           */
          event.preventDefault()
          confirmRef.current?.focus()
        }}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              ref={confirmRef}
              variant={request.danger === true ? 'danger' : 'primary'}
              loading={busy}
              onClick={() => void run().catch(() => {})}
            >
              {request.confirmLabel}
            </Button>
          </>
        }
      >
        {request.body}
      </DialogContent>
    </Dialog>
  )
}
