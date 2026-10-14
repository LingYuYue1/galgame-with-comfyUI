/**
 * 日程生成落库路径 —— F-01 回归测试（2026-10-12）。
 *
 * 「F-01」= 首轮问题筛查报告 P0-①：scheduleGenerator.js 第 913/930 行曾引用
 * 未声明变量（dayType / fallbackToDefaultCalendar），使**每次 LLM 成功解析后必抛
 * ReferenceError**，整条日程生成链路瘫痪（且白烧两层重试的 LLM 调用）。
 *
 * 本测试钉住的三条不变量（都是当初写崩/写漏的落库分支）：
 *   ① 普通生成（不传 dayType）成功写**默认日历** schedule_templates；
 *   ② 显式传 dayType → 写 schedule_day_plans，且**同时升级默认日历**（兜底不落空）；
 *   ③ fallbackToDefaultCalendar:false（"只当日型"）→ 不覆盖默认日历。
 *
 * ⚠ 全程临时库 + LLM 打桩，不碰真库、不调真 LLM。
 *   LLM 打桩方式：本进程内起一个环回 HTTP 服务充当假 LLM 端点，把 config.llm.baseURL
 *   指过去 —— openai SDK 4.x 在 Node 下使用自带的 node-fetch（_shims/node-runtime），
 *   不读 globalThis.fetch，所以「替换全局 fetch」对它无效；环回服务方案让 SDK 的
 *   HTTP 链路（序列化/重试/解析）保持 100% 真实，只把对端换成了脚本。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { installLlmCallLogSuppressor } from './helpers/suppressLlmCallLog.js';

// 降低 stdout 洪泛（node:test 进程隔离的 IPC 分帧 bug 只在输出量大时随机触发）——见 helper 注释
installLlmCallLogSuppressor();

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-schedgen-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

// ── LLM 打桩：环回 HTTP 服务，固定返回一份合法日程 JSON ──
// 数据要点：8 条首尾相接覆盖 24h；唯一睡眠 block（replyDelay=-1，7 小时）；
// 其余 replyDelay 全 0（贴合「正常活动都是 0」的提示词契约，避免触发 80% 秒回兜底改写）。
const ACTIVITIES = [
  { startTime: '00:00', endTime: '07:00', activity: '睡觉', location: '家', replyDelay: -1, description: '安稳睡眠' },
  { startTime: '07:00', endTime: '08:00', activity: '早餐', location: '家', replyDelay: 0, description: '简单早餐' },
  { startTime: '08:00', endTime: '09:00', activity: '通勤', location: '路上', replyDelay: 0, description: '赶往工作地' },
  { startTime: '09:00', endTime: '12:00', activity: '工作', location: '工作室', replyDelay: 0, description: '专注工作' },
  { startTime: '12:00', endTime: '13:00', activity: '午餐', location: '食堂', replyDelay: 0, description: '吃午饭' },
  { startTime: '13:00', endTime: '18:00', activity: '工作', location: '工作室', replyDelay: 0, description: '继续工作' },
  { startTime: '18:00', endTime: '20:00', activity: '晚餐与休息', location: '家', replyDelay: 0, description: '放松一下' },
  { startTime: '20:00', endTime: '24:00', activity: '自由活动', location: '家', replyDelay: 0, description: '看书或散步' },
];
// 与提示词要求的 json_object 输出格式一致（解析器同时兼容裸数组，这里按更真实的形态来）
const STUB_CONTENT = JSON.stringify({ activities: ACTIVITIES });
const llmRequests = [];
const stubServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    // ⚠ Connection: close —— 禁用客户端 keep-alive 连接复用，避免测试结束后
    //   残留连接产生异步活动、与 node:test 结果通道竞争（同 storyOutlineAdvance）。
    res.setHeader('Connection', 'close');
    llmRequests.push({ url: req.url, body: raw });
    if (!String(req.url).includes('chat/completions')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
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

const { loadFeatureMigrations } = await import('../src/db/migrations/index.js');
const { runRegisteredMigrations } = await import('../src/db/migrationRegistry.js');
const { getDb, closeDb } = await import('../src/db/index.js');
await loadFeatureMigrations();
runRegisteredMigrations(getDb());

const { resetClient } = await import('../src/llm/llm-client.js');
resetClient(); // 确保 client 用上指向环回服务的 baseURL

const { generateSchedule } = await import('../src/services/scheduleGenerator.js');

function newCharacter(db, name) {
  const r = db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)`)
    .run(name, name, '你是测试角色，作息规律。');
  return Number(r.lastInsertRowid);
}
const tplOf = (db, id) => db.prepare('SELECT schedule_json, version FROM schedule_templates WHERE character_id = ?').get(id);
const planOf = (db, id, dt) => db.prepare('SELECT schedule_json, version FROM schedule_day_plans WHERE character_id = ? AND day_type = ?').get(id, dt);

test('★ F-01①：普通生成成功写默认日历（旧版此处必抛 ReferenceError）', async () => {
  const db = getDb();
  const id = newCharacter(db, '__sg_plain');
  const r = await generateSchedule({ id, display_name: '__sg_plain', base_prompt: '规律作息。' }, '', {});
  assert.ok(r?.schedule_json, '生成应返回 schedule_json');
  const tpl = tplOf(db, id);
  assert.ok(tpl, '默认日历应已写入');
  assert.equal(JSON.parse(tpl.schedule_json).length, ACTIVITIES.length, '应落库全部活动');
  assert.equal(planOf(db, id, 'workday'), undefined, '不传 dayType 时不该写日型方案');
  assert.ok(llmRequests.some((r2) => r2.url.includes('chat/completions')), '应确实发起过一次 LLM 调用');
});

test('★ F-01②：传 dayType → 写 schedule_day_plans 且同时升级默认日历', async () => {
  const db = getDb();
  const id = newCharacter(db, '__sg_workday');
  const r = await generateSchedule({ id, display_name: '__sg_workday', base_prompt: '规律作息。' }, '', { dayType: 'workday' });
  assert.equal(r?.dayType, 'workday', '返回值应带 dayType');
  const plan = planOf(db, id, 'workday');
  assert.ok(plan, 'workday 方案应已写入');
  assert.equal(JSON.parse(plan.schedule_json).length, ACTIVITIES.length);
  const tpl = tplOf(db, id);
  assert.ok(tpl, '默认日历也应同时写入（兜底不落空）');
});

test('★ F-01③：fallbackToDefaultCalendar:false → 只当日型，不覆盖默认日历', async () => {
  const db = getDb();
  const id = newCharacter(db, '__sg_only');
  await generateSchedule({ id, display_name: '__sg_only', base_prompt: '规律作息。' }, '', {}); // 先建默认日历 v1
  const before = tplOf(db, id);
  assert.ok(before, '前置：默认日历已建立');
  const r = await generateSchedule({ id, display_name: '__sg_only', base_prompt: '规律作息。' }, '', { dayType: 'restday', fallbackToDefaultCalendar: false });
  assert.equal(r?.dayType, 'restday');
  assert.ok(planOf(db, id, 'restday'), 'restday 方案应已写入');
  const afterTpl = tplOf(db, id);
  assert.equal(afterTpl.version, before.version, '默认日历不应被覆盖（只当日型）');
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { stubServer.closeAllConnections?.(); } catch { /* ignore */ }
  try { stubServer.close(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
