/**
 * BUG-03 回归：相册来源反查
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * 相册是**纯磁盘扫描**（galleryCache），从不 join `image_tasks` → 每张图都不知道是谁要的。
 * 来源数据一直在：`image_tasks.conversation_id` 存标签（`char_4_moments` / `media_post` …），
 * `output_paths` 存图片 URL。本文件钉住「按 URL 反查 → 人话来源」这套口径。
 *
 * ── 本文件钉住 ──────────────────────────────────────────────
 * ① URL 归一（去 query / decode / 末两段）+ PNG↔AVIF 变体都能对上；
 * ② 角色链路 → 「朋友圈 · 三月七」，传媒链路 → 「传媒 · 规则34」（出口名从 media_posts 反查）；
 * ③ 查不到 → 「未知来源」，不硬猜。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('来源解析测试不得访问外网'); };
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  normalizeImageKey, describeConversationId, buildImageSourceIndex, attachSource,
} = await import('../src/services/imageSourceResolver.js');
after(() => closeDb());

function seedCharacter(id, displayName) {
  getDb().prepare(`INSERT INTO characters (id, name, display_name, base_prompt, emotion_baseline)
    VALUES (?, ?, ?, '', '')`).run(id, `char${id}`, displayName);
}

function seedOutlet(name) {
  return Number(getDb().prepare(`INSERT INTO media_outlets (name, tagline, prompt, icon, sort_order, enabled, layout)
    VALUES (?, '', '测试', '', 0, 1, 'gallery')`).run(name).lastInsertRowid);
}

function seedTask(conversationId, paths) {
  getDb().prepare(`INSERT INTO image_tasks (conversation_id, prompt_original, output_paths, status, finished_at)
    VALUES (?, 'a prompt', ?, 'done', datetime('now'))`).run(conversationId, JSON.stringify(paths));
}

test('URL 归一：query / 编码 / 反斜杠 / 末两段', () => {
  assert.equal(normalizeImageKey('/images/moments/a%20b.png?_t=123'), 'moments/a b.png');
  assert.equal(normalizeImageKey('E:\\data\\images\\standing\\x.avif'), 'standing/x.avif');
  assert.equal(normalizeImageKey('https://host/images/media/c.png'), 'media/c.png');
  assert.equal(normalizeImageKey(''), '');
});

test('conversation_id → 来源与角色（不认识的标签返回 null）', () => {
  const names = new Map([[4, '三月七']]);
  assert.equal(describeConversationId('char_4_moments', names).source_label, '朋友圈 · 三月七');
  assert.equal(describeConversationId('char_4', names).source, '聊天');
  assert.equal(describeConversationId('char_14_event_48_branch_1', names).source, '奇遇');
  assert.equal(describeConversationId('char_4_schedule_peek_retake', names).source, '日程一瞥');
  assert.equal(describeConversationId('media_post', names).source_label, '传媒');
  assert.equal(describeConversationId('town_newspaper', names).source_label, '小镇 · 日报');
  assert.equal(describeConversationId('something_else', names), null);
});

test('索引：角色图与传媒图都能给出人话来源，查不到给未知来源', () => {
  const db = getDb();
  db.prepare('DELETE FROM image_tasks').run();
  db.prepare('DELETE FROM media_posts').run();
  db.prepare('DELETE FROM media_outlets').run();
  db.prepare('DELETE FROM characters').run();
  seedCharacter(4, '三月七');
  const outletId = seedOutlet('规则34');
  db.prepare(`INSERT INTO media_posts (outlet_id, title, content, image, image_status, published_seq)
    VALUES (?, '传媒帖', '正文', '/images/media/media_1.png', 'done', 1)`).run(outletId);
  // 门户板块图只存在 payload_json 里 —— 反查必须认这条口径
  db.prepare(`INSERT INTO media_posts (outlet_id, title, content, payload_json, image_status, published_seq)
    VALUES (?, '门户帖', '正文', ?, 'done', 2)`).run(outletId, JSON.stringify({
    portal: true, sections: [{ image: '/images/media/media_2.png' }],
  }));

  seedTask('char_4_moments', ['/images/moments/m_1.png']);
  seedTask('media_post', ['/images/media/media_1.png']);
  seedTask('media_portal_section', ['/images/media/media_2.png']);

  const index = buildImageSourceIndex(db);

  assert.equal(attachSource({ url: '/images/moments/m_1.png' }, index).source_label, '朋友圈 · 三月七');
  assert.equal(attachSource({ url: '/images/media/media_1.png' }, index).source_label, '传媒 · 规则34');
  assert.equal(attachSource({ url: '/images/media/media_2.png' }, index).source_label, '传媒 · 门户 · 规则34');

  const withQuery = attachSource({ url: '/images/moments/m_1.png?_t=99' }, index);
  assert.equal(withQuery.character_id, 4, '缓存失效参数不影响反查');

  const unknown = attachSource({ url: '/images/moments/nobody.png' }, index);
  assert.equal(unknown.source_label, '未知来源');
  assert.equal(unknown.character_id, null);

  // 压缩替换：PNG 记录要能对上磁盘上的 AVIF 同名文件
  seedTask('char_4_moments', ['/images/moments/compressed.png']);
  const index2 = buildImageSourceIndex(db);
  assert.equal(attachSource({ url: '/images/moments/compressed.avif' }, index2).character_name, '三月七');
});
