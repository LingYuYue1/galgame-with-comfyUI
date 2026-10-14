import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ★ F-41 前端配套守卫 —— doBatchDelete 的提示必须区分 deleted / missing。
 *
 * ── 背景 ────────────────────────────────────────────────────
 * 后端 delete-batch 自 F-41 起把「真删了文件」（deleted）与「本就已不存在、幂等通过」
 * （missing）分开报。若前端仍只显示 `已删除 ${deleted} 张`：当选中集里混有幽灵图时，
 * 用户会看到数字比选中的少，误以为"还有几张没删掉"——这是修完后端反而产生的**新困惑**；
 * 而 missing 的引用其实已被一并清掉（卡片同样从相册消失）。
 * 并报「（另有 X 张本就已不存在）」把两种去向都说清。
 *
 * ── 本文件（静态护栏）────────────────────────────────────────
 * 钉住 doBatchDelete 函数体：① 读取后端返回的 `missing`；② 提示里出现「本就已不存在」。
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

test('★ F-41：doBatchDelete 的提示区分 deleted / missing（并报「本就已不存在」）', () => {
  const view = stripComments(read('components/Gallery.vue'))
  const body = extractFnBody(view, 'doBatchDelete')
  assert.ok(body, '未找到 doBatchDelete')
  assert.match(body, /res\?\.missing/, '应读取后端返回的 missing（F-41 起响应区分 deleted/missing）')
  assert.match(
    body, /本就已不存在/,
    '提示应并报 missing —— 否则列表混有幽灵图时"已删除 N 张"数字变小，用户误以为没删干净',
  )
})
