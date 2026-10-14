import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGeneration } from '../src/utils/loadGeneration.js'

/**
 * ★ F-22 回归守卫 —— 详情弹窗的「异步加载竞态」。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * CharacterDetailModal 一次打开会**并发**发起好几个异步请求
 * （场景服装 / 场景立绘 / 外观列表 / 关系网）。若用户在请求飞行途中**切到另一个角色**，
 * 先发出的那批响应会**迟到**回来，把新角色的界面数据覆盖成旧角色的。
 * 更糟的是此刻 `detail.dirty` 已是新角色的，于是「保存」有可能把 A 的外观**写进 B**（写库事故）。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 * 「世代号」守卫：每次发起一批新加载先取新世代，异步响应回来后校验是否仍属当前世代，
 * 不是就丢弃。世代号单调递增，旧世代的响应永远不可能再等于当前值，天然自废。
 *
 * 本文件两部分：
 *   ① 行为 —— 用一个假 api + 假延迟，完整复现「A 慢、B 快，A 先回来」的竞态，
 *      验证**带守卫**时最终是 B、**不带守卫**时确实被 A 覆盖（反证守卫的必要性）。
 *   ② 接线 —— 静态钉住 CharacterDetailModal 的三个加载函数确实用了世代校验，防回退。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEBUI = path.resolve(HERE, '..')
const DETAIL = path.join(WEBUI, 'src', 'components', 'CharacterDetailModal.vue')

// ───────────────────────── ① 行为 ─────────────────────────

test('F-22：新世代作废旧世代（后发先至不得覆盖）', () => {
  const g = createGeneration()
  const genA = g.next() // 打开角色 A，发起加载
  const genB = g.next() // 用户在 A 响应前切到 B，发起加载
  assert.equal(g.isCurrent(genB), true, 'B 的响应有效')
  assert.equal(g.isCurrent(genA), false, '★ A 的迟到响应必须被丢弃（否则会把 A 写进 B 的界面）')
})

test('F-22：同一世代内可重复判定为有效', () => {
  const g = createGeneration()
  const gen = g.next()
  assert.equal(g.isCurrent(gen), true)
  assert.equal(g.isCurrent(gen), true, '同一世代可重复判定')
  assert.equal(g.current(), gen)
})

test('F-22：next 单调递增，旧号永不复用', () => {
  const g = createGeneration()
  const seq = [g.next(), g.next(), g.next()]
  assert.deepEqual(seq, [1, 2, 3], '世代号应单调递增')
  assert.equal(g.isCurrent(seq[0]), false)
  assert.equal(g.isCurrent(seq[1]), false)
  assert.equal(g.isCurrent(seq[2]), true)
})

test('F-22：完整竞态链 —— A 的迟到响应不得污染 B 的状态（带守卫）', async () => {
  const g = createGeneration()
  const ui = { characterId: null, outfits: [] }
  const fakeApi = {
    // A 慢（60ms），B 快（5ms）→ A 的响应「后发但先……不，是先发后到」
    list: (id) => new Promise((r) => setTimeout(() => r(['outfit-of-' + id]), id === 'A' ? 60 : 5)),
  }
  async function load(id) {
    const gen = g.next()
    ui.characterId = id
    ui.outfits = [] // 切角色时先清空，避免旧数据残留
    const list = await fakeApi.list(id)
    if (!g.isCurrent(gen)) return // ★ 迟到的旧世代响应被丢弃
    ui.outfits = list
  }
  await Promise.all([load('A'), load('B')])
  assert.equal(ui.characterId, 'B')
  assert.deepEqual(ui.outfits, ['outfit-of-B'], '最终必须显示 B 的外观，A 的迟到响应不得覆盖')
})

test('F-22：反证 —— 无守卫时确实会被迟到响应覆盖', async () => {
  const ui = { outfits: [] }
  const fakeApi = {
    list: (id) => new Promise((r) => setTimeout(() => r(['outfit-of-' + id]), id === 'A' ? 60 : 5)),
  }
  async function load(id) {
    const list = await fakeApi.list(id)
    ui.outfits = list // 直接写，无世代校验
  }
  await Promise.all([load('A'), load('B')])
  assert.deepEqual(ui.outfits, ['outfit-of-A'], '无守卫时被先发出的 A 覆盖 —— 这正是要修的病')
})

// ───────────────────────── ② 接线（静态护栏）─────────────────────────

/** 去掉注释，避免匹配到说明文字 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 从源码里抠出一个具名函数的函数体（含花括号），用于检查其内部实现 */
function extractFnBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) return null
  const brace = src.indexOf('{', m.index + m[0].length)
  let depth = 0
  for (let j = brace; j < src.length; j++) {
    const ch = src[j]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(brace, j + 1) }
  }
  return null
}

test('★ F-22：CharacterDetailModal 的详情加载必须带「世代」防竞态校验', () => {
  const src = stripComments(fs.readFileSync(DETAIL, 'utf8'))

  // ① 引入世代守卫
  assert.match(src, /createGeneration/, '组件应引入 createGeneration 世代守卫（utils/loadGeneration.js）')

  // ② init 每次打开/切角色都取新世代
  const initBody = extractFnBody(src, 'init')
  assert.ok(initBody, '未找到 init 函数')
  assert.match(initBody, /detailLoadGen\.next\(\)/, 'init 必须先取新世代（使上一角色的未决请求自废）')

  // ③ 三个会写界面数据的加载函数，await 之后必须校验世代
  for (const fn of ['loadSceneOutfits', 'loadSceneStandings', 'fetchOutfits']) {
    const body = extractFnBody(src, fn)
    assert.ok(body, `未找到 ${fn} 函数`)
    assert.match(
      body,
      /isCurrent\(/,
      `${fn} 必须在异步响应写入前校验世代（isCurrent），否则迟到响应会覆盖新角色的数据`
    )
  }
})
