import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ★ F-29 回归守卫 —— 橱窗「使用」不得「先带走后确认」。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `LootWindow.vue` 的 `useCell`（点格子上的「使用」）此前是**先写库再问人**：
 *   ① 立刻调 `api.takeLootItems` 把商品从橱窗带走、进背包（写库）；
 *   ② 然后才 emit 给父级弹「选角色 → 确认 → 使用」。
 * 于是用户只要在角色选择器/确认框里点了取消 —— 商品**已经静默躺在背包里**，
 * 橱窗格子已空。取消操作看起来「什么都没发生」，实际发生了一次不可见的写库；
 * 用户想换角色、或只是点错了，都得先去背包里找回商品再手动丢弃。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 *   ① 时序反转：点击「使用」只弹角色选择器（零写库）；**用户确认之后**才真正带走
 *      ——「带走」被包装成 `ensureReady` 回调，从 LootWindow 传给 BackpackModal、
 *      再由 useBackpackActions 在确认通过后调用。（延迟物化）
 *   ② 取消（✕ / 遮罩 / 确认框取消 / 带走失败）→ 一切原样：格子还在、背包零新增。
 *   ③ F-05 语义保留：带回后按**后端返回的真实状态**兜底 —— 未就绪则不进入
 *      useItem，提示等图（避免「道具尚未就绪」被拒）。图上没生成完的格子
 *      在点击时就被拦下（提示 + 不进流程），不会让用户白选角色。
 *
 * 本文件两层（沿用 F-23 模式）：
 *   ① 行为 —— 直驱 useBackpackActions，验证「确认后才物化 / 取消零副作用 /
 *      未就绪与失败分流」的完整时序；
 *   ② 接线（静态护栏）—— 钉住 LootWindow / BackpackModal / composable 的
 *      新契约，防回退到「点击即带走」。
 */

// ───────────────────────── 打桩脚手架 ─────────────────────────

/**
 * 造一个被完全打桩的 useBackpackActions：
 *  · confirm/toast 注入并可记录调用；
 *  · store.useItem 打桩，记录收到的 (itemId, characterId)。
 * 返回 { calls, actions }，calls 是跨桩的**时序数组**（confirm/ensure/useItem/toast）。
 */
async function makeCtx({ confirmResult = true } = {}) {
  setActivePinia(createPinia())
  const { useBackpackStore } = await import('../src/stores/backpack.js')
  const { useBackpackActions } = await import('../src/composables/useBackpackActions.js')

  const calls = []
  const store = useBackpackStore()
  store.useItem = async (itemId, characterId) => {
    calls.push(['useItem', itemId, characterId])
    return { ok: true, summary: '道具已使用' }
  }
  const actions = useBackpackActions({
    confirm: async () => { calls.push('confirm'); return confirmResult },
    toast: (m, t) => { calls.push(['toast', m, t]) },
  })
  return { calls, actions, store }
}

/** 橱窗来源的「虚拟 item」：id 暂时为 null，真实 id 由确认后 ensureReady 带去时取得 */
function lootVirtualItem(ensure) {
  return {
    id: null,
    name: '蕾丝连衣裙',
    kind: 'outfit',
    source_type: 'loot',
    status: 'ready',      // 点击时就绪预判已通过；真实状态由确认后的 take 结果兜底
    _ensureReady: ensure,
  }
}

const has = (calls, type) => calls.some(c => Array.isArray(c) && c[0] === type)
const onlyToasts = (calls) => calls.filter(c => Array.isArray(c) && c[0] === 'toast')

// ───────────────────────── ① 行为 ─────────────────────────

test('★ F-29①：橱窗「使用」点击只弹选择器；确认后才真正带走（confirm → 带走 → 用真实 id 使用）', async () => {
  const { calls, actions } = await makeCtx()
  const item = lootVirtualItem(async () => {
    calls.push('ensure')
    return { backpackId: 421, name: '蕾丝连衣裙', status: 'ready' }
  })

  actions.startUse(item)
  assert.equal(actions.showCharPicker.value, true, '点击「使用」应弹出角色选择器')
  assert.equal(actions.pendingItem.value?.name, item.name, '待选角色的是这件商品本身')
  assert.equal(typeof actions.pendingItem.value?._ensureReady, 'function', '延迟物化钩子须随待选项保留')
  assert.ok(
    !calls.includes('ensure'),
    '★ 弹选择器阶段不得发生任何带走（写库）—— 旧缺陷：点「使用」即刻带走，取消已无法回滚',
  )

  await actions.pickCharacter({ id: 7, display_name: '小雅' })
  assert.deepEqual(calls, [
    'confirm',
    'ensure',
    ['useItem', 421, 7],
    ['toast', '道具已使用', 'success'],
  ], '★ 时序必须是「确认 → 带走 → 用带回的真实 backpackId 使用」')
})

test('★ F-29②：确认后带回的真实状态未就绪 → 不进入 useItem，提示等图（F-05 语义保留）', async () => {
  const { calls, actions } = await makeCtx()
  const item = lootVirtualItem(async () => {
    calls.push('ensure')
    return { backpackId: 422, name: '蕾丝连衣裙', status: 'generating' }
  })

  actions.startUse(item)
  await actions.pickCharacter({ id: 7, display_name: '小雅' })

  assert.ok(!has(calls, 'useItem'), '★ 未就绪不得调用 useItem（否则重蹈 F-05：「道具尚未就绪」被后端拒绝）')
  const toasts = onlyToasts(calls)
  assert.equal(toasts.length, 1, '应有且仅有一条提示')
  assert.match(String(toasts[0][1]), /还在生成/, '提示应说明配图还在生成、完成后可在背包里使用')
  assert.equal(actions.pendingItem.value, null, '流程结束后应清理待选项')
})

test('★ F-29③：确认后带走失败（网络/后端异常）→ 不进入 useItem，明确报错', async () => {
  const { calls, actions } = await makeCtx()
  const item = lootVirtualItem(async () => { throw new Error('网络异常') })

  actions.startUse(item)
  await actions.pickCharacter({ id: 7, display_name: '小雅' })

  assert.ok(!has(calls, 'useItem'), '★ 带走失败不得继续使用（没有真实 id，目标商品也没进背包）')
  const toasts = onlyToasts(calls)
  assert.equal(toasts.length, 1)
  assert.match(String(toasts[0][1]), /网络异常/, '应把失败原因透出给用户')
  assert.equal(actions.pendingItem.value, null)
})

test('F-29④（回归守护）：取消选择（✕/遮罩）→ 零副作用，格子原样保留', async () => {
  const { calls, actions } = await makeCtx()
  const item = lootVirtualItem(async () => {
    calls.push('ensure')
    return { backpackId: 423, name: '蕾丝连衣裙', status: 'ready' }
  })

  actions.startUse(item)
  actions.cancelPick()
  await new Promise(r => setTimeout(r, 10))

  assert.deepEqual(calls, [], '★ 取消后不得有任何写库/提示 —— 除弹窗关闭外一切原样')
  assert.equal(actions.showCharPicker.value, false)
  assert.equal(actions.pendingItem.value, null)
})

test('F-29⑤（回归守护）：确认框里点取消 → 零副作用（除确认询问本身）', async () => {
  const { calls, actions } = await makeCtx({ confirmResult: false })
  const item = lootVirtualItem(async () => {
    calls.push('ensure')
    return { backpackId: 424, name: '蕾丝连衣裙', status: 'ready' }
  })

  actions.startUse(item)
  await actions.pickCharacter({ id: 7, display_name: '小雅' })

  assert.deepEqual(calls, ['confirm'], '★ 确认框取消后不得带走、不得使用 —— 旧缺陷：此时商品已静默入包')
  assert.equal(actions.pendingItem.value, null)
})

// ───────────────────────── ② 接线（静态护栏）─────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 去掉注释，避免匹配到说明文字（F-21 沉淀：守卫只该查代码，不查注释） */
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

test('★ F-29（接线）：LootWindow 点「使用」不得直接带走；须以 ensureReady 延迟到确认之后', () => {
  const loot = stripComments(read('components/LootWindow.vue'))

  const useCell = extractFnBody(loot, 'useCell')
  assert.ok(useCell, '未找到 useCell')
  assert.ok(
    !/api\.takeLootItems\s*\(/.test(useCell),
    '★ useCell 内不得直接调 takeLootItems —— 「点击即带走」正是旧缺陷本体',
  )
  assert.match(useCell, /ensureReady/, 'useCell 须把「带走」包装成 ensureReady 回调交给父级（确认后才执行）')
  assert.match(useCell, /isCellReady\(/, 'useCell 须含就绪预判（图上没好时不进入使用流程）')
  assert.match(useCell, /emit\(\s*'use'/, 'useCell 须以 emit(\'use\') 请求父级进入使用流程')

  const take = extractFnBody(loot, 'takeCellForUse')
  assert.ok(take, '未找到 takeCellForUse（ensureReady 的落地实现）')
  assert.match(take, /api\.takeLootItems\s*\(/, 'takeCellForUse 须真正执行「带走」')
  assert.match(take, /emit\(\s*'taken'/, 'takeCellForUse 成功后须通知父级（刷新背包列表）')
  assert.match(take, /usingSlot/, 'takeCellForUse 须管理进行中状态（按钮 loading / 防重复点击）')

  const ready = extractFnBody(loot, 'isCellReady')
  assert.ok(ready, '未找到 isCellReady 就绪预判')
  assert.match(ready, /imageUrl/, '就绪预判：已有图')
  assert.match(ready, /needsImage/, '就绪预判：这类条目本就不需要图（与后端 takeItems 判定同口径）')
})

test('★ F-29（接线）：onLootUse 须把 ensureReady 透传进使用流程（不再依赖「已带走」）', () => {
  // ★ F-30 后：onLootUse 从 BackpackModal 上移到 useBackpackActions（桌面/移动端共享），
  //   本守卫随之改查 composable 的实现 + 弹窗侧的消费，行为要求不变。
  const comp = stripComments(read('composables/useBackpackActions.js'))
  const onLootUse = extractFnBody(comp, 'onLootUse')
  assert.ok(onLootUse, '未找到 onLootUse（F-30 上移后应在 useBackpackActions 内）')
  assert.match(
    onLootUse,
    /_ensureReady/,
    'onLootUse 须把 ensureReady 放进 startUse 的 item（_ensureReady），供确认后调用',
  )
  assert.ok(
    !/takeLootItems/.test(onLootUse),
    'onLootUse 不得自己发起带走（带走由 LootWindow 的实现负责、由 composable 决定时机）',
  )

  const modal = stripComments(read('components/BackpackModal.vue'))
  assert.match(modal, /onLootUse/, 'BackpackModal 须消费共享接线（从解构中取得 onLootUse）')
})

test('★ F-29（接线）：pickCharacter 须在确认后才物化（_ensureReady 先于 useItem 且失败/未就绪有分流）', () => {
  const comp = stripComments(read('composables/useBackpackActions.js'))
  const pick = extractFnBody(comp, 'pickCharacter')
  assert.ok(pick, '未找到 pickCharacter')

  assert.match(pick, /_ensureReady/, 'pickCharacter 须支持橱窗来源的延迟物化（确认后、useItem 前调用）')
  const idxEnsure = pick.indexOf('_ensureReady')
  const idxUseItem = pick.indexOf('store.useItem(')
  assert.ok(idxEnsure >= 0 && idxUseItem >= 0 && idxEnsure < idxUseItem, '★ 物化（带走）必须发生在 useItem 之前')
  assert.match(pick, /!==\s*'ready'/, '物化结果非 ready 时须分流（F-05 语义：不进入 useItem、提示等图）')
})
