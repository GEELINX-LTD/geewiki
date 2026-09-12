/**
 * 组织与邀请管理台（P5-B M4/M5）—— 路由 `#/org`。
 * ============================================================================
 *
 * ## 为什么整页只按 `administer` 门控
 *
 * 12 个组织端点里，除 `GET /api/org`（`access: 'user'`，登录即可读）之外**全部**要求
 * `admin+`（owner / admin，见 `packages/plugin-org/src/index.ts:277`）。三张卡分别做门控
 * 会得到"点进去三张卡都说你没权限"的页面，不如在页面这一层一次说清：
 *
 * - 能力**未知**（首帧）⇒ 加载态（`capabilities === null`，失败关闭，与 `lib/navPlan.ts`
 *   同一策略：宁可管理员晚一次请求看到内容，也不先渲染再收回）；
 * - 有能力 ⇒ 正常渲染三张卡；
 * - 无能力 ⇒ 一句说明 + 返回入口，**一个管理控件都不挂载**（`#/org` 可以被直接输入，
 *   所以路由自己必须再判一次；服务端当然另有独立判定 —— 前端隐藏不是安全措施）。
 *
 * ## 为什么要调一次 `GET /api/org`
 *
 * 它给出"我在管哪个组织"（名称 / slug / 成员数 / 我的角色）。三张卡都只给局部事实，
 * 没有这一行，管理员在多个实例之间切换时无法确认自己面对的是哪一个组织。
 * 它是本页唯一以普通成员身份也读得到的端点，失败**不阻塞**三张卡（各自有自己的取数与错误态）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Building2, Lock } from 'lucide-react'
import { api, type OrgResponse } from '../api'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { ErrorNotice } from '../ui/ErrorNotice'
import { LoadingState } from '../ui/LoadingState'
import { Skeleton } from '../ui/Skeleton'
import { GroupsCard } from '../components/org/GroupsCard'
import { InvitationsCard } from '../components/org/InvitationsCard'
import { MembersCard } from '../components/org/MembersCard'
import { ORG_ROLE_LABEL } from '../lib/orgPlan'
import { useAuth } from '../lib/authStore'

export function OrgPage({ onNavigate }: { onNavigate: (path: string) => void }): ReactNode {
  const auth = useAuth()

  if (auth.capabilities === null) {
    return (
      <LoadingState label="正在确认你的权限…">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full" />
      </LoadingState>
    )
  }

  if (!auth.capabilities.administer) {
    return (
      <EmptyState
        icon={<Lock className="size-8" />}
        title="你需要组织管理能力才能进入组织管理"
        hint="成员、用户组与邀请的读写都要求拥有者或管理员（服务端对每个端点独立判定，这里只是不显示点了必然失败的入口）。若你确认应该拥有它，请联系组织管理员。"
        action={
          <Button variant="secondary" size="sm" onClick={() => onNavigate('wiki/list')}>
            返回知识库
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">组织</h1>
      <OrgSummary />
      {/*
       * `selfUserId` / `actorRole` 由这里下发（而不是让 MembersCard 自己订阅 auth）：
       * 角色选项的收敛判据要"我是谁 + 我是什么角色"，两个值必须来自**同一次**身份快照，
       * 各订阅一次会出现"id 是新的、角色是旧的"这种只在慢网络上复现的错位。
       */}
      <MembersCard
        selfUserId={auth.user?.id ?? null}
        actorRole={auth.user?.orgRole ?? 'viewer'}
      />
      <GroupsCard />
      <InvitationsCard />
    </div>
  )
}

/** 页首一行组织事实（`GET /api/org`）；失败只提示，不挡下面的卡片 */
function OrgSummary(): ReactNode {
  const [info, setInfo] = useState<OrgResponse | null>(null)
  const [err, setErr] = useState<unknown>(null)

  useEffect(() => {
    let alive = true
    void api
      .org()
      .then((r) => {
        if (alive) setInfo(r)
      })
      .catch((e: unknown) => {
        if (alive) setErr(e)
      })
    return () => {
      alive = false
    }
  }, [])

  if (err !== null) {
    return (
      <div>
        <ErrorNotice error={err} />
      </div>
    )
  }
  if (info === null) {
    return <p className="m-0 text-xs text-muted">正在读取组织信息…</p>
  }

  return (
    <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
      <Building2 aria-hidden="true" className="size-4 text-muted" />
      <span className="font-medium text-ink">{info.org.name}</span>
      <span className="font-mono text-xs text-muted">{info.org.slug}</span>
      <span aria-hidden="true" className="text-muted">·</span>
      <span>共 {info.memberCount} 位成员</span>
      {info.me.role !== null && (
        <>
          <span aria-hidden="true" className="text-muted">·</span>
          <span>你的角色：{ORG_ROLE_LABEL[info.me.role]}</span>
        </>
      )}
    </p>
  )
}
