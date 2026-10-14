import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// F-33 护栏（2026-10-13）：媒体「形态枚举」跨端一致性 —— 后端 OUTLET_LAYOUTS
// （权威，经 `GET /media/layouts` 下发）必须与前端 MediaSettingsModal 的
// FALLBACK_LAYOUTS 逐字一致。
//
// 背景：六个形态的 label/hint 在前后端**两处手抄**，且 28e94d0 引入之日起就漂移
// （5 处文案不一致）：photos/gallery 的标签与说明、poster 的说明细节都对不上；
// 「图片站（SFW）」与「图片站」两个标签并列，gallery 无（成人）标注、区分度差。
// 这类漂移「编译不报错、页面不报错」——只在兜底路径或未来新增形态时才暴露，
// 只能靠契约测试拦住。
//
// 规则：①两端条目逐项全等（key 顺序 + label + hint）；②权威口径钉死：
//   photos=「图片站（全年龄）」、gallery=「图片站（成人）」——与媒体页用户可见
//   语汇（MediaView 分类 hint）一致，两站形成「全年龄/成人」对仗标注，防建错源；
//   ③细节信息不丢：gallery hint 保留「（1 排 4 张）」、poster hint 保留完整结构
//   （热点速报条 → 大标题 → 主图 → 爆点气泡 → 短文案 → 小图组）。

const BACKEND_FILE = fileURLToPath(new URL('../../agent-core/src/services/mediaService.js', import.meta.url))
const FALLBACK_FILE = fileURLToPath(new URL('../src/components/MediaSettingsModal.vue', import.meta.url))

/**
 * 从源码里提取形如 `{ key: 'x', label: 'y', hint: 'z' }` 的枚举条目。
 * （枚举结构只有这三个字段；未来若加字段，本提取器同步扩展。）
 */
function extractLayouts(file, anchor, label) {
  const text = fs.readFileSync(file, 'utf8')
  const start = text.indexOf(anchor)
  assert.ok(start >= 0, `${label} 中找不到锚点 ${anchor}`)
  const end = text.indexOf(']', start)
  assert.ok(end > start, `${label} 中 ${anchor} 块未闭合`)
  const block = text.slice(start, end)
  const re = /\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)',\s*hint:\s*'([^']+)'\s*\}/g
  const out = []
  for (const m of block.matchAll(re)) out.push({ key: m[1], label: m[2], hint: m[3] })
  assert.equal(out.length, 6, `${label} 应解析出 6 个形态（解析到 ${out.length} 个——锚点或格式变了？）`)
  return out
}

const backend = extractLayouts(BACKEND_FILE, 'export const OUTLET_LAYOUTS = [', '后端 mediaService.js')
const fallback = extractLayouts(FALLBACK_FILE, 'const FALLBACK_LAYOUTS = [', '前端 MediaSettingsModal.vue')

test('F-33 ①：两端枚举逐项一致（key 顺序 + label + hint 全等）——同一口径只维护一份', () => {
  assert.deepEqual(
    fallback, backend,
    'FALLBACK_LAYOUTS 与后端 OUTLET_LAYOUTS 漂移了：兜底清单必须与权威清单逐字一致（改动要整段同步）',
  )
})

test('F-33 ②：权威口径钉死 —— 两个图片站用「全年龄 / 成人」对仗标注', () => {
  const byKey = Object.fromEntries(backend.map(l => [l.key, l]))
  assert.equal(byKey.photos.label, '图片站（全年龄）')
  assert.equal(byKey.gallery.label, '图片站（成人）')
})

test('F-33 ③：细节信息不丢 —— 两处都保留 gallery「（1 排 4 张）」与 poster 完整结构', () => {
  for (const [name, list] of [['后端', backend], ['兜底', fallback]]) {
    const byKey = Object.fromEntries(list.map(l => [l.key, l]))
    assert.match(byKey.gallery.hint, /（1 排 4 张）/, `${name} gallery hint 丢了排布信息`)
    assert.match(byKey.poster.hint, /爆点气泡/, `${name} poster hint 丢了「爆点气泡」`)
    assert.match(byKey.poster.hint, /小图组/, `${name} poster hint 丢了「小图组」`)
  }
})
