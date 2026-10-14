/**
 * 场景立绘槽位口径回归测试 —— F-19（2026-10-13）。
 *
 * F-19 = 首轮筛查 P2：`characterStanding.js` 把 `OUTFIT_SCENES` **整表 map** 成立绘槽，
 * 而 `OUTFIT_SCENES` 后来多出了第 5 套 `nude`（「全身」，2026-10-05 由「裸体」改名）——
 * 于是详情页立绘切换器**隐式长到 5 格**，冒出一个人人未预期的「全身」可生成页签，
 * 与四处「四套（工装/私服/居家/睡衣）」的注释/文案打架。
 *
 * 意图考古（三层）指向「四套」是本意：
 *   ① 立绘模块各层注释一律写「四套」，且其核心设计（work 槽回落 standing_url）只对四场景成立；
 *   ② 局部口径把全身当**系统常量、不参与用户输入**（见 test/local-patch-regression.test.js：
 *      「这一套不再参与输入」「裸体永远不是生成目标」）——立绘把它做成可生成页签与之一致性相悖；
 *   ③ 立绘直接 map 枚举 → 枚举一加就自动进列表，文案从未跟改。
 * 修复 = 立绘**单独用四套常量**（`OUTFIT_SCENES` 去掉 `PRIVATE_SCENE`），路由校验同步收口。
 *
 * 本测试钉住四件事：
 *   ① 槽位集 = [work, casual, home, sleep]，不含 nude，顺序固定；
 *   ② `listSceneStandings` 恒返回四行；即便库里**历史遗留**了 nude 行也不返回；
 *   ③ work 槽仍以 `characters.standing_url` 兜底（既有设计不回归）；
 *   ④ 路由契约：GET /standings 的 scenes 为四套；对 nude 的删除 / 上传一律 400「无效的场景」，
 *      堵住「能写不能看」的半态。
 *
 * ⚠ 全程临时库 + 临时 IMAGES_DIR，不碰真实数据、不调 LLM。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-standings-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');            // ⚠ 必须先于 imagePaths.js 加载
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

const { getDb, closeDb } = await import('../src/db/index.js');
const {
  listSceneStandings, upsertSceneStanding,
  STANDING_SCENE_KEYS, STANDING_SCENE_LABELS,
} = await import('../src/services/characterStanding.js');
const { OUTFIT_SCENES, PRIVATE_SCENE } = await import('../src/services/outfitScene.js');
const router = (await import('../src/routes/characters.js')).default;

const db = getDb();
const CID = 99801;   // 专用测试角色，避免与真实数据相撞

const insChar = db.prepare(
  'INSERT INTO characters (id, name, display_name, base_prompt, standing_url) VALUES (?,?,?,?,?)'
);
function seedChar(standingUrl = null) {
  db.prepare('DELETE FROM character_standings WHERE character_id = ?').run(CID);
  db.prepare('DELETE FROM characters WHERE id = ?').run(CID);
  insChar.run(CID, '__zz_standing', '__zz_standing', '## 人设\n立绘槽位测试\n\n## 你的外观\nlong black hair', standingUrl);
}

/** 直接驱动 express router（handler 一次 res.json 即返回） */
function callRoute(method, url, params = {}, body = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url, params, body };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    router.handle(req, res, (err) => (err ? reject(err) : resolve(null)));
  });
}

// ─────────────────────────────────────────────────────────
// ① 槽位集：四套，且不含全身
// ─────────────────────────────────────────────────────────

test('★ 立绘槽位只有四套（不含「全身」/nude），顺序固定', () => {
  assert.deepEqual(STANDING_SCENE_KEYS, ['work', 'casual', 'home', 'sleep'],
    '立绘槽位应为四套且顺序固定');
  assert.ok(!STANDING_SCENE_KEYS.includes(PRIVATE_SCENE),
    `立绘不得含私密场景「${PRIVATE_SCENE}」（修复前 OUTFIT_SCENES 整表 map → 5 格）`);
  assert.ok(!STANDING_SCENE_KEYS.includes('nude'), '裸体/全身槽必须被排除');
  // 枚举本身仍是五套（服装通道要用全身）—— 只收立绘，不动服装
  assert.equal(OUTFIT_SCENES.length, 5, 'OUTFIT_SCENES 应保持五套（服装通道依赖它）');
  // 标签口径：四套的中文名（「工装」已改名「常服」）
  assert.deepEqual(
    STANDING_SCENE_KEYS.map(k => STANDING_SCENE_LABELS[k]),
    ['常服', '私服', '居家', '睡衣'],
  );
});

// ─────────────────────────────────────────────────────────
// ② 列表恒四行；历史遗留的 nude 行也不返回
// ─────────────────────────────────────────────────────────

test('listSceneStandings：恒返回四行、顺序固定', () => {
  seedChar();
  const rows = listSceneStandings(CID);
  assert.equal(rows.length, 4, '应恒为四行（修复前为 5 行，多出「全身」）');
  assert.deepEqual(rows.map(r => r.scene), ['work', 'casual', 'home', 'sleep']);
});

test('★ 库里历史遗留的 nude 立绘行不得出现在列表里（修复后仍需过滤）', () => {
  seedChar();
  // 模拟「修复前进过库」的脏数据：直接写一行 scene='nude'
  db.prepare(
    `INSERT OR REPLACE INTO character_standings (character_id, scene, image_url, prompt_text)
     VALUES (?, 'nude', '/images/standing/legacy_nude.png', 'legacy')`
  ).run(CID);

  const rows = listSceneStandings(CID);
  assert.equal(rows.length, 4, '遗留 nude 行不得让列表变回 5 格');
  assert.ok(!rows.some(r => r.scene === 'nude'), '不得返回 nude 槽');
  // 脏数据本身仍在库里（本修复不删用户数据）——只保证不外显
  const raw = db.prepare(
    "SELECT COUNT(*) n FROM character_standings WHERE character_id = ? AND scene = 'nude'"
  ).get(CID);
  assert.equal(raw.n, 1, '修复不应顺手删库里的历史行（只收口展示/入口）');
});

// ─────────────────────────────────────────────────────────
// ③ work 槽兜底不回归
// ─────────────────────────────────────────────────────────

test('work 槽仍以 characters.standing_url 兜底（既有设计不回归）', () => {
  seedChar('/images/standing/default_face.png');
  const rows = listSceneStandings(CID);
  const work = rows.find(r => r.scene === 'work');
  assert.equal(work.image_url, '/images/standing/default_face.png');
  assert.equal(work.is_fallback, true, '兜底行应标记 is_fallback');
  // 其余槽没图也不该被兜底污染
  assert.equal(rows.find(r => r.scene === 'sleep').image_url, null);
});

test('work 槽有显式立绘时优先用它、不标兜底', () => {
  seedChar('/images/standing/default_face.png');
  upsertSceneStanding(CID, 'work', { imageUrl: '/images/standing/explicit_work.png', promptText: 'p' });
  const work = listSceneStandings(CID).find(r => r.scene === 'work');
  assert.equal(work.image_url, '/images/standing/explicit_work.png');
  assert.equal(work.is_fallback, false);
});

// ─────────────────────────────────────────────────────────
// ④ 路由契约：GET 四套；nude 的删/传一律 400
// ─────────────────────────────────────────────────────────

test('GET /:id/standings：scenes 为四套、standings 四行，均不含全身', async () => {
  seedChar();
  const { status, payload } = await callRoute('GET', `/${CID}/standings`, { id: String(CID) });
  assert.equal(status, 200);
  assert.equal(payload.scenes.length, 4, '返回的场景元数据应为四套');
  assert.ok(!payload.scenes.some(s => s.key === 'nude'), 'scenes 不得含 nude');
  assert.equal(payload.standings.length, 4);
});

test('★ DELETE /:id/standings/nude → 400 无效的场景（堵住「能写不能看」半态）', async () => {
  seedChar();
  const { status, payload } = await callRoute('DELETE', `/${CID}/standings/nude`, { id: String(CID), scene: 'nude' });
  assert.equal(status, 400, '修复前会返回 200（校验放行了 nude）');
  assert.match(String(payload.error), /无效的场景/);
});

test('POST /:id/standings/upload 传 nude → 400 无效的场景（校验先于图片处理）', async () => {
  seedChar();
  const { status, payload } = await callRoute(
    'POST', `/${CID}/standings/upload`, { id: String(CID) }, { scene: 'nude', base64: 'data:image/png;base64,AAAA' }
  );
  assert.equal(status, 400);
  assert.match(String(payload.error), /无效的场景/);
});

after(() => {
  try {
    db.prepare('DELETE FROM character_standings WHERE character_id = ?').run(CID);
    db.prepare('DELETE FROM characters WHERE id = ?').run(CID);
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
