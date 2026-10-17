// 迁移（一次性）: 星图 T15 —— 跨世界旅程（在途时间代价）（2026-10-17）
//
// 用户拍板（2026-10-16 23:50）：「角色不可能是一瞬间到达的」→ 移动 = 发起旅程 →
// **在途状态**（旅途语境）→ 到达改绑。本表存的就是「谁、从哪、去哪、走到哪一步」。
//
// ── 为什么用轻表而不是角色字段 ──────────────────────────────
// 角色字段只能记「当前那一段」，历史就没了；将来要支持多段/往返/中转也不受限。
// 角色侧不新增任何列 —— 在途信息**全部**从本表推，避免两处状态各说各话。
//
// ── 时间口径（踩过坑，写死在注释里）────────────────────────
// 全部走 SQLite 的 `datetime('now')`，即 **UTC 文本** `YYYY-MM-DD HH:MM:SS`。
// 定长格式下文本比较等价于时间比较，所以「到期」判据直接写
// `arrive_at <= datetime('now')`，不要拉回 JS 里比（本地时区会把 UTC 当本地，差 8 小时）。
//
// ── 幂等 ─────────────────────────────────────────────────
// CREATE TABLE / INDEX 全部 IF NOT EXISTS（红线 5），重复执行安全。

export const id = '009_character_trips';
export const description = '星图 T15：character_trips 跨世界旅程表（在途状态 + 到达改绑）';

export function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_trips (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id  INTEGER NOT NULL,
      from_world_id INTEGER,                              -- 出发时快照；NULL = 当时未归属（跟随激活世界）
      to_world_id   INTEGER NOT NULL,                     -- 目的地世界
      status        TEXT NOT NULL DEFAULT 'transit',      -- transit 在途 | arrived 已到达 | cancelled 已取消
      transport     TEXT NOT NULL DEFAULT 'train',        -- train 列车 | ship 星舰 | walk 步行
      scene         TEXT NOT NULL DEFAULT '',             -- 旅途语境正文（空 → 由内置模板按 from/to 拼）
      note          TEXT NOT NULL DEFAULT '',             -- 用户备注（如「顺路去看她」）
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      arrive_at     TEXT NOT NULL,                        -- UTC；到期判据统一在 SQL 里比
      arrived_at    TEXT,                                 -- 实际结算时刻（UTC）
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- 查「某角色此刻在不在途」是最高频的一次查询（每次取世界观都会走）→ 先落这个
    CREATE INDEX IF NOT EXISTS idx_trips_char_status ON character_trips(character_id, status);
    -- 调度器每秒/每分钟扫到期：status + arrive_at 组合索引
    CREATE INDEX IF NOT EXISTS idx_trips_due ON character_trips(status, arrive_at);
  `);
  console.log('[migration] 跨世界旅程表就绪（character_trips）');
}
