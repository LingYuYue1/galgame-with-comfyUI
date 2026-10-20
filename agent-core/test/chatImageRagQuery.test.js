import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { extractImagePromptResponse, requestNonEmptyImagePrompt } from '../src/services/imagePromptResponse.js';

// 执行真实路由函数，隔离数据库、LLM 与 ComfyUI，避免测试发起实际生图。
const source = readFileSync(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
const imageFlowSource = source.slice(
  source.indexOf('async function triggerImageGeneration('),
  source.indexOf('const dialogueGuessCache ='),
);
const stripTagsSource = source.slice(source.indexOf('function stripTags('), source.indexOf('function stripBracketActions('));
const prompt = 'A bedroom selfie shot from a phone front camera.';
const expectedQuery = '小明: 发一张卧室自拍\n小夏: 好呀，我坐在床边拍给你。';

function harness() {
  const history = [
    { role: 'user', content: '之前在咖啡厅' },
    { role: 'assistant', content: '之前穿着外套' },
    { role: 'user', content: '<dynamic_context>天气晴朗，旧日程在公园</dynamic_context>\n发一张卧室自拍' },
    { role: 'assistant', content: '好呀，我坐在床边拍给你。' },
  ];
  const calls = [];
  const events = [];
  const db = {
    prepare(sql) {
      return {
        all: () => history.map(row => ({ ...row })).reverse(),
        get: () => {
          if (sql.includes('SELECT id, prompt FROM raw_messages')) return { id: 4, prompt: null };
          if (sql.includes('SELECT id FROM messages')) return { id: 4 };
          return undefined;
        },
        run: (...args) => {
          if (sql.includes('UPDATE raw_messages SET prompt')) history.at(-1).content += args[1];
          return { changes: 1, lastInsertRowid: 5 };
        },
      };
    },
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    getDb: () => db,
    config: { user: { nickname: '小明' } },
    getSystemRules: () => '',
    getGlobalRule: () => null,
    buildCharacterPersona: () => '测试人设',
    matchAll: () => [],
    matchUser: () => false,
    getLightNoteWithWeather: () => '',
    getCurrentActivity: () => null,
    isTempWoken: () => false,
    getCharacterEmojiMap: () => ({}),
    extractImagePromptResponse,
    requestNonEmptyImagePrompt,
    chatWithLorebook: async () => prompt,
    RAG_TIMEOUT_FAST_MS: 200,
    generateImage: async (text, options) => {
      calls.push({ text, options });
      return { success: true, images: [{ filename: 'test.png', base64: '' }] };
    },
    saveBase64Image: () => '/images/chat/test.png',
    invalidateGalleryCache() {},
    imageJudgeCounters: new Map(),
    getLastWorkflowMode: () => 'test',
    send: (event, data) => events.push({ event, data }),
    character: { id: 1, display_name: '小夏' },
  };
  runInNewContext(stripTagsSource + imageFlowSource, context);
  return { context, calls, events, history };
}

for (const planned of [false, true]) {
  test(`${planned ? '规划预生成' : '普通生图助手'}将最后一轮对话透传给图片 RAG`, async () => {
    const { context, calls, events, history } = harness();
    await context.handleNeedImageFlow('char_1', context.character, context.send, 5,
      planned ? '规划中不同措辞的画面需求' : '', planned ? Promise.resolve(prompt) : null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, prompt);
    assert.equal(calls[0].options.ragQuery, expectedQuery);
    assert.ok(history.at(-1).content.includes(prompt), '落库已拼入英文提示词，RAG 仍须使用之前捕获的对话');
    assert.ok(events.some(item => item.event === 'generate_done'));
    assert.ok(!events.some(item => item.event === 'generate_error'));
  });
}

test('聊天直接返回 prompt 时也传入本轮对话，并剥离动态块和图片 JSON', async () => {
  const { context, calls, history } = harness();
  Object.assign(context, {
    conversationId: 'char_1', tags: { prompt }, lastInsertRowid: 4, allRefIds: [],
    chatUserName: '小明', message: history[2].content,
    fullContent: `${history[3].content}${JSON.stringify({ prompt })}`,
  });
  const cleaner = source.slice(source.indexOf('    const extractRealContent ='), source.indexOf('    const recentInputs ='));
  const directBranch = source.slice(source.indexOf('      // 路径 A:'), source.indexOf('    } else if (hasNeedImageTag)'));
  await runInNewContext(`(async () => { let imageGenPromise; ${cleaner}\n${directBranch}\nawait imageGenPromise; })()`, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.ragQuery, expectedQuery);
});

test('梦话配图使用本轮用户消息和梦话正文作为 RAG query', async () => {
  const { context, calls } = harness();
  const output = [];
  Object.assign(context, {
    broadcast() {},
    ensureDreamOnDemand: async () => ({ id: 1, content: '较早的梦境正文' }),
    generateLiveDreamMurmur: async () => ({ talk: '唔，云朵变成棉花糖了……', imagePrompt: prompt }),
    decorateDreamImagePrompt: text => text,
    _parseLoras: () => [],
    charArtistOverride: () => null,
  });
  runInNewContext(source.slice(source.indexOf('async function handleDreamTalkReply('), source.indexOf('function _parseLoras(')), context);
  const res = { writeHead() {}, setTimeout() {}, write: text => output.push(text), end() {} };
  await context.handleDreamTalkReply(res, 1, 'char_1', 2, context.character, '你梦到什么啦？');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, prompt);
  assert.equal(calls[0].options.ragQuery, '小明: 你梦到什么啦？\n小夏: 唔，云朵变成棉花糖了……');
  assert.ok(output.some(text => text.startsWith('event: generate_done')));
  assert.ok(!output.some(text => text.startsWith('event: generate_error')));
});
