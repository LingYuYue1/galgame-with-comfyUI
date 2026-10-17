import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const stub = source => `data:text/javascript,${encodeURIComponent(source)}`;
const configModule = stub(`
  export const config = { llm: {}, features: {} };
  export const FREE_EGG_MODELS = ['free-test'];
  export function updateFreeEggEnabled(enabled) { config.llm.freeEgg = enabled; }
`);
const { config } = await import(configModule);
const sourceUrl = new URL('../src/llm/llm-client.js', import.meta.url);
const imports = {
  openai: import.meta.resolve('openai'),
  './modelCapabilities.js': new URL('../src/llm/modelCapabilities.js', import.meta.url).href,
  '../config.js': configModule,
  '../services/llmImageInput.js': stub('export const compressLlmImageInputs = async messages => messages;'),
  '../services/llmConcurrency.js': stub('export const acquireSlot = async () => {}; export const releaseSlot = () => {};'),
  '../services/llmTelemetry.js': stub('export const recordLlmCall = () => {};'),
};
const source = readFileSync(sourceUrl, 'utf8').replace(/from '([^']+)'/g,
  (match, specifier) => imports[specifier] ? `from ${JSON.stringify(imports[specifier])}` : match);
const client = await import(stub(source));
const limitKeys = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'];
const messages = [{ role: 'system', content: 'stable rules' }, { role: 'user', content: 'task' }];

// Exercise the real SDK and capture serialized HTTP bodies, without production config or paid calls.
test('all LLM request paths use the configured output allowance', async t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'warn', () => {});
  const requests = [];
  let failRequests = 0;
  let finishReason = 'stop';
  let reasoning;
  let failStream = false;
  const reply = '完整输出'.repeat(1500);
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = JSON.parse(body);
    requests.push(params);
    if (failRequests > 0) {
      failRequests--;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'retry fixture' } }));
      return;
    }
    if (params.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (reasoning) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning.slice(0, 1000) } }] })}\n\n`);
      }
      if (failStream) {
        res.end(`data: ${JSON.stringify({ error: { message: 'stream fixture failure' } })}\n\n`);
        return;
      }
      for (const [index, content] of [reply.slice(0, 3000), reply.slice(3000)].entries()) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(index === 0 ? { reasoning_content: reasoning?.slice(1000) } : {}) } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: params.model, choices: [{ message: { content: reply, reasoning_content: reasoning }, finish_reason: finishReason }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { client.resetClient(); await new Promise(resolve => server.close(resolve)); });
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  Object.assign(config.llm, { baseURL, apiKey: 'local-fixture', model: 'test-model', maxTokens: 65536, thinkingMode: 'disabled' });

  function assertAllowance(params, expected = 65536) {
    const keys = limitKeys.filter(key => Object.hasOwn(params, key));
    assert.equal(keys.length, 1);
    assert.equal(params[keys[0]], expected);
  }
  async function stream(opts) {
    let result = '';
    for await (const chunk of client.chatStream(messages, opts)) result += chunk;
    assert.equal(result, reply);
  }

  await t.test('sync, stream and connection test share the configured allowance', async () => {
    assert.equal(await client.chatSync(messages), reply);
    await stream();
    assert.equal((await client.testLlmConnection()).ok, true);
    assert.equal(requests.length, 3);
    requests.forEach(params => assertAllowance(params));
    assert.deepEqual(requests[0].messages, messages);
    assert.deepEqual(requests[0].thinking, { type: 'disabled' });
    await client.testLlmConnection({ maxTokens: 393216, thinkingMode: 'enabled' });
    assertAllowance(requests.at(-1), 393216);
    assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' });
    assert.equal(config.llm.maxTokens, 65536);
    await assert.rejects(client.testLlmConnection({ maxTokens: 0 }), /正整数/);
  });

  await t.test('sync and stream log complete reasoning separately without changing business output', async () => {
    reasoning = '模拟服务商思考内容。'.repeat(500);
    for (const run of [() => client.chatSync(messages, { label: '发朋友圈助手' }), () => stream({ label: '发朋友圈助手' })]) {
      logs.length = 0;
      const result = await run();
      if (result !== undefined) assert.equal(result, reply);
      assert.equal(logs.filter(line => line === reasoning).length, 1);
      assert.ok(logs.some(line => line.includes('发朋友圈助手 思考链')));
      assert.ok(logs.some(line => line.includes('发朋友圈助手 正文')));
      assert.ok(logs.indexOf(reasoning) < logs.indexOf(reply.slice(0, 2000)));
    }
    reasoning = undefined;
    logs.length = 0;
    await client.chatSync(messages);
    await stream();
    assert.equal(logs.filter(line => line === '(服务商未返回思考内容)').length, 2);
  });

  await t.test('an interrupted stream logs reasoning received before the failure', async () => {
    reasoning = '模拟部分思考。'.repeat(500);
    failStream = true;
    logs.length = 0;
    try {
      await assert.rejects(stream(), /stream fixture failure/);
      assert.ok(logs.includes(reasoning.slice(0, 1000)));
      assert.ok(logs.some(line => line.includes('流中断，已收到的部分')));
    } finally {
      reasoning = undefined;
      failStream = false;
    }
  });

  await t.test('legacy options cannot override the setting; protocol field and finish reason survive', async () => {
    const extraBody = Object.freeze({ max_tokens: 8, max_completion_tokens: 16, max_output_tokens: 32, top_p: 0.8 });
    config.llm.extraBody = extraBody;
    finishReason = 'length';
    const opts = { max_tokens: 1, max_completion_tokens: 2, max_output_tokens: 3, temperature: 0.3 };
    const result = await client.chatSync(messages, { ...opts, returnMeta: true, response_format: { type: 'json_object' } });
    assert.equal(result.content, reply);
    assert.equal(result.finishReason, 'length');
    assert.deepEqual(requests.at(-1).response_format, { type: 'json_object' });
    assert.equal(requests.at(-1).temperature, 0.3);
    assert.equal(requests.at(-1).max_completion_tokens, 65536);
    await stream(opts);
    await client.testLlmConnection({ extraBody });
    for (const params of requests.slice(-3)) {
      assertAllowance(params);
      assert.equal(params.top_p, 0.8);
    }
    assert.equal(extraBody.max_tokens, 8);
    assert.equal(opts.max_tokens, 1);
  });

  await t.test('retry requests keep the configured allowance', async () => {
    failRequests = 1;
    const start = requests.length;
    assert.equal(await client.chatSync(messages, { retries: 1, retryDelay: 1, maxRetries: 0 }), reply);
    assert.equal(requests.length - start, 2);
    requests.slice(start).forEach(params => assertAllowance(params));
  });

  await t.test('free model and fallback requests use their effective configuration', async () => {
    config.llm.freeEgg = true;
    client.resetClient();
    client.resetFreeEggFailureCount();
    failRequests = 1;
    const start = requests.length;
    assert.equal(await client.chatSync(messages, { retries: 0, maxRetries: 0 }), reply);
    assert.deepEqual(requests.slice(start).map(p => p.model), ['free-test', 'test-model']);
    requests.slice(start).forEach(params => assertAllowance(params));
    config.llm.freeEgg = true;
    client.resetClient();
    await stream();
    assert.equal(requests.at(-1).model, 'free-test');
    assertAllowance(requests.at(-1));
  });
});
