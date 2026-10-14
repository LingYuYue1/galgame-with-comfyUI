import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ★ F-39 回归守卫 —— 组件卸载时必须立即 flush「挂起的去抖保存」，不能把它留给
 * setTimeout 去赌（用户拖拽后 500ms 窗口内切视图/切路由 → 未落库批次全靠环境存活）。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * 拖拽落库走 500ms 去抖：`queueSave` 把坐标放进 `pendingSaves` 并挂 `saveTimer`。
 * 而卸载路径只有 `onBeforeUnmount(onPointerUp)` ——它只收尾「进行中的拖拽」
 * （dragging 非空时补一次 queueSave），**对「已排队、等去抖到点」的批次完全不碰**：
 *   · 正常卸载（切视图/切路由）→ 挂在全局 setTimeout 上的 flush 被留下自生自灭
 *     （组件已销毁，却要等最多 500ms 才发请求——纯赌环境还活着）；
 *   · 只要环境先一步销毁（整页刷新/关闭等），这批坐标**静默丢失**；
 *   · 即便存活，也白等 500ms 才落库——用户已经离开这个视图了。
 * 修复=把 flush 从"赌定时器"变成"卸载动作的一部分"。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 * `onBeforeUnmount` 回调改为一套完整收尾：
 *   ① `onPointerUp()`  —— 收尾进行中的拖拽（其内部 queueSave 会把最后坐标入队）；
 *   ② 若 `saveTimer` 挂起 —— `clearTimeout(saveTimer)` 并**立即** `flushSaves()`。
 * 已知边界（有意不做，防扩大）：整页刷新/关闭不经过 Vue 卸载——该场景需 pagehide
 * + keepalive，属另一独立议题，如要做另行立项。
 *
 * ── 本文件（静态护栏）────────────────────────────────────────
 * 钉住 onBeforeUnmount 的匿名回调体内：① 调用 onPointerUp()；② clearTimeout(saveTimer)；
 * ③ flushSaves()。三者在同一回调里构成「收尾→取消→立即落库」的完整链条。
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

test('★ F-39：onBeforeUnmount 必须「收尾拖拽 + 取消去抖 + 立即 flush」三连', () => {
  const view = stripComments(read('components/worldmap/MapPointView.vue'))
  const m = view.match(/onBeforeUnmount\(\(\)\s*=>\s*\{([\s\S]*?)\}\)/)
  assert.ok(
    m,
    'onBeforeUnmount 应以匿名回调注册完整收尾逻辑 —— 当前若是裸传 onPointerUp，'
    + '挂起的去抖保存不会在卸载时 flush（F-39 的病）。',
  )
  const body = m[1]
  assert.match(body, /onPointerUp\(\)/, '卸载时应先收尾进行中的拖拽（onPointerUp）')
  assert.match(
    body, /clearTimeout\(saveTimer\)/,
    '卸载时应取消挂起的去抖定时器（别让 flush 依赖一个组件已销毁后还存活 500ms 的 timer）',
  )
  assert.match(
    body, /flushSaves\(\)/,
    '卸载时应立即落库（flushSaves），不能把未落库批次留在去抖窗口里',
  )
})
