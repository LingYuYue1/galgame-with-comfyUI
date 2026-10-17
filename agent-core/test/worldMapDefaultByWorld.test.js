/**
 * 星图 T14 —— 默认地图按「角色所在世界」解析。
 *
 * 要守的语义只有一条：**没显式传 mapId 时，选图要认人，不认玩家**。
 * 多世界下「地图属于世界」——角色在 B 世界，日程与准入就该按 B 世界的图，而不是
 * 玩家此刻站在哪张图、更不是"最新建的那张图"。
 *
 * 同时守住降级链：① 角色世界的地图 → ② 玩家当前所在地图 → ③ 最新图。
 * **任何一级缺失都落到下一级，绝不返回 null**（返回 null 会让日程弹窗整片空白）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
const TMP_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-map-by-world-'));
process.env.LINSHE_WORLD_PROJECTS_DIR = TMP_PROJECTS;
globalThis.fetch = async (url) => { throw new Error(`map-by-world test forbids network: ${url}`); };

const db = await import('../src/db/index.js');
const wm = await import('../src/services/worldMapService.js');

const database = db.getDb();

function makeWorld(name, content) {
  return Number(database.prepare(
    `INSERT INTO world_settings (name, content, is_active, is_enabled, tagline, visual_tone, sort_order)
     VALUES (?, ?, 0, 1, '', '', 0)`
  ).run(name, content).lastInsertRowid);
}
function makeCharacter(name, worldId) {
  return Number(database.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, world_setting_id) VALUES (?, ?, '测试人格', ?)`
  ).run(name, name, worldId).lastInsertRowid);
}

/** 造一张「一地区 → 一子区 → 一场景」的最小地图 */
function makeMapWithArea(name, worldId, regionName, areaName, sceneName) {
  const mid = Number(database.prepare(
    `INSERT INTO world_maps (name, world_setting_id, note) VALUES (?, ?, '')`
  ).run(name, worldId).lastInsertRowid);
  const ins = database.prepare(
    `INSERT INTO world_map_places (map_id, parent_id, level, key, name, kind, summary, pois_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, '', '[]', ?)`
  );
  const r1 = ins.run(mid, null, 1, `k1_${mid}`, regionName, 'region', 0);
  const r2 = ins.run(mid, Number(r1.lastInsertRowid), 2, `k2_${mid}`, areaName, 'district', 0);
  ins.run(mid, Number(r2.lastInsertRowid), 3, `k3_${mid}`, sceneName, 'scene', 0);
  return mid;
}

// ── 造两个世界、各一张图（B 的图后建，"最新图"会是 B）──
const worldA = makeWorld('T14甲世界', '甲世界正文');
const worldB = makeWorld('T14乙世界', '乙世界正文');
const mapA = makeMapWithArea('甲世界地图', worldA, '甲地区', '甲子区', '甲场景');
const mapB = makeMapWithArea('乙世界地图', worldB, '乙地区', '乙子区', '乙场景');

const charA = makeCharacter('甲角色', worldA);
const charB = makeCharacter('乙角色', worldB);
const charNoWorld = makeCharacter('无世界角色', null);
const worldC = makeWorld('T14丙世界(无图)', '丙世界正文');
const charC = makeCharacter('丙角色', worldC);

test('★★★ T14：默认地图按「角色所在世界」取，而不是最新图 / 玩家所在地图', () => {
  const a = wm.listAreasForSchedule(null, charA);
  assert.equal(a.mapId, mapA, `甲角色应落在甲世界的地图，实得 ${a.mapId}`);
  assert.equal(a.mapName, '甲世界地图');
  assert.deepEqual(a.areas.map(x => x.name), ['甲子区']);

  const b = wm.listAreasForSchedule(null, charB);
  assert.equal(b.mapId, mapB, '乙角色应落在乙世界的地图');
  assert.deepEqual(b.areas.map(x => x.name), ['乙子区']);
});

test('★★ T14：地点清单也跟着角色世界走（同一链路两处取值不许错位）', () => {
  const placesA = wm.listAreaPlaceAttrs('甲子区', null, charA);
  assert.deepEqual(placesA.map(p => p.name), ['甲场景']);
  const placesB = wm.listAreaPlaceAttrs('乙子区', null, charB);
  assert.deepEqual(placesB.map(p => p.name), ['乙场景']);
});

test('★★★ T14：显式传 mapId 仍然最优先（用户在地图页自己选图时不许被世界覆盖）', () => {
  const r = wm.listAreasForSchedule(mapB, charA);
  assert.equal(r.mapId, mapB, '显式指定的图必须赢过"角色所在世界"');
  assert.deepEqual(r.areas.map(x => x.name), ['乙子区']);
});

test('★★★ T14：降级链不返回 null —— 未绑定角色 / 世界无图，都回落到旧逻辑', () => {
  // 未绑定世界 → ②玩家所在地图 或 ③最新图（本测试库里没有 town_players，故落到最新图）
  const unbound = wm.listAreasForSchedule(null, charNoWorld);
  assert.ok(unbound.mapId, '未绑定角色也必须能取到一张图（不许空白）');
  assert.equal(unbound.mapId, mapB, '应回落到最新图（B 图后建）');

  // 归属的世界一张图都没有 → 同样回落，而不是"这个世界没图就没得排"
  const noMapWorld = wm.listAreasForSchedule(null, charC);
  assert.ok(noMapWorld.mapId, '世界无图时必须回落，不许空白');
  assert.equal(noMapWorld.mapId, mapB);

  // 完全不传角色 → 与改造前一致
  const noChar = wm.listAreasForSchedule();
  assert.equal(noChar.mapId, mapB, '不传角色 = 旧行为（最新图）');
});

test('★★ T14：世界被删后绑定悬空的角色 —— 不崩，走降级链', () => {
  const tmpWorld = makeWorld('T14待删世界', '待删');
  const tmpMap = makeMapWithArea('待删地图', tmpWorld, '待删地区', '待删子区', '待删场景');
  const tmpChar = makeCharacter('待删角色', tmpWorld);
  assert.equal(wm.listAreasForSchedule(null, tmpChar).mapId, tmpMap);

  database.prepare('DELETE FROM world_settings WHERE id = ?').run(tmpWorld);
  db.invalidateWorldCache('test.worldDeleted');   // T13 缓存契约：裸改库要声明失效

  const after = wm.listAreasForSchedule(null, tmpChar);
  assert.ok(after.mapId, '悬空绑定不许让解析返回 null');
  // ⚠ 删「世界」不会连带删「地图」（world_maps 对 world_settings 没有级联）——
  //   所以此刻"最新图"仍是刚建的 tmpMap，回落结果就是它。这里对照真实的最新图断言，
  //   不写死具体 id，免得以后地图顺序变了又假红。
  assert.equal(after.mapId, wm.listMaps()[0].id, '绑定的世界没了 → 回落到最新图');
});

test.after(() => {
  try { fs.rmSync(TMP_PROJECTS, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
});
