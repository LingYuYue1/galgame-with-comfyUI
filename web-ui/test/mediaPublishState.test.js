import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ★ F-34 回归守卫 —— 出刊按钮的 publishing 状态「单入口置位」。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `onPublish()` 里 `publishing.value = true` 写了**两遍**：函数入口一次，
 * 「今天已出过 → confirm 加刊」之后再一次。
 * 两遍之间没有任何把状态复位回 false 的路径（confirm 是同步阻塞、函数单线程），
 * 第二遍是**恒真后再置真的冗余赋值**——行为上无差异，危害在读代码的人：
 * 它暗示「加刊是一段独立的 loading 流程」，实际 publishing 从入口到 finally
 * 一直是 true；将来若有人在 confirm 前加了复位逻辑，这行还会掩盖那个改动。
 * 随 28e94d0（Pr/3）引入即如此、此后从未再动 —— 写作残留，不是有意设计。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 * 删掉 confirm 之后的冗余置位。状态语义收敛为单一模式：
 * **入口置 true、finally 复位**（与同文件其它 loading 一致）。
 *
 * ── 本文件（静态护栏）────────────────────────────────────────
 * 钉住 onPublish 函数体内：`publishing.value = true` 恰好 1 次、
 * `publishing.value = false` 恰好 1 次、且复位位于 finally。
 * 未来若确需在流程中途重新置位 —— 测试会拦下，请先重新审视状态机。
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
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

test('★ F-34：onPublish 的 publishing 状态为「入口置 true + finally 复位」单一模式', () => {
  const view = stripComments(read('views/MediaView.vue'))
  const body = extractFnBody(view, 'onPublish')
  assert.ok(body, '未找到 onPublish')

  const setTrue = body.match(/publishing\.value\s*=\s*true/g) || []
  const setFalse = body.match(/publishing\.value\s*=\s*false/g) || []

  assert.equal(
    setTrue.length, 1,
    `publishing.value = true 出现 ${setTrue.length} 次 —— 应为 1 次（仅入口）。`
    + '中途重复置位是 F-34 的病（无复位路径时恒为冗余）；若确需新增，请先审视状态机。',
  )
  assert.equal(
    setFalse.length, 1,
    `publishing.value = false 出现 ${setFalse.length} 次 —— 应为 1 次（finally 复位）。`,
  )

  // 复位必须位于 finally（保证异常路径也解除 loading）
  const finallyIdx = body.indexOf('finally')
  assert.ok(finallyIdx >= 0, 'onPublish 缺少 finally')
  assert.match(
    body.slice(finallyIdx), /publishing\.value\s*=\s*false/,
    '复位必须位于 finally 块内（异常路径也要解除 loading）',
  )
})
