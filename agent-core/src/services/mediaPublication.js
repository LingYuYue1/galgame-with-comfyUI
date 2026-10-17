import { getDb } from '../db/index.js';
import { broadcast } from './unifiedStreamBus.js';

// NULL = 待发布；0 = 升级前已展示的旧帖（沿用 id 游标）；正数 = 实际发布顺序。
//
// ⚠ 0 是「已发布」语义，不是「待发布」：历史实现里批量落库漏写该列、吃了 DEFAULT 0
//   （BUG-01），那种行会伪装成旧帖 —— 不发、不广播。病根已在 insertDrafts 修掉
//   （显式写 NULL），迁移 010 又把库里历史遗留的 0 按 created_at 重排成正式序号。
//   判据若把 0 当成待发布，会让真正的老帖被重新发布、凭空广播一轮「新内容」。
export const MEDIA_PUBLICATION_ORDER = 'COALESCE(NULLIF(p.published_seq, 0), p.id)';

export function mediaImagesReady(post) {
  let payload;
  try { payload = JSON.parse(post.payload_json || 'null'); } catch { return false; }
  const ready = item => !String(item?.image_prompt || '').trim() || !!item?.image;
  if (payload?.portal) return Array.isArray(payload.sections) && payload.sections.every(ready);
  return ready(post) && (!Array.isArray(payload?.panels) || payload.panels.every(ready));
}

export function isMediaPostPublished(postId) {
  return !!getDb().prepare('SELECT 1 FROM media_posts WHERE id = ? AND published_seq IS NOT NULL').get(postId);
}

/** 发布一次：配图齐全后才分配游标，晚完成的旧草稿仍排在最新位置。 */
export function publishMediaPostIfReady(postId) {
  const db = getDb();
  const published = db.transaction(() => {
    const post = db.prepare('SELECT * FROM media_posts WHERE id = ?').get(postId);
    // 只有「待发布(NULL)」才发布。0 **不能**当成待发布：它是升级前旧帖的「已展示」标记
    // （前端靠 COALESCE(NULLIF(...,0), id) 仍能按 id 排序可见）。把它当待发布会让老帖
    // 被重新发布一次、并凭空广播一轮「新内容」。
    // 真正的病根在落库侧（insertDrafts 漏写该列吃了默认值 0），那里已改为显式写 NULL；
    // 迁移 010 又把库里的历史 0 全部重排成正式序号 —— 两道之后，0 不应再出现。
    if (!post || post.published_seq !== null || !mediaImagesReady(post)) return null;
    const previous = Number(db.prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'media_publication_sequence'").pluck().get()) || 0;
    const lastId = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'media_posts'").pluck().get() || 0;
    const seq = Math.max(previous, lastId) + 1;
    const payload = JSON.parse(post.payload_json || 'null');
    const cover = post.image || (payload?.portal ? payload.sections.find(section => section.image)?.image : null) || null;
    db.prepare("INSERT OR REPLACE INTO system_settings (setting_key, setting_value) VALUES ('media_publication_sequence', ?)").run(String(seq));
    const updated = db.prepare("UPDATE media_posts SET published_seq = ?, image = ?, image_status = 'done', image_error = NULL WHERE id = ? AND published_seq IS NULL").run(seq, cover, postId);
    // 并发发布同一条时只有一方能改到行 —— 另一方不得广播第二次「新帖」。
    if (updated.changes !== 1) return null;
    return { outletId: post.outlet_id, postId, count: 1 };
  })();
  if (published) broadcast('media_new_posts', published);
  return !!published;
}
