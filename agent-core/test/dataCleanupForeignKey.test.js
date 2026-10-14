/**
 * 数据清理 · 断引用完整性 —— F-09 回归测试（2026-10-12）。
 *
 * F-09 = 首轮筛查 P1：`purgeData` 的 DETACH_REFS 漏了 `image_tasks.source_msg_id`
 * （真实库全量外键扫描 `PRAGMA foreign_key_list` 确认引用 messages.id 的共 4 张表，
 * image_tasks 是唯一缺失项）→ 勾「聊天记录」清理时 DELETE messages 撞 FOREIGN KEY：
 * partial 失败（其它表删了、消息删不掉 + errors 里躺一条）。
 *
 * 本测试钉住：image_tasks 引用存在时，清理仍能真实删除消息 + 引用被置 NULL + 零错误。
 * ⚠ 临时库（备份目录随库目录一起落在临时目录），不碰真实数据。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-cleanup-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

const { getDb, closeDb } = await import('../src/db/index.js');
const { purgeData } = await import('../src/services/dataCleanup.js');

const db = getDb();
const sqlTime = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);

// 8 天前的消息（超出默认 7 天窗口）
const msgId = Number(db.prepare(
  `INSERT INTO messages (conversation_id, role, content, created_at) VALUES ('char_1', 'user', 'F-09 测试旧消息', ?)`
).run(sqlTime(8 * 86400_000)).lastInsertRowid);

// image_tasks 引用该消息；created_at 用「现在」→ 不属于任何清理窗口，只应被断引用
const taskId = Number(db.prepare(
  `INSERT INTO image_tasks (conversation_id, source_msg_id, prompt_original, created_at) VALUES ('char_1', ?, 'prompt', ?)`
).run(msgId, sqlTime(0)).lastInsertRowid);

test('★ F-09：清理聊天记录真实删除 + image_tasks 断引用置 NULL（无 FK partial 失败）', async () => {
  const r = await purgeData({ days: 7, targets: ['chat'] });
  assert.equal(r.ok, true);
  assert.equal(r.partial, false, `不应有 partial 失败：${JSON.stringify(r.errors)}`);
  assert.equal(r.errors.length, 0, `不应有错误：${JSON.stringify(r.errors)}`);
  assert.ok(r.totalRows >= 1, '应至少删掉 1 行（测试消息）');

  const still = db.prepare('SELECT id FROM messages WHERE id = ?').get(msgId);
  assert.equal(still, undefined, '旧消息应已被删除（漏断引用时会 FK 失败、删不掉）');

  const task = db.prepare('SELECT source_msg_id FROM image_tasks WHERE id = ?').get(taskId);
  assert.ok(task, 'image_tasks 行本身应保留（任务历史），只断引用');
  assert.equal(task.source_msg_id, null, 'source_msg_id 应被断引用置 NULL');
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
