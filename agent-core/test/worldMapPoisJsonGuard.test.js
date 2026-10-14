/**
 * F-36 回归守卫：`pois_json` 为字面量 'null'（或其它非数组 JSON）时，出口必须归一为数组。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `safeParse(s, fallback)` 只在 `JSON.parse` **抛错**时用 fallback；而 `'null'` 是
 * **合法 JSON**（解析成功得 null）→ 返回 null 而不是 []。于是 `mapPlaceRow` 的
 * `pois: safeParse(r.pois_json, [])` 在存量脏数据（pois_json='null'）上把 null 泄给下游：
 *   · `getMap().stats` 的 `p.pois.length` 直接 TypeError —— 整张地图 500；
 *   · 前端收到 `pois: null`（不是数组）——渲染按数组预期。
 * 同文件 `expandPois` 两处已有 `(safeParse(...) || [])` 兜底（**准护栏**——挡 null 但挡不住
 * `123` / `'x'` / `{}` 这类"真值非数组"），`mapPlaceRow` 是漏网的那处。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 * 加 `asArray(v)`（`Array.isArray(v) ? v : []`）把「兜底」升级为「严格兜底」，
 * 四处消费统一：`mapPlaceRow` 出口 / `upsertPlace` 读改写回 / `expandPois` 两处名单。
 *
 * 本文件钉住：①'null' 行不炸且 pois=[]；②'123'/'"abc"' 这类真值非数组也不计入 stats；
 * ③读改写回把脏值洗成 '[]'；④四处的 asArray 接线（静态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = path.join(os.tmpdir(), `linshe-f36-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP
globalThis.fetch = async url => { throw new Error(`f36 test forbids network: ${url}`); }

const { getDb } = await import('../src/db/index.js')
const { addPlace, upsertPlace, getMap } = await import('../src/services/worldMapService.js')

const db = getDb()
db.prepare('INSERT INTO world_maps (id, name) VALUES (?, ?)').run(9101, 'F36 测试图')

/** 造一行 pois_json 为指定字面量的地点（模拟存量脏数据） */
function makeDirtyPlace(name, rawJson) {
  const r = addPlace(9101, { name })
  db.prepare('UPDATE world_map_places SET pois_json = ? WHERE id = ?').run(rawJson, r.place.id)
  return r.place.id
}

test('F-36 ①：pois_json=「null」——getMap 不得抛错，pois 归一为 []', () => {
  const id = makeDirtyPlace('脏数据null', 'null')
  const m = getMap(9101)   // 修复前：stats 里 p.pois.length → TypeError，整个 getMap 抛
  const hit = m.places.find(p => p.id === id)
  assert.ok(hit, '地点应在返回里')
  assert.deepEqual(hit.pois, [], "pois 必须是数组（'null' 解析成功得 null，不能直接泄出去）")
  assert.equal(m.stats.poi, 0, 'stats 的 POI 计数不应把 null 算炸')
})

test('F-36 ②：真值非数组（123 / "abc" / {}）也不得计入 stats（证明必须是 Array.isArray，`|| []` 不够）', () => {
  const idNum = makeDirtyPlace('脏数据123', '123')
  const idStr = makeDirtyPlace('脏数据字符串', '"abc"')
  const idObj = makeDirtyPlace('脏数据对象', '{"a":1}')
  const m = getMap(9101)
  // 修复前：'123' → p.pois.length 为 undefined → reduce 出 NaN；'"abc"' → length=3 误计
  assert.equal(m.stats.poi, 0, '非数组 JSON 一律不计入 POI 总数')
  for (const id of [idNum, idStr, idObj]) {
    assert.deepEqual(m.places.find(p => p.id === id)?.pois, [], `地点 ${id} 的 pois 应为 []`)
  }
})

test('F-36 ③：读改写回把脏值洗成合法数组（「null」→「[]」）', () => {
  const id = makeDirtyPlace('脏数据洗回', 'null')
  upsertPlace(id, { summary: '只改简介' })
  const row = db.prepare('SELECT pois_json FROM world_map_places WHERE id = ?').get(id)
  assert.equal(row.pois_json, '[]', "保存其它字段时，脏的 'null' 应被归一写回为 '[]'")
})

test('F-36 ④（静态）：四处消费统一走 asArray（严格兜底）', () => {
  const svc = fs.readFileSync(fileURLToPath(new URL('../src/services/worldMapService.js', import.meta.url)), 'utf8')
  assert.match(svc, /function asArray\(/, '应存在 asArray 辅助（Array.isArray ? v : []）')
  assert.match(svc, /pois: asArray\(safeParse\(r\.pois_json, \[\]\)\)/, 'mapPlaceRow 出口应走 asArray')
  assert.match(svc, /normalizePois\(patch\.pois\) : asArray\(safeParse\(cur\.pois_json, \[\]\)\)/, 'upsertPlace 读回应走 asArray')
  assert.match(svc, /\.\.\.asArray\(safeParse\(place\.pois_json, \[\]\)\)\.map/, 'expandPois 己方名单应走 asArray')
  assert.match(svc, /\.flatMap\(r => asArray\(safeParse\(r\.pois_json, \[\]\)\)\.map/, 'expandPois 兄弟名单应走 asArray')
})
