/**
 * 星图 T11 —— 日程地点取自「角色所在世界」的地图。
 *
 * 改造前：手动弹窗会带 `areas`，而**自动生成**（调度器 / 新建角色 / 全量重排）什么都不带
 * → 提示词里一句具体地名都没有 → 模型只能从世界观正文抓画面，排出来人人像在同一个路口。
 *
 * 本文件钉四件事：
 *  ① 自动补全真的按角色世界取图取地点；
 *  ② 规模上限（区域 ≤20 / 每区地点 ≤12），且截断后**名字与附带信息仍然一一对应**；
 *  ③ 两道"不许替用户做主"的闸：手动选的区域原样用、明确传空数组表示"不限区域"时不补；
 *  ④ 接线护栏：scheduleGenerator 里真的调了 buildAutoScheduleAreas（防静默断线）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';
const TMP_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-sched-areas-'));
process.env.LINSHE_WORLD_PROJECTS_DIR = TMP_PROJECTS;
globalThis.fetch = async (url) => { throw new Error(`schedule-areas test forbids network: ${url}`); };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = await import('../src/db/index.js');
const wm = await import('../src/services/worldMapService.js');
const { readScheduleOptions } = await import('../src/routes/schedule.js');
const { buildScheduleConstraintBlock } = await import('../src/services/scheduleGenerator.js');

const database = db.getDb();

function makeWorld(name, content = '测试世界正文') {
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
function makeMap(name, worldId) {
  return Number(database.prepare(
    `INSERT INTO world_maps (name, world_setting_id, note) VALUES (?, ?, '')`
  ).run(name, worldId).lastInsertRowid);
}
/** 往图里加「地区 → 子区 → N 个场景」 */
function addArea(mapId, regionName, areaName, sceneNames = []) {
  const ins = database.prepare(
    `INSERT INTO world_map_places (map_id, parent_id, level, key, name, kind, summary, pois_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 0)`
  );
  const r1 = ins.run(mapId, null, 1, `r_${mapId}_${regionName}`, regionName, 'region', '');
  const r2 = ins.run(mapId, Number(r1.lastInsertRowid), 2, `d_${mapId}_${areaName}`, areaName, 'district', '');
  sceneNames.forEach((s, i) => {
    ins.run(mapId, Number(r2.lastInsertRowid), 3, `s_${mapId}_${areaName}_${i}`, s, 'scene', `${s}的简介`);
  });
  return Number(r2.lastInsertRowid);
}

const worldA = makeWorld('T11甲世界');
const mapA = makeMap('T11甲地图', worldA);
addArea(mapA, '甲地区', '甲子区', ['甲咖啡馆', '甲河堤']);
addArea(mapA, '甲地区', '甲二区', ['甲澡堂']);

const charA = makeCharacter('甲角色', worldA);
const worldNoMap = makeWorld('T11无图世界');
const charNoMap = makeCharacter('无图角色', worldNoMap);

test('★★★ T11：自动补全按角色所在世界取图，并带出子区与地点', () => {
  const auto = wm.buildAutoScheduleAreas(charA);
  assert.ok(auto, '有图有区就应该补全');
  assert.equal(auto.mapId, mapA);
  assert.deepEqual(auto.areas, ['甲子区', '甲二区']);
  assert.deepEqual(auto.scenesByArea['甲子区'], ['甲咖啡馆', '甲河堤']);
  assert.equal(auto.autoAreas, true, '要能标识"这是自动补的"');
  // 简介必须一并带出（八股现象的解药）
  assert.ok((auto.summariesByArea['甲子区'] || []).length === 2);
});

test('★★★ T11：补全出来的内容真的会进约束层（不是只算出来不用）', () => {
  const auto = wm.buildAutoScheduleAreas(charA);
  const block = buildScheduleConstraintBlock(auto) || '';
  assert.match(block, /甲子区/);
  assert.match(block, /甲咖啡馆|甲河堤/);
});

test('★★ T11：角色世界没有图 → 返回 null，绝不塞空区域', () => {
  assert.equal(wm.buildAutoScheduleAreas(charNoMap), null);
  assert.equal(wm.buildAutoScheduleAreas(999999), null, '角色不存在也不许抛错');
});

test('★★★ T11：规模上限 —— 区域 ≤20、每区地点 ≤12，截断后名字与简介仍一一对应', () => {
  const w = makeWorld('T11大世界');
  const mid = makeMap('T11大图', w);
  for (let i = 0; i < 25; i++) {
    const scenes = Array.from({ length: 15 }, (_, k) => `大区${i}地点${k}`);
    addArea(mid, '大地区', `大区${i}`, scenes);
  }
  const cid = makeCharacter('大世界角色', w);
  const auto = wm.buildAutoScheduleAreas(cid);
  assert.equal(auto.areas.length, 20, '区域上限 20');
  const first = auto.areas[0];
  assert.equal(auto.scenesByArea[first].length, 12, '每区地点上限 12');
  const kept = new Set(auto.scenesByArea[first]);
  const sm = auto.summariesByArea[first] || [];
  assert.equal(sm.length, 12, '简介条数必须跟地点对齐');
  for (const item of sm) assert.ok(kept.has(item.name), `简介 ${item.name} 必须属于保留下来的地点`);
});

test('★★★ T11：两道闸 —— 手动选的区域原样用；明确传空数组表示"不限区域"', () => {
  // 没传 areas → 没有 areasSpecified（自动路径可以补）
  assert.equal(readScheduleOptions({}).areasSpecified, undefined);
  // 传了空数组 → 明确"不限区域"，自动路径不许补
  assert.equal(readScheduleOptions({ areas: [] }).areasSpecified, true);
  // 传了具体区域 → 手动路径
  const manual = readScheduleOptions({ areas: ['甲子区'] });
  assert.deepEqual(manual.areas, ['甲子区']);
  assert.equal(manual.areasSpecified, true);
});

test('★★ T11 接线护栏：scheduleGenerator 必须调用 buildAutoScheduleAreas（且只调一次）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/scheduleGenerator.js'), 'utf8');
  const hits = (src.match(/buildAutoScheduleAreas\(/g) || []).length;
  assert.equal(hits, 1, `自动补全接线断了：期望 1 处调用，实得 ${hits} 处`);
  assert.match(src, /options\?\.areasSpecified/, '必须保留"用户明确不限区域"的闸');
});

test.after(() => {
  try { fs.rmSync(TMP_PROJECTS, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
});
