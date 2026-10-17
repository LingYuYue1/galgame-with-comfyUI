/**
 * BUG-01 回归：媒体发布序号
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * 图库 / 论坛批次的 INSERT（`mediaService.insertDrafts`）漏写了 `published_seq`，
 * 吃 ALTER 的 `DEFAULT 0`；而 0 被发布判据当成「已发布」→ 不广播 media_new_posts、
 * 不写正式序号、不置 image_status='done'。前端完全依赖这条 SSE 增量刷新，
 * 于是「日志说有新增、库里也有行，界面却要整页刷新才看得到」。
 *
 * ── 本文件钉住 ──────────────────────────────────────────────
 * ① 图库批次落库后 `published_seq` 必须是 NULL（待发布），不是 0；
 * ② 0 是「升级前已展示」的旧帖标记 —— 不得被重新发布（否则老帖会凭空广播一轮）；
 * ③ 迁移 010 把已可见帖按 created_at 重排成 1..N，真草稿（NULL）不被顺手发布。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

process.env.DB_PATH = ':memory:';
const requests = [];
const responses = [];
const imageModule = new URL('../src/services/imageSkill.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === imageModule) return {
      format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(`${imageModule}?actual`)};
        export const generateImageRaw = async () => ({ success: false, images: [] });`,
    };
    return nextLoad(url, context);
  },
});
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://media-seq-test.invalid/v1/chat/completions');
  requests.push(JSON.parse(options.body));
  assert.ok(responses.length, 'unexpected external request');
  return new Response(JSON.stringify({
    choices: [{ message: { content: responses.shift() }, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } });
};
await import('openai/shims/web');
const { getDb, closeDb } = await import('../src/db/index.js');
const { config } = await import('../src/config.js');
const { createOutlet, generateMediaBatch, fillPendingImages } = await import('../src/services/mediaService.js');
const { publishMediaPostIfReady } = await import('../src/services/mediaPublication.js');
const { addClient, removeClient } = await import('../src/services/unifiedStreamBus.js');
const migration = await import('../src/db/migrations/010_media_publication_sequence.migration.js');

config.llm.freeEgg = false;
config.llm._baseURL = 'https://media-seq-test.invalid/v1';
config.llm._apiKey = 'test-only';
after(async () => { await fillPendingImages(0); hooks.deregister(); closeDb(); });

test('图库批次落库必须是待发布（NULL），不能吃 DEFAULT 0', async () => {
  const db = getDb();
  db.prepare('DELETE FROM media_posts').run();
  const outlet = createOutlet({ name: '序号回归图站', prompt: '测试图库', layout: 'gallery' });
  responses.push(JSON.stringify({
    posts: [{ board: '', title: '窗边的午后', content: '作者备注一句', author: '匿名网友', likes: 12, views: 340 }],
  }));
  const result = await generateMediaBatch({ outletId: outlet.id, count: 1, withCharacters: false });
  assert.equal(result.inserted, 1);
  const row = db.prepare('SELECT id, published_seq, image_status FROM media_posts WHERE outlet_id = ?').get(outlet.id);
  assert.equal(row.published_seq, null, 'published_seq 必须是 NULL —— 0 会被发布判据当成「已发布」');
  // 配图状态取决于后台补图是否已跑（本用例把生图桩成失败），这里只钉「还没发布」即可。
  assert.ok(['pending', 'failed'].includes(row.image_status), `image_status 意外：${row.image_status}`);
  // 收尾：把这张草稿发出去，避免它在后续用例里停留在待发布态。
  db.prepare("UPDATE media_posts SET image = '/seq-cover.png' WHERE id = ?").run(row.id);
  publishMediaPostIfReady(row.id);
});

test('0 是旧帖标记：不得被重新发布（否则老帖会凭空广播一轮）', () => {
  const db = getDb();
  db.prepare('DELETE FROM media_posts').run();
  const outlet = createOutlet({ name: '零序号回归', prompt: '测试', layout: 'feed' });
  const legacy = Number(db.prepare(`INSERT INTO media_posts
    (outlet_id, title, content, image, image_prompt, image_status, published_seq)
    VALUES (?, '旧帖', '正文', '/zero.png', 'cover', 'pending', 0)`).run(outlet.id).lastInsertRowid);
  const draft = Number(db.prepare(`INSERT INTO media_posts
    (outlet_id, title, content, image, image_prompt, image_status, published_seq)
    VALUES (?, '新草稿', '正文', '/new.png', 'cover', 'pending', NULL)`).run(outlet.id).lastInsertRowid);

  const events = [];
  const client = { write: value => events.push(value) };
  addClient(client);
  try {
    assert.equal(publishMediaPostIfReady(legacy), false, '0 = 升级前已展示的旧帖，不能当待发布');
    assert.equal(publishMediaPostIfReady(draft), true, 'NULL = 待发布，配图齐了就要发');
    assert.equal(publishMediaPostIfReady(draft), false, '同一条只能发布一次');
    const row = db.prepare('SELECT published_seq, image_status FROM media_posts WHERE id = ?').get(draft);
    assert.ok(row.published_seq > 0, '必须分配到正数序号');
    assert.equal(row.image_status, 'done');
    assert.equal(events.filter(e => e.startsWith('event: media_new_posts\n')).length, 1);
  } finally { removeClient(client); }
});

test('迁移 010：已可见帖按 created_at 重排 1..N，真草稿保持 NULL', () => {
  const db = getDb();
  db.prepare('DELETE FROM media_posts').run();
  db.prepare("DELETE FROM system_settings WHERE setting_key IN ('media_pubseq_renormalized_v1', 'media_publication_sequence')").run();
  const outlet = createOutlet({ name: '迁移回归', prompt: '测试', layout: 'feed' });
  const insert = db.prepare(`INSERT INTO media_posts
    (outlet_id, title, content, image, image_prompt, image_status, published_seq, created_at)
    VALUES (?, ?, '正文', '/x.png', 'cover', 'done', ?, ?)`);
  const oldDirty = Number(insert.run(outlet.id, '旧脏 0', 0, '2026-10-01 10:00:00').lastInsertRowid);
  const middleDirty = Number(insert.run(outlet.id, '中间 0', 0, '2026-10-03 10:00:00').lastInsertRowid);
  const published = Number(insert.run(outlet.id, '已发布 50', 50, '2026-10-02 10:00:00').lastInsertRowid);
  const draft = Number(insert.run(outlet.id, '真草稿', null, '2026-10-04 10:00:00').lastInsertRowid);

  migration.run(db);

  const seq = id => db.prepare('SELECT published_seq FROM media_posts WHERE id = ?').pluck().get(id);
  assert.equal(seq(oldDirty), 1);
  assert.equal(seq(published), 2, '已发布的帖也要按时间参与统一重排，否则时间线接缝对不上');
  assert.equal(seq(middleDirty), 3);
  assert.equal(seq(draft), null, 'NULL = 等图的真草稿，不能被迁移顺手发布');
  assert.equal(
    db.prepare("SELECT setting_value FROM system_settings WHERE setting_key = 'media_publication_sequence'").pluck().get(),
    '3',
    '发布游标必须跟到新的最大值，否则新帖会插到时间线中间',
  );

  // 幂等：再跑一次不得重排（一次性标记已落库）
  db.prepare('UPDATE media_posts SET published_seq = 99 WHERE id = ?').run(published);
  migration.run(db);
  assert.equal(seq(published), 99, '迁移必须幂等，第二次执行不得改动数据');
});
