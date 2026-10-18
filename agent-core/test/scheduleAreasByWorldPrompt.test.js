/**
 * 星图 T11 —— 「日程地点取自角色所在世界」的**提示词级**验证。
 *
 * 与 `scheduleAreasByWorld.test.js` 的分工：
 *   · 那边验证「算得对」（补全/上限/两道闸）；
 *   · 这边验证「真的进了 LLM 消息」—— 用环回 HTTP 假 LLM 抓真实请求体，
 *     看 system 里到底有没有那个世界的地名。少这一层，"补全了但没接进约束层"
 *     这种断线是测不出来的。
 *
 * LLM 打桩方式沿用 `scheduleGeneratorFlow.test.js`：openai SDK 用自带的 node-fetch，
 * 替换 globalThis.fetch 对它无效，所以起一个真假端点、把 baseURL 指过去。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-t11-prompt-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

// 合法日程：首尾相接覆盖 24h、唯一睡眠块（replyDelay=-1）
const ACTIVITIES = [
  { startTime: '00:00', endTime: '07:00', activity: '睡觉', location: '家', replyDelay: -1, description: '安稳睡眠' },
  { startTime: '07:00', endTime: '08:00', activity: '早餐', location: '甲子区·甲咖啡馆', replyDelay: 0, description: '喝一杯' },
  { startTime: '08:00', endTime: '12:00', activity: '工作', location: '甲子区·甲咖啡馆', replyDelay: 0, description: '守着吧台' },
  { startTime: '12:00', endTime: '13:00', activity: '午餐', location: '甲子区·甲河堤', replyDelay: 0, description: '随便吃点' },
  { startTime: '13:00', endTime: '18:00', activity: '工作', location: '甲子区·甲咖啡馆', replyDelay: 0, description: '继续营业' },
  { startTime: '18:00', endTime: '20:00', activity: '散步', location: '甲子区·甲河堤', replyDelay: 0, description: '沿河走走' },
  { startTime: '20:00', endTime: '24:00', activity: '自由活动', location: '家', replyDelay: 0, description: '收拾一下' },
];
const STUB_CONTENT = JSON.stringify({ activities: ACTIVITIES });
const llmRequests = [];

const stubServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    res.setHeader('Connection', 'close');
    llmRequests.push({ url: req.url, body: raw });
    if (!String(req.url).includes('chat/completions')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'stub-1', object: 'chat.completion', created: 0, model: 'stub-model',
      choices: [{ index: 0, message: { role: 'assistant', content: STUB_CONTENT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });
});
await new Promise((resolve, reject) => {
  stubServer.once('error', reject);
  stubServer.listen(0, '127.0.0.1', resolve);
});
const STUB_PORT = stubServer.address().port;

const { config } = await import('../src/config.js');
config.llm.apiKey = 'test-key';
config.llm.baseURL = `http://127.0.0.1:${STUB_PORT}/v1`;
config.llm.model = 'stub-model';
config.llm.freeEgg = false;

const { getDb } = await import('../src/db/index.js');
const { resetClient } = await import('../src/llm/llm-client.js');
resetClient();
const { generateSchedule } = await import('../src/services/scheduleGenerator.js');
const { readScheduleOptions } = await import('../src/routes/schedule.js');

const db = getDb();

// ── 造一个世界 + 一张图 + 一个子区两个地点 + 一个角色 ──
const wid = Number(db.prepare(
  `INSERT INTO world_settings (name, content, is_active, is_enabled, tagline, visual_tone, sort_order)
   VALUES ('T11提示词世界', '测试世界正文', 0, 1, '', '', 0)`
).run().lastInsertRowid);
const mid = Number(db.prepare(`INSERT INTO world_maps (name, world_setting_id, note) VALUES ('T11提示词地图', ?, '')`).run(wid).lastInsertRowid);
const insPlace = db.prepare(
  `INSERT INTO world_map_places (map_id, parent_id, level, key, name, kind, summary, pois_json, sort_order)
   VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 0)`
);
const r1 = insPlace.run(mid, null, 1, 'rg1', '甲地区', 'region', '');
const r2 = insPlace.run(mid, Number(r1.lastInsertRowid), 2, 'dt1', '甲子区', 'district', '');
for (const [i, [name, summary]] of [['甲咖啡馆', '半开间的咖啡铺'], ['甲河堤', '傍晚有人钓鱼']].entries()) {
  insPlace.run(mid, Number(r2.lastInsertRowid), 3, `sc${i}`, name, 'scene', summary);
}
const cid = Number(db.prepare(
  `INSERT INTO characters (name, display_name, base_prompt, world_setting_id) VALUES ('t11c', 'T11角色', '作息规律。', ?)`
).run(wid).lastInsertRowid);
const character = { id: cid, display_name: 'T11角色', base_prompt: '作息规律。' };

/** 取本次请求里全部 system 内容拼起来 */
function systemTextOf(request) {
  const body = JSON.parse(request.body);
  return (body.messages || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n');
}

test('★★★ T11：自动生成（不带 areas）时，角色所在世界的地名真的进了 system', async () => {
  llmRequests.length = 0;
  await generateSchedule(character, '', {});
  assert.ok(llmRequests.length >= 1, '应有 LLM 请求');
  const sys = systemTextOf(llmRequests[0]);
  assert.match(sys, /甲子区/, '子区名应进入约束层');
  assert.match(sys, /甲咖啡馆/, '地点名应进入约束层');
  assert.match(sys, /半开间的咖啡铺/, '地点简介也要带上（八股现象的解药）');
});

test('★★★ T11：用户明确「不限区域」（areas: []）时，不许自动补', async () => {
  llmRequests.length = 0;
  // 模拟弹窗里把所有区域都取消勾选后提交
  const opts = readScheduleOptions({ areas: [] });
  assert.equal(opts.areasSpecified, true, '标记应存在（不可枚举）');
  assert.deepEqual(opts, {}, '对外契约不变：未传有效项时仍是空对象');
  await generateSchedule(character, '', opts);
  const sys = systemTextOf(llmRequests[0]);
  assert.doesNotMatch(sys, /甲子区/, '明确不限区域时不许替用户补上');
});

after(() => {
  try { stubServer.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
});
