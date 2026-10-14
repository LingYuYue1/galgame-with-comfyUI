/**
 * 故事线「判定是否推进」—— F-04 回归测试（2026-10-12）。
 *
 * F-04 = 首轮筛查 P1：前端 StoryView 的「判定是否推进」按钮调用
 * `advanceStoryOutline('')` 传空串 → `judgeOutlineAdvance` 遇空串直接返回
 * 「没有可判定的剧情文本」，**从不发起 LLM 判定**（功能完全不可用）。
 * 且模块底部的 `composeRecentText` 拼接器早已写好、却一直没有调用方接线。
 *
 * 修复：`judgeOutlineAdvance` 在未收到正文时**自动取最近聊天文本**（recent-chat）。
 * 本测试钉住的不变量：
 *   ① 未传正文 → 自动取最近消息组成正文 → 确实发起 LLM 调用，且正文含聊天内容与角色名；
 *   ② LLM 判 true → cursor +1；判 false → cursor 不动；
 *   ③ 显式传入正文时优先手动文本（manual），不混自动取的聊天；
 *   ④ 无聊天记录且无手动文本 → 维持「没有可判定的剧情文本」（不发 LLM）；
 *   ⑤ 请求体带 `thinking:{type:'disabled'}`（F-04 附带：60 的预算防被思考吃光）。
 *
 * ⚠ 全程临时库 + 环回 HTTP LLM 打桩（与 F-01 测试同模式），不碰真实数据、不调真 LLM。
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

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-outline-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

// ── LLM 打桩：环回 HTTP 服务，返回预设的判定 JSON ──
let stubReply = '{"advanced": true}';
const llmRequests = [];
const stubServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    // ⚠ Connection: close —— 禁用客户端 keep-alive 连接复用。全量并发跑测试时，
    //   残留的 keep-alive 连接会让「测试已结束」的进程仍持有异步活动，与 node:test
    //   的结果通道写流竞争，runner 报 "Unable to deserialize cloned data" 并误杀本文件。
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
const { loadFeatureMigrations } = await import('../src/db/migrations/index.js');
const { runRegisteredMigrations } = await import('../src/db/migrationRegistry.js');
await loadFeatureMigrations();
const db = getDb();
runRegisteredMigrations(db);   // story_outlines 由可插拔迁移 007 建表

const { saveOutline, getOutline, judgeOutlineAdvance } = await import('../src/services/story/outlineService.js');

// ── 造数据：两个角色 + 聊天消息 + 一份 2 节点大纲（cursor=1） ──
const id1 = Number(db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('c1', '三月七', 'p')`).run().lastInsertRowid);
const id2 = Number(db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('c2', '青雀', 'p')`).run().lastInsertRowid);
const insMsg = db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)`);
insMsg.run(`char_${id1}`, 'user', '我们今天去哪里？');
insMsg.run(`char_${id1}`, 'assistant', '去下城区逛摊位吧，MARKER_PLOT_ALPHA');
insMsg.run(`char_${id2}`, 'assistant', '南行有货——MARKER_PLOT_BETA');

const RAW = [
  'Beat: 第一天|初到下城区|主线|无|与众人会合',
  'Scene: 下城区广场，人声嘈杂',
  'Subtext: 心里有些不安',
  'Think: 先熟悉环境',
  '',
  'Beat: 第二天|摊位的秘密|主线|无|发现线索',
  'Scene: 街边食摊',
  'Subtext: 摊主眼神躲闪',
  'Think: 这里有问题',
].join('\n');
saveOutline({ raw: RAW, basisNote: 'F-04 测试大纲' });

test('★ F-04①：未传正文 → 自动取最近聊天 → 发起 LLM 判定 → true 则 cursor +1', async () => {
  stubReply = '{"advanced": true}';
  llmRequests.length = 0;
  const before = getOutline();
  assert.equal(before.cursor, 1, '前置：cursor=1');
  const r = await judgeOutlineAdvance({});
  assert.equal(llmRequests.length, 1, '应发起一次 LLM 调用');
  const sentBody = llmRequests[0].body;
  assert.ok(sentBody.includes('MARKER_PLOT_ALPHA'), '发给 LLM 的正文应含最近聊天内容');
  assert.ok(sentBody.includes('MARKER_PLOT_BETA'), '应含另一会话的最近消息');
  assert.ok(sentBody.includes('三月七'), '正文应带角色名（而非裸"角色"）');
  assert.equal(JSON.parse(sentBody).thinking?.type, 'disabled', '应带 thinking:disabled（防思考吃光 60 预算）');
  assert.equal(r.advanced, true);
  assert.equal(r.cursor, 2, 'cursor 应 +1');
  assert.equal(r.textSource, 'recent-chat', '应标记来源为自动取聊天');
});

test('★ F-04②：LLM 判 false → cursor 不动', async () => {
  stubReply = '{"advanced": false}';
  db.prepare('UPDATE story_outlines SET cursor = 1').run();   // 重置回 1，确保能进入判定分支
  llmRequests.length = 0;
  const r = await judgeOutlineAdvance({});
  assert.equal(llmRequests.length, 1);
  assert.equal(r.advanced, false);
  assert.equal(r.cursor, 1, 'cursor 应保持不变');
  assert.equal(r.reason, '剧情未推进');
});

test('★ F-04③：显式传正文时优先手动文本（manual），不混自动取的聊天', async () => {
  stubReply = '{"advanced": false}';
  db.prepare('UPDATE story_outlines SET cursor = 1').run();
  llmRequests.length = 0;
  const r = await judgeOutlineAdvance({ recentText: 'MANUAL_TEXT_XYZ 手动提供的正文' });
  assert.equal(r.textSource, 'manual');
  assert.ok(llmRequests[0].body.includes('MANUAL_TEXT_XYZ'));
  assert.ok(!llmRequests[0].body.includes('MARKER_PLOT_ALPHA'), '手动正文时不应混入自动取的内容');
});

test('★ F-04④：无聊天记录且无手动正文 → 维持「没有可判定的剧情文本」（不发 LLM）', async () => {
  db.prepare('UPDATE story_outlines SET cursor = 1').run();
  db.prepare('DELETE FROM messages').run();
  llmRequests.length = 0;
  const r = await judgeOutlineAdvance({});
  assert.equal(r.advanced, false);
  assert.equal(r.reason, '没有可判定的剧情文本');
  assert.equal(llmRequests.length, 0, '不应发起 LLM 调用');
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  // ⚠ 先强制断开残留连接再关服务：keep-alive 残留会让测试结束后的进程仍有异步活动，
  //   与 node:test 结果通道竞争（见打桩处 Connection: close 注释）。
  try { stubServer.closeAllConnections?.(); } catch { /* ignore */ }
  try { stubServer.close(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
