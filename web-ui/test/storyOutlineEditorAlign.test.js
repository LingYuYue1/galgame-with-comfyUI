import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// F-50 护栏（2026-10-14）：大纲编辑器的「节点 ↔ 原文块」配对必须走服务端下发的
// rawIndex —— raw 里可能存在要素不全的残缺块（如被清空 Scene 的节点，会被解析
// 过滤、不在 beats 里），前端若按 blocks[i] 下标直配，从残缺块起会整体错位：
// 后续节点拿到别人的原文块，往返保存时把别人的块写到自己位置、原文丢失。
//
// 防回退：loadEditor 不得再出现 blocks[i] 式的下标直配（须为 blocks[b?.rawIndex ?? i]）。

const FILE = fileURLToPath(new URL('../src/components/story/StoryOutlineEditorModal.vue', import.meta.url))

test('F-50：loadEditor 按 rawIndex 取块（不得退回下标直配）', () => {
  const src = fs.readFileSync(FILE, 'utf8')
  assert.match(
    src,
    /blocks\[b\?\.rawIndex \?\? i\]/,
    '必须按 rawIndex 配对（带旧服务端回落 i）'
  )
  assert.ok(
    !/blocks\[i\] \|\| ''\)/.test(src),
    '不得再按下标直配 blocks[i]（残缺块存在时会整体错位）'
  )
})
