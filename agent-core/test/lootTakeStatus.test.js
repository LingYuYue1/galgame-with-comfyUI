/**
 * 橱窗带走 —— F-05 回归测试（2026-10-12）。
 *
 * F-05 = 首轮筛查 P1：橱窗「使用」未出图商品必失败 —— 前端把 status 硬编码 'ready'，
 * 绕过 `startUse` 的就绪守卫，一路走到 `useItem` 才被后端拒绝（"道具尚未就绪"）。
 * 修复：`takeItems` 的返回项带**真实 status**（与背包项写入值同源），前端按它分流
 * （未就绪 → 已放进背包 + 提示等图，不弹角色选择器）。
 *
 * 本测试钉住后端契约：`taken[].status` 与 `backpack_items.status` 一致，且四种情形正确：
 *   ① 需图 + 无图 → generating；
 *   ② 无需图的槽位（adult_toy/play）→ ready；
 *   ③ 需图 + 图文件在 → ready；
 *   ④ 需图 + 图文件缺失 → generating。
 *
 * ⚠ 全程临时库 + 临时 IMAGES_DIR，不碰真实数据。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-loot-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');   // ⚠ 必须先于 imagePaths.js 加载
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

// 造一张「图已存在」的文件（case ③ 用）
const ITEMS_DIR = path.join(TMP_DIR, 'images', 'items');
fs.mkdirSync(ITEMS_DIR, { recursive: true });
fs.writeFileSync(path.join(ITEMS_DIR, 'ok.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

const { getDb, closeDb } = await import('../src/db/index.js');
const { takeItems } = await import('../src/services/lootService.js');

const db = getDb();
const insCat = db.prepare(
  `INSERT INTO loot_catalog (tag, name, meaning, cat, slot, page, image_url) VALUES (?, ?, ?, ?, ?, 'testpage', ?)`
);
const idA = Number(insCat.run('tag_a', '无图服饰', 'm', 'adult_outfit', 'lingerie', null).lastInsertRowid);
const idB = Number(insCat.run('tag_b', '玩法状态', 'm', 'adult_toy', 'play', null).lastInsertRowid);
const idC = Number(insCat.run('tag_c', '有图服饰', 'm', 'adult_outfit', 'lingerie', '/images/items/ok.png').lastInsertRowid);
const idD = Number(insCat.run('tag_d', '图缺失服饰', 'm', 'adult_outfit', 'lingerie', '/images/items/missing.png').lastInsertRowid);
const insOffer = db.prepare(`INSERT INTO loot_offers (page, slot_index, item_id) VALUES ('testpage', ?, ?)`);
insOffer.run(0, idA); insOffer.run(1, idB); insOffer.run(2, idC); insOffer.run(3, idD);

test('★ F-05：taken 的 status 与背包项一致，四种情形判断正确', () => {
  const r = takeItems('testpage', [0, 1, 2, 3]);
  assert.equal(r.ok, true);
  assert.equal(r.taken.length, 4);
  const byName = Object.fromEntries(r.taken.map(t => [t.name, t]));
  assert.equal(byName['无图服饰'].status, 'generating', '需图且无图 → generating');
  assert.equal(byName['玩法状态'].status, 'ready', '无需图槽位（adult_toy/play）→ ready');
  assert.equal(byName['有图服饰'].status, 'ready', '需图且文件存在 → ready');
  assert.equal(byName['图缺失服饰'].status, 'generating', '图文件缺失 → generating');
  // 与背包项实际落库状态一致（唯一真源）
  for (const t of r.taken) {
    const row = db.prepare('SELECT status FROM backpack_items WHERE id = ?').get(t.backpackId);
    assert.equal(t.status, row.status, `taken.status 应与背包项一致（${t.name}）`);
  }
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
