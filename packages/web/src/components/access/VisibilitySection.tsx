/**
 * 页面档位设置（M1）—— `PUT /api/pages/:slug/visibility` 的界面。
 * ============================================================================
 *
 * ## 三条刻意的取舍
 *
 * 1. **部分更新，只发用户真的改过的字段。** 服务端对未传字段保持原值，而
 *    `inherit: false` 的语义是"**不再**继承祖先档位"—— 一次"顺手带上"的提交
 *    就会把继承态悄悄改掉（用户只改了发布勾选，却发现继承被断开）。故这里拿
 *    服务端最近一次回值当基线，逐字段比较后才决定放进 `patch`。
 * 2. **不弹确认框。** 档位可回改、且改完立刻在界面上可见（`role="status"` 播报结果），
 *    再加一层确认只会训练用户闭眼点"确定"。真正的危险信号是**扇出失败**（见下），
 *    那一条用 danger 提示并且不自动消失。
 * 3. **「已发布」在非 `public` 档时禁用**：`published_at` 只在 `public` 档下才对匿名
 *    生效（发布**不继承**，见后端 `PUT /visibility` 的注释），允许在 `org` 档下勾选
 *    会让人以为"我发布了"，而匿名访客仍然读不到。
 * 4. **只在没有未保存改动时跟随父级回填**：宿主「刷新」会重新取一次页面，本组件必须跟着
 *    更新（否则刷新后档位区还显示旧值），但**不能**用 `key` 重挂载 —— 那会丢掉用户手里
 *    未保存的选择。见下方 `useEffect` 里的判据。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, type PageVisibility } from '../../api'
import { Button } from '../../ui/Button'
import { Card, CardBody, CardHeader } from '../../ui/Card'
import { ErrorNotice } from '../../ui/ErrorNotice'
import { focusRing, touchTarget } from '../../ui/a11y'
import { cn } from '../../ui/cn'
import { PAGE_VISIBILITY_OPTIONS, resyncNotice } from '../../lib/accessPlan'

interface Baseline {
  visibility: PageVisibility
  inherit: boolean
  published: boolean
}

export function VisibilitySection({
  slug,
  current,
  onSaved,
}: {
  slug: string
  /** 服务端下发的当前值（只有有可见性管理权时才会下发档位字段） */
  current: Baseline
  /**
   * 保存成功后的通知，带上**服务端回值**。
   *
   * 宿主用它把"当前档位"传给块级区（块的档位选项要按页面档位收敛）；
   * 注意**不要**借此 `loadAuth()` —— 改档位不会改变自己的能力。
   */
  onSaved?: (next: Baseline) => void
}): ReactNode {
  const [base, setBase] = useState<Baseline>(current)
  const [visibility, setVisibility] = useState<PageVisibility>(current.visibility)
  const [inherit, setInherit] = useState(current.inherit)
  const [published, setPublished] = useState(current.published)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<unknown>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)

  const dirty =
    visibility !== base.visibility || inherit !== base.inherit || published !== base.published

  /**
   * 父级**重新取数**后同步回填（本批 R4 修掉的真实缺陷）。
   *
   * 缺陷：`useState(current)` 只吃首次 props，而宿主的「刷新」只更新 `page` 后
   * 原位重渲染本组件（`PageAccessPanel` 里没有 `key`）——React 保留旧 state，
   * 于是另外三个区块都刷新了、唯独档位区还显示旧值（改完档位点刷新看不到变化）。
   *
   * 为什么**不用 `key` 强制重挂载**：那会把用户还没保存的选择一起丢掉
   * （刷新按钮就在旁边，误点一次就白改）。所以这里只在**没有未保存改动**时同步。
   *
   * 判据（对比哪些字段）：把 `current` 的三个字段 —— `visibility` / `inherit` / `published`
   * —— 与**基线** `base` 逐一比较。`base` 就是"服务端最近一次回值"（保存成功时更新，
   * 或上一次同步时更新），因此"`current` 与 `base` 有任一不同"= 服务端那份变了。
   * 反过来，`dirty === true` 时用户手里有未保存的选择，任何自动同步都会覆盖它 ⇒ 跳过。
   * 注意 `current` 是宿主每次渲染新建的对象（身份每次都变），故判据只看**值**，不看引用。
   */
  useEffect(() => {
    if (dirty) return
    if (
      current.visibility === base.visibility &&
      current.inherit === base.inherit &&
      current.published === base.published
    ) {
      return
    }
    setBase(current)
    setVisibility(current.visibility)
    setInherit(current.inherit)
    setPublished(current.published)
  }, [current, base, dirty])

  const save = useCallback(async (): Promise<void> => {
    /*
     * 只装**真的变了**的字段。空 patch 在服务端是合法请求（等于什么都不做），
     * 但这里直接不提交 —— 按钮也据此禁用，避免制造"我改了什么"的错觉。
     */
    const patch: { visibility?: PageVisibility; inherit?: boolean; published?: boolean } = {}
    if (visibility !== base.visibility) patch.visibility = visibility
    if (inherit !== base.inherit) patch.inherit = inherit
    if (published !== base.published) patch.published = published
    if (Object.keys(patch).length === 0) return

    setBusy(true)
    setErr(null)
    setNotice(null)
    try {
      const r = await api.setVisibility(slug, patch)
      // 基线以**服务端回值**为准（不是本地状态）：发布态是服务端打的 `published_at`
      const next: Baseline = {
        visibility: r.visibility,
        inherit: r.inherit,
        published: r.published_at !== null,
      }
      setBase(next)
      setVisibility(next.visibility)
      setInherit(next.inherit)
      setPublished(next.published)
      setNotice(resyncNotice(r))
      onSaved?.(next)
    } catch (e: unknown) {
      setErr(e)
    } finally {
      setBusy(false)
    }
  }, [slug, base, visibility, inherit, published, onSaved])

  return (
    <Card>
      <CardHeader
        title="页面档位"
        description="决定「谁默认能读到这一页」。档位之外还可以单独授权（见下方授权与申请）。"
      />
      <CardBody>
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-1 p-0 text-xs font-semibold text-ink-soft">谁能读到这个页面</legend>
          {PAGE_VISIBILITY_OPTIONS.map((opt) => (
            <label
              key={opt.id}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2',
                'border border-line hover:bg-hover',
                touchTarget,
                focusRing,
              )}
            >
              <input
                type="radio"
                name="page-visibility"
                className={cn('mt-0.5', focusRing)}
                value={opt.id}
                checked={visibility === opt.id}
                disabled={busy}
                onChange={() => setVisibility(opt.id)}
              />
              <span className="min-w-0">
                <span className="block text-sm text-ink">{opt.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted">{opt.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
          <label className={cn('flex cursor-pointer items-start gap-2.5 text-sm text-ink', touchTarget)}>
            <input
              type="checkbox"
              className={cn('mt-0.5', focusRing)}
              checked={inherit}
              disabled={busy}
              onChange={(e) => setInherit(e.target.checked)}
            />
            <span>
              继承祖先档位
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                勾选时，本页实际生效的是「祖先链上最窄的那一档」（取最窄，不会更宽）；
                取消勾选表示"以本页自己选的档位为准，不再随祖先变化"。
              </span>
            </span>
          </label>

          <label
            className={cn(
              'flex items-start gap-2.5 text-sm text-ink',
              visibility === 'public' && !busy ? 'cursor-pointer' : 'cursor-not-allowed',
              touchTarget,
            )}
          >
            <input
              type="checkbox"
              className={cn('mt-0.5', focusRing)}
              checked={published}
              // 非 public 档时禁用：见文件头第 3 条
              disabled={busy || visibility !== 'public'}
              onChange={(e) => setPublished(e.target.checked)}
            />
            <span className={visibility === 'public' ? '' : 'text-muted'}>
              已发布
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                公开档需同时勾选「已发布」才对匿名访客可见；发布不继承（祖先发布了不等于本页已发布）。
                {visibility === 'public' ? '' : '当前不是公开档，此项不可改。'}
              </span>
            </span>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!dirty}
            onClick={() => void save()}
          >
            保存档位
          </Button>
          {!dirty && <span className="text-xs text-muted">没有改动</span>}
        </div>

        {err !== null && (
          <div className="mt-3">
            <ErrorNotice error={err} role="alert" />
          </div>
        )}

        {/*
          结果播报（`role="status"`：礼貌播报，不打断）。危险态**不自动消失** ——
          扇出失败是内容泄漏级，用户必须能一直看到它、并把运维叫来。
        */}
        {notice !== null && (
          <p
            role="status"
            className={cn(
              'm-0 mt-3 rounded-md border px-3 py-2 text-note leading-relaxed',
              notice.tone === 'danger'
                ? 'border-danger-line bg-danger-bg text-danger-ink'
                : 'border-ok-line bg-ok-bg text-ok-ink',
            )}
          >
            {notice.text}
            {notice.tone === 'danger' && (
              <span className="mt-1 block text-xs">
                界面没有重算块档位的入口：请运维用块一致性探针核对后重算，再回到本页确认。
              </span>
            )}
          </p>
        )}
      </CardBody>
    </Card>
  )
}
