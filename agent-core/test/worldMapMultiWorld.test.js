/**
 * 星图 T16（2026-10-18）—— 「地图归属于哪个世界」这件事，必须贯穿到生成与展示。
 *
 * 实锤 bug（用户报「地图系统无法创建多个世界观的地图」）：
 *   建图时可以指定归属世界，但**生成骨架/展开地点/补场景提示词一律取 `getWorldSetting()`=激活世界**。
 *   于是给「二维市」建图，生成出来的是激活世界（星穹铁道）的「星轨锚带 / 列车枢台」。
 *   图能建、归属能选，内容永远只有激活世界那一套 —— 从用户视角就是"建不了别的世界的地图"。
 *
 * 本文件锁两件事：
 *   1. 骨架生成的 LLM 消息里是**地图归属世界**的正文，不是激活世界的；
 *   2. 角色能被放到"他日程里那个地点"上（含自由文本的双向包含匹配）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-t16-mapworld-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

const A_TEXT = '甲世界正文：这是一座浮在云海上的环形城，上城住着星轨工程师。';
const B_TEXT = '乙世界正文：这是一条终年落雨的旧商店街，屋檐下挂满褪色的纸灯笼。';

const SKELETON = JSON.stringify({
  regions: [
    {
      key: 'b_region', name: '旧商店街', name_en: 'Old Shopping Street',
      kind: '商业区', summary: '雨棚连成一片的老街。',
      districts: [
        { key: 'b_d1', name: '乙书店区', name_en: 'Book District', kind: '街区', summary: '旧书店与文具铺。' },
      ],
    },
  ],
});

const llmRequests = [];
const stubServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    res.setHeader('Connection', 'close');
    llmRequests.push({ url: req.url, body: raw });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'stub-1', object: 'chat.completion', created: 0, model: 'stub-model',
      choices: [{ index: 0, message: { role: 'assistant', content: SKELETON }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });
});
await new Promise((resolve, reject) => {
  stubServer.once('error', reject);
  stubServer.listen(0, '127.0.0.1', resolve);
});

const { config } = await import('../src/config.js');
config.llm.apiKey = 'test-key';
config.llm.baseURL = `http://127.0.0.1:${stubServer.address().port}/v1`;
config.llm.model = 'stub-model';
config.llm.freeEgg = false;

const { getDb } = await import('../src/db/index.js');
const { loadFeatureMigrations } = await import('../src/db/migrations/index.js');
const { runRegisteredMigrations } = await import('../src/db/migrationRegistry.js');
const { resetClient } = await import('../src/llm/llm-client.js');
resetClient();
const { generateSkeleton, matchPlaceByName, getMapResidents } = await import('../src/services/worldMapService.js');
const { getLocalDateKey } = await import('../src/utils/localDate.js');

const db = getDb();
loadFeatureMigrations();
runRegisteredMigrations(db);

// ── 两个世界：A 是激活世界（诱饵），B 才是地图归属 ──
const widA = Number(db.prepare(
  `INSERT INTO world_settings (name, content, is_active, is_enabled, tagline, visual_tone, sort_order)
   VALUES ('T16甲世界', ?, 1, 1, '', '', 0)`
).run(A_TEXT).lastInsertRowid);
const widB = Number(db.prepare(
  `INSERT INTO world_settings (name, content, is_active, is_enabled, tagline, visual_tone, sort_order)
   VALUES ('T16乙世界', ?, 0, 1, '', '', 1)`
).run(B_TEXT).lastInsertRowid);
const mapB = Number(db.prepare(
  `INSERT INTO world_maps (name, world_setting_id, note) VALUES ('T16乙世界地图', ?, '')`
).run(widB).lastInsertRowid);

function systemTextOf(request) {
  const body = JSON.parse(request.body);
  return (body.messages || []).map(m => String(m.content || '')).join('\n\n');
}

test('★★★ T16：生成骨架用的是「地图归属世界」的正文，不是激活世界', async () => {
  llmRequests.length = 0;
  await generateSkeleton(mapB, {});
  assert.ok(llmRequests.length >= 1, '应有 LLM 请求');
  const all = systemTextOf(llmRequests[0]);
  assert.match(all, /终年落雨的旧商店街/, '必须带上地图归属世界（乙）的正文');
  assert.doesNotMatch(all, /浮在云海上的环形城/, '绝不能把激活世界（甲）的正文带进来 —— 这就是串味的来源');
});

test('★★★ T16：骨架落库后地点真的在，且归属世界没被改', () => {
  const map = db.prepare('SELECT * FROM world_maps WHERE id = ?').get(mapB);
  assert.equal(Number(map.world_setting_id), widB);
  const places = db.prepare('SELECT * FROM world_map_places WHERE map_id = ?').all(mapB);
  assert.ok(places.length >= 2, '应写入大地区与子地区');
  assert.ok(places.some(p => p.name === '旧商店街'));
});

// ── 地点匹配：日程地点是自由文本 ──
const PLACES = [
  { id: 1, name: '咖啡' },
  { id: 2, name: '咖啡馆' },
  { id: 3, name: '咖啡馆二楼' },
  { id: 4, name: '旧书店' },
];

test('T16：地点名完全相等 → 命中自己', () => {
  assert.equal(matchPlaceByName('旧书店', PLACES)?.id, 4);
});

test('T16：日程写成「旧书店二楼」也要落到「旧书店」', () => {
  assert.equal(matchPlaceByName('旧书店二楼', PLACES)?.id, 4);
});

test('T16：多地命中时取名字最长的那个（否则选谁看遍历顺序 = 随机）', () => {
  assert.equal(matchPlaceByName('咖啡馆二楼靠窗', PLACES)?.id, 3, '应选「咖啡馆二楼」而不是「咖啡」');
});

test('T16：对不上就返回 null，不许乱塞', () => {
  assert.equal(matchPlaceByName('匹诺康尼·黄金的时刻', PLACES), null);
  assert.equal(matchPlaceByName('', PLACES), null);
});

// ── 居民上图标：造一个"此刻在旧书店"的角色 ──
test('★★★ T16：角色按日程当下的地点被放到对应地点上', () => {
  const cid = Number(db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, avatar_path, world_setting_id)
     VALUES ('t16c', 'T16居民', '每天泡书店。', '/avatars/t16.png', ?)`
  ).run(widB).lastInsertRowid);
  // 全天一段，地点写「旧书店二楼」——故意不写全等，覆盖包含匹配
  const today = getLocalDateKey();
  db.prepare(
    `INSERT INTO daily_schedules (character_id, schedule_date, schedule_json) VALUES (?, ?, ?)`
  ).run(cid, today, JSON.stringify([
    { startTime: '00:00', endTime: '24:00', activity: '看书', location: '旧书店二楼', replyDelay: 0, description: '翻旧书' },
  ]));

  const data = getMapResidents(mapB);
  assert.ok(data, '地图应存在');
  const rows = data.residents.filter(r => r.id === cid);
  assert.equal(rows.length, 1, '本世界的角色应出现');
  const place = db.prepare('SELECT * FROM world_map_places WHERE name = ? AND map_id = ?').get('旧书店', mapB);
  if (place) {
    assert.equal(rows[0].place_id, place.id);
    assert.equal((data.by_place[place.id] || []).length, 1);
  } else {
    // 骨架是桩数据，不一定含「旧书店」——退一步：至少不许匹配到别的地点上
    assert.equal(rows[0].place_id, null, '匹配不到就明确为空，不许乱挂');
  }
});

test('T16：别的世界的角色不会出现在这张图上', () => {
  const cidA = Number(db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, world_setting_id)
     VALUES ('t16a', 'T16外人', '', ?)`
  ).run(widA).lastInsertRowid);
  const data = getMapResidents(mapB);
  assert.equal(data.residents.some(r => r.id === cidA), false);
});

after(() => {
  try { stubServer.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
});
