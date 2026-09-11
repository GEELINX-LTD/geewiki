import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  Package,
  Play,
  RefreshCw,
  Save,
  Square,
} from 'lucide-react'
import { ApiError, api, type ConfigIssue, type DiscoveryIssueInfo, type ListEntry, type PluginInfo, type SessionState } from '../api'
import { SchemaForm } from '../components/SchemaForm'
import { describeRoot, type FieldDescriptor } from '../lib/configSchema'
import { describeError, errorLine } from '../lib/errorText'
import { resolveAreaState } from '../lib/areaState'
import { useSlowHint } from '../lib/useSlowHint'
import { syncPluginUi, subscribePluginUiState, pluginUiState } from '../lib/pluginUi'
import { classifyUiSkips, UI_SKIP_HELP, UI_SKIP_LABEL } from '../lib/pluginUiPlan'
import {
  descriptionOf,
  displayNameOf,
  LAYER_HUMAN,
  LAYER_TECH,
  PERSIST_HINT,
  SESSION_LAYER_HINT,
  SOURCE_TEXT,
  STATE_TEXT,
  stateTone,
} from '../lib/pluginDisplay'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  ErrorState,
  LoadingState,
  SkeletonTable,
  Textarea,
  Tooltip,
} from '../ui'

function fmtError(err: unknown): string {
  return errorLine(err)
}

/**
 * 取出 `has_dependents`（409）里的依赖方名单。
 *
 * 后端抛的是 `ManagerError('has_dependents', …, { dependents })`，`details` 原样透传到前端
 * `ApiError.details`。**防御性读取**：`details` 是 `unknown`，若形状不符就退回空数组，
 * 由调用方给"存在依赖方但名单不可用"的兜底文案（而不是显示 `undefined`）。
 */
function dependentNamesOf(details: unknown): string[] {
  if (typeof details !== 'object' || details === null) return []
  const raw = (details as { dependents?: unknown }).dependents
  if (!Array.isArray(raw)) return []
  return raw.filter((n): n is string => typeof n === 'string' && n.length > 0)
}

/** 把后端 invalid_config 的逐条问题按字段路径归并（供表单就地展示） */
function issuesToMap(issues: readonly ConfigIssue[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const issue of issues) {
    const key = (issue.path ?? []).join('.')
    map.set(key, [...(map.get(key) ?? []), issue.message])
  }
  return map
}

/**
 * 解析"JSON 原文"配置编辑框（未声明 configSchema 的插件走这条通道）。
 * 空文本视为 `{}`；非对象（数组/标量）与语法错误都给出明确提示且**不发请求**。
 */
function parseConfigText(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return { ok: false, message: `配置不是合法 JSON: ${(err as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: '配置必须是 JSON 对象（不能是数组或标量）' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** 配置编辑器状态：descriptor 为 null 表示插件未声明 schema（退回 JSON 编辑框） */
interface ConfigEditorState {
  name: string
  loading: boolean
  descriptor: FieldDescriptor | null
  value: Record<string, unknown>
  /** 配置的持久化层（存在哪个清单里）；null = 尚未得知 */
  layer: 'base' | 'session' | null
  /** 插件的激活层（未激活为 null） */
  activeLayer: 'base' | 'session' | null
}

type RowAction = 'enable' | 'disable' | 'config' | 'replace'

/** 技术详情里的"键 → 值"一行（值可以是多个 chip） */
function DetailRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 py-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-xs break-words text-ink-soft">{children}</dd>
    </div>
  )
}

/** 单色小标签（技术细节里的 token / 路径） */
function Chip({ children }: { children: ReactNode }): ReactNode {
  return (
    <code className="mr-1 inline-block rounded-xs border border-line bg-sunken px-1.5 py-0.5 font-mono text-2xs text-ink-soft">
      {children}
    </code>
  )
}

export function AdminPage(): ReactNode {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  /** 首屏加载的原始错误：非 null 时整块显示可重试的错误态（区别于"确实没有插件"的空态） */
  const [loadError, setLoadError] = useState<unknown>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** 全页性忙碌（刷新/持久化）：只有这类操作才该禁用全表 */
  const [busyGlobal, setBusyGlobal] = useState('')
  /**
   * **按行**忙碌：原先是一个全局 `busy` 字符串，任一操作在途就把**全表**按钮禁用
   * （`disabled={busy !== ''}` 出现 13 次），于是"启用 A 插件"期间连 B 插件的按钮都点不动。
   * 现在按 `{插件名, 动作}` 记录，只禁用该行的相关控件——各插件的启停本就互不依赖
   * （冲突组互斥由**后端**判定并返回 409，前端不做乐观假设）。
   */
  const [busyRow, setBusyRow] = useState<{ name: string; action: RowAction } | null>(null)
  const [configFor, setConfigFor] = useState<string | null>(null)
  const [configText, setConfigText] = useState('')
  const [editor, setEditor] = useState<ConfigEditorState | null>(null)
  const [configErrors, setConfigErrors] = useState<Map<string, string[]>>(new Map())
  /** 外部插件发现期被跳过的目录（清单缺失/入口缺失/路径越界/重名/加载抛错等） */
  const [issues, setIssues] = useState<DiscoveryIssueInfo[]>([])
  /** 冲突组顶替确认（启用撞上同组已激活插件时弹出） */
  const [replacePrompt, setReplacePrompt] = useState<{
    target: PluginInfo
    conflict: string
    dependents: string[]
    config?: Record<string, unknown>
  } | null>(null)
  /**
   * 被依赖方阻止停用的插件（409 `has_dependents`）。用于就地给出专门说明与可操作指引，
   * 而不是只闪一条泛化错误——用户需要知道"到底是谁挡住了"以及"下一步能做什么"。
   */
  const [blockedDisable, setBlockedDisable] = useState<{ name: string; dependents: string[] } | null>(null)
  /** 「应用并持久化」的二次确认（有副作用：写进基础清单） */
  const [persistPrompt, setPersistPrompt] = useState(false)

  /** 插件 UI 状态（含入口表 skipped）：由 pluginUi.ts 的订阅式 store 提供 */
  const uiState = useSyncExternalStore(subscribePluginUiState, pluginUiState, pluginUiState)

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api.plugins(), api.session()])
      setLoadError(null)
      setPlugins(p.plugins)
      setSession(s)
      setIssues(p.issues ?? [])
      // 插件 UI 与 fork 生命周期绑定：load() 是四条变更成功路径（act/confirmEnable/doReplace/
      // saveConfig）的汇聚点，故只挂这一处即可让插槽跟随启停。
      // **强制**拉取：整表 revision 只覆盖 plugins（已激活 ∩ 有界面 ∩ 产物存在），**不含 skipped**，
      // 因此"新装了一个未启用/无界面的插件"不会改变 revision；若走 304 短路，管理台就永远看不到
      // 这条 skipped 信息。普通轮询仍走 304（省请求），只有这里需要完整表。
      void syncPluginUi({ force: true })
    } catch (err) {
      // 首屏失败要能"整块重试"，不能只留一条会消失的 notice：故额外记 loadError
      setLoadError(err)
      setNotice({ kind: 'err', text: `加载失败: ${fmtError(err)}` })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  /** 错误态里"重试"的进行中标记（只服务于那个按钮的 loading 样式） */
  const [retrying, setRetrying] = useState(false)
  const slowAdmin = useSlowHint(plugins === null && loadError === null)
  /*
    表格区域四态（互斥）：与 `#/wiki` 列表用**同一个** `resolveAreaState`。
    AdminPage 原本的 `loadError !== null ? … : plugins === null ? …` 顺序已经是"错误优先"、
    本身正确；改用统一判据的目的是**把这条不变量固化成可测的东西**，避免将来有人把
    加载判断挪到错误判断之前又回到"头部说加载中、正文说出错"。
  */
  const tableState = resolveAreaState({
    loading: plugins === null && loadError === null,
    hasError: loadError !== null,
    isEmpty: plugins !== null && plugins.length === 0,
  })
  const retryLoad = useCallback((): void => {
    setRetrying(true)
    void load().finally(() => setRetrying(false))
  }, [load])


  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>, successMsg: string) => {
      setBusyGlobal(label)
      setNotice(null)
      try {
        await fn()
        setNotice({ kind: 'ok', text: successMsg })
        await load()
      } catch (err) {
        setNotice({ kind: 'err', text: fmtError(err) })
      } finally {
        setBusyGlobal('')
      }
    },
    [load],
  )

  /**
   * 停用插件。与其它动作的关键差别：`409 has_dependents` 不是"操作失败"，而是后端在
   * **保护依赖完整性**（有活动依赖方时卸载会连带打断它们）。因此把它单独识别出来，
   * 就地给出"谁挡住了 + 下一步能做什么"，其余错误仍走通用提示。
   */
  const disablePlugin = useCallback(
    async (p: PluginInfo): Promise<void> => {
      setBusyRow({ name: p.name, action: 'disable' })
      setNotice(null)
      setBlockedDisable(null)
      try {
        await api.disable(p.name)
        setNotice({ kind: 'ok', text: `已停用 ${displayNameOf(p)}（临时变更已保存）` })
        await load()
      } catch (err) {
        // 依赖阻止：展示专门的说明块（依赖方名单来自 details.dependents）
        if (err instanceof ApiError && err.code === 'has_dependents') {
          setBlockedDisable({ name: p.name, dependents: dependentNamesOf(err.details) })
          setNotice(null)
        } else {
          setNotice({ kind: 'err', text: fmtError(err) })
        }
      } finally {
        setBusyRow(null)
      }
    },
    [load],
  )

  const openConfig = (p: PluginInfo): void => {
    if (configFor === p.name) {
      setConfigFor(null)
      setEditor(null)
      return
    }
    setConfigFor(p.name)
    setConfigErrors(new Map())
    setConfigText(p.config ? JSON.stringify(p.config, null, 2) : '')
    setEditor({ name: p.name, loading: true, descriptor: null, value: p.config ?? {}, layer: null, activeLayer: null })
    // 拉取清洗后的 schema 载荷与当前生效配置；插件未声明 schema 时退回 JSON 编辑
    void api
      .pluginConfig(p.name)
      .then((res) => {
        setEditor({
          name: p.name,
          loading: false,
          descriptor: res.schema ? describeRoot(res.schema) : null,
          value: res.config ?? {},
          layer: res.layer ?? null,
          activeLayer: res.activeLayer ?? null,
        })
        // JSON 原文通道以服务端值回填（descriptor 分支由 SchemaForm 自己渲染值）
        if (!res.schema) setConfigText(JSON.stringify(res.config ?? {}, null, 2))
      })
      .catch((err: unknown) => {
        setEditor({ name: p.name, loading: false, descriptor: null, value: p.config ?? {}, layer: null, activeLayer: null })
        setNotice({ kind: 'err', text: `读取配置失败: ${fmtError(err)}` })
      })
  }

  /**
   * 依赖方闭包（前端预览，与后端 collectDependentsClosure 同语义）：
   * 冲突组替换会把旧插件的依赖方一起卸载再接回，确认框需先如实告知用户。
   *
   * **只返回当前活跃的依赖方**，与后端口径一致：后端的卸载/接回集合是
   * `collectDependentsClosure(...).filter(active)`，未激活的依赖方根本不在替换范围内。
   * 若不过滤，确认框会把"未启用"的插件也列为将被重启，夸大影响面、与事实不符。
   * 遍历本身仍走完整依赖图（不过滤中间节点）——被顶替插件的下游可能隔着未激活节点。
   */
  const dependentsOf = useCallback(
    (root: string): string[] => {
      const list = plugins ?? []
      const stateOf = new Map(list.map((p) => [p.name, p.state]))
      const seen = new Set([root])
      const out: string[] = []
      const queue = [root]
      while (queue.length > 0) {
        const cur = queue.shift() as string
        for (const p of list) {
          if (seen.has(p.name)) continue
          if (p.requires.includes(cur)) {
            seen.add(p.name)
            out.push(p.name)
            queue.push(p.name)
          }
        }
      }
      return out.filter((n) => stateOf.get(n) === 'active').sort()
    },
    [plugins],
  )

  /** 名字 → 人话显示名（用于提示文案里指代某个插件） */
  const labelOf = useCallback(
    (name: string): string => {
      const p = (plugins ?? []).find((x) => x.name === name)
      return p ? displayNameOf(p) : name
    },
    [plugins],
  )

  /** 取出「启用」时要一并提交的配置（与"保存配置"共用同一套解析+报错逻辑） */
  const enableConfigOf = (p: PluginInfo): Record<string, unknown> | undefined | 'invalid' => {
    if (editor?.name === p.name && editor.descriptor) return editor.value
    if (configFor === p.name && configText.trim()) {
      const parsed = parseConfigText(configText)
      if (!parsed.ok) {
        setNotice({ kind: 'err', text: parsed.message })
        return 'invalid'
      }
      return parsed.value
    }
    return undefined
  }

  const confirmEnable = (p: PluginInfo): void => {
    const config = enableConfigOf(p)
    if (config === 'invalid') return
    setConfigFor(null)
    setEditor(null)
    void (async () => {
      setBusyRow({ name: p.name, action: 'enable' })
      setNotice(null)
      try {
        await api.enable(p.name, config)
        setNotice({ kind: 'ok', text: `已启用 ${displayNameOf(p)}` })
        await load()
      } catch (err) {
        // 冲突组互斥（409 conflict_group）：不当作死路，转为"是否顶替"确认
        if (err instanceof ApiError && err.code === 'conflict_group') {
          const conflict = (err.details as { with?: string } | undefined)?.with
          if (conflict) {
            setReplacePrompt({ target: p, conflict, dependents: dependentsOf(conflict), config })
            return
          }
        }
        setNotice({ kind: 'err', text: fmtError(err) })
      } finally {
        setBusyRow(null)
      }
    })()
  }

  /** 用户确认顶替：POST /replace（旧插件卸载、其依赖方接回新提供者） */
  const doReplace = (): void => {
    const prompt = replacePrompt
    if (!prompt) return
    setReplacePrompt(null)
    void (async () => {
      setBusyRow({ name: prompt.target.name, action: 'replace' })
      setNotice(null)
      try {
        const res = await api.replace(prompt.target.name, prompt.config)
        // 冲突可能在用户确认前被别处解除（例如另一处停用了冲突方）：此时后端走
        // "无冲突降级"路径、响应 replaced === null，若仍写"已用 X 替换 Y"就与事实不符。
        const replacedName = res.replaced?.name
        const text = [
          replacedName
            ? `已用 ${displayNameOf(prompt.target)} 替换 ${labelOf(replacedName)}`
            : `冲突已解除，已直接启用 ${displayNameOf(prompt.target)}（未发生替换）`,
          res.restarted.length > 0 ? `已接回依赖它的：${res.restarted.map(labelOf).join('、')}` : '',
        ]
          .filter(Boolean)
          .join('；')
        setNotice({ kind: 'ok', text })
        await load()
      } catch (err) {
        setNotice({ kind: 'err', text: `替换失败: ${fmtError(err)}` })
      } finally {
        setBusyRow(null)
      }
    })()
  }

  /** 保存配置（PUT /config）：已激活插件热更新，未激活仅落盘（requiresRestart） */
  const saveConfig = useCallback(
    async (p: PluginInfo): Promise<void> => {
      if (!editor || editor.name !== p.name) return
      setBusyRow({ name: p.name, action: 'config' })
      setNotice(null)
      setConfigErrors(new Map())
      try {
        // 无 schema 插件提交的是 JSON 编辑框解析结果（而不是服务端返回的原值，
        // 否则用户编辑会被静默丢弃）；解析失败时已提前 return，不发请求
        let payload = editor.value
        if (!editor.descriptor) {
          const parsed = parseConfigText(configText)
          if (!parsed.ok) {
            setNotice({ kind: 'err', text: parsed.message })
            return
          }
          payload = parsed.value
        }
        const res = await api.updatePluginConfig(p.name, payload)
        setNotice({
          kind: 'ok',
          text: res.hotUpdated
            ? `已保存并热更新 ${displayNameOf(p)} 的配置`
            : `已保存 ${displayNameOf(p)} 的配置（${res.requiresRestart ? '插件未启用，配置已保存，下次启用后生效' : '下次启动生效'}）`,
        })
        await load()
      } catch (err) {
        if (err instanceof ApiError && err.code === 'invalid_config') {
          const details = err.details as { issues?: ConfigIssue[] } | undefined
          setConfigErrors(issuesToMap(details?.issues ?? []))
        }
        setNotice({ kind: 'err', text: fmtError(err) })
      } finally {
        setBusyRow(null)
      }
    },
    [configText, editor, load],
  )

  const counts = useMemo(() => {
    if (!plugins) return null
    return plugins.reduce(
      (acc, p) => {
        acc[p.state]++
        return acc
      },
      { active: 0, inactive: 0, error: 0 } as Record<'active' | 'inactive' | 'error', number>,
    )
  }, [plugins])

  const sessionChanges = session?.session.enabled ?? []
  const canPersist = sessionChanges.length > 0
  /** 入口表跳过项按严重度分组：`attention` 是本该可见却没出现（或清单有问题），`normal` 是设计使然 */
  const uiSkips = classifyUiSkips(uiState.skipped)
  const rowBusyOf = (name: string): RowAction | null => (busyRow?.name === name ? busyRow.action : null)

  return (
    <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-lg font-semibold text-ink">插件管理</h1>
          <p className="m-0 mt-0.5 text-xs text-muted">
            启用或停用插件、调整它们的配置。改动立即生效，无需重启。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {notice && (
            <span
              role="status"
              className={
                notice.kind === 'ok'
                  ? 'rounded-md border border-ok-line bg-ok-bg px-2.5 py-1 text-xs text-ok-ink'
                  : 'rounded-md border border-danger-line bg-danger-bg px-2.5 py-1 text-xs text-danger-ink'
              }
            >
              {notice.text}
            </span>
          )}
          <Button
            icon={<RefreshCw className="size-3.5" />}
            loading={busyGlobal === 'refresh'}
            disabled={busyGlobal !== ''}
            onClick={() => void act('refresh', api.plugins, '已刷新')}
          >
            刷新
          </Button>
        </div>
      </header>

      {/* ---------- 需要用户注意的问题（保留既有四个专门区块，换新原语） ---------- */}

      {issues.length > 0 && (
        <Card className="border-warn-line bg-warn-bg">
          <CardHeader
            as="h2"
            title={
              <span className="flex items-center gap-1.5 text-warn-ink">
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                有 {issues.length} 个插件目录没能加载
              </span>
            }
            description="这些目录里的插件完全没被加载（与下面「界面没能加载」不同：那一类是插件在、只是界面缺）。"
          />
          <CardBody>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {issues.map((issue, i) => (
                <li key={`${issue.code}:${issue.dir}:${i}`}>
                  <Chip>{issue.code}</Chip>
                  <span className="font-mono text-2xs text-muted">{issue.dir}</span>
                  <div className="text-xs text-danger-ink">{issue.message}</div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {uiSkips.attention.length > 0 && (
        <Card className="border-warn-line bg-warn-bg">
          <CardHeader
            as="h2"
            title={
              <span className="flex items-center gap-1.5 text-warn-ink">
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                有 {uiSkips.attention.length} 个插件的界面没能加载
              </span>
            }
            description="插件本身已在运行，但它的前端界面没有出现在这里——通常是发布时漏带了界面产物。"
          />
          <CardBody>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {uiSkips.attention.map((item) => (
                <li key={`${item.reason}:${item.name}`}>
                  <span className="text-xs font-medium text-ink">{labelOf(item.name)}</span>
                  <Badge tone="warn" className="ml-2">
                    {UI_SKIP_LABEL[item.reason]}
                  </Badge>
                  <div className="text-xs text-muted">{UI_SKIP_HELP[item.reason]}</div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {/* 其余没有界面的插件：这是**设计使然**（未启用 / 本就无前端界面），不该用告警色淹没上面真正的异常 */}
      {uiSkips.normal.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">
            另外 {uiSkips.normal.length} 个插件没有前端界面（未启用，或本就没有界面）
          </summary>
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {uiSkips.normal.map((item) => (
              <li key={`${item.reason}:${item.name}`}>
                <span className="text-ink-soft">{labelOf(item.name)}</span>
                <span className="text-muted">
                  {' '}
                  — {UI_SKIP_LABEL[item.reason]}：{UI_SKIP_HELP[item.reason]}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {blockedDisable && (
        <Card className="border-accent-soft-line bg-accent-soft">
          <CardHeader
            as="h2"
            title={
              <span className="flex items-center gap-1.5 text-accent-soft-ink">
                <Info className="size-3.5" aria-hidden="true" />
                无法停用「{labelOf(blockedDisable.name)}」：还有插件在依赖它
              </span>
            }
          />
          <CardBody className="flex flex-col gap-2">
            {blockedDisable.dependents.length > 0 ? (
              <p className="m-0 text-xs text-ink-soft">
                以下正在运行的插件依赖它：
                {blockedDisable.dependents.map((n) => (
                  <Badge key={n} tone="neutral" className="ml-1">
                    {labelOf(n)}
                  </Badge>
                ))}
              </p>
            ) : (
              <p className="m-0 text-xs text-ink-soft">
                它仍有正在运行的依赖方（服务端未返回名单，可在依赖图中查看指向它的连线）。
              </p>
            )}
            <p className="m-0 text-xs text-ink-soft">
              这是<strong>保护性拦截</strong>：直接停用会让上述插件的依赖悬空。可先
              <strong>逐个停用这些依赖方</strong>，再回来停用它；若它是被同一冲突组里的其它插件顶替，
              也可以在目标插件那行点「启用」走<strong>替换</strong>（会连同依赖方一起安全接管）。
            </p>
            <div>
              <Button size="sm" onClick={() => setBlockedDisable(null)} disabled={busyGlobal !== ''}>
                知道了
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ---------- 总览 + 插件列表 ---------- */}

      <Card>
        <CardHeader
          title="插件"
          description={
            counts
              ? `共 ${plugins?.length ?? 0} 个：${counts.active} 个运行中，${counts.inactive} 个未启用${counts.error > 0 ? `，${counts.error} 个异常` : ''}`
              : undefined
          }
        />
        {tableState === 'error' ? (
          /*
            三态优先级：**先错误**（请求没成功 ⇒ 不知道有没有插件），再加载，最后才判"确实为空"。
            顺序反了会把"加载失败"误报成"没有已注册的插件"——而插件其实都在，只是没读到。
          */
          <ErrorState
            className="m-4"
            title={describeError(loadError).title}
            hint={describeError(loadError).hint}
            onRetry={describeError(loadError).retryable ? retryLoad : undefined}
            retrying={retrying}
          />
        ) : tableState === 'loading' ? (
          <LoadingState slow={slowAdmin}>
            <SkeletonTable rows={5} cols={4} />
          </LoadingState>
        ) : tableState === 'empty' ? (
          <EmptyState
            icon={<Package className="size-6" />}
            title="没有已注册的插件"
            hint="内置插件随宿主发布；外部插件放入插件目录后重启即可被发现。"
          />
        ) : plugins === null ? null : (
          <table className="w-full border-collapse text-left" tabIndex={0} aria-label="插件列表">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="px-4 py-2 text-xs font-medium text-muted">
                  插件
                </th>
                <th scope="col" className="w-40 px-4 py-2 text-xs font-medium text-muted">
                  状态
                </th>
                <th scope="col" className="w-56 px-4 py-2 text-right text-xs font-medium text-muted">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((p) => (
                <PluginRow
                  key={p.name}
                  p={p}
                  rowBusy={rowBusyOf(p.name)}
                  globalBusy={busyGlobal !== ''}
                  configOpen={configFor === p.name}
                  configText={configText}
                  editor={editor?.name === p.name ? editor : null}
                  configErrors={configErrors}
                  labelOf={labelOf}
                  onConfigText={setConfigText}
                  onEditorChange={(next) => setEditor((prev) => (prev ? { ...prev, value: next } : prev))}
                  onOpenConfig={() => openConfig(p)}
                  onEnable={() => confirmEnable(p)}
                  onSaveConfig={() => void saveConfig(p)}
                  onDisable={() => void disablePlugin(p)}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* ---------- 临时变更（原「会话变更（Session Layer）」） ---------- */}

      <Card>
        <CardHeader
          title="临时变更"
          description={SESSION_LAYER_HINT}
          actions={
            <Button
              variant="primary"
              icon={<Save className="size-3.5" />}
              disabled={!canPersist || busyGlobal !== ''}
              onClick={() => setPersistPrompt(true)}
            >
              应用并持久化
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-3">
          {sessionChanges.length === 0 ? (
            <p className="m-0 text-xs text-muted">当前没有临时变更——所有启停都已写进基础清单。</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {sessionChanges.map((e) => (
                <li key={e.name} className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink">{labelOf(e.name)}</span>
                  <Badge tone="accent">{LAYER_HUMAN.session}</Badge>
                  {e.config && Object.keys(e.config).length > 0 && (
                    <code className="font-mono text-2xs text-muted">{JSON.stringify(e.config)}</code>
                  )}
                </li>
              ))}
            </ul>
          )}

          {session && session.bootErrors.length > 0 && (
            <div className="rounded-md border border-danger-line bg-danger-bg px-3 py-2">
              <h3 className="m-0 flex items-center gap-1.5 text-xs font-semibold text-danger-ink">
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                启动时有 {session.bootErrors.length} 个插件没能加载
              </h3>
              {session.bootErrors.map((e, i) => (
                <p key={i} className="m-0 mt-1 text-xs text-danger-ink">
                  {e}
                </p>
              ))}
            </div>
          )}

          {session && session.base.enabled.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted">
                查看基础清单（{session.base.enabled.length} 个插件随启动加载）
              </summary>
              <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                {session.base.enabled.map((e: ListEntry) => (
                  <li key={e.name} className="flex flex-wrap items-center gap-2">
                    <span className="text-ink-soft">{labelOf(e.name)}</span>
                    <Badge tone="neutral">{LAYER_HUMAN.base}</Badge>
                    {e.config && Object.keys(e.config).length > 0 && (
                      <code className="font-mono text-2xs text-muted">{JSON.stringify(e.config)}</code>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardBody>
      </Card>

      {/* ---------- 确认对话框 ---------- */}

      <Dialog open={persistPrompt} onOpenChange={setPersistPrompt}>
        <DialogContent
          title="把这些变更设为长期生效？"
          description={PERSIST_HINT}
          footer={
            <>
              <DialogClose asChild>
                <Button>取消</Button>
              </DialogClose>
              <Button
                variant="primary"
                onClick={() => {
                  setPersistPrompt(false)
                  void act('persist', api.persist, '已应用并持久化：临时变更已写入基础清单')
                }}
              >
                确认应用
              </Button>
            </>
          }
        >
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {sessionChanges.map((e) => (
              <li key={e.name} className="text-xs">
                {labelOf(e.name)}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      <Dialog open={replacePrompt !== null} onOpenChange={(open) => !open && setReplacePrompt(null)}>
        <DialogContent
          title={
            replacePrompt
              ? `用「${displayNameOf(replacePrompt.target)}」替换「${labelOf(replacePrompt.conflict)}」？`
              : ''
          }
          description="两者属于同一个冲突组，同一时间只能启用一个。"
          footer={
            <>
              <Button onClick={() => setReplacePrompt(null)}>取消</Button>
              <Button variant="primary" onClick={doReplace}>
                替换并启用
              </Button>
            </>
          }
        >
          {replacePrompt && (
            <div className="flex flex-col gap-2 text-xs text-ink-soft">
              <p className="m-0">
                将会先停用「{labelOf(replacePrompt.conflict)}」
                {replacePrompt.dependents.length > 0 && (
                  <>（连同依赖它的 {replacePrompt.dependents.map(labelOf).join('、')}）</>
                )}
                ，再启用「{displayNameOf(replacePrompt.target)}」
                {replacePrompt.dependents.length > 0 && <>，并把依赖方接回新的提供者</>}。
              </p>
              <p className="m-0">
                替换期间被停用的插件会<strong>短暂不可用</strong>（约几秒，等待在途请求结束），完成后自动恢复。
                全程无需重启。
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PluginRow(props: {
  p: PluginInfo
  rowBusy: RowAction | null
  globalBusy: boolean
  configOpen: boolean
  configText: string
  editor: ConfigEditorState | null
  configErrors: Map<string, string[]>
  labelOf: (name: string) => string
  onConfigText: (v: string) => void
  onEditorChange: (next: Record<string, unknown>) => void
  onOpenConfig: () => void
  onEnable: () => void
  onSaveConfig: () => void
  onDisable: () => void
}): ReactNode {
  const { p, rowBusy, globalBusy, configOpen, configText, editor, configErrors, labelOf, onConfigText, onEditorChange, onOpenConfig, onEnable, onSaveConfig, onDisable } = props
  // 只禁用"正在忙的那一行"；全局操作（刷新/持久化）在途时也一并禁用，避免与整体刷新交错
  const rowDisabled = rowBusy !== null || globalBusy
  const busy = rowBusy !== null
  const name = displayNameOf(p)
  const desc = descriptionOf(p)

  return (
    <>
      <tr className={p.state === 'error' ? 'border-b border-line bg-warn-bg/40' : 'border-b border-line'}>
        {/* 主列：人话名称 + 说明 + 来源；技术细节全部收进可展开的详情 */}
        <td className="px-4 py-2.5 align-top">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{name}</span>
            {p.source && (
              <Tooltip
                content={
                  p.source === 'external'
                    ? '外部插件：放在插件目录里被发现，可独立于宿主更新'
                    : '内置插件：随宿主一起发布'
                }
              >
                <span>
                  <Badge tone="neutral">{SOURCE_TEXT[p.source]}</Badge>
                </span>
              </Tooltip>
            )}
          </div>
          {desc !== undefined && <p className="m-0 mt-0.5 text-xs text-muted">{desc}</p>}
          {p.state === 'error' && p.error !== undefined && (
            <p className="m-0 mt-0.5 text-xs text-danger-ink">{p.error}</p>
          )}
        </td>

        {/* 状态列：状态 + 这一层对用户意味着什么（"重启后还在不在"） */}
        <td className="px-4 py-2.5 align-top">
          <Badge tone={stateTone(p.state)}>{STATE_TEXT[p.state]}</Badge>
          <div className="mt-1 text-xs text-muted">
            {p.layer ? LAYER_HUMAN[p.layer] : '—'}
          </div>
        </td>

        {/* 操作列：一个主要动作 + 详情开关 */}
        <td className="px-4 py-2.5 align-top">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {(p.state === 'inactive' || p.state === 'error') && (
              <Button
                size="sm"
                variant="primary"
                icon={<Play className="size-3.5" />}
                loading={rowBusy === 'enable'}
                disabled={rowDisabled}
                onClick={onEnable}
              >
                {p.state === 'error' ? '重试' : '启用'}
              </Button>
            )}
            {p.state === 'active' && p.layer === 'session' && (
              <Button
                size="sm"
                variant="danger"
                icon={<Square className="size-3" />}
                loading={rowBusy === 'disable'}
                disabled={rowDisabled}
                onClick={onDisable}
              >
                停用
              </Button>
            )}
            {p.state === 'active' && p.layer === 'base' && (
              <Tooltip content="它由基础清单管理：先临时停用或改清单，再重启生效">
                <span className="px-1 text-xs text-muted">随启动加载</span>
              </Tooltip>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={configOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              disabled={busy && rowBusy !== 'config'}
              onClick={onOpenConfig}
              aria-expanded={configOpen}
            >
              详情
            </Button>
          </div>
        </td>
      </tr>

      {configOpen && (
        <tr className="border-b border-line bg-sunken">
          <td colSpan={3} className="px-4 py-3">
            <div className="flex flex-col gap-4">
              {/* ---- 技术详情：一个信息都没少，只是默认不糊在脸上 ---- */}
              <details open className="text-xs">
                <summary className="cursor-pointer font-medium text-ink-soft">技术详情</summary>
                <dl className="m-0 mt-2">
                  <DetailRow label="标识">
                    <Chip>{p.name}</Chip>
                  </DetailRow>
                  <DetailRow label="版本">{p.version}</DetailRow>
                  <DetailRow label="所在层">
                    {p.layer ? LAYER_TECH[p.layer] : '当前未激活'}
                  </DetailRow>
                  <DetailRow label="热插拔">
                    {p.hotReloadable ? '支持：改动立即生效，无需重启' : '不支持：改动需重启进程'}
                  </DetailRow>
                  <DetailRow label="提供的能力">{p.provides !== undefined ? <Chip>{p.provides}</Chip> : '—'}</DetailRow>
                  <DetailRow label="依赖">
                    {p.requires.length === 0 ? (
                      '无'
                    ) : (
                      p.requires.map((r) => <Chip key={r}>{r}</Chip>)
                    )}
                  </DetailRow>
                  {p.conflictGroup !== undefined && (
                    <DetailRow label="冲突组">
                      <Chip>{p.conflictGroup}</Chip>
                      <span className="text-muted">（同组内只能启用一个）</span>
                    </DetailRow>
                  )}
                  {p.migrations !== undefined && (
                    <DetailRow label="数据迁移目录">
                      <Chip>{p.migrations}</Chip>
                    </DetailRow>
                  )}
                </dl>
              </details>

              {/* ---- 配置 ---- */}
              <div className="flex flex-col gap-2">
                <div>
                  <span className="text-xs font-medium text-ink-soft">
                    配置{editor?.descriptor ? '（按插件声明的结构生成）' : '（JSON 原文）'}
                  </span>
                  {editor && !editor.loading && (
                    <p className="m-0 mt-0.5 text-xs text-muted">
                      {editor.layer
                        ? `保存位置：${LAYER_TECH[editor.layer]}`
                        : '尚无已保存的配置'}
                      {editor.activeLayer === null && '；插件当前未启用，保存后下次启用生效'}
                    </p>
                  )}
                </div>
                {editor?.loading ? (
                  <p className="m-0 text-xs text-muted">读取配置中…</p>
                ) : editor?.descriptor ? (
                  <SchemaForm root={editor.descriptor} value={editor.value} onChange={onEditorChange} errors={configErrors} />
                ) : (
                  <Textarea
                    rows={4}
                    value={configText}
                    onChange={(e) => onConfigText(e.target.value)}
                    placeholder={'{\n  \n}'}
                    spellCheck={false}
                    className="font-mono text-xs"
                    aria-label="配置（JSON 原文）"
                  />
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Save className="size-3.5" />}
                    loading={rowBusy === 'config'}
                    disabled={rowDisabled || editor?.loading === true}
                    onClick={onSaveConfig}
                  >
                    保存配置
                  </Button>
                  {(p.state === 'inactive' || p.state === 'error') && (
                    <Button size="sm" disabled={rowDisabled || editor?.loading === true} onClick={onEnable}>
                      启用「{name}」
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={onOpenConfig}>
                    收起
                  </Button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
