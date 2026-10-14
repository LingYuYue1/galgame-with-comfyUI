/**
 * 超能力移动豁免兜底 —— F-13 回归测试（2026-10-12）。
 *
 * F-13 = 首轮筛查 P1（报告 #15）：`scheduleGenerator` 取移动方式时兜底读
 * `character?.transit_mode` —— 但**各调用方传入的角色对象都不含该列**
 * （replyQueueScheduler / chars.js / schedule.js 的 SELECT 只取需要的几列），
 * 兜底恒为 undefined → 自动生成路径（调度器/新建角色，不带 options）里
 * 超能力角色被按普通口径判「跨区瞬移」（通勤复算误报 + 约束层要求别瞬移）。
 * 修复：照 home_place 的同款做法**直接查库兜底**（`readCharacterTransitMode`）。
 *
 * 三层钉住：
 *   ① readCharacterTransitMode 从库正确读取（teleport / 未设置 / 不存在）；
 *   ② checkTransitFeasibility 对豁免档位直接放行（返回空）、对普通档位照常报；
 *   ③ **端到端**：generateSchedule（不传任何 options，模拟调度器路径）对
 *      transit_mode=teleport 的角色**不再打出「换场偏紧」告警**；对照 normal 角色会打。
 *
 * ⚠ 临时库 + 环回 HTTP LLM 打桩（同 F-01 模式），不碰真实数据、不调真 LLM。
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

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-transit-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

// ── 打桩日程：甲站(09:00-10:00) → 乙站(10:00-11:00) 无缝换场（gap=0，正是「瞬移」场景），
//    通勤表要求 60 分钟 ──
const ACTS = [
  { startTime: '00:00', endTime: '07:00', activity: '睡觉', location: '家', replyDelay: -1, description: '睡' },
  { startTime: '07:00', endTime: '09:00', activity: '早餐', location: '家', replyDelay: 0, description: '吃' },
  { startTime: '09:00', endTime: '10:00', activity: '在甲站等车', location: '甲站', replyDelay: 0, description: '等' },
  { startTime: '10:00', endTime: '11:00', activity: '到乙站办事', location: '乙站', replyDelay: 0, description: '办' },
  { startTime: '11:00', endTime: '18:00', activity: '工作', location: '工作室', replyDelay: 0, description: '工' },
  { startTime: '18:00', endTime: '19:00', activity: '晚饭', location: '食堂', replyDelay: 0, description: '饭' },
  { startTime: '19:00', endTime: '20:00', activity: '散步', location: '河堤', replyDelay: 0, description: '散' },
  { startTime: '20:00', endTime: '24:00', activity: '自由活动', location: '家', replyDelay: 0, description: '玩' },
];
const STUB_CONTENT = JSON.stringify({ activities: ACTS });
const stubServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    // ⚠ Connection: close —— 禁用客户端 keep-alive 连接复用，避免测试结束后
    //   残留连接产生异步活动、与 node:test 结果通道竞争（同 storyOutlineAdvance）。
    res.setHeader('Connection', 'close');
    if (!String(req.url).includes('chat/completions')) { res.statusCode = 404; res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'stub', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, message: { role: 'assistant', content: STUB_CONTENT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });
});
await new Promise((resolve, reject) => { stubServer.once('error', reject); stubServer.listen(0, '127.0.0.1', resolve); });
const STUB_PORT = stubServer.address().port;

const { config } = await import('../src/config.js');
config.llm.apiKey = 'test-key';
config.llm.baseURL = `http://127.0.0.1:${STUB_PORT}/v1`;
config.llm.model = 'stub-model';
config.llm.freeEgg = false;

const { getDb, closeDb } = await import('../src/db/index.js');
const db = getDb();

const { readCharacterTransitMode, checkTransitFeasibility, generateSchedule } = await import('../src/services/scheduleGenerator.js');

// ── 造数据：通勤表（甲站→乙站 60 分钟）+ 两个角色（teleport / normal） ──
db.prepare(`INSERT INTO world_maps (id, name) VALUES (1, '测试图')`).run();
db.prepare(`INSERT INTO world_map_transit (map_id, line_id, line_name, from_stop, to_stop, mode, km, minutes, seq)
            VALUES (1, 'L1', '一号线', '甲站', '乙站', 'rail', 10, 60, 1)`).run();
const mkChar = (name, mode) => Number(db.prepare(
  `INSERT INTO characters (name, display_name, base_prompt, transit_mode) VALUES (?, ?, '规律作息。', ?)`
).run(name, name, mode).lastInsertRowid);
const idTeleport = mkChar('__f13_teleport', 'teleport');
const idNormal = mkChar('__f13_normal', 'normal');

test('★ F-13①：readCharacterTransitMode 直接查库（不依赖传入对象字段）', () => {
  assert.equal(readCharacterTransitMode(idTeleport), 'teleport');
  assert.equal(readCharacterTransitMode(idNormal), 'normal');
  assert.equal(readCharacterTransitMode(999999), undefined, '不存在的角色 → undefined');
  assert.equal(readCharacterTransitMode(null), undefined);
});

test('★ F-13②：checkTransitFeasibility 对豁免档位放行、对普通档位照常报', () => {
  const edges = [{ from_stop: '甲站', to_stop: '乙站', minutes: 60, line_name: '一号线' }];
  const acts = [
    { startTime: '09:00', endTime: '10:00', location: '甲站' },
    { startTime: '10:05', endTime: '11:00', location: '乙站' },
  ];
  assert.equal(checkTransitFeasibility(acts, edges, null, 'teleport').length, 0, '豁免档位应直接放行');
  assert.ok(checkTransitFeasibility(acts, edges, null, 'normal').length >= 1, '普通档位应报换场不足');
});

test('★ F-13③（端到端）：不传 options 时，teleport 角色不再误报「换场偏紧」', async (t) => {
  // mock 但**转发到 stderr**（静音会藏住校验失败原因；断言只看 mock.calls）
  const warn = t.mock.method(console, 'warn', (...args) => { process.stderr.write(`[warn] ${args.join(' ')}\n`); });
  const tpl = await generateSchedule({ id: idTeleport, display_name: '__f13_teleport', base_prompt: '规律作息。' });
  const teleWarns = warn.mock.calls.map(c => String(c.arguments?.[0] ?? '')).join('\n');
  assert.ok(tpl?.schedule_json, '生成应成功');
  assert.ok(!teleWarns.includes('换场偏紧'),
    `teleport 角色不应被记「换场偏紧」（修复前因兜底读不到 transit_mode 误报）：\n${teleWarns}`);

  // 对照：normal 角色同样日程 → 应被打出「换场偏紧」（证明检查真的在跑）
  warn.mock.resetCalls();
  await generateSchedule({ id: idNormal, display_name: '__f13_normal', base_prompt: '规律作息。' });
  const normalWarns = warn.mock.calls.map(c => String(c.arguments?.[0] ?? '')).join('\n');
  assert.ok(normalWarns.includes('换场偏紧'), 'normal 角色应被记「换场偏紧」（对照组，防假绿）');
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { stubServer.closeAllConnections?.(); } catch { /* ignore */ }
  try { stubServer.close(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
