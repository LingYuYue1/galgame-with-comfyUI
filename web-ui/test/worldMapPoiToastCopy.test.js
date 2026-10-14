import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ★ F-38 回归守卫 —— AI 追加生活地点的 toast 不得指向已删除的「保存生活地点」按钮。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * 2026-10-07 一站式编辑重构：「保存生活地点」独立按钮被删除，统一为顶部「保存」
 * （见 WorldMapView.vue 的考古注释：L344-347 / 801-804 / 922-926；同页状态提示
 * L348 也已改为「生活地点有改动 · 点右上角『保存』一并提交」）。但 `onAiAddPois`
 * 的成功 toast 没跟上，仍说「确认后点『保存生活地点』」——**指向一个已不存在的
 * 按钮**，用户照着找不到。随 28e94d0（Pr/4）引入即残留、此后从未动过（写作残留）。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 * toast 文案改为与 L348 同口径：「确认后点右上角『保存』一并提交」。
 *
 * ── 本文件（静态护栏）────────────────────────────────────────
 * ① 剥掉注释（含模板注释）后全文件不得残留「保存生活地点」——
 *    历史考古注释**允许**保留该字样（说明按钮去过哪），运行时文案不允许；
 * ② onAiAddPois 的 toast 必须引导到「右上角『保存』」。
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 剥注释：先 Vue 模板注释，再 JS 块注释与行注释（字符串里的 `://` 不误伤） */
function stripComments(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 从源码里抠出具名函数的函数体（含花括号）。参数表可能含解构，须先配平圆括号（F-23 沉淀）。 */
function extractFnBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) return null
  const paren = src.indexOf('(', m.index + m[0].length - 1)
  let pd = 0
  let afterParams = -1
  for (let j = paren; j < src.length; j++) {
    const ch = src[j]
    if (ch === '(') pd++
    else if (ch === ')') { pd--; if (pd === 0) { afterParams = j; break } }
  }
  if (afterParams < 0) return null
  const brace = src.indexOf('{', afterParams)
  if (brace < 0) return null
  let depth = 0
  for (let j = brace; j < src.length; j++) {
    const ch = src[j]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(brace, j + 1) }
  }
  return null
}

test('★ F-38 ①：运行时文案不得再出现「保存生活地点」（注释里的历史说明除外）', () => {
  const stripped = stripComments(read('views/WorldMapView.vue'))
  assert.ok(
    !stripped.includes('保存生活地点'),
    '运行时（非注释）代码里残留了「保存生活地点」——该按钮 2026-10-07 已并入顶部「保存」，'
    + '任何指向它的提示都会让用户找不到按钮。若确需恢复该按钮，请先同步本测试与全部文案。',
  )
})

test('★ F-38 ②：onAiAddPois 的成功 toast 应引导到「右上角『保存』」', () => {
  const stripped = stripComments(read('views/WorldMapView.vue'))
  const body = extractFnBody(stripped, 'onAiAddPois')
  assert.ok(body, '未找到 onAiAddPois')
  assert.match(body, /右上角/, 'toast 应说明保存按钮的位置（右上角）——与同页 L348 提示同口径')
  assert.match(body, /「保存」/, 'toast 应引导用户点顶部「保存」一并提交')
})
