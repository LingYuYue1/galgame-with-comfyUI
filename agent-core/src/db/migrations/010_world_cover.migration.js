// 迁移（一次性）: 星图卡片封面图（2026-10-18）
//
// 用户要求：「让这个卡牌可以插入图片背景」。
//
// ── 为什么存 URL 而不存 base64 ─────────────────────────────
// 图片落在 `data/world-covers/`，DB 只存 `/world-covers/xxx.jpg` 这种短路径：
//   · listWorldSettings 每次都会被星图首页调用，塞 base64 会让列表接口膨胀几十倍；
//   · 换封面时能顺手删掉旧文件（存 base64 就只能靠 SQLite 自己膨胀）。
//
// 空字符串 = 没设封面（卡片回落为纯色/渐变），不是 NULL —— 与 tagline/visual_tone 同口径，
// 省掉下游一堆 null 判断。
//
// 幂等：加列前查 PRAGMA table_info（红线 5）。SQLite 限制：ADD COLUMN 带 NOT NULL 必须有默认值。

export const id = '010_world_cover';
export const description = '星图：world_settings 加 cover_image（卡片背景图 URL）';

export function run(db) {
  const tableExists = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'world_settings'`).get();
  if (!tableExists) return; // 空库兜底：依赖表由 initSchema 建

  const cols = db.prepare('PRAGMA table_info(world_settings)').all();
  if (!cols.some(c => c.name === 'cover_image')) {
    db.exec(`ALTER TABLE world_settings ADD COLUMN cover_image TEXT NOT NULL DEFAULT ''`);
    console.log('[migration] world_settings.cover_image 已就绪');
  }
}
