/**
 * F-42 回归测试：保护集必须覆盖「奇遇记录 / 报纸记录 / 消息正文」对图的引用。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `buildProtectedSet` 原先只扫 `messages.images` / `moment_posts.images` / 7 个单值字段——
 * 「仍被保留的记录」通过其它形态对图的引用全部漏掉：
 *   · 奇遇记录：`event_history.final_image`、`event_history.choice_history`（JSON 文本）、
 *     `character_events.image`、`character_events.choice_history`
 *   · 报纸记录：`town_newspapers.items_json / character_event_json / world_state_json`
 *   · 消息正文：`messages.content`（奇遇消息 JSON 里的 `"image":"/images/events/..."`）
 * 于是「奇遇配图 / 报纸配图」的本体图（真实库实查：events 29 个文件 28 个被引用、
 * newspaper 18 个全部被引用）在清理时被当孤儿误删 → 历史回看 / 报纸墙破图。
 * 模块注释与界面文案都承诺过「仍被保留的记录所引用的图片不会删」——本修复兑现之。
 *
 * ── 本文件钉住 ──────────────────────────────────────────────
 * ① 奇遇记录（4 个字段全覆盖）引用的老图 → 保留；无引用孤儿 → 照删（不过度保护）；
 * ② 报纸记录（3 个 JSON 列）引用的老图 → 保留；孤儿 → 照删；
 * ③ 消息正文引用：不清 messages 时全量保护；清 chat 时按存活子集（新消息引用保留、
 *    只被删消息引用的可删）——与 F-10 既有口径一致。
 *
 * ⚠ 临时库 + 临时 IMAGES_DIR，不碰真实数据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-cleanrefs-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');   // ⚠ 先于 imagePaths 加载
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

const OLD_MTIME = new Date(Date.now() - 30 * 86400_000);
function putImage(dirName, name) {
  const d = path.join(TMP_DIR, 'images', dirName);
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, name);
  fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.utimesSync(p, OLD_MTIME, OLD_MTIME);
}
const has = (dirName, name) => fs.existsSync(path.join(TMP_DIR, 'images', dirName, name));

// ── 造图（全部 30 天前 → 老于 7 天窗口）──
putImage('events', 'ev_final.png');     // event_history.final_image 引用
putImage('events', 'ev_choice.png');    // event_history.choice_history 引用
putImage('events', 'ev_char.png');      // character_events.image 引用
putImage('events', 'ev_char2.png');     // character_events.choice_history 引用
putImage('events', 'ev_orphan.png');    // 无引用 → 应删
putImage('events', 'ev_live.png');      // 新消息 content 引用 → 应保留
putImage('events', 'ev_dead.png');      // 只被老消息 content 引用 → 清 chat 后应删
putImage('newspaper', 'np_items.png');  // items_json 引用
putImage('newspaper', 'np_char.png');   // character_event_json 引用
putImage('newspaper', 'np_world.png');  // world_state_json 引用
putImage('newspaper', 'np_orphan.png'); // 无引用 → 应删

const { getDb, closeDb } = await import('../src/db/index.js');
const { purgeData } = await import('../src/services/dataCleanup.js');

const db = getDb();
const sqlTime = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);

// 角色（event_history / character_events 的 FK 依赖）
const charId = db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('c1', '测试角色', '测试用')`).run().lastInsertRowid;

// 奇遇记录：finished 用 final_image + choice_history 两种引用形态
db.prepare(`INSERT INTO event_history (character_id, title, final_image, choice_history) VALUES (?, ?, ?, ?)`)
  .run(charId, '旧奇遇', '/images/events/ev_final.png',
    JSON.stringify([{ text: '分支A', image: '/images/events/ev_choice.png' }]));
// 进行中奇遇：image + choice_history
db.prepare(`INSERT INTO character_events (character_id, event_type_key, expires_at, image, choice_history) VALUES (?, ?, ?, ?, ?)`)
  .run(charId, 'test_key', sqlTime(-86400_000), '/images/events/ev_char.png',
    JSON.stringify([{ text: '分支B', image: '/images/events/ev_char2.png' }]));

// 报纸记录：三个 JSON 列各引一张
db.prepare(`INSERT INTO town_newspapers (publish_date, items_json, character_event_json, world_state_json) VALUES (?, ?, ?, ?)`)
  .run('2025-01-01',
    JSON.stringify([{ category: '民生', image: '/images/newspaper/np_items.png' }]),
    JSON.stringify({ image: '/images/newspaper/np_char.png', character_name: '测试' }),
    JSON.stringify({ image: '/images/newspaper/np_world.png' }));

// 消息正文（content JSON 里的图链）：新消息（1 天前）+ 老消息（8 天前）
const insMsg = db.prepare(`INSERT INTO messages (conversation_id, role, content, images, created_at) VALUES ('char_1', 'assistant', ?, NULL, ?)`);
insMsg.run(JSON.stringify({ text: '新奇遇', image: '/images/events/ev_live.png' }), sqlTime(1 * 86400_000));
insMsg.run(JSON.stringify({ text: '老奇遇', image: '/images/events/ev_dead.png' }), sqlTime(8 * 86400_000));

test('① 奇遇记录（event_history / character_events）引用的老图保留，孤儿照删', async () => {
  const r = await purgeData({ days: 7, targets: ['events'] });
  assert.equal(r.partial, false, `不应有 partial 失败：${JSON.stringify(r.errors)}`);
  // 先守卫（修复前后都应成立）：
  assert.ok(!has('events', 'ev_orphan.png'), 'ev_orphan.png 无任何引用，应被清理（保护集不能过度保护）');
  // 后主断言（修复前红）：
  assert.ok(has('events', 'ev_final.png'), 'ev_final.png 被 event_history.final_image 引用，应保留（修复前被误删）');
  assert.ok(has('events', 'ev_choice.png'), 'ev_choice.png 被 event_history.choice_history 引用，应保留（修复前被误删）');
  assert.ok(has('events', 'ev_char.png'), 'ev_char.png 被 character_events.image 引用，应保留（修复前被误删）');
  assert.ok(has('events', 'ev_char2.png'), 'ev_char2.png 被 character_events.choice_history 引用，应保留（修复前被误删）');
});

test('② 报纸记录（town_newspapers 三 JSON）引用的老图保留，孤儿照删', async () => {
  const r = await purgeData({ days: 7, targets: ['newspaper'] });
  assert.equal(r.partial, false, `不应有 partial 失败：${JSON.stringify(r.errors)}`);
  assert.ok(!has('newspaper', 'np_orphan.png'), 'np_orphan.png 无引用，应被清理');
  assert.ok(has('newspaper', 'np_items.png'), 'np_items.png 被 items_json 引用，应保留（修复前被误删）');
  assert.ok(has('newspaper', 'np_char.png'), 'np_char.png 被 character_event_json 引用，应保留（修复前被误删）');
  assert.ok(has('newspaper', 'np_world.png'), 'np_world.png 被 world_state_json 引用，应保留（修复前被误删）');
});

test('③ 消息正文引用：不清 messages 时全量保护；清 chat 时按存活子集（F-10 口径）', async () => {
  // 阶段一：清 events、不动 messages → 新老消息正文的引用都受保护
  let r = await purgeData({ days: 7, targets: ['events'] });
  assert.equal(r.partial, false, `不应有 partial 失败：${JSON.stringify(r.errors)}`);
  assert.ok(has('events', 'ev_live.png'), 'ev_live.png 被 1 天前消息正文引用，应保留（修复前被误删）');
  assert.ok(has('events', 'ev_dead.png'), 'ev_dead.png 被 8 天前消息正文引用、但本次不删 messages，应保留（修复前被误删）');

  // 阶段二：清 chat + events → 老消息被删；只被它引用的 ev_dead 变孤儿可删；新消息的 ev_live 仍保留
  r = await purgeData({ days: 7, targets: ['chat', 'events'] });
  assert.equal(r.partial, false, `不应有 partial 失败：${JSON.stringify(r.errors)}`);
  assert.ok(has('events', 'ev_live.png'), 'ev_live.png 被存活（新）消息引用，清 chat 后仍应保留');
  assert.ok(!has('events', 'ev_dead.png'), 'ev_dead.png 只被已删消息引用，应随清理被删（存活子集：不过度保护）');
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
