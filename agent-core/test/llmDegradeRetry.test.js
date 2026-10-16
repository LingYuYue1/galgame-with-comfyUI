/**
 * F-62 回归测试：`chatSync` 的「空正文 + finish_reason=length」降级重发。
 *
 * 背景（为什么要这层网）：本机通道（opencode + deepseek-v4.1-flash、
 * `LLM_THINKING_MODE=enabled`）下**推理 token 计入 max_tokens**。调用方按正文长度设的
 * 预算被思考吃光时，返回的是 `content=''` + `finish_reason='length'` —— 对调用方等同
 * 「模型没说话」：wakeService / replyQueueScheduler 直接 `throw new Error('Empty reply')`，
 * peek 落模板兜底（F-60），日程生成整条链失败（F-58）。
 *
 * 本测试钉住的四条不变量：
 *   ① 空正文 + length + 思考开启 → **自动关思考重发一次**，返回重发后的正文；
 *      且两次请求的 thinking 值必须在报文体里真实生效（enabled → disabled）；
 *   ② 空正文但 finish_reason='stop' → **不是**预算问题，不重发（不能把「模型真不想说」
 *      也当成预算事故，否则每个空返回都要白烧一次调用）；
 *   ③ 思考本来就关着（全局 disabled）→ 不重发；
 *   ④ 逃生阀 `degradeRetry:false` → 不重发，原样交回空正文（不改变调用方错误语义）。
 *
 * ⚠ LLM 打桩方式：本进程环回 HTTP 服务当假端点（openai SDK 用自带 node-fetch，
 *   替换 globalThis.fetch 无效），`Connection: close` 防测试结束后的残留连接。
 *   全程不碰真库、不调真 LLM。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { installLlmCallLogSuppressor } from './helpers/suppressLlmCallLog.js';

installLlmCallLogSuppressor();

// ── 假 LLM 端点：按「第几次请求」依次吐预设响应，并记录每次的请求体 ──
/** 预设队列：[{ content, finishReason }]，用完后重复最后一个 */
const scripted = [];
const llmRequests = [];
const stubServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    res.setHeader('Connection', 'close');   // 禁 keep-alive 复用，避免残留异步活动
    if (!String(req.url).includes('chat/completions')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    llmRequests.push({ body: JSON.parse(raw || '{}') });
    const step = scripted[Math.min(llmRequests.length - 1, scripted.length - 1)] || { content: '', finishReason: 'length' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'stub', object: 'chat.completion', created: 0, model: 'stub-model',
      choices: [{ index: 0, message: { role: 'assistant', content: step.content }, finish_reason: step.finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
});
await new Promise((resolve, reject) => {
  stubServer.once('error', reject);
  stubServer.listen(0, '127.0.0.1', resolve);
});
const STUB_PORT = stubServer.address().port;

after(() => { stubServer.close(); });

const { config } = await import('../src/config.js');
config.llm.apiKey = 'test-key';
config.llm.baseURL = `http://127.0.0.1:${STUB_PORT}/v1`;
config.llm.model = 'stub-model';
config.llm.freeEgg = false;
config.llm.headers = {};
config.llm.extraBody = {};

const { chatSync, resetClient } = await import('../src/llm/llm-client.js');
resetClient();   // 让 client 用上指向环回服务的 baseURL

const MSGS = [{ role: 'user', content: '写一句画面描述' }];
const thinkingOf = (i) => llmRequests[i]?.body?.thinking ?? null;

test('① 空正文 + finish_reason=length + 思考开启 → 关思考重发一次并返回正文', async () => {
  scripted.length = 0;
  llmRequests.length = 0;
  config.llm.thinkingMode = 'enabled';
  scripted.push(
    { content: '', finishReason: 'length' },                                  // 第一次：推理吃光预算
    { content: 'A girl stands by the window.', finishReason: 'stop' },        // 第二次：降级后正常
  );

  const out = await chatSync(MSGS, { max_tokens: 64, label: 'test-degrade-1' });

  assert.equal(llmRequests.length, 2, '应恰好重发一次（不多不少）');
  assert.deepEqual(thinkingOf(0), { type: 'enabled' }, '首次请求应带全局的 thinking=enabled');
  assert.deepEqual(thinkingOf(1), { type: 'disabled' }, '重发请求必须显式关闭思考');
  assert.equal(out, 'A girl stands by the window.', '应返回降级重发后的正文，而不是空串');
});

test('② 空正文但 finish_reason=stop → 不是预算事故，不重发', async () => {
  scripted.length = 0;
  llmRequests.length = 0;
  config.llm.thinkingMode = 'enabled';
  scripted.push({ content: '', finishReason: 'stop' });

  const out = await chatSync(MSGS, { max_tokens: 64, label: 'test-degrade-2' });

  assert.equal(llmRequests.length, 1, 'stop 结尾的空正文不应触发降级重发');
  assert.equal(out, '', '原样交回空串，由调用方既有兜底处理');
});

test('③ 全局已关思考 → 空正文 + length 也不重发（本来就不是这个病）', async () => {
  scripted.length = 0;
  llmRequests.length = 0;
  config.llm.thinkingMode = 'disabled';
  try {
    scripted.push({ content: '', finishReason: 'length' });

    const out = await chatSync(MSGS, { max_tokens: 64, label: 'test-degrade-3' });

    assert.equal(llmRequests.length, 1, '思考关着时不应重发');
    assert.equal(out, '');
  } finally {
    config.llm.thinkingMode = 'enabled';
  }
});

test('④ 逃生阀 degradeRetry:false → 不重发，原样交回空正文', async () => {
  scripted.length = 0;
  llmRequests.length = 0;
  config.llm.thinkingMode = 'enabled';
  scripted.push(
    { content: '', finishReason: 'length' },
    { content: '不该出现的内容', finishReason: 'stop' },
  );

  const out = await chatSync(MSGS, { max_tokens: 64, label: 'test-degrade-4', degradeRetry: false });

  assert.equal(llmRequests.length, 1, '逃生阀关闭后不得重发');
  assert.equal(out, '');
});

test('⑤ 正常返回（有正文）→ 无论 finish_reason 都不重发', async () => {
  scripted.length = 0;
  llmRequests.length = 0;
  config.llm.thinkingMode = 'enabled';
  scripted.push({ content: '正常正文', finishReason: 'length' });   // 正文被截断但有内容

  const out = await chatSync(MSGS, { max_tokens: 64, label: 'test-degrade-5' });

  assert.equal(llmRequests.length, 1, '有正文就不该重发（截断由调用方自行判断）');
  assert.equal(out, '正常正文');
});
