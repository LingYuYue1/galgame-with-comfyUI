/**
 * 移动型世界（载具）—— 角色日程可以落在任何星球（2026-10-18）
 *
 * 用户原话：
 *   「一键编排日程的时候现在有这个所属世界了就可以按照所属世界去编排了，这样他们就会出现在
 *     各自世界的地图里。但是只有一个世界是特殊的，星穹列车。这个世界的角色是可以随时出现在
 *     任何星球的。」
 *
 * 要锁住的两件事：
 *   ① **固定世界**：日程地点只能来自这个世界自己的地图（宁可没有，也不借）；
 *   ② **移动型世界**：同一个角色多次编排会落在不同的星球（车是家，但今天可能停别处）。
 *
 * 为什么单独成文件：它验的是「取哪张图」这一个决策点，
 * 和 worldMapMultiWorld（生成链路取哪个世界的正文）不是一回事。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-vehicle-'));
process.env.DB_PATH = path.join(TMP, 'agent.db');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP, 'world-projects');
globalThis.fetch = async (url) => { throw new Error(`vehicle schedule test forbids network: ${url}`); };

const db = await import('../src/db/index.js');
const { loadFeatureMigrations } = await import('../src/db/migrations/index.js');
const { runRegisteredMigrations } = await import('../src/db/migrationRegistry.js');
await loadFeatureMigrations();
runRegisteredMigrations(db.getDb());
const database = db.getDb();

const { buildAutoScheduleAreas } = await import('../src/services/worldMapService.js');

/** 每个用例从干净地基开始（主世界保留 —— 它是骨架） */
function resetData() {
  database.prepare('DELETE FROM character_trips').run();
  database.prepare('DELETE FROM characters').run();
  database.prepare('DELETE FROM world_maps').run();
  database.prepare('DELETE FROM world_settings WHERE is_core = 0').run();
  db.invalidateWorldCache('test.reset');
}

function makeWorld(name, content, { vehicle = 0 } = {}) {
  const w = db.createWorldSetting({ name, content });
  database.prepare('UPDATE world_settings SET is_vehicle = ? WHERE id = ?').run(vehicle ? 1 : 0, w.id);
  db.invalidateWorldCache(`test.mkworld#${w.id}`);
  return db.getWorldSettingById(w.id);
}

/**
 * 建一张图：每个 areaName 会落成一个 **L2 子地区**（挂在它自己的 L1 大地区下）。
 * 注意 `listAreasForSchedule` 取的是 L2 —— 只插 L1 会拿到空清单，测出来全是 null。
 */
function makeMap(worldId, mapName, areaNames) {
  const info = database.prepare(
    `INSERT INTO world_maps (name, world_setting_id, note) VALUES (?, ?, '')`
  ).run(mapName, worldId);
  const mapId = Number(info.lastInsertRowid);
  areaNames.forEach((n, i) => {
    const r = database.prepare(`
      INSERT INTO world_map_places
        (map_id, parent_id, level, key, name, name_en, kind, summary, pois_json, sort_order)
      VALUES (?, NULL, 1, ?, ?, '', '', '', '[]', ?)
    `).run(mapId, `r${i}`, `${n}·大区`, i);
    database.prepare(`
      INSERT INTO world_map_places
        (map_id, parent_id, level, key, name, name_en, kind, summary, pois_json, sort_order)
      VALUES (?, ?, 2, ?, ?, '', '', '', '[]', 0)
    `).run(mapId, Number(r.lastInsertRowid), `d${i}`, n);
  });
  return mapId;
}

function makeChar(name, worldId) {
  return Number(database.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, world_setting_id) VALUES (?, ?, '测试人格', ?)`
  ).run(name, name, worldId).lastInsertRowid);
}

/** 采样 n 次，统计每次取到的地图名 */
function sampleMapNames(characterId, n = 40) {
  const tally = new Map();
  for (let i = 0; i < n; i++) {
    const r = buildAutoScheduleAreas(characterId);
    const key = r ? r.mapName : '(null)';
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return tally;
}

// ── ① 字段本身可写可读 ────────────────────────────────────

test('★ is_vehicle 可写可读，且缺省不动其它字段', () => {
  resetData();
  const w = makeWorld('载具候选', '# 载具\n正文\n');
  assert.equal(Number(w.is_vehicle), 0, '默认不是移动型');

  const on = db.updateWorldSetting(w.id, { is_vehicle: true });
  assert.equal(Number(on.is_vehicle), 1);
  assert.equal(on.content, w.content, '只改 is_vehicle 不该动正文');

  const off = db.updateWorldSetting(w.id, { is_vehicle: false });
  assert.equal(Number(off.is_vehicle), 0);
});

// ── ② 固定世界：只从自己的地图取 ──────────────────────────

test('★★ 固定世界：角色只拿到本世界地图的地点，不会被别处借走', () => {
  resetData();
  const fixed = makeWorld('固定甲', '# 固定甲\n');
  const other = makeWorld('固定乙', '# 固定乙\n');
  makeMap(fixed.id, '固定甲·全域', ['东区', '西区']);
  makeMap(other.id, '固定乙·全域', ['北区', '南区']);

  const cid = makeChar('老实人', fixed.id);
  const tally = sampleMapNames(cid, 20);

  assert.deepEqual([...tally.keys()], ['固定甲·全域'], `出现了别的地图：${JSON.stringify([...tally])}`);
  assert.equal(tally.get('固定甲·全域'), 20);
});

// ── ③ 移动型世界：会停靠在别处 ────────────────────────────

test('★★★ 移动型世界：同一角色多次编排会落在不同星球的地图上', () => {
  resetData();
  const train = makeWorld('测试列车', '# 列车\n车厢\n', { vehicle: 1 });
  const planetA = makeWorld('星球甲', '# 甲\n');
  const planetB = makeWorld('星球乙', '# 乙\n');
  makeMap(train.id, '列车·车厢', ['观景车厢', '派对车厢']);
  makeMap(planetA.id, '星球甲·全域', ['甲城', '甲港']);
  makeMap(planetB.id, '星球乙·全域', ['乙城', '乙谷']);

  const cid = makeChar('列车组的人', train.id);
  const tally = sampleMapNames(cid, 60);
  const names = [...tally.keys()];

  assert.ok(names.includes('列车·车厢'), `在车上的情况没出现：${JSON.stringify(names)}`);
  assert.ok(
    names.some(n => n === '星球甲·全域' || n === '星球乙·全域'),
    `一次都没停靠到别的星球：${JSON.stringify(names)}`
  );
  // 只会有这三张图，绝不该借到"别的固定世界"（这里没有别的固定世界，所以只需检查不越界）
  for (const n of names) {
    assert.ok(['列车·车厢', '星球甲·全域', '星球乙·全域'].includes(n), `取到了不该取的地图：${n}`);
  }
});

test('★★ 移动型世界只有自己一张图时 → 老老实实待在车上，不报错', () => {
  resetData();
  const solo = makeWorld('孤车', '# 孤车\n', { vehicle: 1 });
  makeMap(solo.id, '孤车·车厢', ['唯一车厢']);
  const cid = makeChar('孤独乘客', solo.id);

  const tally = sampleMapNames(cid, 12);
  assert.deepEqual([...tally.keys()], ['孤车·车厢']);
});

test('★★ 移动型世界：没有任何有地点的图 → 返回 null（不崩、不乱借）', () => {
  resetData();
  const empty = makeWorld('空车', '# 空车\n', { vehicle: 1 });
  // 建地图但一个地点都不放
  database.prepare(`INSERT INTO world_maps (name, world_setting_id, note) VALUES ('空图', ?, '')`).run(empty.id);
  const cid = makeChar('空车乘客', empty.id);
  assert.equal(buildAutoScheduleAreas(cid), null);
});
