import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AlertTriangle, Info, Package, Play, PlugZap, RefreshCw, Save, Square, Workflow } from 'lucide-react'
import {
  ApiError,
  api,
  type GraphData,
  type ConfigIssue,
  type DiscoveryIssueInfo,
  type ListEntry,
  type LlmProbeFailure,
  type LlmProbeInput,
  type LlmProviderOption,
  type LlmTestResponse,
  type PluginInfo,
  type SessionState,
  type SlotAssignmentInfo,
} from '../api'
import { SchemaForm, type LlmFormState } from '../components/SchemaForm'
import { PluginGraph } from '../components/PluginGraph'
import { describeRoot, hasDynamicOptions, type FieldDescriptor } from '../lib/configSchema'
import { describeError, errorLine } from '../lib/errorText'
import { resolveAreaState } from '../lib/areaState'
import { useSlowHint } from '../lib/useSlowHint'
import { syncPluginUi, subscribePluginUiState, pluginUiState } from '../lib/pluginUi'
import { Ext } from '../lib/slots'
import { themeContrastIssues } from '../lib/pluginTheme'
import { AA_TEXT_MIN } from '../lib/contrastPlan'
import { classifyUiSkips, UI_SKIP_HELP, UI_SKIP_LABEL } from '../lib/pluginUiPlan'
import {
  descriptionOf,
  displayNameOf,
  LAYER_HUMAN,
  LAYER_TECH,
  PERSIST_HINT,
  pluginToneOf,
  SESSION_LAYER_HINT,
  SOURCE_TEXT,
  STATE_TEXT,
  TONE_HINT,
  TONE_TEXT,
  type PluginTone,
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

/**
 * 图例圆点：与画布节点上的徽章同源（`pluginToneOf`），避免"图上叫临时停用、图例叫挂起"。
 */
const TONE_DOT: Record<PluginTone, string> = {
  ok: 'bg-ok',
  session: 'bg-session',
  suspended: 'bg-suspended',
  warn: 'bg-warn',
  neutral: 'bg-line-strong',
}

/**
 * 探测失败 → 给用户看的文本。
 *
 * `detail`（上游原文，服务端已脱敏 + 截断）**必须显示**：网关的报错五花八门
 * （"model not found" / "no route for /models" / 配额用尽），只有原文能让人一眼定位。
 */
function probeFailureText(failure: LlmProbeFailure | undefined, fallback: string): string {
  if (!failure) return fallback
  const head = failure.status !== undefined ? `${failure.message}（HTTP ${failure.status}）` : failure.message
  return failure.detail ? `${head}\n上游原文：${failure.detail}` : head
}

/**
 * 配置表单的当前值 → 探测参数（草稿）。
 *
 * 只取探测用得上的四个键；`apiKey` 是写一次字段，输入框里的值是"用户刚填的新密钥"，
 * 留空则**不下发**，由服务端改用已保存的那份。
 */
function probeDraftOf(value: Record<string, unknown>): LlmProbeInput {
  const str = (key: string): string | undefined => {
    const raw = value[key]
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    return trimmed === '' ? undefined : trimmed
  }
  const provider = str('provider')
  const baseUrl = str('baseUrl')
  const model = str('model')
  const apiKey = str('apiKey')
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
}

function fmtError(err: unknown): string {
  return errorLine(err)
}

/**
 * 插槽名 → 人话。`editor` 是唯一 `single`（单占用）插槽，故实际冲突只可能出现在它上面；
 * 另两个 `multi` 插槽留着是为了将来后端新增 `single` 插槽时界面不会退化成显示裸标识符
 * （未知插槽名回退为原标识符，宁可难看也不要静默显示成空）。
 */
const SLOT_HUMAN: Record<string, string> = {
  'app-header': '顶部栏界面',
  'app-footer': '页脚界面',
  editor: '正文编辑器',
}

function slotHuman(slot: string): string {
  return SLOT_HUMAN[slot] ?? slot
}

/**
 * 冲突提示的标题：把"几处未生效"汇总成一个数，避免标题里塞满包名。
 *
 * 为什么要汇总而不是逐个列进标题：冲突可能同时出现在多个插槽上（后端按插槽分组），
 * 标题只负责"有事发生"，具体是哪些插件放在卡片正文里逐条说。
 */
function slotConflictTitle(conflicts: readonly SlotAssignmentInfo[]): string {
  const n = conflicts.reduce((sum, c) => sum + c.suppressed.length, 0)
  return `有 ${n} 个插件的界面没有生效`
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
  /**
   * 写一次字段（`role: 'secret'`）是否已配置：只报有无，值永不回显。
   * 表单据此把输入框标为「已配置（留空 = 不修改）」。
   */
  secrets: Record<string, boolean>
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

/**
 * 图例：只用图上的视觉语言，不出现任何接口路径。
 *
 * 五种状态全列：合并前只列了三种（运行中/未启用/异常），于是"临时启用"与"临时停用"
 * 这两种**会随重启改变行为**的状态在图上是没有说明的——而它们恰恰是最需要解释的两种
 * （用户提的就是"要新增两个颜色进行标识"）。颜色与节点上的徽章同源（`pluginToneOf`）。
 */
function GraphLegend(): ReactNode {
  const items: { tone: PluginTone; label: string; hint: string }[] = [
    { tone: 'ok', label: STATE_TEXT.active, hint: `随启动加载：在基础清单里，任何重启都会加载` },
    {
      tone: 'session',
      label: LAYER_HUMAN.session,
      hint: '只写在会话清单里：立即生效，正常重启仍保留；进程异常崩溃恢复时会被丢弃',
    },
    {
      tone: 'suspended',
      label: '临时停用',
      hint: '仅当前进程内停用：什么都没写盘，重启后照基础清单恢复；想永久停用请点「应用并持久化」',
    },
    { tone: 'warn', label: STATE_TEXT.error, hint: '加载或运行出错，详情见该插件的弹窗' },
    { tone: 'neutral', label: STATE_TEXT.inactive, hint: '没有启用的插件' },
  ]
  return (
    <ul
      aria-label="状态图例"
      className="m-0 flex list-none flex-wrap items-center justify-end gap-x-3 gap-y-1 p-0 text-xs text-muted"
    >
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <i className={`size-2 rounded-full ${TONE_DOT[it.tone]}`} aria-hidden="true" />
          <Tooltip content={it.hint}>
            <span className="cursor-help">{it.label}</span>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}

export function GraphPage(): ReactNode {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  /**
   * 依赖图数据。本批把「插件管理」与「依赖图」合并成一页后，这里既是图也是管理台：
   * 图与插件列表来自管理器的两个端点，但**一起取**——分开取只会多一次往返，并多出一套
   * 「列表好了图没好」的中间态要做判据，而它们失败的原因本来就是同一个（管理器不可用）。
   */
  const [graph, setGraph] = useState<GraphData | null>(null)
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
  /**
   * 本次保存要**显式清除**的写一次字段（如 `apiKey`）。
   *
   * 与"留空 = 不修改"分开：密钥不回显，输入框恒为空，若把空串当清除，
   * 用户每改一次别的字段都会顺手删掉密钥。
   */
  const [clearSecrets, setClearSecrets] = useState<string[]>([])
  /** 模型服务商下拉选项（GET /api/llm/providers）；undefined = 该表单不需要 / 尚未取到 */
  const [providerOptions, setProviderOptions] = useState<LlmProviderOption[] | undefined>(undefined)
  /** 思考强度的候选档位（同一份 providers 响应里的 `effortPresets`；只是建议，可自由填写） */
  const [effortPresets, setEffortPresets] = useState<string[] | undefined>(undefined)
  /**
   * 模型清单。`source` 记住"这份清单是从哪个端点拉来的"：
   * 用户改过 baseUrl 之后，旧清单就**不再交给表单**（否则会拿别家的模型名去填这一家），
   * 但也不用清空状态——端点填回原值时清单立刻可用。
   */
  const [llmModels, setLlmModels] = useState<{ models?: string[]; error?: string; source: string; loading: boolean }>({
    source: '',
    loading: false,
  })
  /** 连接测试的结果（null = 本次还没测过） */
  const [llmTest, setLlmTest] = useState<{ running: boolean; result?: LlmTestResponse; error?: string } | null>(null)
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
  /**
   * 插槽冲突（同一单占用插槽被多个插件声明，仲裁后有插件未生效）。
   *
   * 后端 `GET /api/plugins/slots` 的 `conflicts` 常为空数组；为空时**整个区块不渲染**
   * （不留空壳）。这是纯诊断信息，取不到就不显示——见 `load()` 里的容错说明。
   */
  const [slotConflicts, setSlotConflicts] = useState<SlotAssignmentInfo[]>([])

  /** 插件 UI 状态（含入口表 skipped）：由 pluginUi.ts 的订阅式 store 提供 */
  const uiState = useSyncExternalStore(subscribePluginUiState, pluginUiState, pluginUiState)

  const load = useCallback(async () => {
    try {
      /*
        插槽冲突信息与主数据**并行**取，且**失败不致命**（`.catch(() => null)`）。
        为什么不像其它失败那样弹提示：本仓库的纪律是「同一个失败只呈现一次」，而这个端点
        与 `api.plugins()` 同属管理器——它单独失败通常意味着管理器整体不可用，那时上面的
        `api.plugins()` 已经失败并整块报错了。为它再弹一条只会变成第二个"服务出错"提示。
        代价是"插槽诊断静默缺失"，但它本就是**附加**信息，不影响启停插件本身。
      */
      const [p, s, slots, g] = await Promise.all([
        api.plugins(),
        api.session(),
        api.slots().catch(() => null),
        api.graph(),
      ])
      setLoadError(null)
      setPlugins(p.plugins)
      setSession(s)
      setGraph(g.graph)
      setIssues(p.issues ?? [])
      setSlotConflicts(slots?.conflicts ?? [])
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
    合并前的插件页原本的 `loadError !== null ? … : plugins === null ? …` 顺序已经是"错误优先"、
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
        /*
         * 两种层的后果不同，提示必须分开说：会话层插件停用是**真的写了会话清单**（"已保存"成立）；
         * 基础层插件停用**什么都没写**（进程内登记，重启即恢复），继续沿用旧文案会让人以为已经持久化。
         */
        setNotice({
          kind: 'ok',
          text:
            p.layer === 'session'
              ? `已停用 ${displayNameOf(p)}（会话清单已更新）`
              : `已在本进程内临时停用 ${displayNameOf(p)}（未写盘，重启后恢复）`,
        })
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

  /** 按表单草稿读取模型清单（不必先保存：改完端点密钥就能挑模型） */
  const fetchLlmModels = (value: Record<string, unknown>): void => {
    const draft = probeDraftOf(value)
    const source = draft.baseUrl ?? ''
    setLlmModels({ source, loading: true })
    void api
      .llmModels(draft)
      .then((res) =>
        setLlmModels({
          source,
          loading: false,
          ...(res.ok ? { models: res.models } : { error: probeFailureText(res.error, '读取模型清单失败') }),
        }),
      )
      .catch((err: unknown) => setLlmModels({ source, loading: false, error: fmtError(err) }))
  }

  /** 连接测试：拿表单当前值（含未保存的密钥）真打一次上游 */
  const runLlmTest = (value: Record<string, unknown>): void => {
    setLlmTest({ running: true })
    void api
      .llmTest(probeDraftOf(value))
      .then((result) => setLlmTest({ running: false, result }))
      .catch((err: unknown) => setLlmTest({ running: false, error: fmtError(err) }))
  }

  /**
   * 交给模型接入表单的运行期状态。
   *
   * 清单按 `source === 草稿里的 baseUrl` 才下发：用户改了端点，旧清单立刻失效
   * （否则会拿别家端点的模型名往这家填）；填回原值时又立刻可用，不必重拉。
   */
  const editorValue = editor?.value ?? {}
  const draftBaseUrl = typeof editorValue['baseUrl'] === 'string' ? (editorValue['baseUrl'] as string).trim() : ''
  const showLlmTools = editor?.descriptor ? hasDynamicOptions(editor.descriptor, 'llm-providers') : false
  const freshModels = llmModels.source === draftBaseUrl
  const llmForm: LlmFormState | undefined = showLlmTools
    ? {
        ...(effortPresets ? { effortPresets } : {}),
        ...(freshModels && llmModels.models ? { models: llmModels.models } : {}),
        ...(freshModels && llmModels.error ? { modelsError: llmModels.error } : {}),
        modelsLoading: llmModels.loading,
        onFetchModels: () => fetchLlmModels(editorValue),
      }
    : undefined

  const openConfig = (p: PluginInfo): void => {
    if (configFor === p.name) {
      setConfigFor(null)
      setEditor(null)
      return
    }
    setConfigFor(p.name)
    setConfigErrors(new Map())
    setClearSecrets([])
    setProviderOptions(undefined)
    setEffortPresets(undefined)
    setLlmModels({ source: '', loading: false })
    setLlmTest(null)
    setConfigText(p.config ? JSON.stringify(p.config, null, 2) : '')
    setEditor({
      name: p.name,
      loading: true,
      descriptor: null,
      value: p.config ?? {},
      secrets: {},
      layer: null,
      activeLayer: null,
    })
    // 拉取清洗后的 schema 载荷与当前生效配置；插件未声明 schema 时退回 JSON 编辑
    void api
      .pluginConfig(p.name)
      .then((res) => {
        const descriptor = res.schema ? describeRoot(res.schema) : null
        setEditor({
          name: p.name,
          loading: false,
          descriptor,
          value: res.config ?? {},
          secrets: res.secrets ?? {},
          layer: res.layer ?? null,
          activeLayer: res.activeLayer ?? null,
        })
        // JSON 原文通道以服务端值回填（descriptor 分支由 SchemaForm 自己渲染值）
        if (!res.schema) setConfigText(JSON.stringify(res.config ?? {}, null, 2))
        // 服务商下拉的选项来自**运行期注册**的适配器：只有表单真的需要时才去拉，
        // 免得每次打开任意插件的配置都多发一个请求。
        if (descriptor && hasDynamicOptions(descriptor, 'llm-providers')) {
          void api
            .llmProviders()
            .then((r) => {
              setProviderOptions(r.providers)
              if (r.effortPresets && r.effortPresets.length > 0) setEffortPresets(r.effortPresets)
            })
            .catch(() => setProviderOptions([]))
          // 端点已知（配置里填过）就顺手把模型清单拉一次：打开配置就能直接挑模型，
          // 不必先点一下按钮。端点为空时不猜——拉了也是错，反而多一条报错噪音。
          const saved = res.config ?? {}
          if (typeof saved['baseUrl'] === 'string' && (saved['baseUrl'] as string).trim() !== '') {
            fetchLlmModels(saved)
          }
        }
      })
      .catch((err: unknown) => {
        setEditor({
          name: p.name,
          loading: false,
          descriptor: null,
          value: p.config ?? {},
          secrets: {},
          layer: null,
          activeLayer: null,
        })
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
        const res = await api.updatePluginConfig(p.name, payload, clearSecrets)
        setClearSecrets([])
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
    [clearSecrets, configText, editor, load],
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
  /**
   * 进程内**临时停用**的插件名（不落盘 ⇒ 重启即恢复）。
   *
   * 与 `sessionChanges` 并列进「临时变更」：两者都**没有写进基础清单**，都符合"临时"的口径——
   * 只是一个往会话清单加了条目（临时启用），一个就地停掉、什么都不写（临时停用）。
   * 两者的生命周期不同（前者正常重启仍在、后者重启即恢复），文案必须说清，否则用户
   * 会以为"应用并持久化"对两者是一回事。
   */
  const runtimeDisabled = session?.runtimeDisabled ?? []
  const canPersist = sessionChanges.length > 0 || runtimeDisabled.length > 0
  /** 当前打开详情弹窗的插件（图上点击的那个）；`configFor` 同时是画布的选中态 */
  const pluginToShow = plugins?.find((p) => p.name === configFor) ?? null
  /** 入口表跳过项按严重度分组：`attention` 是本该可见却没出现（或清单有问题），`normal` 是设计使然 */
  const uiSkips = classifyUiSkips(uiState.skipped)
  /** ★ P10：主题贡献里低于 AA 的对比度组合（渲染期现算，见下面告警块的注释） */
  const themeIssues = themeContrastIssues()
  const rowBusyOf = (name: string): RowAction | null => (busyRow?.name === name ? busyRow.action : null)

  return (
    <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-xl font-semibold text-ink">插件管理</h1>
          <p className="m-0 mt-0.5 text-xs text-muted">
            箭头从「被依赖的插件」指向「依赖它的插件」。<strong className="font-medium text-ink-soft">点任意节点</strong>即可查看详情、改配置、启停。
          </p>
          <p className="m-0 mt-0.5 text-xs text-muted">
            某个直接依赖若已由上游带来（例如 X 依赖 B 与 C，而 B 本身也依赖 C），图上<strong className="font-medium text-ink-soft">不再重复画</strong>
            那根线；它的直接依赖清单在弹窗里仍完整列出。
          </p>
        </div>
        {/* ★ P6：插件管理页的工具条是一个宿主节点（`graph-toolbar`）——刷新与全局操作区 */}
        <Ext id="graph-toolbar">
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
        </Ext>
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

      {/*
        ★ P10：主题贡献的对比度告警。
        与上面两块的区别：这里**不是故障**，是一个"能用但读起来费劲"的取舍——
        故用 warn 色但措辞克制，且**不阻断注册**（设计文档 §7.4：糟糕主题的最终判据是运维）。
        为什么要在这里显示：插件把 `--gw-ink` 改成浅灰之后，用户只会看到"字看不清"，
        既不知道是谁干的、也没有任何出口——这条告警就是那个出口。
        读数在渲染期现算：GraphPage 已订阅插件 UI 状态（`subscribePluginUiState`），
        插件主题注册/卸载会触发重渲染，故不需要第二套订阅。
      */}
      {themeIssues.length > 0 && (
        <Card className="border-warn-line bg-warn-bg">
          <CardHeader
            as="h2"
            title={
              <span className="flex items-center gap-1.5 text-warn-ink">
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                有 {themeIssues.length} 处主题配色对比度低于 {AA_TEXT_MIN}:1
              </span>
            }
            description="WCAG 2.2 SC 1.4.3 AA 要求正文文字与背景的对比度不低于 4.5:1。这些主题仍然生效（宿主不替运维决定），但正文可能读起来费劲。"
          />
          <CardBody>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {themeIssues.map((issue) => (
                <li key={`${issue.owner}:${issue.mode}:${issue.text}:${issue.background}`}>
                  <span className="text-xs font-medium text-ink">{issue.name}</span>
                  <Badge tone="warn" className="ml-2">
                    {issue.mode === 'dark' ? '深色' : '浅色'} {issue.ratio.toFixed(2)}:1
                  </Badge>
                  <div className="font-mono text-2xs text-muted">
                    {issue.text} 落在 {issue.background} 上（要求 ≥ {issue.required}:1）
                  </div>
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

      {/*
        插槽冲突：某个**单占用**插槽（目前只有 `editor`）被多个已启用插件同时声明。
        后端按"谁先启用谁生效"确定性裁决，所以功能是正常的——但**用户必须知道**自己启用的
        第二个编辑器没有生效。此前这条信息只存在于 REST 响应里，界面上完全看不到，
        于是"我启用了却没反应"变成静默故障（本仓库反复在打的那一类）。

        放在 issues / uiSkips 之后、blockedDisable 之前：同属"需要你注意"的信息组。
      */}
      {slotConflicts.length > 0 && (
        <Card className="border-warn-line bg-warn-bg">
          <CardHeader
            as="h2"
            title={
              <span className="flex items-center gap-1.5 text-warn-ink">
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                {slotConflictTitle(slotConflicts)}
              </span>
            }
            description="同一个位置只能由一个插件提供。这些插件本身都在正常运行，只是它们贡献的那部分界面被系统按「谁先启用谁生效」裁定掉了。"
          />
          <CardBody className="flex flex-col gap-2">
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {/*
                排版注意：缩进换行会让 JSX 在文本与元素之间插入一个空格，而中文标点前不该有空格
                （「备用编辑器 的正文编辑器」）。故这里用 flex + gap 表达间隔，文本片断之间不留换行，
                既避免了游离空格，也让徽标与文字的对齐由布局而非空格决定。
              */}
              {slotConflicts.map((c) => (
                <li
                  key={`${c.slot}:${c.owners.join(',')}`}
                  className="flex flex-wrap items-center gap-1 text-xs text-ink-soft"
                >
                  <span className="text-ink">{slotHuman(c.slot)}</span>
                  <span>：</span>
                  <Badge tone="ok">{labelOf(c.effective[0] ?? '')}</Badge>
                  <span>正在提供，</span>
                  {c.suppressed.map((n) => (
                    <Badge key={n} tone="neutral">
                      {labelOf(n)}
                    </Badge>
                  ))}
                  <span>未生效。</span>
                </li>
              ))}
            </ul>
            <p className="m-0 text-xs text-ink-soft">
              想换成另一个：在下面<strong>停用</strong>正在提供它的那个插件，被顶掉的那个会自动接上（裁定在每次启停后重新计算）。
            </p>
            <p className="m-0 text-xs text-ink-soft">
              若希望这类插件本来就互斥、在<strong>启用时</strong>就得到明确提示，需要插件作者用「冲突组」声明——那是一处配置，不是这里的操作能改的。
            </p>
          </CardBody>
        </Card>
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
                它仍有正在运行的依赖方（服务端未返回名单，可在「插件管理」页查看指向它的连线）。
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
          title="插件与依赖"
          description={
            counts
              ? `共 ${plugins?.length ?? 0} 个：${counts.active} 个运行中，${counts.inactive} 个未启用${counts.error > 0 ? `，${counts.error} 个异常` : ''}${runtimeDisabled.length > 0 ? `，${runtimeDisabled.length} 个被临时停用` : ''}`
              : undefined
          }
          actions={<GraphLegend />}
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
        ) : graph === null || plugins === null ? (
          <div className="p-4">
            <LoadingState slow={slowAdmin}>
              <SkeletonTable rows={5} cols={4} />
            </LoadingState>
          </div>
        ) : graph.nodes.length === 0 ? (
          <EmptyState
            icon={<Workflow className="size-6" />}
            title="还没有可显示的插件"
            hint="启用至少一个插件后，这里会画出它们之间的依赖关系。"
          />
        ) : (
          /*
            高度比合并前给得更高（70vh/44rem → 76vh/52rem）：节点是按层叠的，列高由该层
            节点数决定，视口越矮 fitView 缩得越小——26 个插件时字会小到看不清，
            而"看不清"正是用户这次要解决的问题。多出来的高度不花任何布局成本。
          */
          <div className="h-[min(76vh,52rem)] overflow-hidden border-t border-line bg-sunken">
            {/*
              画布**只在四个状态都过了之后**才挂载：React Flow 初始化时会自动 fitView，
              若在 0 高度/被遮挡时挂载，fitView 会把缩放算成极小值（表现为"图缩成一点"）。
              图区在合并前是懒加载的独立页面 chunk，现在挂在页面里，但页面本身仍是懒加载的
              （`App.tsx` 的 LazyGraphPage）⇒ @xyflow/react 依然不进主包。
            */}
            <PluginGraph
              graph={graph}
              labelOf={labelOf}
              selectedId={configFor}
              onSelect={(id) => {
                const p = plugins.find((x) => x.name === id)
                if (p) openConfig(p)
              }}
            />
          </div>
        )}
      </Card>

      {/* 节点详情：与图同一个 Card 之外的弹窗（原先是大表格里的一行展开，字段一个没少） */}
      {pluginToShow !== null && (
        <PluginDetailDialog
          p={pluginToShow}
          rowBusy={rowBusyOf(pluginToShow.name)}
          globalBusy={busyGlobal !== ''}
          configText={configText}
          editor={editor?.name === pluginToShow.name ? editor : null}
          configErrors={configErrors}
          labelOf={labelOf}
          onConfigText={setConfigText}
          onEditorChange={(next) => setEditor((prev) => (prev ? { ...prev, value: next } : prev))}
          onClose={() => setConfigFor(null)}
          clearSecrets={clearSecrets}
          onToggleClearSecret={(name) =>
            setClearSecrets((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
          }
          providerOptions={providerOptions}
          llm={llmForm}
          llmTest={llmTest}
          onLlmTest={() => runLlmTest(editorValue)}
          onEnable={() => confirmEnable(pluginToShow)}
          onSaveConfig={() => void saveConfig(pluginToShow)}
          onDisable={() => void disablePlugin(pluginToShow)}
        />
      )}

      {/* ---------- 临时变更（原「会话变更（Session Layer）」） ---------- */}

      <Card>
        <CardHeader
          title={
            sessionChanges.length + runtimeDisabled.length > 0
              ? `临时变更（${sessionChanges.length + runtimeDisabled.length} 项）`
              : '临时变更'
          }
          description={
            runtimeDisabled.length > 0 ? (
              <>
                <span className="block">{SESSION_LAYER_HINT}</span>
                <span className="mt-0.5 block">
                  临时停用<strong className="font-medium text-ink-soft">不写任何文件</strong>：只在本进程内生效，重启后照基础清单恢复；点「应用并持久化」才会把它从基础清单移除。
                </span>
              </>
            ) : (
              SESSION_LAYER_HINT
            )
          }
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
          {/*
            空态判据必须**两种临时变更都算上**：只判 `sessionChanges` 时，用户"临时停用一个基础层插件"
            之后卡片会显示"当前没有临时变更"——被停用的插件明明列在下面却又被这句话否掉（用户实测报的正是这个）。
          */}
          {sessionChanges.length === 0 && runtimeDisabled.length === 0 ? (
            <p className="m-0 text-xs text-muted">当前没有临时变更——所有启停都已写进基础清单。</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {sessionChanges.map((e) => (
                <li key={e.name} className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink">{labelOf(e.name)}</span>
                  <Badge tone="session">{LAYER_HUMAN.session}</Badge>
                  <span className="text-xs text-muted">正常重启仍保留；异常崩溃恢复时丢弃</span>
                  {e.config && Object.keys(e.config).length > 0 && (
                    <code className="font-mono text-2xs text-muted">{JSON.stringify(e.config)}</code>
                  )}
                </li>
              ))}
              {runtimeDisabled.map((name) => (
                <li key={name} className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink">{labelOf(name)}</span>
                  <Badge tone="suspended">临时停用</Badge>
                  <span className="text-xs text-muted">
                    仅当前进程内停用，什么都没写盘——重启后照基础清单恢复；要永久停用请「应用并持久化」
                  </span>
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
          description={
            runtimeDisabled.length > 0
              ? `${PERSIST_HINT}\n临时停用的插件会从基础清单里移除：此后任何重启都不会再加载它们。`
              : PERSIST_HINT
          }
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
                启用 {labelOf(e.name)} → 写进基础清单，此后任何重启都会加载
              </li>
            ))}
            {runtimeDisabled.map((name) => (
              <li key={name} className="text-xs">
                停用 {labelOf(name)} → 从基础清单移除，此后任何重启都不再加载
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

/**
 * 节点详情弹窗：**图上点一个节点弹出的那个**（合并前是大表格里的一行 + 展开的配置区）。
 *
 * 为什么从"行内展开"改成"弹窗"：图上的节点没有"行"可展开；而详情/配置的字段一个不少
 * （技术详情、依赖、迁移目录、SchemaForm / JSON 原文、保存与测试连接），只是换了个容器。
 * 保留 `rowBusy` 的按插件粒度：图上同时开两个弹窗是不可能的，但"哪个插件在忙"仍然要精确，
 * 否则刷新时弹窗里的按钮会全部闪成禁用态。
 */
function PluginDetailDialog(props: {
  p: PluginInfo
  rowBusy: RowAction | null
  globalBusy: boolean
  configText: string
  editor: ConfigEditorState | null
  configErrors: Map<string, string[]>
  labelOf: (name: string) => string
  onConfigText: (v: string) => void
  onEditorChange: (next: Record<string, unknown>) => void
  /** 关闭弹窗（点遮罩/按 Esc 也走它） */
  onClose: () => void
  onEnable: () => void
  onSaveConfig: () => void
  onDisable: () => void
  /** 本次保存要显式清除的写一次字段（`role:'secret'`） */
  clearSecrets: string[]
  onToggleClearSecret: (name: string) => void
  /** 服务商下拉选项；undefined = 该插件表单不需要（或尚未取到） */
  providerOptions?: LlmProviderOption[]
  /** 模型清单 / 思考强度档位；undefined = 这不是模型接入表单（连「测试连接」一起隐藏） */
  llm?: LlmFormState
  /** 连接测试状态（null = 本次还没测过） */
  llmTest?: { running: boolean; result?: LlmTestResponse; error?: string } | null
  onLlmTest?: () => void
}): ReactNode {
  const { p, rowBusy, globalBusy, configText, editor, configErrors, labelOf: _labelOf, onConfigText, onEditorChange, onClose, onEnable, onSaveConfig, onDisable, clearSecrets, onToggleClearSecret, providerOptions, llm, llmTest, onLlmTest } = props
  // 只禁用"正在忙的那一行"；全局操作（刷新/持久化）在途时也一并禁用，避免与整体刷新交错
  const rowDisabled = rowBusy !== null || globalBusy
  const name = displayNameOf(p)
  const desc = descriptionOf(p)

  const tone = pluginToneOf({ state: p.state, layer: p.layer, runtimeDisabled: p.runtimeDisabled === true })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={name}
        description={p.name}
        footer={
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
            {/*
              停用按钮现在对**两种层**都给：基础层插件走的就是本批新增的"真·临时停用"
              （进程内停用、不落盘、重启恢复）。此前基础层只显示一句"随启动加载"，配的
              tooltip 还写着"先临时停用或改清单"——而那时 `disable()` 对基础层是直接拒绝的，
              也就是说提示让人去做一件做不到的事（本批把它兑现了，文案也随之改成实话）。
            */}
            {p.state === 'active' && (
              <Tooltip
                content={
                  p.layer === 'session'
                    ? '从会话清单移除：重启后也不会再加载它（它本来就不在基础清单里）'
                    : '仅当前进程内停用，不写任何文件——重启后照基础清单恢复。要永久停用请用「应用并持久化」'
                }
              >
                <span>
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
                </span>
              </Tooltip>
            )}
            <DialogClose asChild>
              <Button size="sm" variant="ghost">
                关闭
              </Button>
            </DialogClose>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {/* 概览：人话名称 + 来源 + 状态 + "重启后还在不在"（详情里再给技术原文） */}
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
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
              <Badge tone={tone}>{TONE_TEXT[tone]}</Badge>
              <span className="text-xs text-muted">{TONE_HINT[tone]}</span>
            </div>
            {desc !== undefined && <p className="m-0 text-xs text-muted">{desc}</p>}
            {p.state === 'error' && p.error !== undefined && (
              <p className="m-0 text-xs text-danger-ink">{p.error}</p>
            )}
          </div>
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
                  <SchemaForm
                    root={editor.descriptor}
                    value={editor.value}
                    onChange={onEditorChange}
                    errors={configErrors}
                    secrets={editor.secrets}
                    clearSecrets={clearSecrets}
                    onToggleClearSecret={onToggleClearSecret}
                    providerOptions={providerOptions}
                    llm={llm}
                  />
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
                {llm !== undefined && <LlmTestPanel state={llmTest ?? null} />}
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
                  {/*
                   * 「测试连接」用**当前表单值**打上游，不需要先保存：
                   * 配一个新端点时最想知道的就是"这套值通不通"，而保存失败与端点不通是两回事。
                   */}
                  {llm !== undefined && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<PlugZap className="size-3.5" />}
                      loading={llmTest?.running === true}
                      disabled={rowDisabled || editor?.loading === true}
                      onClick={onLlmTest}
                    >
                      测试连接
                    </Button>
                  )}
                  {(p.state === 'inactive' || p.state === 'error') && (
                    <Button size="sm" disabled={rowDisabled || editor?.loading === true} onClick={onEnable}>
                      启用「{name}」
                    </Button>
                  )}
                </div>
              </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 连接测试的结果面板。
 *
 * 三步各自成行、各自表态，因为它们的失败**互不蕴含**：
 * 目标解析失败（没密钥 / 端点没填）= 两步都没打出去；
 * 清单失败但对话通过 = 端点不实现 `/models`，完全能用；
 * 对话失败 = 这套配置真的不能用，此时上游原文比任何概括都有用。
 */
function LlmTestPanel(props: {
  state: { running: boolean; result?: LlmTestResponse; error?: string } | null
}): ReactNode {
  const { state } = props
  if (state === null) return null
  if (state.running) {
    return <p className="m-0 text-xs text-muted">正在连接端点：读取模型清单 + 一次最小对话（最长约 20 秒）…</p>
  }
  if (state.error) {
    return <p className="err-text m-0 text-xs">测试请求本身失败：{state.error}</p>
  }
  const result = state.result
  if (!result) return null
  const target = `${result.provider || '（自动选择服务商）'} · ${result.baseUrl || '（未取到端点地址）'}`
  return (
    <div className="probe-result">
      <p className="m-0 text-xs text-ink-soft">
        测试结果 —— 服务商/端点：<code className="font-mono text-2xs">{target}</code>
        {result.model ? <>；模型：<code className="font-mono text-2xs">{result.model}</code></> : null}
      </p>
      {result.error ? (
        // 目标没解析出来：两步都没执行，说清楚缺什么就够了
        <p className="err-text m-0 text-xs">
          {probeFailureText(result.error, '无法开始测试')}
          <span className="muted">（尚未向端点发出任何请求）</span>
        </p>
      ) : (
        <>
          <p className="m-0 text-xs">
            {result.chat?.ok ? (
              <span className="text-ink">
                对话：通过
                {result.chat.latencyMs !== undefined ? `（${result.chat.latencyMs}ms）` : ''}
                {result.chat.reply ? <>，回复 <code className="font-mono text-2xs">{result.chat.reply}</code></> : null}
              </span>
            ) : (
              <span className="err-text">对话：失败 —— {probeFailureText(result.chat?.error, '未返回可诊断的信息')}</span>
            )}
          </p>
          <p className="m-0 text-xs">
            {result.models?.ok ? (
              <span className="text-ink-soft">模型清单：{result.models.models.length} 个</span>
            ) : (
              // 清单失败不判整体失败：不少网关不实现 /models，对话照样能用
              <span className="muted">
                模型清单：未取到（{probeFailureText(result.models?.error, '未知原因')}）——不影响对话使用，可手填模型名。
              </span>
            )}
          </p>
        </>
      )}
    </div>
  )
}
