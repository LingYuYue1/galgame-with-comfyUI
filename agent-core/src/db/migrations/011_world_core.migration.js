// 迁移（一次性）: 世界分两层 —— 「主世界（骨架）」+ 「副世界（具体世界）」（2026-10-18）
//
// ── 用户原话 ──────────────────────────────────────────────
// 「放一个主世界观，这个世界观并不是多大的世界，而是一个通用的兼容规则……这里主要写骨架，
//   并不当做世界使用，这个主世界观当做常激活的状态。其他世界都为启用的副世界观。
//   这样，角色读取生成内容时候会读取主世界框架 + 自己锁绑定的世界观，
//   这样即使没有归属，那些角色也有最基础的世界骨架使用。」
//
// ── 要解决什么 ────────────────────────────────────────────
// 改之前「激活」是**唯一的兜底世界**：没归属的角色直接吃激活世界的全文。
// 于是把「二维市」设为激活之后，景元、银狼、符玄、三月七、青雀全都跑去按二相乐园说话。
// 这是"一个具体世界冒充全局默认值"造成的事故，不是使用者操作错。
//
// ── 所以这样设计 ──────────────────────────────────────────
//   · 新增 `is_core`：标记「主世界」。它是**骨架层**，永远叠加，不做具体世界用。
//   · 全局唯一：写入时保证同时只有一个 is_core=1。
//   · 解析顺序变成：主世界（框架） + 角色绑定的世界（具体）；未绑定 → 只有主世界。
//   · `is_active` 不再是"谁是默认世界"的开关（保留列是为了回滚与历史数据），
//     主世界建立后把它全部置 0 —— 避免两个字段同时声称自己是默认。
//
// ⚠ 首次执行会自动建一个**空的**主世界「世界框架」，等使用者自己写通用规则。
//   为什么不把现有某个世界直接升为主世界：现存的都是具体世界（仙舟罗浮 / 二维市），
//   升上去会立刻成为所有角色的公共骨架 —— 那是把污染范围从"未归属角色"扩大到"全部角色"。

export const id = '011_world_core';
export const description = '世界分两层：主世界（骨架，常驻叠加）+ 副世界（具体世界）';

export function run(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(world_settings)').all();
    if (!cols.some(c => c.name === 'is_core')) {
      db.exec(`ALTER TABLE world_settings ADD COLUMN is_core INTEGER NOT NULL DEFAULT 0`);
      console.log('[migration] world_settings 增加 is_core 列');
    }

    const hasCore = db.prepare('SELECT COUNT(*) AS n FROM world_settings WHERE is_core = 1').get().n;
    if (hasCore > 0) {
      console.log('[migration] 主世界已存在，跳过初始化');
      return;
    }

    // 主世界：骨架层，正文留给使用者写（这里只给一句占位说明，避免"空世界"看起来像故障）
    db.prepare(`
      INSERT INTO world_settings (name, content, tagline, visual_tone, is_active, is_enabled, is_core, sort_order)
      VALUES (?, ?, ?, '', 0, 1, 1, -1)
    `).run(
      '世界框架',
      '',
      '所有世界共用的基础规则（骨架层，常驻叠加）',
    );

    // 旧语义的"激活"全部退位：默认世界从此由 is_core 决定
    const cleared = db.prepare('UPDATE world_settings SET is_active = 0 WHERE is_core = 0').run();
    console.log(`[migration] 已建立主世界「世界框架」，并把 ${cleared.changes} 个旧激活标记清掉（改为副世界）`);
  } catch (err) {
    console.log('[migration] 世界分层迁移跳过:', err.message);
  }
}
