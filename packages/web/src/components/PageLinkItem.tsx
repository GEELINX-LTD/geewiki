/**
 * 「反向链接 / 本页引用了」区块里的**单个链接项**。
 *
 * 单独成文件而不是留在 `PageLinks.tsx` 里，是为了**可测**：`PageLinks` 会在
 * `useEffect` 里取数，把它整块拖进测试就得连带 shim 网络层与 `window`；而这一项是**纯展示**，
 * 四种输入进、HTML 出。仓库里 `navGate.test.ts` 已经证明"SSR 渲染 + 直接断言 HTML"这条路可用。
 *
 * ## 四种状态必须**渲染成三个样子**
 *
 * | `exists`    | 状态      | 样子                                   |
 * |-------------|-----------|----------------------------------------|
 * | `true`      | `ok`      | 正常链接                                |
 * | `false`     | `missing` | **红链**：弱化 + 「新建该页」入口        |
 * | `'hidden'`  | `hidden`  | **不可点的灰化文本**，且**没有**创建入口  |
 * | 缺失        | `unknown` | 正常链接，但**同样没有**创建入口          |
 *
 * `'hidden'` 渲染成"不存在"的后果不是显示问题：用户会去**创建一个已经存在的页面**
 * ⇒ 脏数据 + 错误引导（设计文档 §5.5）。所以它既不能是正常链接（点了也是 404），
 * 也绝不能长得像红链。
 *
 * `unknown` 与 `ok` 的**样子相同、能力不同**：`unknown` 绝不提供创建入口。缺失只说明
 * "这个后端没告诉我们"，把"不知道"当成"不存在"就等于给用户一个可能建出重复页的入口 ——
 * 宁可少给一个入口。反向链接本就没有 `exists` 字段，它们走的就是这一态（服务端已按可见性过滤过，
 * 所以显示成正常链接是对的）。
 */
import type { ReactNode } from 'react'
import type { PageLinkRef } from '../api'
/* 从 `ui/cn` 直接取，**不走 `ui` 的 barrel**：barrel 会把 Radix 整包拉进模块图，
   而本组件要能被 SSR 测试单独渲染（见文件头说明）。 */
import { cn } from '../ui/cn'
import { MISSING_LINK_ATTR, MISSING_LINK_CLASS } from '../lib/linkPlan'
import {
  HIDDEN_LINK_ATTR,
  hiddenHint,
  linkStateOf,
  missingHint,
  missingNewPageHref,
  refHref,
  refLabel,
} from '../lib/pageLinksPlan'

export function PageLinkItem({ item }: { item: PageLinkRef }): ReactNode {
  const state = linkStateOf(item)
  const label = refLabel(item)

  /* 「存在但无权查看」：**不是链接**。做成 <a> 会给出一个必然 404 的目标，
     而"点了才知道看不到"不如"一眼就知道看不到"。 */
  if (state === 'hidden') {
    return (
      <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className="text-sm text-muted"
          {...{ [HIDDEN_LINK_ATTR]: '', title: hiddenHint(item.slug) }}
        >
          {label}
        </span>
        <span className="font-mono text-2xs text-muted">{item.slug}</span>
        <span className="text-2xs text-muted">（存在但无权查看）</span>
      </li>
    )
  }

  const missing = state === 'missing'
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <a
        href={refHref(item.slug)}
        className={cn(
          'text-sm underline underline-offset-2',
          missing ? MISSING_LINK_CLASS : 'text-accent hover:text-accent-hover',
        )}
        {...(missing ? { [MISSING_LINK_ATTR]: '', title: missingHint(item.slug) } : {})}
      >
        {label}
      </a>
      <span className="font-mono text-2xs text-muted">{item.slug}</span>
      {missing && (
        <>
          <span className="text-2xs text-muted">（目标页面不存在）</span>
          <a href={missingNewPageHref()} className="text-2xs text-accent underline underline-offset-2">
            新建该页
          </a>
        </>
      )}
    </li>
  )
}
