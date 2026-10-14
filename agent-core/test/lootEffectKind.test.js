/**
 * F-26（+ 修复期新发现 F-59）回归测试（2026-10-13）。
 *
 * F-26 = 首轮筛查 P2：`serializeItem`（背包列表）与 `listActiveEffects`（生效效果列表）里
 *   `kind` / `effect_name` 只查内置池 `ITEM_EFFECTS`、未回落 `getLootEffect` →
 *   橱窗 loot 道具（effect_key 不在内置池）恒显示「未知」分类与原始 key。
 *   同文件早有正确先例：`useItemInTransaction`（L618 一带）、`buildBuffBlock`（F-14 修）。
 *
 * F-59 = 修复期新发现（同型、同文件）：`removeActiveEffect` 同样只查内置池 →
 *   loot 服装/变身类效果被「提前移除」时不撤销它落地的临时外观（效果没了、衣服还穿着）；
 *   内置同类效果则正常清理（本测试以 loot 条目对照钉住）。
 *
 * 钉住：①loot 的 kind/effect_name 取清单定义；②内置不回归；③未知 key 仍兜底；
 *       ④生效效果列表同修；⑤提前移除 loot 服装效果会清理其 global_outfits 行。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-lootkind-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

const { getDb, closeDb } = await import('../src/db/index.js');
const { listBackpack, listActiveEffects, removeActiveEffect } = await import('../src/services/itemService.js');

const db = getDb();

// ── 造数：橱窗清单两行（服装 → outfit；成人玩具 → buff）──
const insCatalog = db.prepare(`INSERT INTO loot_catalog (tag, name, meaning, cat, slot, page) VALUES (?, ?, ?, ?, 's', 'p')`);
insCatalog.run('t_cloth_1', '测试洋装', '一件测试用洋装', 'clothes');
insCatalog.run('t_toy_1', '测试玩具', '一件测试用玩具', 'adult_toy');

const insItem = db.prepare(`
  INSERT INTO backpack_items (effect_key, name, description, status, source_type, owner_key, collected_at)
  VALUES (?, ?, 'd', ?, ?, 'me', datetime('now'))
`);
// 背包（ready）：loot 服装 / 内置 / 未知 key 三个
const lootReady = Number(insItem.run('t_cloth_1', '测试洋装', 'ready', 'loot').lastInsertRowid);
const innerReady = Number(insItem.run('jk_uniform', 'JK制服', 'ready', 'legacy_chest').lastInsertRowid);
const unknownReady = Number(insItem.run('no_such_key_xyz', '来路不明', 'ready', 'loot').lastInsertRowid);
// 生效效果（used）：loot 服装效果用
const lootUsed = Number(insItem.run('t_cloth_1', '测试洋装', 'used', 'loot').lastInsertRowid);

const charId = Number(db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('t_char_1', '测试角色', 'x')`).run().lastInsertRowid);

// 生效效果：loot 服装一条，payload 指向一条临时外观（global_outfits）
const outfitRow = Number(db.prepare(`INSERT INTO global_outfits (name, description, enabled, character_id, expires_at) VALUES ('测试洋装', 'd', 1, ?, datetime('now', '+1 day'))`).run(charId).lastInsertRowid);
const lootEffectId = Number(db.prepare(`INSERT INTO item_effects (item_id, character_id, effect_key, payload_json, expires_at) VALUES (?, ?, 't_cloth_1', ?, datetime('now', '+1 day'))`).run(lootUsed, charId, JSON.stringify({ outfitRowId: outfitRow })).lastInsertRowid);

test('★ F-26①：背包 loot 道具 kind/effect_name 取清单定义（不再恒 unknown / 原始 key）', () => {
  const { items } = listBackpack();
  const it = items.find(x => x.id === lootReady);
  assert.ok(it, 'loot 道具应在背包列表');
  assert.equal(it.kind, 'outfit', 'kind 应回落 getLootEffect（clothes → outfit）');
  assert.equal(it.effect_name, '测试洋装', 'effect_name 应取清单 name');
});

test('★ F-26②：内置道具不回归', () => {
  const { items } = listBackpack();
  const it = items.find(x => x.id === innerReady);
  assert.ok(it);
  assert.equal(it.kind, 'outfit');
  assert.equal(it.effect_name, 'JK制服');
});

test('★ F-26③：未知 key 仍兜底 unknown / 原 key', () => {
  const { items } = listBackpack();
  const it = items.find(x => x.id === unknownReady);
  assert.ok(it);
  assert.equal(it.kind, 'unknown');
  assert.equal(it.effect_name, 'no_such_key_xyz');
});

test('★ F-26④：生效效果列表里 loot 效果的 kind/effect_name 同修', () => {
  const list = listActiveEffects();
  const ef = list.find(x => x.id === lootEffectId);
  assert.ok(ef, 'loot 生效效果应在列表');
  assert.equal(ef.kind, 'outfit');
  assert.equal(ef.effect_name, '测试洋装');
});

test('★ F-59：提前移除 loot 服装效果 → 其临时外观被清理（此前残留）', () => {
  const r = removeActiveEffect(lootEffectId);
  assert.equal(r.ok, true);
  const still = db.prepare('SELECT id FROM global_outfits WHERE id = ?').get(outfitRow);
  assert.equal(still, undefined, 'global_outfits 行应随效果移除被删');
  const ef = db.prepare('SELECT id FROM item_effects WHERE id = ?').get(lootEffectId);
  assert.equal(ef, undefined, '效果行应被删');
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
