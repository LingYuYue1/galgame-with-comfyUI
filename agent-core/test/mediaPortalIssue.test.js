import { test, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 门户出刊（数字报刊）回归 —— **本地二创口径**。
 *
 * ⚠ 本文件原本是上游 v3.8.0 的契约测试（「恰好 4 栏目」/ `features.mediaAutoMinutes` /
 *   `generateMediaBatch` 返回 `{ inserted, postId }`）。本地二创的门户与其为**设计级分歧**：
 *     · 栏目数是**开放口径**：提示词写「4~6 个」，`normalizePortalDraft` 至多保留 8 栏（不硬裁到 4）；
 *     · 自动抓帖用 `features.mediaAutoPerNight`（每晚 N 批 + 夜间窗口内错峰），非固定分钟间隔；
 *     · `generatePortalIssue` 返回**落库的 DB 行**，期号由模型按提示词给出（服务端在 user 消息里
 *       把「上一期第 N 期 / 本期用 N+1」讲清楚）。
 *   详见 `docs/二创更新日志.md`。故本文件按**本地真实行为**重写断言；
 *   **上游「恰好 4 栏目」契约不适用于本地二创门户**。
 */

process.env.DB_PATH = ':memory:';
const responses = [];
const requests = [];
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://media-test.invalid/v1/chat/completions');
  requests.push(JSON.parse(options.body));
  assert.ok(responses.length, 'unexpected LLM request');
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: JSON.stringify(responses.shift()) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  }), { headers: { 'content-type': 'application/json' } });
};
await import('openai/shims/web');
const { getDb, closeDb } = await import('../src/db/index.js');
const { setSetting } = await import('../src/db/settings.js');
const { config } = await import('../src/config.js');
const { addClient, removeClient } = await import('../src/services/unifiedStreamBus.js');
const { normalizePortalDraft, createOutlet, generateMediaBatch, maybeAutoGenerate, listPosts, fillPortalImages } = await import('../src/services/mediaService.js');

after(async () => {
  // 出刊后的无配图后台回调结束后再关闭内存数据库。
  await new Promise(resolve => setTimeout(resolve, 20));
  closeDb();
});

function draft(count, issue = 1) {
  return {
    issue, title: '测试报刊', lead: '本期导语',
    sections: Array.from({ length: count }, (_, i) => ({
      key: `column${i + 1}`, name: `栏目${i + 1}`, lead: `导语${i + 1}`, image_prompt: '',
    })),
  };
}

test('portal drafts keep every valid section up to 8, drop empty names, never mutate input, and resolve issue by rule', () => {
  // 本地口径：不做「恰好 4 栏」硬收裁，保留全部合法栏目（上限 8）
  for (const count of [4, 5, 6, 8]) {
    const raw = draft(count);
    const snapshot = structuredClone(raw);
    const result = normalizePortalDraft(raw);
    assert.equal(result.sections.length, count, `本地应保留 ${count} 栏`);
    assert.deepEqual(result.sections.map(s => s.key), raw.sections.map((_, i) => `column${i + 1}`));
    assert.deepEqual(raw, snapshot, '不得改动输入对象');
  }
  // 只有超过上限才收裁（上限 8）
  assert.equal(normalizePortalDraft(draft(10)).sections.length, 8);
  // 空名栏目被**剔除**（而非抛错）；一个可用栏目都没有才抛
  const partial = draft(4);
  partial.sections[0].name = '';
  assert.equal(normalizePortalDraft(partial).sections.length, 3);
  assert.throws(() => normalizePortalDraft({ title: 'x', sections: [] }), /门户一个板块都没有/);
  // 期号规则：模型给出合法值就采用；非法/缺失才回落到 prevIssue + 1
  assert.equal(normalizePortalDraft(draft(4, 99), 3).issue, 99);
  assert.equal(normalizePortalDraft(draft(4, 1), 3).issue, 1);
  const noIssue = draft(4);
  delete noIssue.issue;
  assert.equal(normalizePortalDraft(noIssue, 3).issue, 4);
});

test('manual and automatic portal publishing use local numbering, notify the UI, and preserve old content', async () => {
  const db = getDb();
  db.prepare('UPDATE media_outlets SET enabled = 0').run();
  const outlet = createOutlet({ name: '门户口径回归报', prompt: '测试用报刊', layout: 'portal' });
  config.llm.freeEgg = false;
  config.llm._baseURL = 'https://media-test.invalid/v1';
  config.llm._apiKey = 'test-only';
  // 本地自动抓帖档位（每晚 N 批）；上游的 mediaAutoMinutes 在本地已不生效
  config.features.mediaAutoPerNight = 1;

  const events = [];
  const client = { write: value => events.push(value) };
  addClient(client);
  try {
    // 历史：一条 5 栏门户（第 7 期）+ 一条 payload=null 的旧社交帖。
    // 后者用来验证本地 prevIssue 会**跳过没有 payload 的帖**，仍取到第 7 期。
    const old = { portal: true, ...draft(5, 7) };
    const oldJson = JSON.stringify(old);
    const insert = db.prepare('INSERT INTO media_posts (outlet_id, title, content, payload_json) VALUES (?, ?, ?, ?)');
    const oldId = Number(insert.run(outlet.id, old.title, '', oldJson).lastInsertRowid);
    insert.run(outlet.id, '旧社交帖', '', null);

    // ── 手动出刊 ──
    responses.push(draft(5, 8));
    const manual = await generateMediaBatch({ outletId: outlet.id });
    const read = id => JSON.parse(db.prepare('SELECT payload_json FROM media_posts WHERE id = ?').get(id).payload_json);

    // 本地 generatePortalIssue 返回**落库的 DB 行**（不是上游的 { inserted, postId }）
    assert.ok(manual?.id, '本地应返回落库的 DB 行');
    assert.equal(manual.outlet_id, outlet.id);
    assert.equal(read(manual.id).sections.length, 5, '本地保留模型给出的栏目数');
    assert.equal(read(manual.id).issue, 8);

    // 本地提示词：user 消息给出「上一期第 7 期 / 本期用 8」（prevIssue 正确跳过 payload=null 的帖）
    const manualReq = requests.at(-1);
    const userMsg = manualReq.messages.find(m => m.role === 'user').content;
    assert.match(userMsg, /上一期是第 7 期，本期编号用 8/);
    // 本地骨架提示词是「4~6 个」开放口径（非上游「必须恰好 4 个栏目」）
    const sysMsg = manualReq.messages.find(m => typeof m.content === 'string' && m.content.includes('只输出门户骨架')).content;
    assert.match(sysMsg, /4~6 个/);

    // 旧内容一字未改
    assert.equal(db.prepare('SELECT payload_json FROM media_posts WHERE id = ?').get(oldId).payload_json, oldJson);
    // 出刊一次 → 广播一次
    assert.equal(events.filter(e => e.startsWith('event: media_new_posts\n')).length, 1);
    assert.equal(requests.length, 1);

    // ── 自动出刊（本地口径：mediaAutoPerNight + 夜间窗口 + 落库的下次时刻）──
    const beforeAuto = db.prepare('SELECT id, payload_json FROM media_posts ORDER BY id').all();
    const at2200 = new Date();
    at2200.setHours(22, 0, 0, 0);   // 落在夜间窗口（20:00→次日 02:00）内
    setSetting('media_next_auto_at', String(at2200.getTime() - 1000));   // 已到点
    responses.push(draft(6, 9));
    await maybeAutoGenerate(at2200.getTime());

    const newest = db.prepare('SELECT id, payload_json FROM media_posts ORDER BY id DESC LIMIT 1').get();
    assert.notEqual(newest.id, manual.id, '自动应再出一期');
    assert.equal(JSON.parse(newest.payload_json).sections.length, 6);
    assert.equal(JSON.parse(newest.payload_json).issue, 9);
    // 已有内容（含手动那一期）一字未改
    assert.deepEqual(db.prepare('SELECT id, payload_json FROM media_posts WHERE id <= ? ORDER BY id').all(manual.id), beforeAuto);
    // 手动 + 自动 → 共两次广播、两次 LLM 调用
    assert.equal(events.filter(e => e.startsWith('event: media_new_posts\n')).length, 2);
    assert.equal(requests.length, 2);
  } finally {
    config.features.mediaAutoPerNight = 0;
    removeClient(client);
  }
});

test('generated portal text stays private until all four images have been saved', async () => {
  const db = getDb();
  const outlet = createOutlet({ name: '图文完成后发布回归', prompt: 'test', layout: 'portal' });
  const raw = draft(4);
  raw.sections.forEach(s => { s.image_prompt = 'a completed illustration'; });
  responses.push(raw);
  const events = [];
  const client = { write: value => events.push(value) };
  addClient(client);
  try {
    const result = await generateMediaBatch({ outletId: outlet.id });
    assert.equal(listPosts({ outletId: outlet.id }).total, 0);
    assert.equal(events.filter(e => e.startsWith('event: media_new_posts\n')).length, 0);
    // 本地口径（与上游「设计级分歧」，见文件头）：generateMediaBatch 门户分支返回**完整 post 行**（非 {postId}）
    const payload = JSON.parse(db.prepare('SELECT payload_json FROM media_posts WHERE id = ?').pluck().get(result.id));
    payload.sections.forEach((s, i) => { s.image = `/section-${i}.png`; });
    // Emulate images durably saved before the completion/recovery callback, without external generation.
    db.prepare('UPDATE media_posts SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), result.id);
    await fillPortalImages(6);
    const published = listPosts({ outletId: outlet.id });
    assert.equal(published.total, 1);
    assert.equal(published.posts[0].image, '/section-0.png');
    assert.ok(published.posts[0].payload.sections.every(s => s.image));
    assert.equal(events.filter(e => e.startsWith('event: media_new_posts\n')).length, 1);
    await fillPortalImages(6);
    assert.equal(events.filter(e => e.startsWith('event: media_new_posts\n')).length, 1);
  } finally { removeClient(client); }
});
