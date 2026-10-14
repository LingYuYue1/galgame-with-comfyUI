/**
 * 数据清理 · 保护集「存活子集」 —— F-10 回归测试（2026-10-12）。
 *
 * F-10 = 首轮筛查 P1：清理时保护集**整表跳过**将被清理的表（如 messages）——
 * 于是**存活消息**（清理窗口之外、不会被删的那些）所引用的老图（mtime 超过窗口）
 * 不在保护集里，被当孤儿**误删**；用户清完聊天记录后发现：没被删的消息里图挂了。
 *
 * 本测试双向钉住：
 *   ① 同一张老图被「老消息 + 新消息」共同引用 → 清理后**必须仍在**（被存活子集保护）；
 *   ② 只被老消息引用的老图 → 清理后**应被删**（保护集不能过度保护）。
 *
 * ⚠ 临时库 + 临时 IMAGES_DIR，不碰真实数据。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-cleanprotect-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');   // ⚠ 先于 imagePaths 加载
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

// 图文件（mtime 30 天前 → 老于 7 天清理窗口）
const CHAT_DIR = path.join(TMP_DIR, 'images', 'chat');
fs.mkdirSync(CHAT_DIR, { recursive: true });
const OLD_MTIME = new Date(Date.now() - 30 * 86400_000);
function putImage(name) {
  const p = path.join(CHAT_DIR, name);
  fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.utimesSync(p, OLD_MTIME, OLD_MTIME);
}
putImage('shared_both.png');   // 老消息 + 新消息共同引用 → 应保留
putImage('only_old.png');      // 只被老消息引用 → 应删除

const { getDb, closeDb } = await import('../src/db/index.js');
const { purgeData } = await import('../src/services/dataCleanup.js');

const db = getDb();
const sqlTime = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const insMsg = db.prepare(`INSERT INTO messages (conversation_id, role, content, images, created_at) VALUES ('char_1', 'user', ?, ?, ?)`);
insMsg.run('老消息：引用了两张老图', JSON.stringify(['/images/chat/shared_both.png', '/images/chat/only_old.png']), sqlTime(8 * 86400_000));
insMsg.run('新消息：仍在引用其中一张老图', JSON.stringify(['/images/chat/shared_both.png']), sqlTime(1 * 86400_000));

test('★ F-10：存活消息引用的老图不被误删；仅被删消息引用的老图仍正常清理', async () => {
  const r = await purgeData({ days: 7, targets: ['chat'] });
  assert.equal(r.partial, false, `不应有 partial 失败：${JSON.stringify(r.errors)}`);
  assert.ok(r.totalRows >= 1, '应删掉老消息');

  // ① 被存活（新）消息引用的老图必须还在
  assert.ok(fs.existsSync(path.join(CHAT_DIR, 'shared_both.png')),
    'shared_both.png 被 1 天前的新消息引用，清理后应保留（修复前因整表跳过保护被误删）');
  // ② 只被老消息引用的老图应被清掉（保护集不能过度保护）
  assert.ok(!fs.existsSync(path.join(CHAT_DIR, 'only_old.png')),
    'only_old.png 只被已删消息引用，应被清理');
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
