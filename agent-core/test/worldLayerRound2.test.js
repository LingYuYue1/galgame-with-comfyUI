/**
 * 世界分层 · 第二轮回归测试（2026-10-18）
 *
 * 守的是分层之后才出现的四类错位：
 *  ① **主世界被当成"一个具体世界"** —— 抽卡池、建图默认、旅程目的地，三处都会踩；
 *  ② **抽世界与取角色互不相干** —— 媒体会出现「二维市背景 + 仙舟作者」；
 *  ③ **旅程的"已经在那儿"判定** —— 分层把 `is_active` 全清成 0，旧判定永远不触发；
 *  ④ **角色自主旅游的四道闸** —— 开关、已在途、全局上限、无归属。
 *
 * 为什么单独成文件：这些断言全是"分层引入的新不变量"，
 * 和 worldProjectLibrary.test.js（世界文本拼接）不是一类东西。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
process.env.LINSHE_WORLD_PROJECTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-layer2-'));
globalThis.fetch = async (url) => { throw new Error(`world layer test forbids network: ${url}`); };

const db = await import('../src/db/index.js');
const worldRepo = await import('../src/db/worldRepository.js');
const tripRepo = await import('../src/db/tripRepository.js');
const { loadFeatureMigrations } = await import('../src/db/migrations/index.js');
const { runRegisteredMigrations } = await import('../src/db/migrationRegistry.js');
const { config } = await import('../src/config.js');
const { pickActiveCharacters } = await import('../src/services/mediaService.js');
const { maybeAutoTravel, countTravellers } = await import('../src/services/autoTravel.js');

await loadFeatureMigrations();
runRegisteredMigrations(db.getDb());
const database = db.getDb();

/** 清掉所有副世界、角色、旅程，让每个用例从干净地基开始（主世界保留 —— 它是骨架） */
function resetWorlds() {
  database.prepare('DELETE FROM character_trips').run();
  database.prepare('DELETE FROM characters').run();
  database.prepare('DELETE FROM world_maps').run();
  database.prepare('DELETE FROM world_settings WHERE is_core = 0').run();
  db.invalidateWorldCache('test.reset');
}

function makeSubWorld(name, content = `# ${name}\n${name}的正文\n`, { enabled = 1 } = {}) {
  const row = db.createWorldSetting({ name, content });
  database.prepare('UPDATE world_settings SET is_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, row.id);
  db.invalidateWorldCache(`test.mkworld#${row.id}`);
  return db.getWorldSettingById(row.id);
}

function makeChar(name, worldId = null) {
  return Number(database.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, world_setting_id) VALUES (?, ?, '测试人格', ?)`
  ).run(name, name, worldId).lastInsertRowid);
}

// ── ① 主世界不许被当成"一个具体世界" ───────────────────────

test('★ 抽卡池排除主世界：骨架正文永远不出现在媒体抽样里', () => {
  resetWorlds();
  const core = worldRepo.getCoreWorldSetting();
  assert.ok(core, '迁移应已建出主世界');
  // 给骨架写一段独特的正文，并确保它是启用的（默认就是）
  db.updateWorldSetting(core.id, { content: '# 框架\n骨架独有标记COREMARK\n' });
  database.prepare('UPDATE world_settings SET is_enabled = 1 WHERE id = ?').run(core.id);
  db.invalidateWorldCache('test.core');

  const sub = makeSubWorld('抽样副世界', '# 副世界\n副世界独有标记SUBMARK\n');

  // 抽很多次，骨架的正文一次都不许出现
  for (let i = 0; i < 40; i++) {
    const text = worldRepo.getWorldSettingSample(1, 3) || '';
    assert.ok(!text.includes('COREMARK'), '主世界（骨架）被抽进了媒体池');
  }
  // 副世界是会被抽到的（否则说明池子空了，上面的断言等于没验）
  const seen = Array.from({ length: 40 }, () => worldRepo.getWorldSettingSample(1, 3) || '').join('\n');
  assert.ok(seen.includes('SUBMARK'), '副世界应该被抽到');
  assert.ok(sub.id > 0);
});

test('★ sampleWorldSettings 连抽中的世界 id 一起返回，且与文本一致', () => {
  resetWorlds();
  const a = makeSubWorld('甲世界', '# 甲\n甲独有AAA\n');
  const b = makeSubWorld('乙世界', '# 乙\n乙独有BBB\n');
  const c = makeSubWorld('丙世界', '# 丙\n丙独有CCC\n');

  const sampled = worldRepo.sampleWorldSettings(3, 3);   // 池里正好 3 个 → 必中全部
  assert.deepEqual([...sampled.ids].sort(), [a.id, b.id, c.id].sort(), 'ids 应覆盖三个副世界');
  assert.ok(sampled.text.includes('AAA') && sampled.text.includes('BBB') && sampled.text.includes('CCC'));
});

test('★ 建图默认落「第一个副世界」，绝不落主世界', () => {
  resetWorlds();
  const first = makeSubWorld('排序靠前的副世界');
  makeSubWorld('排序靠后的副世界');

  const fallback = worldRepo.getDefaultSubWorld();
  assert.ok(fallback, '有副世界时必须能取到');
  assert.equal(fallback.id, first.id, '应按 sort_order/id 取第一个副世界');
  assert.equal(Number(fallback.is_core), 0, '取到的必须是副世界');
});

test('★ 一个副世界都没有时，建图默认返回 null（由路由提示"先建一个世界"）', () => {
  resetWorlds();
  assert.equal(worldRepo.getDefaultSubWorld(), null);
});

// ── ② 旅程：主世界不是"可以去的地方"，且"已经在那儿"要能判 ──

test('★ 主世界不能当旅程目的地', () => {
  resetWorlds();
  const core = worldRepo.getCoreWorldSetting();
  const sub = makeSubWorld('出发世界');
  const cid = makeChar('旅行者A', sub.id);

  const r = tripRepo.createTrip({ characterId: cid, toWorldId: core.id });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CORE_WORLD');
});

test('★ 「已经在那儿」判定用的是归属世界 —— 分层把 is_active 清零不再让它失效', () => {
  resetWorlds();
  const a = makeSubWorld('出发地');
  const b = makeSubWorld('目的地');
  const cid = makeChar('旅行者B', a.id);

  const same = tripRepo.createTrip({ characterId: cid, toWorldId: a.id });
  assert.equal(same.ok, false);
  assert.equal(same.code, 'ALREADY_THERE', '回自己的归属世界应被拦下');

  const other = tripRepo.createTrip({ characterId: cid, toWorldId: b.id });
  assert.equal(other.ok, true, other.error);
  tripRepo.cancelTrip(other.item.id);
});

test('★ 未归属角色没有"出身地" → 去任何副世界都不判 ALREADY_THERE', () => {
  resetWorlds();
  const a = makeSubWorld('某个世界');
  const cid = makeChar('无家可归者', null);

  const r = tripRepo.createTrip({ characterId: cid, toWorldId: a.id });
  assert.equal(r.ok, true, '未归属角色本来就吃骨架，去副世界是真实移动');
  tripRepo.cancelTrip(r.item.id);
});

// ── ③ 抽世界与取角色必须配对 ──────────────────────────────

test('★★ pickActiveCharacters 按世界收窄作者池：只出该世界居民 + 未归属角色', () => {
  resetWorlds();
  const wA = makeSubWorld('作者世界甲');
  const wB = makeSubWorld('作者世界乙');
  const inA = makeChar('甲的居民', wA.id);
  const inB1 = makeChar('乙的居民一', wB.id);
  const inB2 = makeChar('乙的居民二', wB.id);
  const homeless = makeChar('未归属者', null);

  const picked = pickActiveCharacters(3, { worldIds: [wA.id] });
  const ids = picked.map((c) => Number(c.id));
  assert.ok(ids.includes(inA), '甲世界的居民应可被抽到');
  assert.ok(ids.includes(homeless), '未归属角色（只吃骨架）放哪个世界都不算串味，应可被抽到');
  assert.ok(!ids.includes(inB1) && !ids.includes(inB2), '乙世界的居民不该出现在甲的稿子里');

  // 不传 worldIds → 老行为（全库随机），至少不该报错
  const all = pickActiveCharacters(3);
  assert.ok(Array.isArray(all));
});

test('★★ 媒体抽样与作者池配对：抽中谁，作者就来自谁（多次抽样统计）', () => {
  resetWorlds();
  const wA = makeSubWorld('配对甲');
  const wB = makeSubWorld('配对乙');
  const inA = makeChar('配对·甲居民', wA.id);
  const inB = makeChar('配对·乙居民', wB.id);

  for (let i = 0; i < 30; i++) {
    const sampled = worldRepo.sampleWorldSettings(1, 1);
    const picked = pickActiveCharacters(3, { worldIds: sampled.ids }).map((c) => Number(c.id));
    if (sampled.ids.includes(wA.id) && !sampled.ids.includes(wB.id)) {
      assert.ok(!picked.includes(inB), '抽中甲世界却抽到了乙居民');
    }
    if (sampled.ids.includes(wB.id) && !sampled.ids.includes(wA.id)) {
      assert.ok(!picked.includes(inA), '抽中乙世界却抽到了甲居民');
    }
  }
});

// ── ④ 角色自主旅游：四道闸 ────────────────────────────────

test('★★ 自主旅游：开关关 → 永不出发', () => {
  resetWorlds();
  const a = makeSubWorld('甲');
  makeSubWorld('乙');
  const cid = makeChar('爱旅行的人', a.id);

  const prev = config.features.autoTravel;
  const prevChance = config.trip.autoTravelChance;
  try {
    config.features.autoTravel = false;
    config.trip.autoTravelChance = 1;      // 概率拉满，验证"开关是硬闸"
    for (let i = 0; i < 20; i++) {
      assert.equal(maybeAutoTravel({ id: cid, display_name: '爱旅行的人' }), null);
    }
    assert.equal(countTravellers(), 0);
  } finally {
    config.features.autoTravel = prev;
    config.trip.autoTravelChance = prevChance;
  }
});

test('★★ 自主旅游：开关开 + 概率拉满 → 出发，且目的地是副世界、交通方式合法', () => {
  resetWorlds();
  const a = makeSubWorld('出发地', '# 甲\n');
  const b = makeSubWorld('目的地', '# 乙\n');
  const cid = makeChar('会走的人', a.id);

  const prev = config.features.autoTravel;
  const prevChance = config.trip.autoTravelChance;
  try {
    config.features.autoTravel = true;
    config.trip.autoTravelChance = 1;
    const r = maybeAutoTravel({ id: cid, display_name: '会走的人' });
    assert.ok(r?.ok, '概率 1 时必须出发');
    assert.equal(Number(r.item.to_world_id), b.id, '只能去另一个副世界（排除出发地）');
    assert.ok(['train', 'ship', 'walk'].includes(r.item.transport));
    assert.equal(Number(r.item.from_world_id), a.id);
    assert.equal(countTravellers(), 1);
  } finally {
    config.features.autoTravel = prev;
    config.trip.autoTravelChance = prevChance;
  }
});

test('★★ 自主旅游：已有人在路上时，别人不再出发（全局上限）', () => {
  resetWorlds();
  const a = makeSubWorld('甲地');
  const b = makeSubWorld('乙地');
  const c1 = makeChar('先走的人', a.id);
  const c2 = makeChar('后想走的人', a.id);

  const prev = config.features.autoTravel;
  const prevChance = config.trip.autoTravelChance;
  try {
    config.features.autoTravel = true;
    config.trip.autoTravelChance = 1;
    assert.ok(maybeAutoTravel({ id: c1, display_name: '先走的人' })?.ok);
    assert.equal(maybeAutoTravel({ id: c2, display_name: '后想走的人' }), null, '同时只允许一个人在途');
    assert.equal(countTravellers(), 1);
  } finally {
    config.features.autoTravel = prev;
    config.trip.autoTravelChance = prevChance;
  }
});

test('★★ 自主旅游：没有归属世界的角色不参与', () => {
  resetWorlds();
  makeSubWorld('甲地');
  makeSubWorld('乙地');
  const cid = makeChar('无归属者', null);

  const prev = config.features.autoTravel;
  const prevChance = config.trip.autoTravelChance;
  try {
    config.features.autoTravel = true;
    config.trip.autoTravelChance = 1;
    assert.equal(maybeAutoTravel({ id: cid, display_name: '无归属者' }), null);
    assert.equal(countTravellers(), 0);
  } finally {
    config.features.autoTravel = prev;
    config.trip.autoTravelChance = prevChance;
  }
});

test('★ 自主旅游：只有一个副世界 → 无处可去（安静放弃，不报错）', () => {
  resetWorlds();
  const only = makeSubWorld('唯一的世界');
  const cid = makeChar('只有一条路的人', only.id);

  const prev = config.features.autoTravel;
  const prevChance = config.trip.autoTravelChance;
  try {
    config.features.autoTravel = true;
    config.trip.autoTravelChance = 1;
    assert.equal(maybeAutoTravel({ id: cid, display_name: '只有一条路的人' }), null);
  } finally {
    config.features.autoTravel = prev;
    config.trip.autoTravelChance = prevChance;
  }
});
