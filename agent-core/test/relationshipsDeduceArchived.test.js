/**
 * 关系推演「归档中心角色」回归测试 —— F-16（2026-10-12）。
 *
 * F-16 = 首轮筛查 P1：`routes/relationships.js` 的 `/deduce` 在**非 user 模式**下，
 * 中心角色是单独查库的（**不受归档过滤** —— 注释明确「中心角色不受影响」，即设计上
 * 允许归档角色当中心），但结果装配用的 `nameToChar` 只从「未归档角色」构建：
 *   `const fromChar = nameToChar[item.from_name]` → 归档中心查不到 → `continue` 跳过
 *   **每一条** → 推演恒返回 `{relationships: []}`（LLM 其实正常跑完、内容全被丢）。
 *
 * 三层钉住：
 *   ① ★（主诉）归档角色当中心 → 返回非空，且 from_id / from_display 正确；
 *   ② 对照：未归档中心照常返回（修复不得破坏既有路径）；
 *   ③ 另一半设计不回归：**归档的非中心角色**仍不出现在候选（不写进 prompt）。
 *
 * ⚠ 临时库 + 环回 HTTP LLM 打桩（同 F-01/F-04 模式）：不碰真实数据、不调真 LLM。
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

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-reldeduce-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

// ── LLM 打桩：环回 HTTP 服务；回复内容按测试用例动态给 ──
let stubReply = '{"relationships":[]}';
const llmRequests = [];
const stubServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    // 禁用客户端 keep-alive 连接复用，避免测试结束后残留异步活动（见 helper 注释）
    res.setHeader('Connection', 'close');
    llmRequests.push({ url: req.url, body: raw });
    if (!String(req.url).includes('chat/completions')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'stub', object: 'chat.completion', created: 0, model: 'stub',
      choices: [{ index: 0, message: { role: 'assistant', content: stubReply }, finish_reason: 'stop' }],
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

const { getDb, closeDb } = await import('../src/db/index.js');
const router = (await import('../src/routes/relationships.js')).default;

const db = getDb();

// ── 种子：归档中心 + 未归档中心 + 两名候选 + 一名归档路人（不该进候选）──
const insert = db.prepare(
  'INSERT INTO characters (name, display_name, base_prompt, archived) VALUES (?, ?, ?, ?)'
);
const archCenterId = Number(insert.run('arch_center', '归档中心', '你是归档中心（测试角色）', 1).lastInsertRowid);
const liveCenterId = Number(insert.run('live_center', '在职中心', '你是在职中心（测试角色）', 0).lastInsertRowid);
insert.run('cand_a', '候选甲', '你是候选甲（测试角色）', 0);
insert.run('cand_b', '候选乙', '你是候选乙（测试角色）', 0);
insert.run('arch_other', '归档路人', '你是归档路人（测试角色）', 1);

/** 直接驱动 express router（handler 一次性 res.json 返回） */
function callDeduce(body) {
  return new Promise((resolve, reject) => {
    const req = { method: 'POST', url: '/deduce', params: {}, body };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    router.handle(req, res, (err) => (err ? reject(err) : resolve(null)));
  });
}

function stubFor(centerName) {
  return JSON.stringify({
    relationships: [
      { from_name: centerName, to_name: 'cand_a', relationship_text: '从小一起长大的死党', intimacy: 2 },
      { from_name: centerName, to_name: 'cand_b', relationship_text: '互相看不顺眼的同事', intimacy: 0 },
    ],
  });
}

test('★ F-16①：归档角色当中心 → 推演返回非空（修复前：恒空）', async () => {
  stubReply = stubFor('arch_center');
  llmRequests.length = 0;
  const { status, payload } = await callDeduce({ characterId: archCenterId, mode: 'character' });

  assert.equal(status, 200);
  assert.equal(llmRequests.length, 1, 'LLM 应已发起（修复前也是——问题在结果装配被丢）');
  assert.equal(payload.relationships.length, 2, '归档中心应返回 2 条关系（修复前被 fromChar 缺失整条跳过 → 0）');
  const first = payload.relationships[0];
  assert.equal(first.from_name, 'arch_center');
  assert.equal(first.from_id, archCenterId, 'from_id 应为归档中心自己的 id');
  assert.equal(first.from_display, '归档中心');
  assert.deepEqual(payload.relationships.map(r => r.to_name).sort(), ['cand_a', 'cand_b']);
  assert.equal(payload.relationships.find(r => r.to_name === 'cand_a').intimacy, 2, 'intimacy 应按 LLM 给值透传');
});

test('F-16②（对照）：未归档中心照常返回（既有路径不回归）', async () => {
  stubReply = stubFor('live_center');
  llmRequests.length = 0;
  const { status, payload } = await callDeduce({ characterId: liveCenterId, mode: 'character' });

  assert.equal(status, 200);
  assert.equal(llmRequests.length, 1);
  assert.equal(payload.relationships.length, 2);
  assert.equal(payload.relationships[0].from_display, '在职中心');
});

test('F-16③（设计另一半不回归）：归档的**非中心**角色仍不进候选、不写进 prompt', async () => {
  stubReply = stubFor('live_center');
  llmRequests.length = 0;
  await callDeduce({ characterId: liveCenterId, mode: 'character' });

  const prompt = llmRequests[0].body;
  assert.ok(prompt.includes('cand_a'), '候选应写进 prompt');
  assert.ok(!prompt.includes('arch_other'), '归档路人不得出现在候选/prompt');
  assert.ok(!prompt.includes('归档路人'), '归档路人的显示名也不得出现');
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { stubServer.closeAllConnections?.(); } catch { /* ignore */ }
  try { stubServer.close(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
