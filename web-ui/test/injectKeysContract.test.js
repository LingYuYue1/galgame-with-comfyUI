import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// F-06 护栏（2026-10-12）：全仓 provide / inject 键名配对契约。
//
// 背景：`Gallery.vue` 曾把 `inject('confirm')` 写成 `inject('confirmFn')`
// （应用全局 provide 的是 'confirm'）—— 恒注入不到、拿到 null，
// 多选删除静默回落到浏览器原生 confirm。这类「键名拼错」编译不报错、运行不抛错，
// 只能靠人工发现；本测试把「inject ⊆ provide」变成可自动校验的契约。
//
// 规则：src/ 下所有 `provide('key'` 与 `inject('key'`（单双引号均可）——
//   ① 每个被 inject 的键都必须有对应 provide（拼错即失败，附文件:行号）；
//   ② provide 了但没人 inject 的键仅打印提示、不失败（可能是预留能力）。

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(vue|js)$/.test(e.name)) out.push(p)
  }
  return out
}

function collect() {
  const provided = new Map()   // key -> [relative file]
  const injected = new Map()   // key -> ['relative file:line']
  const reProvide = /provide\(\s*['"]([^'"]+)['"]/g
  const reInject = /inject\(\s*['"]([^'"]+)['"]/g
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f).replace(/\\/g, '/')
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const m of line.matchAll(reProvide)) {
        if (!provided.has(m[1])) provided.set(m[1], [])
        provided.get(m[1]).push(`${rel}:${i + 1}`)
      }
      for (const m of line.matchAll(reInject)) {
        if (!injected.has(m[1])) injected.set(m[1], [])
        injected.get(m[1]).push(`${rel}:${i + 1}`)
      }
    })
  }
  return { provided, injected }
}

const { provided, injected } = collect()

test('★ F-06 护栏：所有 inject 的键名都有对应的 provide（无拼写孤例）', () => {
  const orphans = []
  for (const [key, locs] of injected) {
    if (!provided.has(key)) orphans.push(`  '${key}' ← ${locs.join(', ')}`)
  }
  assert.equal(
    orphans.length, 0,
    `发现 inject 了但全仓无 provide 的键名（拼写疑似错误）：\n${orphans.join('\n')}`
  )
})

test('契约自检：扫描确实工作（能扫到已知的 confirm / toast）', () => {
  assert.ok(injected.has('confirm'), '应扫到 confirm 的 inject 点');
  assert.ok(provided.has('confirm'), '应扫到 confirm 的 provide 点');
  assert.ok(injected.has('toast'), '应扫到 toast 的 inject 点');
  // 反向提示（不判失败）：provide 但未 inject —— 预留能力，改了记得同步
  const idle = [...provided.keys()].filter(k => !injected.has(k))
  if (idle.length) console.log(`[契约] provide 但暂无 inject 的键（预留/待接线）：${idle.join(', ')}`);
})
