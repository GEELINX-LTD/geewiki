/**
 * 编辑器预览用的**块级可见性投影**（P3d）。
 *
 * ## 为什么前端需要一份镜像实现
 *
 * 投影的真源在服务端（`packages/plugin-wiki/src/blocks.ts` 的 `projectBlocks`），
 * 而编辑器预览是**纯客户端**渲染 —— 正文还没保存，服务端看不到它。作者要能自查
 * "别人打开这条会看到什么"，就必须在本地做同一件事。
 *
 * `packages/core` 不能进浏览器包（顶层 `import 'node:fs'`）⇒ 只能持镜像副本，
 * 与本仓既有惯例一致（`slugRules.ts` / `pluginUiPlan.ts` / `SLOT_NAMES` 都这么办）。
 * **镜像必须与服务端逐字一致**，由 `packages/web/test/gatedPreview.test.ts` 的
 * 源码级守卫钉住（比对两边的正则字面量与占位文案）。
 *
 * ## 与服务端刻意一致的几条行为（别"顺手优化"掉）
 *
 * 1. **连续的受限块合并成一个占位**。每块给一行会把"这里有 5 段受限内容"渲染成 5 行
 *    重复文案；更要紧的是**行数会随作者的分段方式变化**，而分段方式是结构信息 ——
 *    占位不该泄露它。合并之后，占位只泄露"这里有一段受限内容"这一个事实。
 * 2. **措辞按读者而非内容选择**：匿名给"需登录查看"，已登录给"需更高权限查看"。
 *    这样既不泄露受限内容的档位（`org` 还是 `granted`），又让访客知道该做什么。
 * 3. **标记是语法、不是内容**：可见区段的标记被剥掉 —— 与 `ParsedBlock.text`
 *    的语义一致（"不含 gated 标记本身"）。
 * 4. **只接受 `org` 与 `granted`**。v2/v3 的 `<!--gated:role=editor-->` 会被服务端
 *    **显式拒绝**（不是静默忽略 —— 静默忽略会让作者以为收紧了、其实按 public 暴露）。
 *    预览里把它记进 `invalidMarkers` 让作者**在保存前**就看见。
 */

/*
 * ★ 与 `packages/plugin-wiki/src/blocks.ts` 的 `OPEN_RE` / `CLOSE_RE` **逐字一致**。
 * 守卫测试会比对这个字面量，改一侧不改另一侧会立刻变红。
 */
const OPEN_RE = /^<!--\s*gated\s*:\s*([^>]*?)\s*-->\s*$/
const CLOSE_RE = /^<!--\s*\/gated\s*-->\s*$/

/** 预览视角：`all` = 我自己（看得到全部），`org` = 组织成员，`anonymous` = 未登录访客。 */
export type PreviewAudience = 'all' | 'org' | 'anonymous'

export interface GatedPreview {
  markdown: string
  /** 被遮蔽的区段数（渲染成占位的那些） */
  gatedCount: number
  /**
   * 服务端会**拒绝**的标记（已废弃的 `role=…`、不认识的取值、嵌套、未闭合、多余的闭合）。
   * 非空意味着**这份正文保存时会被 400 拒绝** —— 预览里必须显眼提示，不能等保存才发现。
   */
  invalidMarkers: readonly string[]
}

/** 该档位的区段在这个视角下是否可见。 */
function visibleTo(spec: string, audience: PreviewAudience): boolean {
  if (audience === 'all') return true
  if (spec === 'org') return audience === 'org'
  // `granted` 只对**显式被授予者**可见；预览里没有"某个人"这个上下文，故一律遮蔽。
  if (spec === 'granted') return false
  // 不认识的标记：正文按可见处理（作者需要看见它才能改），同时记进 invalidMarkers。
  return true
}

/**
 * 占位文案的**识别式**（服务端与本地预览生成的是同一句话，见下方 `flushGated`）。
 *
 * 用途只有一个，但很关键：**发现"手上的正文是投影结果"**。
 * 投影会消费掉 `<!--gated:…-->` 标记、把受限段落换成这句话。若把这样一份正文当原文
 * 编辑并保存，段落权限标记就**没了** —— 受限段落因此静默变成公开（服务端会照单全收，
 * 因为从它的角度看，作者就是删掉了标记）。
 *
 * 三条真实来路：① 旧客户端写下的草稿（`localStorage` 里存的是当年那份投影正文）；
 * ② 用户从别处粘贴了带占位的文本；③ 将来某条读路径被误用为编辑源。
 * 拿不准时的口径是**提醒**而不是静默保存（见 `WikiEdit` 的保存拦截）。
 */
export const GATED_PLACEHOLDER_RE = /^>\s*🔒\s*此处有\s*\d+\s*段内容需(?:登录|更高权限)查看\s*$/m

/** 正文里是否含服务端/预览生成的占位文案（⇒ 这不是原文） */
export function looksProjected(markdown: string): boolean {
  return GATED_PLACEHOLDER_RE.test(markdown)
}

/**
 * 按视角投影正文：把该视角看不到的 gated 区段替换为**显式占位**。
 *
 * 返回的是 Markdown（不是 HTML）—— 调用方照常走既有的 `renderMarkdownBody` 渲染，
 * 于是预览与详情页共用同一套渲染管线（占位文案的样式因此天然一致）。
 */
export function projectForAudience(markdown: string, audience: PreviewAudience): GatedPreview {
  const lines = markdown.split('\n')
  const out: string[] = []
  const invalid: string[] = []
  /** 连续被遮蔽的"块"数（近似服务端的块计数，见下方说明） */
  let gatedRun = 0
  let gatedCount = 0
  let region: { spec: string; body: string[] } | null = null

  const flushGated = (): void => {
    if (gatedRun === 0) return
    // ★ 措辞与 `projectBlocks` 逐字一致（守卫测试钉住）
    const suffix = audience === 'anonymous' ? '需登录查看' : '需更高权限查看'
    out.push(`> 🔒 此处有 ${gatedRun} 段内容${suffix}`)
    gatedCount += gatedRun
    gatedRun = 0
  }

  /*
   * 服务端按**块**计数，这里按**非空行**近似。两者对"作者写的普通段落"是一致的
   * （一段一行）；对列表、代码块这类多行块会略有偏差。预览是自查工具而非判定，
   * 这点偏差可以接受 —— 但如果哪天要精确对齐，得在前端也实现一遍分块。
   */
  const countBlocks = (body: readonly string[]): number =>
    Math.max(1, body.filter((l) => l.trim() !== '').length)

  for (const line of lines) {
    if (region === null) {
      const m = OPEN_RE.exec(line)
      if (m !== null) {
        const spec = (m[1] ?? '').trim()
        if (spec !== 'org' && spec !== 'granted') invalid.push(spec)
        region = { spec, body: [] }
        continue
      }
      if (CLOSE_RE.test(line)) {
        invalid.push('/gated')
        continue
      }
      flushGated()
      out.push(line)
      continue
    }
    /* ---- 区段内 ---- */
    if (CLOSE_RE.test(line)) {
      if (visibleTo(region.spec, audience)) {
        flushGated() // 可见区段前的受限占位要先收口，否则顺序会错
        out.push(...region.body)
      } else {
        gatedRun += countBlocks(region.body)
      }
      region = null
      continue
    }
    if (OPEN_RE.test(line)) {
      // 服务端对嵌套是**硬拒绝**（`gated_nested`）⇒ 这里记录，且不把它当作新的区段起点
      invalid.push('nested')
      region.body.push(line)
      continue
    }
    region.body.push(line)
  }

  if (region !== null) {
    // 未闭合：服务端会 `gated_unclosed` 拒绝保存。预览按**失败关闭**处理 ——
    // 不把未闭合区段的内容当成可见正文吐出去。
    invalid.push('unclosed')
    gatedRun += countBlocks(region.body)
  }
  flushGated()

  return { markdown: out.join('\n'), gatedCount, invalidMarkers: invalid }
}
