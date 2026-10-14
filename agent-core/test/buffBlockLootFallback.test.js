/**
 * 聊天人格 · 临时状态注入（橱窗玩具） —— F-14 回归测试（2026-10-12）。
 *
 * F-14 = 首轮筛查 P1：`buildBuffBlock` 的过滤与取文案都只认旧道具池 `ITEM_EFFECTS`，
 * 而橱窗带走的成人玩具 effect_key 是**商品 tag**（只存在 `loot_catalog`，经
 * `getLootEffect` 回落）→ 使用后写入的 buff 在聊天人格组装时被整条过滤 →
 * 「使用玩具后对话人格带上 6 小时状态」**永不生效**（静默无感）。
 * 修复：两处回落 `getLootEffect(effect_key)`（与 useItem 的效果回落同一真源）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-buffblock-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

const { getDb, closeDb } = await import('../src/db/index.js');
const { buildBuffBlock } = await import('../src/services/itemService.js');

const db = getDb();
// 造一条橱窗道具（命中 toyEffectText 的「震动」类模板）
db.prepare(`INSERT INTO loot_catalog (tag, name, meaning, cat, slot, page) VALUES ('vibrator_egg_x', '跳蛋', 'm', 'adult_toy', 'toy', 'testpage')`).run();

test('★ F-14①：橱窗玩具（loot tag）的 buff 能进聊天人格块', () => {
  const out = buildBuffBlock([{ item_name: '跳蛋', effect_key: 'vibrator_egg_x', remaining_seconds: 6 * 3600 }]);
  assert.ok(out.includes('道具效果 · 临时状态'), '应产出注入块');
  assert.ok(out.includes('跳蛋'), '应带道具名');
  assert.ok(out.includes('小腹里还留着钝钝的胀感'), '应回落 loot 清单的 effectText（修复前整条被过滤）');
  assert.ok(out.includes('剩余约 6 小时'));
});

test('★ F-14②：旧道具池的 buff 行为不回归', () => {
  const out = buildBuffBlock([{ item_name: '元气符咒', effect_key: 'energy', remaining_seconds: 3600 }]);
  assert.ok(out.includes('精力充沛'), '旧道具池 effectText 照常输出');
});

test('★ F-14③：非 buff / 未知 key 不注入', () => {
  assert.equal(buildBuffBlock([{ item_name: 'x', effect_key: 'no_such_key', remaining_seconds: 100 }]), '');
  assert.equal(buildBuffBlock([{ item_name: '心情修复贴', effect_key: 'mood_fix', remaining_seconds: 100 }]), '');
  assert.equal(buildBuffBlock([]), '');
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
