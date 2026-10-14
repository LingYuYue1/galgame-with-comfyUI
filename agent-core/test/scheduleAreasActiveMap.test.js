/**
 * F-37 回归守卫：`listAreasForSchedule` 未显式传 mapId 时，必须取「玩家当前所在地图」
 * （town_players.map_id，DB 真源），而不是「最新创建的地图」（listMaps()[0]）。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `listMaps()` 是 `ORDER BY m.id DESC`，`[0]` 恒为**最新创建**的图。而日程链路有三处
 * **不显式传 mapId**（ScheduleView 弹窗 GET regenerate-options 传 undefined、
 * regenerate 请求体不带、台账 buildLedgerCtx 不传参），于是玩家在 A 图（先建）活动、
 * 之后又建了 B 图时：
 *   · 日程弹窗列出的是 B 图的区域（用户感知「这不是我现在这张图」）；
 *   · 生成日程按 B 图的地点/准入/通勤——角色日程排的全是另一张图的地点；
 *   · 台账拿 B 图的受限名单审计 A 图日程——误报/漏报。
 * 三处同病根：默认解析取了「最新图」，而不是「当前图」。
 *
 * ── 三层意图考古（结论：意图存在但入口没接上 = 可修）────────
 * ① 注释自声明：函数注释只说「日程弹窗与注入共用」，未声明"默认取最新图"；
 * ② 相邻链路：`town_players.map_id` 的 schema 注释明言「玩家当前所在地图（聚焦口径的
 *    权威来源）」，`townBuildingFeatureRuntime.currentMapId()` 等已在消费该概念——
 *    「当前地图」语义在仓库里是第一等公民，只是日程链路没接上；
 * ③ git 溯源：`28e94d0`（Pr/1~Pr/6 合并）引入本文件，`listMaps()[0]` 是"先跑起来"
 *    的顺手写法，无历史纠葛。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 * `resolveDefaultMapId()`：先读 `town_players.map_id`，**校验该图仍存在**后使用；
 * 取不到/图已删时回退旧行为 `listMaps()[0]`。不 import townService——那是运行时内存态
 * 且有模块耦合；同库直读 DB 零新耦合（本文件本来就用 getDb）。
 *
 * 本文件钉住：①玩家在 A（先建）、B（后建）时默认返回 A；②显式传参优先于默认；
 * ③无 town 数据时保持旧兜底（最新图）；④当前图指针失效时不哑掉、回退最新图；
 * ⑤静态：默认解析接线（resolveDefaultMapId 含 town_players 查询与存在性校验）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = path.join(os.tmpdir(), `linshe-f37-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP
globalThis.fetch = async url => { throw new Error(`f37 test forbids network: ${url}`); }

const { getDb } = await import('../src/db/index.js')
const { createMap, addPlace, listAreasForSchedule } = await import('../src/services/worldMapService.js')

const db = getDb()

// ── 数据搭建：A 先建（玩家所在地图），B 后建（「最新图」陷阱）──
const A = createMap({ name: 'F37-地图A' })
const B = createMap({ name: 'F37-地图B' })
assert.ok(A.id < B.id, '前置：B 必须是后建（id 更大 = listMaps()[0] 的最新区）')

const rA = addPlace(A.id, { name: '雾都' })
const dA = addPlace(A.id, { parentId: rA.place.id, name: '时钟塔区' })
addPlace(A.id, { parentId: dA.place.id, name: '钟楼的表盘', scenePrompt: '指针停摆的钟楼表盘' })

const rB = addPlace(B.id, { name: '海湾城' })
const dB = addPlace(B.id, { parentId: rB.place.id, name: '栈桥区' })
addPlace(B.id, { parentId: dB.place.id, name: '灯塔咖啡', scenePrompt: '临海灯塔下的咖啡馆' })

/** 设置/清空「玩家当前所在地图」（town_players 单行，id='me'） */
function setPlayerMap(mapId) {
  db.prepare("DELETE FROM town_players WHERE id = 'me'").run()
  if (mapId != null) {
    db.prepare("INSERT INTO town_players (id, display_name, map_id) VALUES ('me', '测试玩家', ?)").run(mapId)
  }
}

test('F-37 ①：玩家在 A（先建）、另有后建 B —— 默认必须返回 A（当前图），而不是 B（最新图）', () => {
  setPlayerMap(A.id)
  const res = listAreasForSchedule()
  // 修复前：走 listMaps()[0] → 返回 B（「最新图」陷阱，先红点）
  assert.equal(res.mapId, A.id, '默认应取「玩家当前所在地图」，而不是 listMaps()[0]（最新建图）')
  assert.equal(res.mapName, 'F37-地图A', '地图名应随 mapId 一同返回')
  assert.deepEqual(res.areas.map(a => a.name), ['时钟塔区'], '区域清单应来自 A 图')
  assert.ok(!res.areas.some(a => a.name === '栈桥区'), '不得混入 B 图的区域')
})

test('F-37 ②：显式传 mapId 优先于「当前图」——传 B 就返回 B（即便玩家在 A）', () => {
  setPlayerMap(A.id)
  const res = listAreasForSchedule(B.id)
  assert.equal(res.mapId, B.id, '显式传参是调用方意图，不得被当前图覆盖')
  assert.deepEqual(res.areas.map(a => a.name), ['栈桥区'], '区域清单应来自显式传入的 B 图')
})

test('F-37 ③：无小镇数据（town_players 无行）—— 保持旧兜底（最新图），不回归为空', () => {
  setPlayerMap(null)
  const res = listAreasForSchedule()
  assert.equal(res.mapId, B.id, '没有「当前图」信息时应回退旧行为 listMaps()[0]（最新图）')
  assert.deepEqual(res.areas.map(a => a.name), ['栈桥区'])
})

test('F-37 ④：当前图指针指向已删除的地图 —— 不得哑掉，回退最新图', () => {
  setPlayerMap(99999)   // 不存在的地图 id（模拟地图被删后指针未清）
  const res = listAreasForSchedule()
  assert.equal(res.mapId, B.id, '当前图已删时应回退 listMaps()[0]，而不是返回空或错图')
})

test('F-37 ⑤（静态）：默认解析走 resolveDefaultMapId（含 town_players 查询与存在性校验）', () => {
  const svc = fs.readFileSync(fileURLToPath(new URL('../src/services/worldMapService.js', import.meta.url)), 'utf8')
  assert.match(svc, /function resolveDefaultMapId\(/, '应存在 resolveDefaultMapId 辅助')
  const body = svc.match(/function resolveDefaultMapId\([\s\S]*?\n\}/)?.[0] || ''
  assert.match(body, /town_players/, '默认解析应读 town_players.map_id（当前图真源）')
  assert.match(body, /world_maps WHERE id/, '应校验当前图仍存在（地图可能已被删）')
  const listBody = svc.match(/function listAreasForSchedule\([\s\S]*?\n\}/)?.[0] || ''
  assert.match(listBody, /resolveDefaultMapId\(/, 'listAreasForSchedule 的默认兜底应调用 resolveDefaultMapId')
})
