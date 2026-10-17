import { getDb } from '../db/index.js';
import { broadcast } from './unifiedStreamBus.js';

// NULL = 待发布；正数 = 实际发布顺序。
// 0 = 历史脏值：建表 ALTER 的 DEFAULT 0 把「新帖漏写该列」与「升级前的旧帖」混在了一起，
//     迁移 010 已把库里所有 0 归一成按时间排好的正数序号，此后不应再出现 0。
//     `MEDIA_PUBLICATION_ORDER` 的 NULLIF 保留，是为了老库在迁移执行前也能正确排序。
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
    // 只有「待发布(NULL)」才发布。0 是历史上的默认值脏数据（见文件头注），不能当成已发布 ——
    // 否则漏写 published_seq 的批次会永远卡在 0、不广播。迁移 010 之后库里已无 0，
    // 这里保留 `> 0` 判断是第二道防线：即便再有 0 漏网，也宁可补发布一次。
    if (!post || Number(post.published_seq) > 0 || !mediaImagesReady(post)) return null;
    const previous = Number(db.prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'media_publication_sequence'").pluck().get()) || 0;
    const lastId = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'media_posts'").pluck().get() || 0;
    const seq = Math.max(previous, lastId) + 1;
    const payload = JSON.parse(post.payload_json || 'null');
    const cover = post.image || (payload?.portal ? payload.sections.find(section => section.image)?.image : null) || null;
    db.prepare("INSERT OR REPLACE INTO system_settings (setting_key, setting_value) VALUES ('media_publication_sequence', ?)").run(String(seq));
    const updated = db.prepare("UPDATE media_posts SET published_seq = ?, image = ?, image_status = 'done', image_error = NULL WHERE id = ? AND (published_seq IS NULL OR published_seq = 0)").run(seq, cover, postId);
    // 并发发布同一条时只有一方能改到行 —— 另一方不得广播第二次「新帖」。
    if (updated.changes !== 1) return null;
    return { outletId: post.outlet_id, postId, count: 1 };
  })();
  if (published) broadcast('media_new_posts', published);
  return !!published;
}
