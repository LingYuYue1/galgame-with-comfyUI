// 迁移（一次性）: 世界可以是「移动型」（载具）—— 角色日程可以出现在任何星球（2026-10-18）
//
// ── 用户原话 ──────────────────────────────────────────────
// 「一键编排日程的时候现在有这个所属世界了就可以按照所属世界去编排了，这样他们就会出现在
//   各自世界的地图里。但是只有一个世界是特殊的，星穹列车。这个世界的角色是可以随时出现在
//   任何星球的。」
//
// ── 要解决什么 ────────────────────────────────────────────
// T11 之后，日程地点一律从「角色归属世界」的地图里取（`buildAutoScheduleAreas`）。
// 这对仙舟、二维市这类「固定世界」是对的，但对**载具型世界**是错的：
//   星穹列车本身只有几节车厢，可它的角色白天可能停在罗浮、晚上停在二维市 ——
//   把她的日程锁死在"吧台 / 客房 / 走廊"里，等于把她关在车上。
//
// ── 所以这样设计 ──────────────────────────────────────────
//   · 新增 `is_vehicle`：标记「这是一个在外面跑的世界」。
//   · 标了它的世界，`buildAutoScheduleAreas` 会把**所有有地点的世界**都当作候选
//     （一半概率在本世界，一半概率停靠在别处），角色因此能落进任意星球的地图。
//   · 只影响"日程从哪儿取地点"，不改变世界文本的解析 —— 她仍然是列车上的人，
//     世界观还是那一套；只是今天可能下了车。
//
// ⚠ 首次执行会把名字含「星穹列车」的世界标为移动型（现有库里就这一个）。
//   这只是初始化；之后使用者在世界详情里可以自己开关。

export const id = '012_world_vehicle';
export const description = '世界可以是「移动型」（载具）：角色日程可出现在任何星球';

export function run(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(world_settings)').all();
    if (!cols.some(c => c.name === 'is_vehicle')) {
      db.exec(`ALTER TABLE world_settings ADD COLUMN is_vehicle INTEGER NOT NULL DEFAULT 0`);
      console.log('[migration] world_settings 增加 is_vehicle 列');
    }

    // 初始化：把「星穹列车」标成移动型。只在它还没被标记时做一次，
    // 避免使用者后来手动关掉、下次启动又被翻回来。
    const row = db.prepare(
      `SELECT id, is_vehicle FROM world_settings WHERE name LIKE '%星穹列车%' LIMIT 1`
    ).get();
    if (row && Number(row.is_vehicle) === 0) {
      db.prepare('UPDATE world_settings SET is_vehicle = 1 WHERE id = ?').run(row.id);
      console.log(`[migration] 已把「星穹列车」(id=${row.id}) 标为移动型世界`);
    }
  } catch (err) {
    console.log('[migration] 移动型世界迁移跳过:', err.message);
  }
}
