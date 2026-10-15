import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

process.env.DB_PATH = ':memory:';
const requests = [];
const responses = [];
const imageModule = new URL('../src/services/imageSkill.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === imageModule) return {
      format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(`${imageModule}?actual`)};
        export const generateImageRaw = async () => ({ success: false, images: [] });`,
    };
    return nextLoad(url, context);
  },
});
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://media-format-test.invalid/v1/chat/completions');
  assert.equal(new Headers(options.headers).get('content-type'), 'application/json');
  requests.push(JSON.parse(options.body));
  assert.ok(responses.length, 'unexpected external request');
  return new Response(JSON.stringify({
    choices: [{ message: { content: responses.shift() }, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } });
};
await import('openai/shims/web');
const { getDb, closeDb } = await import('../src/db/index.js');
const { config } = await import('../src/config.js');
const { extractFirstJson } = await import('../src/services/eventGenerator.js');
const {
  buildFormatPrompt, normalizeMediaDraft, createOutlet,
  generateMediaBatch, fillPendingImages,
} = await import('../src/services/mediaService.js');
config.llm.freeEgg = false;
config.llm._baseURL = 'https://media-format-test.invalid/v1';
config.llm._apiKey = 'test-only';
after(async () => { await fillPendingImages(0); hooks.deregister(); closeDb(); });

const post = { title: '窗边喝茶', content: '午后的光落在杯子上。', image_prompt: 'A cup beside a window, warm sunlight' };

test('social output example is valid JSON with numeric metrics and a required image prompt', () => {
  const format = buildFormatPrompt({}, [], []);
  const raw = JSON.parse(extractFirstJson(format));
  assert.equal(typeof raw.posts[0].likes, 'number');
  assert.equal(typeof raw.posts[0].views, 'number');
  assert.ok(raw.posts[0].image_prompt.trim());
  assert.equal(normalizeMediaDraft(raw, [])[0].image_prompt, raw.posts[0].image_prompt);
  assert.match(format, /每条帖子必填，必须是非空英文字符串/);
});

test('board and author names containing quotes or backslashes cannot break the JSON example', () => {
  const name = '窗边 "日常" \\ 分享';
  const format = buildFormatPrompt({}, [{ name }], [{ display_name: name }]);
  const raw = JSON.parse(extractFirstJson(format));
  assert.ok(raw.posts[0].board.includes(name));
  assert.ok(format.includes(`第 1 条帖子的作者必须是「${name}」本人`));
});

test('valid JSON with missing, empty or non-string image fields cannot become text-only drafts', () => {
  for (const value of [undefined, null, '', ' \n ', 1, false, {}, ['a scene']]) {
    assert.throws(() => normalizeMediaDraft({ posts: [{ ...post, image_prompt: value }] }, []), /第 1 条.*image_prompt/);
  }
  assert.throws(() => normalizeMediaDraft({ posts: [post, { title: '第二条', content: '正文' }] }, []), /第 2 条.*image_prompt/);
  assert.equal(normalizeMediaDraft({ posts: [{ ...post, image_prompt: undefined, imagePrompt: 'legacy scene' }] }, [])[0].image_prompt, 'legacy scene');
});

test('request declares JSON output, preserves message roles and waits for images', async () => {
  const db = getDb();
  const outlet = createOutlet({ name: '图文格式回归', prompt: '测试媒体', layout: 'feed' });
  const boardName = '窗边 "日常" \\ 分享';
  db.prepare('INSERT INTO media_boards (outlet_id, name) VALUES (?, ?)').run(outlet.id, boardName);
  const corrected = { ...post, board: boardName, image_prompt: 'A sign shaped like \\sun beside a window' };
  responses.push(JSON.stringify({ posts: [corrected] }));
  const start = requests.length;
  const result = await generateMediaBatch({ outletId: outlet.id, count: 1, withCharacters: false });
  await fillPendingImages(0);
  assert.equal(result.inserted, 1);
  const calls = requests.slice(start);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].response_format, { type: 'json_object' });
  assert.equal(calls[0].messages.at(-1).role, 'user');
  assert.deepEqual(calls[0].messages.map(m => m.role), ['system', 'system', 'system', 'user']);
  assert.equal(calls[0].messages[1].content, '测试媒体');
  const formatIndex = 2;
  assert.ok(calls[0].messages.at(-1).content.includes(boardName));
  assert.doesNotThrow(() => JSON.parse(extractFirstJson(calls[0].messages[formatIndex].content)));
  const rows = db.prepare('SELECT image_prompt, published_seq FROM media_posts WHERE outlet_id = ?').all(outlet.id);
  assert.deepEqual(rows, [{ image_prompt: corrected.image_prompt, published_seq: null }]);
});

test('missing image prompt fails immediately without retrying or inserting any part of the batch', async () => {
  const db = getDb();
  const outlet = createOutlet({ name: '拒绝无图回归', prompt: '测试媒体', layout: 'feed' });
  const broken = JSON.stringify({ posts: [post, { title: '缺图', content: '正文', image_prompt: null }] });
  responses.push(broken);
  const start = requests.length;
  await assert.rejects(generateMediaBatch({ outletId: outlet.id, count: 2, withCharacters: false }), /图文输出不完整.*第 2 条.*image_prompt/);
  assert.equal(requests.length - start, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM media_posts WHERE outlet_id = ?').get(outlet.id).n, 0);
});

test('truncated JSON fails immediately without retrying or publishing a partial batch', async () => {
  const db = getDb();
  const outlet = createOutlet({ name: '截断输出回归', prompt: '测试媒体', layout: 'feed' });
  responses.push('{"posts":[{"title":"截断');
  const start = requests.length;
  await assert.rejects(generateMediaBatch({ outletId: outlet.id, count: 1, withCharacters: false }), /未返回完整 JSON/);
  assert.equal(requests.length - start, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM media_posts WHERE outlet_id = ?').get(outlet.id).n, 0);
});
