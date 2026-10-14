import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ★ F-40 回归守卫 —— 全域图「参考用时」文案的点名必须与图上可指认的点位一致。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * 文案写「参考：泊地站 → 珠星站 … 分 · → 海原站 … 分」（用户 2026-10-05 给约束时的
 * 口语站名），但**图上渲染的点名**是 REGION_LAYOUT 里的 `n`：「二维市」「珠星大厦」
 * 「海原市」「观览云岛站」——用户照着文案在图上找「泊地站/珠星站/海原站」**找不到**。
 *
 * ── 谁是"对"的（考古结论：计算对、文案错）────────────────────
 * refs 的计算起点是 `pt('二维市')`。实测：二维市↔珠星大厦 447.2px、二维市↔海原市
 * 447.2px、二维市↔观览云岛站 208px —— 按 M_PER_PX=66.8、eta=4+km/32*60 换算恰为
 * **60 / 60 / 30 分**，与 M_PER_PX 注释记载的用户约束（珠星↔泊地 60 / 海原↔泊地 60 /
 * 观览云岛↔泊地 30）**逐条吻合**——「泊地站」是「二维市」大区下的节点（见
 * erxiangCoords.json：「二维市」area 下挂着「泊地站」），全域图只画大区点，所以
 * 反解约束里的「泊地站」在图上就是「二维市」这个点。**计算锚点是对的，错的是文案
 * 用了图上不存在的站名**（F-40 病灶），修法=文案改从图上点名。
 *
 * ── 本文件 ──────────────────────────────────────────────────
 * ① 文案点名 ⊆ 图上点位表（REGION_LAYOUT/MOON_LAYOUT 的 { n }）——先红主点；
 * ② 数据自洽：起点「二维市」→ 三个目标 应恰为 60/60/30（证明起点选择是反解基准，
 *    防止未来有人"统一命名"时反把正确的计算起点改掉）。
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

const vue = read('components/worldmap/MapPointView.vue')

/** 图上可渲染的点名（REGION_LAYOUT / MOON_LAYOUT 里的 { n: 'xxx' }） */
const spotNames = new Set([...vue.matchAll(/\{\s*n:\s*'([^']+)'/g)].map(m => m[1]))

test('★ F-40 ①：参考用时的点名必须出自图上点位表（用户得能在图上找到）', () => {
  const line = vue.match(/参考：[^\n]*/)?.[0] || ''
  assert.ok(line, '未找到「参考：」文案行')

  const start = line.match(/参考：([\u4e00-\u9fa5]+)\s*→/)?.[1]
  assert.ok(start, '未能解析起点点名')
  const labels = [...line.matchAll(/→\s*([\u4e00-\u9fa5]+?)\s*\{\{/g)].map(m => m[1])
  assert.ok(labels.length >= 3, '应能解析出三个目标点名')

  for (const name of [start, ...labels]) {
    assert.ok(
      spotNames.has(name),
      `文案点名「${name}」不在图上点位表（REGION_LAYOUT.spots 的 n）里 —— `
      + '用户会照着文案在图里找这个点、找不到（F-40：口语站名与图点名的错位）。'
      + '修法：改为图上可指认的点名（见本文件注释的考古结论：泊地站→二维市 等）。',
    )
  }
})

test('★ F-40 ②（数据自洽）：以「二维市」为起点，三条参考线应恰为 60 / 60 / 30 分', () => {
  // 复刻 overview computed 的 refs 计算（pt → d2 → eta），常数从源码原样抓取
  const pts = {}
  for (const m of vue.matchAll(/\{\s*n:\s*'([^']+)',\s*x:\s*([\d.]+),\s*y:\s*([\d.]+)/g)) {
    pts[m[1]] = { x: parseFloat(m[2]), y: parseFloat(m[3]) }
  }
  const mPerPx = parseFloat(vue.match(/const M_PER_PX = ([-\d.]+)/)?.[1])
  assert.ok(mPerPx > 0, '未解析到 M_PER_PX')

  const stat = vue.match(/const o = pt\('([^']+)'\)/)
  assert.ok(stat, '未找到 refs 起点（const o = pt(...)）')
  assert.equal(
    stat[1], '二维市',
    '起点锚点应为「二维市」——它是 2026-10-05 反解约束（用户口语的"泊地站"）在图上对应的点位；'
    + '改它前先读 M_PER_PX 注释与 erxiangCoords.json（泊地站是二维市 area 下的节点）。',
  )

  const distKm = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * mPerPx / 1000
  const eta = (km) => Math.round(4 + km / 32 * 60)   // 与源码一致：轨道 32km/h + 进站 4 分
  const o = pts['二维市']
  assert.ok(o, '图上应存在「二维市」点')
  assert.equal(eta(distKm(o, pts['珠星大厦'])), 60, '二维市→珠星大厦 应恰为 60 分（用户约束）')
  assert.equal(eta(distKm(o, pts['海原市'])), 60, '二维市→海原市 应恰为 60 分（用户约束）')
  assert.equal(eta(distKm(o, pts['观览云岛站'])), 30, '二维市→观览云岛站 应恰为 30 分（用户约束）')
})
