import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ★ F-43 前端守卫 —— runPurge 必须如实处理 partial / errors（不再恒报成功）。
 *
 * ── 背景 ────────────────────────────────────────────────────
 * 后端 `purgeData` 自 F-09 起在「有失败」时如实返回 `partial: true` + `errors[]`
 * （dataCleanup.js 注释明言「前端据此提示，不再出现『显示清理完成、实际一行没删』的假成功」）。
 * 但前端 runPurge 此前恒报 success toast、结果卡也只显示删除量 —— 用户看不到「N 处失败」，
 * 正是那条注释承诺的「最后一公里」缺位（与 F-41 同族：响应里有信息、前端不读）。
 *
 * ── 本文件（静态护栏）────────────────────────────────────────
 * 钉住 runPurge 函数体：① 读取响应的 `partial`；② 失败时提示含「处失败」。
 * 钉住结果卡：③ 标注 partial 状态；④ 列出 errors 明细。
 * 守卫（修复前后均应通过）：⑤ 全成功路径仍报 success；⑥ catch 分支提示仍在。
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

test('守卫：全成功路径与 catch 分支不回归（修复前后均过）', () => {
  const clean = stripComments(read('components/DataCleanupCard.vue'))
  const body = extractFnBody(clean, 'runPurge')
  assert.ok(body, '未找到 runPurge')
  assert.match(body, /'success'/, '全成功路径仍应报成功 toast（不回归）')
  assert.match(clean, /清理失败：/, 'catch 分支的失败提示仍在（不回归）')
})

test('★ F-43 主断言：runPurge 读取 partial/errors、失败如实提示；结果卡展示明细', () => {
  const clean = stripComments(read('components/DataCleanupCard.vue'))
  const body = extractFnBody(clean, 'runPurge')
  assert.ok(body, '未找到 runPurge')

  assert.match(
    body, /\.partial/,
    'runPurge 应读取响应的 partial —— 后端自 F-09 起在有失败时如实返回（此前恒报成功）',
  )
  assert.match(
    body, /处失败/,
    '部分失败时的提示应含「N 处失败」—— 否则用户以为全部清干净了',
  )
  assert.match(clean, /lastResult\.partial/, '结果卡应标注失败状态')
  assert.match(clean, /lastResult\.errors/, '结果卡应列出失败明细（table + message）')
})
