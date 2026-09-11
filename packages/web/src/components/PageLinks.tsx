/**
 * 详情页的「反向链接」（谁引用了本页）与「本页引用了」（出链）区块。
 *
 * 为什么值得做：后端在 `37ceb4c` 就提供了这两个端点，但前端一直没消费——**一个已上线却不可见的
 * 功能，维护成本在、价值为零**。反向链接是成熟 wiki 的标志性能力：读者据此顺着关联探索，
 * 而不必自己翻遍侧栏。
 *
 * 三个刻意的设计取舍：
 * 1. **合并取数**：两个端点用 `Promise.all` 一次取，共用**一处**加载/错误呈现——避免同一次失败
 *    在页面上被报两遍（上一批刚修过"同一个失败三处呈现"的问题）。
 * 2. **出链为空时整块不渲染**：出链在正文里本来就看得见，单独列一遍的唯一增量价值是**标出红链**，
 *    所以没有内容时它只会是噪声。反向链接相反——它不可见，所以**始终渲染**，空时给明确文案。
 * 3. **用真 `<a href>` 而不是 onClick 导航**：可中键新开、可复制、键盘天然可达。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, Link2 } from 'lucide-react'
import { api, type OutLinksResponse } from '../api'
import { Card, CardBody, CardHeader, EmptyState, ErrorState, LoadingState, Skeleton } from '../ui'
import { resolveAreaState } from '../lib/areaState'
import { describeError } from '../lib/errorText'
import { backlinkSummary, isHiddenRef, isMissingRef } from '../lib/pageLinksPlan'
import { useSlowHint } from '../lib/useSlowHint'
import { PageLinkItem } from './PageLinkItem'

interface LinksData {
  backlinks: { slug: string; title: string }[]
  links: OutLinksResponse['links']
}

interface LinksState {
  loading: boolean
  error: unknown
  data: LinksData | null
}

export function PageLinks({ slug }: { slug: string }): ReactNode {
  const [state, setState] = useState<LinksState>({ loading: true, error: null, data: null })

  const load = useCallback(() => {
    let cancelled = false
    setState({ loading: true, error: null, data: null })
    void (async () => {
      try {
        const [back, out] = await Promise.all([api.backlinks(slug), api.links(slug)])
        if (cancelled) return
        setState({ loading: false, error: null, data: { backlinks: back.backlinks, links: out.links } })
      } catch (err) {
        if (cancelled) return
        setState({ loading: false, error: err, data: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [slug])

  useEffect(() => load(), [load])

  const slow = useSlowHint(state.loading)
  const isEmpty =
    state.data !== null && state.data.backlinks.length === 0 && state.data.links.length === 0
  /*
    区域状态由 `resolveAreaState` 统一判定（优先级：错误 > 加载 > 空 > 就绪）。
    `isEmpty` 取"两个列表都为空"：只要一侧有内容就不算空区域，反向链接自己的空文案在区块内呈现。
  */
  const area = resolveAreaState({ loading: state.loading, hasError: state.error !== null, isEmpty })

  if (area === 'loading') {
    return (
      <LoadingState slow={slow} label="正在载入相关页面…">
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-6 py-5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-4 w-40" />
        </div>
      </LoadingState>
    )
  }

  if (area === 'error') {
    const view = describeError(state.error)
    return <ErrorState title={view.title} hint={view.hint} onRetry={load} />
  }

  if (area === 'empty') {
    return (
      <EmptyState
        title="还没有相关页面"
        hint={
          '没有页面引用本页，本页也没有链接到其它页面。在正文里写 [[页面标识]]，' +
          '或 [文字](/wiki/页面标识)，就能建立页面之间的互链。'
        }
      />
    )
  }

  const data = state.data as LinksData
  const summary = backlinkSummary(data.backlinks.length, true)

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="反向链接"
          description={summary ?? undefined}
          actions={<Link2 className="size-4 text-muted" aria-hidden="true" />}
        />
        <CardBody>
          {data.backlinks.length === 0 ? (
            <p className="m-0 text-sm text-muted">
              还没有页面引用这个页面。在别的页面正文里写 [[{slug}]] 就能链接过来。
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {data.backlinks.map((item) => (
                <PageLinkItem key={item.slug} item={item} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* 出链为空时整块不渲染：正文里已经看得见这些链接，空列表只会是噪声。 */}
      {data.links.length > 0 && (
        <Card>
          <CardHeader
            title="本页引用了"
            description={
              /*
                三种"没有标题"要分别说：不存在（红链，可创建）／存在但无权查看（**别去创建**）／
                存在且有标题（正常）。把第二类归进第一类，就会引导用户创建重复页面。
              */
              data.links.some(isMissingRef) && data.links.some(isHiddenRef)
                ? '其中有的目标页面不存在、有的存在但无权查看（均已标出）'
                : data.links.some(isMissingRef)
                  ? '其中有的目标页面还不存在（已标出）'
                  : data.links.some(isHiddenRef)
                    ? '其中有的目标页面存在但无权查看（已标出）'
                    : `共 ${data.links.length} 个站内链接`
            }
            actions={<ArrowUpRight className="size-4 text-muted" aria-hidden="true" />}
          />
          <CardBody>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {data.links.map((item) => (
                <PageLinkItem key={item.slug} item={item} />
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

