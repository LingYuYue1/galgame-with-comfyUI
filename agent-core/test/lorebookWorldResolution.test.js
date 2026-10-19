/**
 * 世界书 · 世界解析（本地改造，2026-10-19 合并 S2.3）
 *
 * 为什么单独一条：上游 `prepareLorebook` 取世界用的是 `getActiveWorldSetting()`。
 * 本地在 v3.10 前已把世界分成两层（`world_settings.is_core`）：主世界是骨架、常驻叠加，
 * **副世界才是具体世界**。照抄上游的话，所有角色都会去查主世界那本世界书
 * （而主世界按设计不带世界书）—— 世界书等于永远不生效，且与「星图优先」的口径打架。
 *
 * 本文件锁死解析顺序：显式 worldId → 角色所属世界 → 全局兜底。
 * 判据用「激活世界 ≠ 角色世界」这个组合来区分新旧行为：
 *   · 旧行为（取激活世界）→ 注入 0 条；
 *   · 新行为（取角色世界）→ 必须注入角色那本。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-lorebook-world-'));
process.env.DB_PATH = path.join(TMP, 'agent.db');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP, 'world-projects');
process.env.IMAGES_DIR = path.join(TMP, 'images');
globalThis.fetch = () => { throw new Error('lorebook world test forbids network'); };

const dbmod = await import('../src/db/index.js');
const worldRepo = await import('../src/db/worldRepository.js');
const { createLorebookRepository } = await import('../src/db/lorebookRepository.js');
const { prepareLorebook } = await import('../src/services/lorebook/runtime.js');

const db = dbmod.getDb();

/** 清干净：角色、世界书、世界 */
function reset() {
  db.prepare('DELETE FROM world_lorebook_runs').run();
  db.prepare('DELETE FROM world_lorebooks').run();
  db.prepare('DELETE FROM characters').run();
  db.prepare('DELETE FROM world_settings').run();
  dbmod.invalidateWorldCache('test.reset');
}

/** 建一个世界；core=true 时设为主世界 */
function makeWorld(name, { core = false, active = false, content = '' } = {}) {
  const w = worldRepo.createWorldSetting({ name, content });
  if (core) db.prepare('UPDATE world_settings SET is_core = 1 WHERE id = ?').run(w.id);
  if (active) db.prepare('UPDATE world_settings SET is_active = 1 WHERE id = ?').run(w.id);
  return db.prepare('SELECT * FROM world_settings WHERE id = ?').get(w.id);
}

function makeCharacter(name, worldId) {
  const info = db.prepare('INSERT INTO characters (name, display_name, base_prompt, world_setting_id) VALUES (?,?,?,?)')
    .run(name, name, '性格安静。', worldId);
  return Number(info.lastInsertRowid);
}

function saveBook(worldId, text) {
  createLorebookRepository(db).save(worldId, {
    name: '测试世界书',
    enabled: true,
    document: {
      entries: [{ uid: 1, key: [], constant: true, position: 1, content: text }],
    },
    settings: {},
  });
}

const MSGS = [
  { role: 'system', content: '你是角色扮演助手。' },
  { role: 'user', content: '今天做什么？' },
];

const flat = (r) => r.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

after(() => {
  try { db.close(); } catch { /* 已关 */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('★★★ 角色所属世界的世界书会被注入 —— 而不是「激活世界」那本', async () => {
  reset();
  // 激活世界（旧口径会取它）没有书；角色所在世界有书
  makeWorld('激活世界', { active: true, content: '激活世界的正文。' });
  const home = makeWorld('角色世界', { content: '角色世界的正文。' });
  saveBook(home.id, '【角色世界的世界书条目】星港泊位按航线分组。');
  const cid = makeCharacter('测试角色', home.id);

  const res = await prepareLorebook(MSGS, { characterId: cid, scope: 'chat', turnKey: `t-${Date.now()}` });
  assert.ok(flat(res).includes('星港泊位按航线分组'), '角色所属世界的世界书没有被注入 —— 解析又退回 getActiveWorldSetting 了');
});

test('★★ 没有角色上下文时仍走全局兜底（激活世界）', async () => {
  reset();
  const active = makeWorld('激活世界', { active: true, content: '激活世界的正文。' });
  saveBook(active.id, '【激活世界的世界书条目】旧城区的钟楼每晚报时。');
  const other = makeWorld('角色世界', { content: '角色世界的正文。' });
  makeCharacter('测试角色', other.id);

  const res = await prepareLorebook(MSGS, { scope: 'chat', turnKey: `t-${Date.now()}` });
  assert.ok(flat(res).includes('旧城区的钟楼每晚报时'), '无角色上下文时应回落到激活世界');
});

test('★★ 显式 worldId 优先级最高（压过角色所属世界）', async () => {
  reset();
  const a = makeWorld('世界A', { active: true, content: 'A 的正文。' });
  const b = makeWorld('世界B', { content: 'B 的正文。' });
  saveBook(a.id, '【A 的世界书条目】A 城的渡口用铜牌排队。');
  saveBook(b.id, '【B 的世界书条目】B 城的夜市只收纸票。');
  const cid = makeCharacter('测试角色', b.id);

  const res = await prepareLorebook(MSGS, { worldId: a.id, characterId: cid, scope: 'chat', turnKey: `t-${Date.now()}` });
  const text = flat(res);
  assert.ok(text.includes('A 城的渡口用铜牌排队'), '显式 worldId 没有生效');
  assert.ok(!text.includes('B 城的夜市只收纸票'), '不应把角色所属世界的书也塞进来');
});

test('★ 世界里没有书 / 书未启用 → 原样返回，不炸', async () => {
  reset();
  const w = makeWorld('空世界', { active: true, content: '正文。' });
  const cid = makeCharacter('测试角色', w.id);
  const res = await prepareLorebook(MSGS, { characterId: cid, scope: 'chat', turnKey: `t-${Date.now()}` });
  assert.equal(res.messages.length, MSGS.length);
  assert.ok(!flat(res).includes('【'));
});
