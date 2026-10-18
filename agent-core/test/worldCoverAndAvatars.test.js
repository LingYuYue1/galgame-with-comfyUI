/**
 * 星图卡片：封面图 + 居民头像（2026-10-18 用户要求）。
 *
 * 钉住三件事：
 *  ① `listWorldSettings` 带出每个世界的居民（卡片左下角头像要用），且**只带已归属、未归档**的；
 *  ② 头像字段是 `avatar_path`，且最多 8 个（卡片只叠 5 个 + "+N"，多了没意义还涨包）；
 *  ③ `cover_image` 可写可清（空串 = 清除，不是 NULL —— 与 tagline 同口径）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-cover-'));
process.env.LINSHE_WORLD_PROJECTS_DIR = TMP;
globalThis.fetch = async (url) => { throw new Error(`cover test forbids network: ${url}`); };

const db = await import('../src/db/index.js');
const database = db.getDb();

const wA = db.createWorldSetting({ name: '__封面世界A__', content: 'A' });
const wB = db.createWorldSetting({ name: '__封面世界B__', content: 'B' });

function mkChar(name, worldId, extra = {}) {
  const sql = `INSERT INTO characters (name, display_name, base_prompt, world_setting_id, avatar_path, archived)
               VALUES (?, ?, 'p', ?, ?, ?)`;
  return Number(database.prepare(sql).run(name, name, worldId, extra.avatar || null, extra.archived ? 1 : 0).lastInsertRowid);
}

const c1 = mkChar('_甲', wA.id, { avatar: '/avatars/a.png' });
const c2 = mkChar('_乙', wA.id, {});
const c3 = mkChar('_丙', wA.id, { archived: true });      // 归档的：#星图 卡片不该显示
mkChar('_丁', wB.id, {});
mkChar('_无主', null, {});                                 // 未归属：不进任何世界

test('★★ 卡片居民：只带已归属且未归档的，且带 avatar_path', () => {
  const list = db.listWorldSettings();
  const a = list.find(w => w.id === wA.id);
  const b = list.find(w => w.id === wB.id);
  assert.ok(Array.isArray(a.characters), '必须带 characters 数组');
  const ids = a.characters.map(c => c.id);
  assert.deepEqual(ids.sort((x, y) => x - y), [c1, c2].sort((x, y) => x - y), '只应有 c1/c2（c3 已归档）');
  assert.equal(a.characters.find(c => c.id === c1).avatar_path, '/avatars/a.png');
  assert.equal(a.characters.find(c => c.id === c2).avatar_path, '', '没头像时给空串，前端才走首字占位');
  assert.equal(b.characters.length, 1);
  assert.equal(a.characterCount, 2, 'characterCount 口径不变（仍只数已归属）');
});

test('★ 卡片居民最多 8 个（够叠 5 个 + "+N"）', () => {
  for (let i = 0; i < 10; i++) mkChar(`_批量${i}`, wB.id, {});
  const b = db.listWorldSettings().find(w => w.id === wB.id);
  assert.equal(b.characters.length, 8, '最多带 8 个，避免列表接口随角色数膨胀');
  assert.equal(b.characterCount, 11, '总数仍要准（前端用它算 +N）');
});

test('★★ cover_image 可写可清（空串=清除，不是 NULL）', () => {
  db.updateWorldSetting(wA.id, { cover_image: '/world-covers/world_1_x.jpg' });
  assert.equal(db.getWorldSettingById(wA.id).cover_image, '/world-covers/world_1_x.jpg');
  db.updateWorldSetting(wA.id, { cover_image: '' });
  assert.equal(db.getWorldSettingById(wA.id).cover_image, '', '清除后应是空串');
  // 不传 = 不改（别把已有封面误清）
  db.updateWorldSetting(wA.id, { cover_image: '/world-covers/keep.jpg' });
  db.updateWorldSetting(wA.id, { tagline: '只改简介' });
  assert.equal(db.getWorldSettingById(wA.id).cover_image, '/world-covers/keep.jpg');
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});
