/**
 * loot 生图落定（成功/失败兜底） —— F-12 回归测试（2026-10-12）。
 *
 * F-12 = 首轮筛查 P1：橱窗商品生图**失败**时后端不处理「已带走的背包道具」→
 * 永远停在 generating，而前端「生成中不上架」→ 道具**永久消失**（看不见、用不了）。
 * 普通道具的对照做法：失败时 completeChestItem(…, null)（降级上架）+ 广播 item_ready。
 *
 * 本测试钉住 `settleWaitingLootItems`（被成功/失败两条路径共用）的语义：
 *   ① 失败（imageUrl=null）→ 同款 generating 道具全部降级上架（ready、无图）；
 *   ② 成功（带 url）→ 同款全部 ready 且带图；
 *   ③ 只影响「同款 + loot + generating + 无图」的项；无匹配时 no-op。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-lootsettle-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

const { getDb, closeDb } = await import('../src/db/index.js');
const { settleWaitingLootItems } = await import('../src/services/lootService.js');

const db = getDb();
const ins = db.prepare(`
  INSERT INTO backpack_items (effect_key, name, description, status, source_type, owner_key, collected_at, image_url)
  VALUES (?, ?, 'd', ?, 'loot', 'me', datetime('now'), ?)
`);
// 目标：同款 tag_x 的两个 generating 无图项
const a = Number(ins.run('tag_x', '玩具A', 'generating', null).lastInsertRowid);
const b = Number(ins.run('tag_x', '玩具B', 'generating', null).lastInsertRowid);
// 干扰项：不同款仍在 generating / 同款但已 ready 带图
const other = Number(ins.run('tag_y', '别的', 'generating', null).lastInsertRowid);
const done = Number(ins.run('tag_x', '已完成', 'ready', '/images/items/x.png').lastInsertRowid);

test('★ F-12①：失败降级 —— 同款 generating 道具全部变 ready 无图（不再永久卡死）', () => {
  const ids = settleWaitingLootItems('tag_x', null);
  assert.deepEqual([...ids].sort((x, y) => x - y), [a, b].sort((x, y) => x - y), '应返回两个受影响 id');
  for (const id of [a, b]) {
    const row = db.prepare('SELECT status, image_url FROM backpack_items WHERE id = ?').get(id);
    assert.equal(row.status, 'ready', '应降级上架为 ready');
    assert.equal(row.image_url, null, '无图（降级形态，图缺席不阻塞使用）');
  }
  // 干扰项不动
  assert.equal(db.prepare('SELECT status FROM backpack_items WHERE id = ?').get(other).status, 'generating');
  assert.equal(db.prepare('SELECT image_url FROM backpack_items WHERE id = ?').get(done).image_url, '/images/items/x.png');
});

test('★ F-12②：成功带图 —— 同款在等图的项全部 ready 且带图', () => {
  const c = Number(ins.run('tag_z', '等待中的', 'generating', null).lastInsertRowid);
  const ids = settleWaitingLootItems('tag_z', '/images/items/z.png');
  assert.deepEqual(ids, [c]);
  const row = db.prepare('SELECT status, image_url FROM backpack_items WHERE id = ?').get(c);
  assert.equal(row.status, 'ready');
  assert.equal(row.image_url, '/images/items/z.png');
});

test('★ F-12③：无匹配项时是 no-op（不抛错、返回空数组）', () => {
  assert.deepEqual(settleWaitingLootItems('tag_none', null), []);
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
