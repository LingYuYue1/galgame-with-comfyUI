import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileTemplate } from '@vue/compiler-sfc'

// F-08 回归（2026-10-12）：NewspaperModal 的「加载骨架 / 还没印好」门只应存在一份。
//
// 背景：模板里曾有两组**完全重复**的 `v-if="loading"` / `v-else-if="!paper"` 块 ——
// loading 时两个骨架同时进 DOM 叠着；且 `article v-else` 挂在第二组链上，
// 修改时若删错位置，v-else 会失去前驱（编译报错）。本测试用真实 SFC 编译器钉住结构。

const src = readFileSync(new URL('../src/components/NewspaperModal.vue', import.meta.url), 'utf8')
const { descriptor } = parse(src)
const template = descriptor.template.content

test('★ F-08①：loading / empty 门各只出现一次（无重复块）', () => {
  // 一组门 = loading 门 + empty 门，共 2 个 np-gate；重复块修复前是 4 个
  const gates = template.match(/class="np-gate"/g) || []
  assert.equal(gates.length, 2, `np-gate 应为 2（loading 门 + empty 门各一），实际 ${gates.length}（多于 2 = 存在重复块）`)
  const loadings = template.match(/v-if="loading"/g) || []
  assert.equal(loadings.length, 1, 'v-if="loading" 应只出现 1 次')
  const empties = template.match(/v-else-if="!paper"/g) || []
  assert.equal(empties.length, 1, 'v-else-if="!paper" 应只出现 1 次')
  const skLine = template.match(/np-sk-line/g) || []
  assert.equal(skLine.length, 1, '骨架应只有一份（修复前为 2 份）')
  const skBlock = template.match(/np-sk-block/g) || []
  assert.equal(skBlock.length, 2, '骨架应只有一份（2 个 block；修复前为 4 个）')
})

test('★ F-08②：模板可编译（v-else 链完整、无悬挂）', () => {
  const r = compileTemplate({ source: template, filename: 'NewspaperModal.vue', id: 'f08' })
  assert.equal(r.errors.length, 0, `模板编译错误：${r.errors.map(e => e.message || String(e)).join('; ')}`)
})
