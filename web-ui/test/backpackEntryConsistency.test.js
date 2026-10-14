import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ★ F-30 回归守卫 —— 宝箱入口两端不一致。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * 「背包」有两个入口，各自是**两套玩法**：
 *  · 桌面（酒馆页背包卡 → BackpackModal）：`SHOW_CHEST=false` 宝箱**整体隐藏**
 *    （2026-10-04 起的决策注释：「宝箱已被『橱窗』取代」），内容区是「背包 / 橱窗」两个 tab；
 *  · 移动（侧栏「更多」→ `/backpack` → BackpackView 整页）：还停在宝箱时代 ——
 *    宝箱当主入口（就绪大卡 + 顶栏冷却计时 + 开箱演出），**没有橱窗入口**。
 * 同一功能在两处体验割裂：移动端根本玩不到橱窗（当前核心玩法）。
 *
 * ── 定性（意图考古三层）──────────────────────────────────────
 *  ① `BackpackModal` 的 `SHOW_CHEST` 注释自声明「宝箱已被橱窗取代、故默认隐藏」
 *     ——「取代」是有意决策，且没有任何注释为「移动端保留宝箱」辩护；
 *  ② `useBackpackActions` 头注释自声明「BackpackModal（酒馆桌面弹窗）与
 *     BackpackView（移动端整页）**共享**」——两处本就该同体验；`LootWindow` 自包含可复用；
 *  ③ `git log -S`：`BackpackView` 来自更早的 `a4229b6`（手机端背包页适配）；
 *     橱窗/隐藏宝箱随 `28e94d0`（并入 Pr/1~Pr/6）进来时，对 BackpackView 的改动
 *     **只有一句冷却文案**（`bp-chest-hint`）——桌面改造时移动端没跟上（改一处漏一处）。
 *  → 「意图存在（两端一致）、未达成」，**可修**。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 *  ① 移动端同口径：`SHOW_CHEST=false` 隐藏宝箱（大卡 / 顶栏计时 / 开箱演出三面都约束）；
 *  ② 移动端接入「橱窗」：与桌面同款「背包 / 橱窗」视图切换 + 复用同一套接线；
 *  ③ 橱窗接线升为**共享能力**：`onLootTaken` / `onLootUse` 从 useBackpackActions 出，
 *     两端只消费、不重写（F-29 的「延迟物化」时序因此天然两端一致）；
 *  ④ 空态文案不再引导去已隐藏的「宝箱」。
 *
 * 本文件两层：① 行为（composable 的共享橱窗接线）；② 接线（两端静态护栏）。
 */

// ───────────────────────── 打桩脚手架 ─────────────────────────

async function makeCtx() {
  setActivePinia(createPinia())
  const { useBackpackStore } = await import('../src/stores/backpack.js')
  const { useBackpackActions } = await import('../src/composables/useBackpackActions.js')
  const store = useBackpackStore()
  const actions = useBackpackActions({ confirm: async () => true, toast: () => {} })
  return { store, actions }
}

// ───────────────────────── ① 行为 ─────────────────────────

test('★ F-30①：橱窗接线升为共享能力 —— onLootTaken / onLootUse 由 useBackpackActions 提供', async () => {
  const { actions } = await makeCtx()
  assert.equal(typeof actions.onLootTaken, 'function', '应导出 onLootTaken（带走后刷新背包）')
  assert.equal(typeof actions.onLootUse, 'function', '应导出 onLootUse（橱窗点使用）')

  // onLootTaken：橱窗带走了商品 → 刷新背包列表
  let fetched = 0
  actions.store.fetchItems = async () => { fetched++ }
  actions.onLootTaken()
  assert.equal(fetched, 1, 'onLootTaken 应触发一次背包刷新')

  // onLootUse：进入「选角色」流程；商品**尚未带走**（F-29 时序）；携带延迟物化钩子
  let ensured = 0
  actions.onLootUse({
    name: '蕾丝连衣裙', kind: 'outfit',
    ensureReady: async () => { ensured++; return { backpackId: 7, name: '蕾丝连衣裙', status: 'ready' } },
  })
  assert.equal(actions.showCharPicker.value, true, 'onLootUse 应进入选角色流程')
  assert.equal(actions.pendingItem.value?.name, '蕾丝连衣裙')
  assert.equal(actions.pendingItem.value?.status, 'ready', '点击时已预判就绪（真实状态由确认后兜底）')
  assert.equal(typeof actions.pendingItem.value?._ensureReady, 'function', '必须携带 F-29 的延迟物化钩子')
  assert.equal(ensured, 0, '★ 弹选择器阶段不得带走（F-29：确认之后才写库）')
  actions.cancelPick()
})

// ───────────────────────── ② 接线（静态护栏）─────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 去掉注释，避免匹配到说明文字（F-21 沉淀：守卫只该查代码，不查注释） */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('★ F-30②：移动端整页与桌面同口径 —— 宝箱三面（大卡/计时/演出）都受 SHOW_CHEST 约束', () => {
  const modal = stripComments(read('components/BackpackModal.vue'))
  const view = stripComments(read('views/BackpackView.vue'))

  assert.match(modal, /const SHOW_CHEST = false/, '桌面：宝箱被橱窗取代（既有决策，保护不回归）')
  assert.match(view, /const SHOW_CHEST = false/, '★ 移动端必须同口径：宝箱同样被橱窗取代')

  assert.match(view, /v-if="SHOW_CHEST && store\.chest\.canOpen"/, '宝箱大卡须受 SHOW_CHEST 约束')
  assert.match(view, /v-if="SHOW_CHEST && !store\.chest\.canOpen"/, '顶栏冷却计时须受 SHOW_CHEST 约束')
  assert.match(view, /<ChestRevealOverlay\s+v-if="SHOW_CHEST"/, '开箱演出层须受 SHOW_CHEST 约束')
})

test('★ F-30③：移动端接入「橱窗」—— 同款视图切换 + 只消费共享接线、不重写', () => {
  const view = stripComments(read('views/BackpackView.vue'))

  assert.match(view, /import LootWindow from '\.\.\/components\/LootWindow\.vue'/, '移动端须引入橱窗组件')
  assert.match(view, /<LootWindow[\s\S]{0,240}@taken="onLootTaken"[\s\S]{0,240}@use="onLootUse"/, '橱窗须接上 taken/use 接线')

  assert.match(view, /const \{[\s\S]*?onLootTaken[\s\S]*?\} = useBackpackActions\(/, '接线须来自共享 composable（解构取得）')
  assert.ok(!/function onLootTaken|function onLootUse/.test(view), '不得本地重写（两端必须同源，后续修复自动两端生效）')

  assert.match(view, /LinsheTabs/, '须有「背包 / 橱窗」视图切换（与桌面同款心智）')
})

test('★ F-30④：两端空态文案不得再引导去「宝箱」（入口已隐藏，残留文案是误导）', () => {
  const modal = stripComments(read('components/BackpackModal.vue'))
  const view = stripComments(read('views/BackpackView.vue'))

  assert.ok(!modal.includes('去左边的宝箱看看吧'), '桌面空态残留：宝箱已隐藏，不得再引导去左边')
  assert.ok(!view.includes('去上面的宝箱看看吧'), '移动端空态残留：宝箱已隐藏，不得再引导去上面')
  assert.ok(!view.includes('宝箱冷却中，就绪后再来看看吧'), '移动端空态残留：宝箱已隐藏，不得再提宝箱冷却')
})
