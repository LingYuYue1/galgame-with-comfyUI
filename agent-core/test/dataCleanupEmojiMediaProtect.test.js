/**
 * F-46 回归测试：保护集补全「表情图两列 + 传媒 payload 图」。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `buildProtectedSet` 的「单值图片字段」清单（PROTECT_SINGLE_FIELDS）漏了表情功能的两列：
 *   · `user_emojis.image_path`（我的表情库）
 *   · `character_emojis.image_path`（角色表情包）
 * 而这两张表的记录**不在任何清理目标里**（「表情包」目标 `emoji` 只清 emoji 目录的图）
 * → 记录永远在、图却被当孤儿删掉（表情库里全破图）。注释「这些表的记录不在清理范围内，
 * **一律**参与保护集」= 意图存在、清单未达成。
 *
 * 另经全库普查（2026-10-14）发现同类漏项：`media_posts.payload_json`（传媒海报/门户的
 * panels[].image / sections[].image，真实库 7 行）——mediaService 的孤儿清理（F-02）早已
 * 把 payload 图纳入保护，dataCleanup 却没接 → 两个清理器口径不一致，「传媒配图」清理
 * 会把仍被帖子引用的图误删。
 *
 * ── 本文件钉住 ──────────────────────────────────────────────
 * ① 清「表情包」目标：user_emojis / character_emojis 引用的老图保留；无引用孤儿照删；
 * ② 清「传媒配图」目标：payload_json 引用的老图保留；孤儿照删。
 *
 * ⚠ 临时库 + 临时 IMAGES_DIR，不碰真实数据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-emojiprot-'));
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
putImage('emoji', 'em_user.png');     // user_emojis.image_path 引用
putImage('emoji', 'em_char.png');     // character_emojis.image_path 引用
putImage('emoji', 'em_orphan.png');   // 无引用 → 应删
putImage('media', 'm_payload.png');   // media_posts.payload_json 引用
putImage('media', 'm_orphan.png');    // 无引用 → 应删

const { getDb, closeDb } = await import('../src/db/index.js');
const { purgeData } = await import('../src/services/dataCleanup.js');

const db = getDb();

// 角色（emoji_sets / character_emojis 的外键依赖）
const charId = db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('c1', '测试角色', '测试用')`).run().lastInsertRowid;

// 用户表情库
db.prepare(`INSERT INTO user_emojis (emoji_key, prompt, image_path, status) VALUES ('测试表情', 'prompt', ?, 'done')`)
  .run('/images/emoji/em_user.png');

// 角色表情包（set + 条目）
const setId = db.prepare(`INSERT INTO emoji_sets (character_id, name, is_active) VALUES (?, '默认', 1)`).run(charId).lastInsertRowid;
db.prepare(`INSERT INTO character_emojis (character_id, set_id, emoji_key, prompt, image_path, status) VALUES (?, ?, '卖萌', 'prompt', ?, 'done')`)
  .run(charId, setId, '/images/emoji/em_char.png');

// 传媒帖子（payload 里嵌图；outlet 为外键依赖）
const outletId = db.prepare(`INSERT INTO media_outlets (name) VALUES ('测试媒体')`).run().lastInsertRowid;
db.prepare(`INSERT INTO media_posts (outlet_id, title, content, image_status, payload_json) VALUES (?, '海报帖', '正文', 'done', ?)`)
  .run(outletId, JSON.stringify({ panels: [{ image: '/images/media/m_payload.png' }, { image: null }] }));

test('① 清「表情包」：user_emojis / character_emojis 引用的老图保留，孤儿照删', async () => {
  const r = await purgeData({ days: 7, targets: ['emoji'] });
  assert.equal(r.partial, false, `不应有 partial 失败：${JSON.stringify(r.errors)}`);
  // 先守卫（修复前后都应成立）：
  assert.ok(!has('emoji', 'em_orphan.png'), 'em_orphan.png 无任何引用，应被清理（保护集不能过度保护）');
  // 后主断言（修复前红）：
  assert.ok(has('emoji', 'em_user.png'), 'em_user.png 被 user_emojis.image_path 引用，应保留（修复前被误删）');
  assert.ok(has('emoji', 'em_char.png'), 'em_char.png 被 character_emojis.image_path 引用，应保留（修复前被误删）');
});

test('② 清「传媒配图」：payload_json 引用的老图保留，孤儿照删', async () => {
  const r = await purgeData({ days: 7, targets: ['media'] });
  assert.equal(r.partial, false, `不应有 partial 失败：${JSON.stringify(r.errors)}`);
  assert.ok(!has('media', 'm_orphan.png'), 'm_orphan.png 无引用，应被清理');
  assert.ok(has('media', 'm_payload.png'), 'm_payload.png 被 media_posts.payload_json 引用，应保留（修复前被误删）');
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
