// 迁移（一次性数据归一）: 媒体发布序号（BUG-01）—— 2026-10-17
//
// ── 病是什么 ────────────────────────────────────────────────
// `media_posts.published_seq` 是后来用 ALTER 加的，**默认值是 0**：
//   0    = 升级前的旧帖（已展示，前端靠 COALESCE(NULLIF(...,0), id) 按 id 排序）
//   NULL = 待发布（配图齐后由 publishMediaPostIfReady 分配正数序号并广播）
// 但「图库 / 论坛」的批量落库（mediaService.insertDrafts）漏写了这一列 → 新帖吃默认 0
// → 发布判据把 0 当成「已发布」直接 return → 不广播 media_new_posts、不写正式序号。
// 结果：日志有「新增 N 条」、库里也有行，界面却要整页刷新才看得到（且只是占位卡）。
//
// ── 这条迁移做什么 ──────────────────────────────────────────
// 库里现在混着两套坐标系（正的 seq 与 0 回退到 id），两者数值空间重叠，按
// COALESCE(...) 排出来的时间线是"大概对、接缝处乱"（例：10-16 的帖压在 10-15 的帖上）。
// 这里把**所有已可见帖**（published_seq IS NOT NULL，含 0）按 created_at 重排成
// 1..N 的连续序号：既把 0 归一并消除，又把时间线接缝抹平。
// 之后：0 不再出现，`IS NOT NULL` 与 `> 0` 两种口径完全等价。
//
// ── 刻意不做什么 ────────────────────────────────────────────
// · 不碰 `published_seq IS NULL` 的真草稿 —— 它们是"等图"，不该被提前发布。
// · 不重建表改默认值（ALTER 改不了默认值；重建表风险远大于收益）——
//   改为在 db/index.js 与 insertDrafts 处立规矩：INSERT 必须显式写 NULL。
//
// ── 幂等 ─────────────────────────────────────────────────
// 用 system_settings 的一次性标记兜底（registry 的已应用记录是二次保护）；
// 表/列不存在（空库、老库未升级）直接跳过，不抛错。

export const id = '010_media_publication_sequence';
export const description = '媒体：published_seq 历史 0 归一 + 按创建时间重排序号（BUG-01）';

const MARKER = 'media_pubseq_renormalized_v1';

export function run(db) {
  const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_posts'").get();
  if (!tableExists) return;

  const cols = db.prepare('PRAGMA table_info(media_posts)').all().map(c => c.name);
  if (!cols.includes('published_seq')) return;

  const settingsExists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_settings'").get();
  if (settingsExists && db.prepare('SELECT 1 FROM system_settings WHERE setting_key = ?').get(MARKER)) return;

  // 只重排"已可见"的帖子：created_at 是 UTC 文本（定长，文本序 = 时间序），
  // 同秒落库的批次用 id 兜底保证确定性。
  const rows = db.prepare(`
    SELECT id FROM media_posts
    WHERE published_seq IS NOT NULL
    ORDER BY COALESCE(created_at, ''), id
  `).all();

  const update = db.prepare('UPDATE media_posts SET published_seq = ? WHERE id = ?');
  db.transaction(() => {
    rows.forEach((row, index) => update.run(index + 1, row.id));
    if (settingsExists) {
      // 发布游标必须跟到新的最大值，否则下一条新帖会拿到比历史帖更小的序号、插到时间线中间。
      db.prepare("INSERT OR REPLACE INTO system_settings (setting_key, setting_value) VALUES ('media_publication_sequence', ?)")
        .run(String(rows.length));
      db.prepare("INSERT OR REPLACE INTO system_settings (setting_key, setting_value) VALUES (?, '1')").run(MARKER);
    }
  })();

  if (rows.length) console.log(`[migration] 媒体发布序号已按时间重排（${rows.length} 条，0 已归一）`);
}
