/**
 * F-53 回归测试：睡眠状态同步 cron 必须与 initialize 同口径（排除归档角色）
 *
 * 缺陷：`startSleepingStateCron` 的 tick 全量扫 `characters`——归档角色仍被每轮同步
 * （连带 broadcast、醒后加速推送等副作用），与既有口径不一致：
 *   · characters.js 归档路由注释：「归档 = 不再参与任何主动行为……各调度器的选人查询叠加 COALESCE(archived,0)=0」；
 *   · `initialize()` 已排除归档（注释：归档角色例外——日程也在「主动行为」之列）；
 *   · `getTodayScheduleRaw` 同样对归档角色直接返回 null。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const mgr = await import('../src/services/scheduleManager.js');
const { getLocalDateKey } = await import('../src/utils/localDate.js');

config.dbPath = ':memory:';

const fmtMin = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 一个覆盖当前时刻的睡眠时段（replyDelay=-1） */
function sleepSlot() {
  const curMin = new Date().getHours() * 60 + new Date().getMinutes();
  const start = Math.min(Math.max(curMin - 5, 0), 1439 - 30);
  return [fmtMin(start), fmtMin(start + 30)];
}

function insertChar(db, displayName, archived) {
  db.prepare(`INSERT INTO characters (name, display_name, base_prompt, archived) VALUES (?, ?, '旅客', ?)`)
    .run(`char_${displayName}`, displayName, archived ? 1 : 0);
  return db.prepare('SELECT id FROM characters WHERE display_name = ?').get(displayName).id;
}

/** 直插今日快照（含一个当前时刻内的睡眠块） */
function insertSleepSnapshot(db, charId) {
  const [s, e] = sleepSlot();
  const schedule = [
    { startTime: s, endTime: e, activity: '就寝安眠', location: '卧室', replyDelay: -1, tags: ['睡眠'], description: '沉入睡眠。' },
  ];
  db.prepare('INSERT INTO daily_schedules (character_id, schedule_date, schedule_json) VALUES (?, ?, ?)')
    .run(charId, getLocalDateKey(), JSON.stringify(schedule));
}

test('睡眠同步 cron：活跃角色照常同步、归档角色不被触碰（与 initialize 同口径）', async t => {
  const db = getDb();
  t.after(() => closeDb());

  const activeId = insertChar(db, '活跃睡眠', 0);
  const archivedId = insertChar(db, '归档睡眠', 1);
  insertSleepSnapshot(db, activeId);
  insertSleepSnapshot(db, archivedId);

  // 两人都先置为清醒（构造「处在睡眠时段、期待被同步成睡眠」的初始态）
  db.prepare('UPDATE characters SET is_sleeping = 0, sleep_until = NULL WHERE id IN (?, ?)').run(activeId, archivedId);

  mgr.syncAllSleepingStates();

  const active = db.prepare('SELECT is_sleeping FROM characters WHERE id = ?').get(activeId);
  const archived = db.prepare('SELECT is_sleeping FROM characters WHERE id = ?').get(archivedId);
  assert.equal(active.is_sleeping, 1, '活跃角色处在睡眠时段 → 应被同步为睡眠（守卫）');
  assert.equal(archived.is_sleeping, 0, '归档角色不应被 cron 同步（保持原值；修复前会被置 1）');
});

test('守卫：归档角色即使被同步链查过，快照缺失时也不会被「顺手补建」（getTodayScheduleRaw 红线）', async t => {
  const db = getDb();
  t.after(() => closeDb());

  const archivedId = insertChar(db, '归档无快照', 1);
  // 不建快照 → 直接同步 → 不应产生任何快照行（归档禁止日程的既有守卫）
  mgr.syncSleepingState(archivedId);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM daily_schedules WHERE character_id = ?').get(archivedId);
  assert.equal(rows.n, 0, '归档角色不得被补建今日快照');
});
