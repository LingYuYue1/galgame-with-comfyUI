/**
 * F-49 回归测试：特殊朋友圈队列「generating 孤儿」恢复
 *
 * 缺陷：条目被标记 generating 后若进程中断（崩溃/被杀——失败回退的 catch 不执行），
 * 重启后该状态永久滞留：扫描逻辑对非 pending 条目直接跳过——既不再生成、也不判过期，
 * 该条特殊朋友圈永久丢失、无自愈路径（违反文件头「启动时立即扫一遍……正在时段内的马上发送」承诺）。
 *
 * 修复语义（本测试钉住）：
 * - 遗留孤儿（本进程未领取的 generating）：窗口内 → 重置 pending 重新派发；已出窗 → expired
 * - 本进程领取中的 generating（生成进行时）不得被误重置/重复派发（守卫）
 * - 孤儿恢复后若生成失败 → 照常回退 pending 等下轮重试
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const editor = await import('../src/services/scheduleEditor.js');
const special = await import('../src/services/scheduleSpecialMoment.js');
const schedMgr = await import('../src/services/scheduleManager.js');

config.dbPath = ':memory:';

// 模块级「进行中」集合在测试进程内跨用例共享（键为 characterId::startTime；
// 各用例的角色 id 都从 1 起、时刻窗口又可能重合 → 会撞键）。
// 每个用例开始前清空：避免上一用例故意制造的「进行中」残留污染本用例
//（守卫用例必须停留在「已领取未完成」，残留无法在用例内自行消化）。
beforeEach(() => { special.__resetSpecialMomentInFlightForTest(); });

function insertCharWithSchedule(db, displayName, activities) {
  db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '旅客')`)
    .run(`char_${displayName}`, displayName);
  const char = db.prepare('SELECT id FROM characters WHERE display_name = ?').get(displayName);
  db.prepare('INSERT INTO schedule_templates (character_id, schedule_json) VALUES (?, ?)')
    .run(char.id, JSON.stringify(activities));
  // 派生当日快照（与线上 ensureTodaySchedule 同源）
  schedMgr.ensureTodaySchedule(char.id);
  return char.id;
}

function loadSchedule(db, characterId) {
  const row = db.prepare(
    `SELECT schedule_json FROM daily_schedules WHERE character_id = ? AND schedule_date = DATE('now', 'localtime')`
  ).get(characterId);
  return row ? JSON.parse(row.schedule_json) : null;
}

const fmtMin = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 构造一个包含当前时刻、且不跨午夜的时间窗（HH:MM） */
function inWindowSlot(duration = 30) {
  const curMin = new Date().getHours() * 60 + new Date().getMinutes();
  const start = Math.min(Math.max(curMin, 0), 1439 - duration);
  return [fmtMin(start), fmtMin(start + duration)];
}

/** 构造一个已经过去的时段（结束时刻 = 当前分钟，nowMin >= endMin 即判出窗） */
function pastSlot() {
  const curMin = new Date().getHours() * 60 + new Date().getMinutes();
  const start = Math.max(curMin - 10, 0);
  return [fmtMin(start), fmtMin(curMin)];
}

const BASE_DAY = [
  { startTime: '07:00', endTime: '12:00', activity: '上午工作', location: '事务所', replyDelay: 0, tags: ['工作'], description: '伏案工作。' },
  { startTime: '12:00', endTime: '13:00', activity: '午餐', location: '餐厅', replyDelay: 0, tags: ['日常'], description: '吃午饭。' },
  { startTime: '13:00', endTime: '18:00', activity: '下午外出', location: '街区', replyDelay: 0, tags: ['外出'], description: '外出办事。' },
  { startTime: '18:00', endTime: '22:00', activity: '晚间休闲', location: '公寓', replyDelay: 0, tags: ['休闲'], description: '在家休息。' },
  { startTime: '22:00', endTime: '07:00', activity: '就寝安眠', location: '公寓卧室', replyDelay: -1, tags: ['睡眠'], description: '沉入睡眠。' },
];

/** 把一条「上个进程标记 generating 后中断」的遗留孤儿写进当日快照 */
function pushOrphan(db, charId, slot, activity) {
  const schedule = loadSchedule(db, charId);
  schedule.push({
    startTime: slot[0], endTime: slot[1], activity,
    location: '公园', replyDelay: 0, tags: [], description: '',
    edited: 1, specialMomentStatus: 'generating',
  });
  db.prepare('UPDATE daily_schedules SET schedule_json = ? WHERE character_id = ?')
    .run(JSON.stringify(schedule), charId);
}

test('遗留 generating 孤儿（窗口内）：重启后应被恢复派发，而非永久卡死', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const charId = insertCharWithSchedule(db, '孤儿窗口内', BASE_DAY);
  const [inWinStart, inWinEnd] = inWindowSlot(30);

  // 状态停留在 generating、但本进程从未领取过它（内存领取集合为空）
  // —— 等价于「上个进程标记后中断、本进程重启」的遗留孤儿
  pushOrphan(db, charId, [inWinStart, inWinEnd], '被中断的约定');

  const generated = [];
  special.setSpecialScheduleMomentGenerator(async item => {
    generated.push(item);
    editor.updateSpecialMomentStatus(item.characterId, item.activity.startTime, 'sent');
  });
  await special.runSpecialMomentCheck();

  assert.equal(generated.length, 1, '遗留孤儿应被识别并重新派发（缺陷版：被跳过 → 0 条）');
  assert.equal(generated[0].activity.activity, '被中断的约定');
  assert.equal(generated[0].characterId, charId);
  const after = loadSchedule(db, charId);
  assert.equal(after.find(a => a.activity === '被中断的约定').specialMomentStatus, 'sent', '恢复派发成功后应标记 sent');
});

test('遗留 generating 孤儿（已出窗）：应标记 expired，而非永久停留在 generating', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const charId = insertCharWithSchedule(db, '孤儿已出窗', BASE_DAY);
  const [pastStart, pastEnd] = pastSlot();

  pushOrphan(db, charId, [pastStart, pastEnd], '出窗的约定');

  const generated = [];
  special.setSpecialScheduleMomentGenerator(async item => { generated.push(item); });
  await special.runSpecialMomentCheck();

  assert.equal(generated.length, 0, '已出窗的孤儿不应补发');
  const after = loadSchedule(db, charId);
  assert.equal(
    after.find(a => a.activity === '出窗的约定').specialMomentStatus, 'expired',
    '出窗孤儿应过期（缺陷版：永久停留在 generating）'
  );
});

test('守卫：本进程领取中（生成进行时）的条目不得被误当孤儿重置', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const charId = insertCharWithSchedule(db, '领取守卫', BASE_DAY);
  const [inWinStart, inWinEnd] = inWindowSlot(30);

  const schedule = loadSchedule(db, charId);
  schedule.push({
    startTime: inWinStart, endTime: inWinEnd, activity: '慢速生成中',
    location: '公园', replyDelay: 0, tags: [], description: '',
    edited: 1, specialMomentStatus: 'pending',
  });
  db.prepare('UPDATE daily_schedules SET schedule_json = ? WHERE character_id = ?')
    .run(JSON.stringify(schedule), charId);

  // 第一次扫描：条目被本进程领取（pending → generating，进入内存领取集合）
  const due1 = special.collectDueSpecialMoments();
  assert.equal(due1.length, 1, '待发条目应被正常领取');
  assert.equal(loadSchedule(db, charId).find(a => a.activity === '慢速生成中').specialMomentStatus, 'generating');

  // 模拟生成仍在进行中（尚未 resolve）：再次扫描不得把它当作孤儿重置/重复派发
  const due2 = special.collectDueSpecialMoments();
  assert.equal(due2.length, 0, '领取中的条目不得被重复派发');
  assert.equal(
    loadSchedule(db, charId).find(a => a.activity === '慢速生成中').specialMomentStatus, 'generating',
    '领取中（本进程进行时）的状态不得被误重置'
  );
});

test('遗留孤儿恢复后若生成失败：回退 pending 等下轮重试（不卡死）', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const charId = insertCharWithSchedule(db, '孤儿失败重试', BASE_DAY);
  const [inWinStart, inWinEnd] = inWindowSlot(40);

  pushOrphan(db, charId, [inWinStart, inWinEnd], '会失败的孤儿约定');

  let attempts = 0;
  special.setSpecialScheduleMomentGenerator(async () => {
    attempts++;
    throw new Error('LLM down');
  });
  await special.runSpecialMomentCheck();

  assert.equal(attempts, 1, '恢复后的孤儿应被真实尝试生成一次');
  const after = loadSchedule(db, charId);
  assert.equal(
    after.find(a => a.activity === '会失败的孤儿约定').specialMomentStatus, 'pending',
    '恢复后失败应回退 pending（缺陷版：停留在 generating，永远等不到重试）'
  );
});
