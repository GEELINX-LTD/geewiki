/**
 * 相对时间的单测。
 *
 * 为什么单独一个文件：版本记录里"何时改的"是用户最常读的一列，时间文案说错（把昨天说成
 * "1天前"、把未来时间说成"x 秒后"、把坏数据说成"刚刚"）都是**看起来对但其实在撒谎**的
 * 缺陷。这类问题只有把每一档的边界钉住才防得住。
 *
 * 时间桶（与 `timePlan.ts` 的实现一一对应）：
 * | 档位 | 窗口 |
 * |---|---|
 * | 刚刚 | < 60 秒（含未来时间，见下） |
 * | N分钟前 | 60 秒 – 60 分钟 |
 * | N小时前 | 1 – 24 小时 |
 * | 昨天 | 24 – 48 小时 |
 * | N天前 | 2 – 30 天 |
 * | N个月前 | 30 天 – 12 个月 |
 * | N年前 | ≥ 12 个月 |
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_JUST_NOW_SECONDS,
  YESTERDAY_SECONDS,
  absoluteTime,
  relativeTime,
} from '../src/lib/timePlan'

const here = dirname(fileURLToPath(import.meta.url))
const NOW = new Date('2026-09-12T12:00:00Z')
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString()

test('刚刚：60 秒内不说"x 秒钟前"（那不是中文，也读起来在跳秒）', () => {
  assert.equal(relativeTime(ago(0), NOW), '刚刚')
  assert.equal(relativeTime(ago(5), NOW), '刚刚')
  assert.equal(relativeTime(ago(45), NOW), '刚刚')
  assert.equal(relativeTime(ago(MAX_JUST_NOW_SECONDS - 1), NOW), '刚刚')
  // 边界另一侧必须已经换档（否则这个常量就是摆设）
  assert.equal(relativeTime(ago(MAX_JUST_NOW_SECONDS), NOW), '1分钟前')
  assert.equal(relativeTime(ago(MAX_JUST_NOW_SECONDS + 5), NOW), '1分钟前')
})

test('永不输出秒级相对时间（"秒钟前"不是中文）', () => {
  for (const s of [1, 5, 30, 45, 46, 59]) {
    assert.doesNotMatch(relativeTime(ago(s), NOW), /秒钟前|秒前/, `${s} 秒不该出现秒级措辞`)
  }
})

test('分钟档：1 – 59 分钟，向下取整（59分59秒 不得读成"60分钟前"）', () => {
  assert.equal(relativeTime(ago(120), NOW), '2分钟前')
  assert.equal(relativeTime(ago(59 * 60), NOW), '59分钟前')
  assert.equal(relativeTime(ago(59 * 60 + 59), NOW), '59分钟前')
  assert.equal(relativeTime(ago(3600), NOW), '1小时前')
})

test('小时档：1 – 24 小时，同样向下取整（23小时59分 ≠ 24小时前）', () => {
  assert.equal(relativeTime(ago(3600), NOW), '1小时前')
  assert.equal(relativeTime(ago(20 * 3600), NOW), '20小时前')
  assert.equal(relativeTime(ago(23 * 3600 + 59 * 60), NOW), '23小时前')
})

test('「昨天」：24 – 48 小时（时长档，不是日历日）', () => {
  assert.equal(relativeTime(ago(24 * 3600), NOW), '昨天')
  assert.equal(relativeTime(ago(47 * 3600), NOW), '昨天')
  assert.equal(relativeTime(ago(YESTERDAY_SECONDS - 1), NOW), '昨天')
  // 边界两侧：不到 24 小时是小时档，超过 48 小时是"N天前"
  assert.equal(relativeTime(ago(23 * 3600), NOW), '23小时前')
  assert.equal(relativeTime(ago(YESTERDAY_SECONDS + 60), NOW), '2天前')
})

test('天数档：2 天起给"N天前"（不再用"前天"这类丢精度的说法）', () => {
  assert.equal(relativeTime(ago(2 * 86400), NOW), '2天前')
  assert.equal(relativeTime(ago(5 * 86400), NOW), '5天前')
  // 反例守卫：`Intl` 的 `numeric: 'auto'` 会说"前天"/"去年"，那对手头这个用途丢精度
  assert.doesNotMatch(relativeTime(ago(2 * 86400), NOW), /前天|昨天|今天/)
})

test('月 / 年档', () => {
  assert.equal(relativeTime(ago(40 * 86400), NOW), '1个月前')
  assert.equal(relativeTime(ago(70 * 86400), NOW), '2个月前')
  assert.equal(relativeTime(ago(400 * 86400), NOW), '1年前')
  assert.doesNotMatch(relativeTime(ago(400 * 86400), NOW), /去年|今年/)
})

test('未来时间（时钟漂移）说「刚刚」，不说"x 秒后"', () => {
  const future = new Date(NOW.getTime() + 60_000).toISOString()
  assert.equal(relativeTime(future, NOW), '刚刚')
  const farFuture = new Date(NOW.getTime() + 86400_000).toISOString()
  assert.equal(relativeTime(farFuture, NOW), '刚刚')
})

test('无法解析的时间串原样返回（不猜、不假装是"刚刚"）', () => {
  assert.equal(relativeTime('不是时间', NOW), '不是时间')
  assert.equal(relativeTime('', NOW), '')
  // 反空洞：能解析的串不能被这条兜底吃掉
  assert.equal(relativeTime(ago(120), NOW), '2分钟前')
})

test('absoluteTime：可解析时给中文格式，不可解析时原样返回', () => {
  assert.match(absoluteTime('2026-09-12T04:00:00Z'), /\d{4}/)
  assert.equal(absoluteTime('坏串'), '坏串')
})

test('同一时间点重复调用结果稳定（相对时间是纯函数，不读真实时钟）', () => {
  const iso = ago(3 * 3600)
  assert.equal(relativeTime(iso, NOW), relativeTime(iso, NOW))
  assert.equal(relativeTime(iso, NOW), '3小时前')
})

// ───────────────────────── 源码级守卫 ─────────────────────────

test('守卫：「昨天」不得依赖 Intl 的 auto 模式（那会同时改掉别的档）', () => {
  const src = readFileSync(join(here, '../src/lib/timePlan.ts'), 'utf8')
  assert.ok(src.length > 500, '读不到 timePlan？反空洞')
  assert.match(src, /YESTERDAY_SECONDS/, '「昨天」档必须有具名常量，便于单测钉边界')
  assert.doesNotMatch(src, /numeric:\s*'auto'/, "不得用 numeric:'auto'（会说前天/去年，丢精度）")
  assert.match(src, /numeric:\s*'always'/, "应当显式声明 numeric:'always'")
})
