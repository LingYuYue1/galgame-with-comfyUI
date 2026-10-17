// 迁移（一次性）: 星图（多世界系统）基础字段（2026-10-17）
//
// world_settings（世界）加三列：
//   · tagline      星图卡片一句话气质
//   · visual_tone  视觉基调 ≤60 字（拼入生图环境层）
//   · is_enabled   世界开关（1 启用 / 0 休眠；休眠不参与媒体抽卡与后台任务）
// characters（角色）加一列：
//   · world_setting_id  角色「所在/归属世界」（可空 = 未归属，读取回落激活世界）
//
// 幂等：加列前查 PRAGMA table_info（红线 5）。
// SQLite 限制：ADD COLUMN 带 NOT NULL 必须有非空默认值；本迁移不建外键。

export const id = '008_world_columns';
export const description = '星图：world_settings 加 tagline/visual_tone/is_enabled；characters 加 world_setting_id';

export function run(db) {
  const has = (cols, name) => cols.some((c) => c.name === name);
  const tableExists = (name) =>
    !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

  // 空库兜底：表不存在则跳过（依赖表由 initSchema 建；本迁移只负责给老库补列）
  if (tableExists('world_settings')) {
    const wsCols = db.prepare('PRAGMA table_info(world_settings)').all();
    if (!has(wsCols, 'tagline')) {
      db.exec(`ALTER TABLE world_settings ADD COLUMN tagline TEXT NOT NULL DEFAULT ''`);
    }
    if (!has(wsCols, 'visual_tone')) {
      db.exec(`ALTER TABLE world_settings ADD COLUMN visual_tone TEXT NOT NULL DEFAULT ''`);
    }
    if (!has(wsCols, 'is_enabled')) {
      db.exec(`ALTER TABLE world_settings ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 1`);
    }
  }

  if (tableExists('characters')) {
    const chCols = db.prepare('PRAGMA table_info(characters)').all();
    if (!has(chCols, 'world_setting_id')) {
      db.exec(`ALTER TABLE characters ADD COLUMN world_setting_id INTEGER`);
    }
  }
}
