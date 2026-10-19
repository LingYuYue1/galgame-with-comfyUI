/**
 * 主题文字 token 护栏（2026-10-19）
 *
 * 实锤缺陷：`--text-tertiary` 全站从来没被声明过，而 10 处 `color: var(--text-tertiary)`
 * 不带兜底值 —— 未定义的自定义属性用在 `color` 上是**无效声明**，浏览器会让它退回
 * 「继承父级颜色」。结果：本该淡一档的提示文字与正文同亮，视觉层级直接丢失，
 * 看起来像"这段样式没生效"。同类历史命名 `--text-muted` 也有 3 处无兜底。
 *
 * 守的不变量
 *   ① 凡是 `var(--text-*)` **且不带兜底值**的引用，必须在 `src` 里找得到定义；
 *   ② `tokens.css` 里每一档文字色都要在**两套主题**里各定义一次
 *      （只写暖色 = 暗夜档悄悄回落到暖色值）。
 *
 * 为什么不管带兜底的引用：`var(--text-muted, #999)` 本身就是合法降级，
 * 强行改名会动到 6 处无关视觉；这里只锁"没有兜底就一定会坏"的那一类。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** 递归收集 src 下的样式来源文件（.vue / .css / .js 里的字符串也算） */
function collectFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) collectFiles(p, out)
    else if (/\.(vue|css|js)$/.test(name)) out.push(p)
  }
  return out
}

test('★ 无兜底的 var(--text-*) 引用必须有定义（否则会静默退化成继承色）', () => {
  const files = collectFiles(SRC)
  const defined = new Set()
  const bare = new Map()

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(--text-[a-z0-9-]+)\s*:/g)) defined.add(m[1])
    // 只匹配 `var(--text-x)` —— 带逗号的 `var(--text-x, #999)` 有兜底，不进判据
    for (const m of text.matchAll(/var\(\s*(--text-[a-z0-9-]+)\s*\)/g)) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/')
      if (!bare.has(m[1])) bare.set(m[1], new Set())
      bare.get(m[1]).add(rel)
    }
  }

  const missing = [...bare].filter(([token]) => !defined.has(token))
  const detail = missing
    .map(([token, where]) => `${token} ← ${[...where].join(', ')}`)
    .join(' | ')

  assert.deepEqual(missing.map(([token]) => token), [], `以下 text token 被引用但全站没有定义：${detail}`)
})

test('★ 每一档文字色都要在暖色 / 暗夜两套主题里各定义一次', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles', 'tokens.css'), 'utf8')
  const tiers = ['--text-primary', '--text-secondary', '--text-tertiary']
  for (const tier of tiers) {
    const hits = css.match(new RegExp(`^\\s*${tier}\\s*:`, 'gm')) || []
    assert.equal(hits.length, 2, `${tier} 应在暖色与暗夜各定义一次，实际 ${hits.length} 次（当前只有两套主题；新增主题时同步改本断言）`)
  }
})
