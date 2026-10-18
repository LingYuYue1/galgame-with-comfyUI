/**
 * 星图 T15 —— 跨世界旅程（在途时间代价）回归测试。
 *
 * 用户拍板（2026-10-16 23:50）：「确实会消耗时间……角色不可能是一瞬间到达的」
 *   → 移动 = 发起旅程 → **在途状态**（旅途语境）→ 到达改绑。
 *
 * 本文件守五件事：
 *  ① 发起校验（同世界 / 已在途 / 目的地不存在 / 归档角色）；
 *  ② **在途语境覆盖**（红线：覆盖不拼接 —— 出发地与目的地的正文一个字都不许进 prompt）；
 *  ③ 到达结算：标记 arrived + 改绑 + 幂等（重复结算不重复改绑）；
 *  ④ 取消：原地不动，绑定保持出发前的样子；
 *  ⑤ 时长夹紧（1~168）与「目的地被删后结算不崩」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
// 项目库落到临时目录：本测试会建世界，不能写到用户真实的 data/world-projects
const TMP_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-trips-projects-'));
process.env.LINSHE_WORLD_PROJECTS_DIR = TMP_PROJECTS;
globalThis.fetch = async (url) => { throw new Error(`trip test forbids network: ${url}`); };

const { getDb } = await import('../src/db/index.js');
const { loadFeatureMigrations } = await import('../src/db/migrations/index.js');
const { runRegisteredMigrations } = await import('../src/db/migrationRegistry.js');
await loadFeatureMigrations();

const db = getDb();
runRegisteredMigrations(db); // character_trips 由可插拔迁移 009 建表

const {
  createTrip,
  getActiveTrip,
  getTripById,
  listTrips,
  cancelTrip,
  finalizeDueTrips,
  getTripStatusFor,
  getTripDurationHours,
} = await import('../src/db/index.js');
const { getWorldSetting, getCharacterWorldSettingId } = await import('../src/db/index.js');

// ── 造数据：两个世界 + 两个角色 ──────────────────────────────
let seq = 0;
function makeWorld(name, content) {
  const info = db.prepare(
    `INSERT INTO world_settings (name, content, is_active, is_enabled, tagline, visual_tone, sort_order)
     VALUES (?, ?, 0, 1, '', '', ?)`
  ).run(name, content, ++seq);
  return Number(info.lastInsertRowid);
}
function makeCharacter(displayName, worldSettingId) {
  const info = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, world_setting_id)
     VALUES (?, ?, '测试人格', ?)`
  ).run(`c${++seq}`, displayName, worldSettingId);
  return Number(info.lastInsertRowid);
}

const WORLD_A_TEXT = '【A世界·灯塔城】这里是A世界的正文：海雾、灯塔、钟楼。';
const WORLD_B_TEXT = '【B世界·砂海站】这里是B世界的正文：砂海、货运站、夜班列车。';

const wA = makeWorld('A世界', WORLD_A_TEXT);
const wB = makeWorld('B世界', WORLD_B_TEXT);
const wC = makeWorld('C世界', '【C世界·云上庭】这里是C世界的正文。');

const charA = makeCharacter('青雀', wA);
const charB = makeCharacter('停云', wB);

// 让 A 世界成为激活世界（"未绑定回落激活"口径要用到）
db.prepare('UPDATE world_settings SET is_active = 1 WHERE id = ?').run(wA);

test('★ T15：发起旅程 → 在途状态正确（时长 / 交通 / 未到期）', () => {
  const r = createTrip({ characterId: charA, toWorldId: wB, transport: 'ship', durationHours: 6, note: '带了一只旧箱子' });
  assert.equal(r.ok, true, r.error);
  const t = r.item;
  assert.equal(t.status, 'transit');
  assert.equal(t.transport, 'ship');
  assert.equal(t.transport_label, '星舰');
  assert.equal(t.from_world_id, wA, '出发地应快照为当时的绑定世界');
  assert.equal(t.to_world_id, wB);
  assert.equal(t.is_due, false);
  assert.ok(t.remaining_minutes > 300 && t.remaining_minutes <= 360, `剩余应约 6 小时，实得 ${t.remaining_minutes}`);
});

test('★★★ T15：在途期间世界语境 = 旅途，且出发地/目的地正文一个字都不进 prompt', () => {
  const world = getWorldSetting(charA);
  assert.ok(world, '在途时应有世界块');
  assert.match(world, /旅途/, '应是旅途语境');
  assert.match(world, /尚未抵达/, '应明确"还没到"');
  assert.match(world, /星舰/, '应带上交通方式');
  assert.ok(!world.includes('灯塔城'), '出发地正文不许出现（覆盖不拼接）');
  assert.ok(!world.includes('砂海站'), '目的地正文不许出现（覆盖不拼接）');
  // 未在途的角色不受影响
  const other = getWorldSetting(charB);
  assert.ok(other.includes('砂海站'), 'B 角色应照常吃自己世界的正文');
});

test('★★ T15：同一世界 / 已在途 / 目的地不存在 → 各自给出可读原因', () => {
  const same = createTrip({ characterId: charB, toWorldId: wB });
  assert.equal(same.ok, false);
  assert.equal(same.code, 'ALREADY_THERE');

  const dup = createTrip({ characterId: charA, toWorldId: wC });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'ALREADY_IN_TRANSIT');
  assert.match(dup.error, /路上/);

  const noWorld = createTrip({ characterId: charB, toWorldId: 999999 });
  assert.equal(noWorld.ok, false);
  assert.equal(noWorld.code, 'NO_WORLD');

  const noChar = createTrip({ characterId: 999999, toWorldId: wC });
  assert.equal(noChar.ok, false);
  assert.equal(noChar.code, 'NO_CHARACTER');
});

test('★★★ T15：到达结算 → 标记 arrived + 改绑目的地，且重复结算幂等', () => {
  const trip = getActiveTrip(charA);
  assert.ok(trip);
  // 手动把到期时间推到过去，模拟"到点了"
  db.prepare(`UPDATE character_trips SET arrive_at = datetime('now', '-1 minutes') WHERE id = ?`).run(trip.id);

  // ⚠ 这里必须直查库：`getCharacterWorldSettingId()` 会先问"在途吗"，
  //   而问的动作本身就带**读时结算**（到点就地改绑）。用它断言"结算前"永远拿不到旧值。
  const rawBefore = db.prepare('SELECT world_setting_id FROM characters WHERE id = ?').get(charA).world_setting_id;
  assert.equal(rawBefore, wA, '结算前绑定仍是出发地');

  const settled = finalizeDueTrips({ characterId: charA });
  assert.equal(settled.length, 1);
  assert.equal(getTripById(trip.id).status, 'arrived');
  assert.equal(getCharacterWorldSettingId(charA), wB, '结算后应改绑到目的地');

  // ★ 到达还要把「日程刷新时间」提前到当下 —— 光清 day_plans 不够：
  //   默认日历不会自动重排，不推刷新时间她可能按旧世界再过多一两天。
  const refreshAt = db.prepare('SELECT next_schedule_refresh_at FROM characters WHERE id = ?').get(charA).next_schedule_refresh_at;
  assert.ok(refreshAt, '到达后应把日程刷新时间推到当下（不许留空）');
  assert.match(String(refreshAt), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '应是 SQLite datetime 文本（UTC）');
  // 与"现在"对齐：SQLite 同一口径取一次 now，前后差应在 2 分钟内（不写死具体时刻，防时钟漂移）
  const nowText = db.prepare("SELECT datetime('now') AS n").get().n;
  const toMs = (s2) => Date.parse(String(s2).replace(' ', 'T') + 'Z');
  assert.ok(Math.abs(toMs(refreshAt) - toMs(nowText)) < 2 * 60 * 1000, '刷新时间应≈当前时刻');

  // 幂等：再结算一次什么都不做（不会重复改绑、不重复清日程）
  const again = finalizeDueTrips({ characterId: charA });
  assert.equal(again.length, 0, '重复结算必须无事发生');

  // 世界解析切到目的地
  const world = getWorldSetting(charA);
  assert.ok(world.includes('砂海站'), '到达后应吃目的地正文');
  assert.ok(!world.includes('旅途'), '到达后不该再是旅途语境');
});

test('★★ T15：取消 → 原地不动，绑定保持出发前', () => {
  const r = createTrip({ characterId: charB, toWorldId: wC, transport: 'walk', durationHours: 3 });
  assert.equal(r.ok, true, r.error);
  const tripId = r.item.id;

  // 在途时语境是旅途
  assert.match(getWorldSetting(charB), /旅途/);

  const c = cancelTrip(tripId);
  assert.equal(c.ok, true, c.error);
  assert.equal(getTripById(tripId).status, 'cancelled');
  assert.equal(getActiveTrip(charB), null, '取消后不再在途');
  assert.equal(getCharacterWorldSettingId(charB), wB, '取消不改绑');

  const world = getWorldSetting(charB);
  assert.ok(world.includes('砂海站'), '取消后回到自己世界的正文');

  // 已结束的旅程不能再取消
  const again = cancelTrip(tripId);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'NOT_IN_TRANSIT');
});

test('★★ T15：时长夹紧到 1~168，且默认值来自 config', () => {
  const charC = makeCharacter('三月七', wA);
  const tooShort = createTrip({ characterId: charC, toWorldId: wB, durationHours: 0 });
  assert.equal(tooShort.ok, true, tooShort.error);
  assert.ok(tooShort.item.remaining_minutes >= 55, '0 小时应被夹到 1 小时');
  cancelTrip(tooShort.item.id);

  const tooLong = createTrip({ characterId: charC, toWorldId: wB, durationHours: 999 });
  assert.equal(tooLong.ok, true, tooLong.error);
  assert.ok(tooLong.item.remaining_minutes >= 167 * 60, '999 小时应被夹到 168 小时');
  cancelTrip(tooLong.item.id);

  const d = getTripDurationHours();
  assert.ok(d >= 1 && d <= 168, `默认时长应在 1~168，实得 ${d}`);
});

test('★★ T15：目的地世界在途中被删 → 结算不崩，角色保持原绑定', () => {
  const charD = makeCharacter('花火', wA);
  const tmpWorld = makeWorld('临时世界', '【临时】会被删掉的世界。');
  const r = createTrip({ characterId: charD, toWorldId: tmpWorld, durationHours: 2 });
  assert.equal(r.ok, true, r.error);
  db.prepare(`UPDATE character_trips SET arrive_at = datetime('now', '-1 minutes') WHERE id = ?`).run(r.item.id);

  // 绕开 T12 引用保护直接删（模拟"世界在旅途中被删"的极端情形）
  db.prepare('DELETE FROM world_settings WHERE id = ?').run(tmpWorld);

  const settled = finalizeDueTrips({ characterId: charD });
  assert.equal(settled.length, 1, '仍应被结算掉（不留永久在途）');
  assert.equal(getCharacterWorldSettingId(charD), wA, '目的地没了 → 保持原绑定，不当机');
});

test('★ T15：旅程列表 / 状态摘要字段完整（前端依赖）', () => {
  const list = listTrips({ worldId: wA, limit: 50 });
  assert.ok(list.length > 0, '应能按世界查到旅程');
  for (const t of list) {
    assert.ok('character_id' in t && 'status' in t && 'transport_label' in t, '缺字段');
    assert.ok(t.from_world_id === wA || t.to_world_id === wA, '按世界过滤应命中出发地或目的地');
  }

  const charE = makeCharacter('灵砂', wA);
  const r = createTrip({ characterId: charE, toWorldId: wB, transport: 'train', durationHours: 4 });
  const status = getTripStatusFor(charE);
  assert.ok(status, '在途应有状态摘要');
  assert.equal(status.to_world_name, 'B世界', '摘要要带世界名（前端直接显示）');
  assert.equal(status.from_world_name, 'A世界');
  assert.ok(status.remaining_minutes > 0);
  cancelTrip(r.item.id);
});

test.after(() => {
  try { fs.rmSync(TMP_PROJECTS, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
});
