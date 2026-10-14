/**
 * F-25 护栏：「删除形象」按钮在**兜底态**下不得出现。
 *
 * 背景：work（常服）槽没有显式立绘时，后端用 `characters.standing_url` 兜底显示
 * （`listSceneStandings` 返回 `is_fallback: true`）。此时「删除形象」删的是**显式记录**——
 * 本就不存在 → 后端 0 行删除仍无条件返回 `ok:true` → 前端照样 toast「形象已删除」＝**假成功**。
 * 后端早已返回 `is_fallback` 标记，而前端此前 0 处消费（入口没接上）。
 *
 * 本例钉住两件事：
 *   ① 纯函数判定：**有图且非兜底**才可删；
 *   ② 接线：弹窗把 `canRemove` 放进面板接口、面板用它做按钮 `v-if`（不得退回只看 displayUrl）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { canRemoveSceneStanding } from '../src/utils/standingRemovable.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PANEL = readFileSync(resolve(__dirname, '../src/components/CharacterStandingPanel.vue'), 'utf8')
const MODAL = readFileSync(resolve(__dirname, '../src/components/CharacterDetailModal.vue'), 'utf8')
const UTIL = readFileSync(resolve(__dirname, '../src/utils/standingRemovable.js'), 'utf8')

test('F-25 判定：有图且非兜底 → 可删', () => {
  assert.equal(canRemoveSceneStanding({ image_url: '/images/a.png', is_fallback: false }), true)
})

test('F-25 判定：兜底图（is_fallback:true）→ 不可删（否则点了报"已删除"却无变化）', () => {
  assert.equal(canRemoveSceneStanding({ image_url: '/images/a.png', is_fallback: true }), false)
})

test('F-25 判定：无图 / 空值 → 不可删', () => {
  assert.equal(canRemoveSceneStanding({ image_url: '', is_fallback: false }), false)
  assert.equal(canRemoveSceneStanding({ image_url: null, is_fallback: true }), false)
  assert.equal(canRemoveSceneStanding(null), false)
  assert.equal(canRemoveSceneStanding(undefined), false)
})

test('F-25 接线：面板「删除形象」按钮 v-if 用 canRemove，不得退回只看 displayUrl', () => {
  assert.match(PANEL, /v-if="ctl\.canRemove"[\s\S]{0,200}@click="ctl\.remove"/, '按钮应绑 ctl.canRemove')
  assert.doesNotMatch(PANEL, /v-if="ctl\.displayUrl"[\s\S]{0,200}@click="ctl\.remove"/, '不得退回只看 displayUrl')
})

test('F-25 接线：弹窗 standingPanel 暴露 canRemove；判定实现消费后端 is_fallback', () => {
  assert.match(MODAL, /canRemove:\s*currentSceneRemovable/, 'standingPanel 的 canRemove 必须来自可删判定 computed')
  assert.match(UTIL, /is_fallback/, '判定实现必须消费后端 is_fallback 标记')
})
