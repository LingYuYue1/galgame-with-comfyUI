// 迁移（一次性）: image_tasks 增 `anchor_ref` —— 记下"这张图当时注入的是哪份角色锚点"（2026-10-22）
//
// ── 为什么需要这一列 ──────────────────────────────────────
// 从今天起，生图提示词最前面会由代码拼一段角色锚点（character_outfits.body + 当前服装）。
// 锚点本身已经并进 `prompt_refined`，但那张表存的是**整段提示词**，
// 事后想回答"这张图当时用的是哪份锚点、有没有注入"只能靠肉眼翻字符串。
//
// 单独留一列之后：
//   · `SELECT count(*) FROM image_tasks WHERE anchor_ref IS NOT NULL` → 锚点到达率
//   · 某张图画错了人 → 直接看它当时用的锚点，和现在的 body 一比对就知道是锚点过期还是模型没听
//
// ⚠ 历史行保持 NULL（当时确实没有锚点），不做回填 —— 回填就等于伪造记录。

export const id = '013_image_task_anchor';
export const description = 'image_tasks 增 anchor_ref：记录本次注入的角色锚点文本';

export function run(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(image_tasks)').all();
    if (!cols.some(c => c.name === 'anchor_ref')) {
      db.exec(`ALTER TABLE image_tasks ADD COLUMN anchor_ref TEXT`);
      console.log('[migration] image_tasks 增加 anchor_ref 列');
    }
  } catch (err) {
    // 空库 / 表还没建：initSchema 的建表语句里已经有这一列，这里跳过即可
    console.log('[migration] image_tasks.anchor_ref 迁移跳过:', err.message);
  }
}
