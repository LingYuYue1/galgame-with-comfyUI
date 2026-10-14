import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const chatRouter = (await import('../src/routes/chat.js')).default;
const relationshipRouter = (await import('../src/routes/relationships.js')).default;

function call(router, method, url, body = {}, query = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
      on() { return this; }, // 聊天链路会注册 'close' 注销活跃流；测试桩给个空实现
    };
    router.handle({ method, url, body, query, params: {} }, res, err => err ? reject(err) : resolve(null));
  });
}

// 本地二创有意**保留**聊天带图（attachedImages）与用户上传入口；
// 上游 v3.8.0 将其移除属「上游删除动作」，本地不采纳（见 docs/二创更新日志.md）。
// 本测试改为钉住「本地保留行为」：上传入口可用、带图消息不再因 message 为空被拦。
test('聊天上传入口与带图消息在本地仍可用，空白且无图的消息才被拦截', async () => {
  // ① 上传入口仍在（本地保留）
  const up = await call(chatRouter, 'POST', '/chat/upload-image', { base64: 'data:image/png;base64,AAAA' });
  assert.notEqual(up, null, '上传入口 /chat/upload-image 应存在（本地保留）');
  assert.equal(up.status, 200);
  assert.ok(up.payload?.url, '上传应返回可用的图片 URL');

  // ② 空 / 非字符串消息，且**不带图** → 明确拦截（本地基线校验：无图时 message 必须是非空字符串）
  for (const message of [undefined, '', 123]) {
    const result = await call(chatRouter, 'POST', '/characters/1/chat', { message });
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'message is required');
  }

  // ③ 空消息但**带图**（/images/ 路径）→ 不再以 message 为空为由拦截（本地保留的带图链路）
  const withImg = await call(chatRouter, 'POST', '/characters/999999/chat',
    { message: '', images: ['/images/chat/old.png'] });
  assert.notEqual(withImg?.payload?.error, 'message is required', '带图时不应再因 message 为空被拦');
  assert.equal(withImg.status, 404, '消息校验通过后走到角色存在性检查（该测试角色不存在 → 404）');
});

// 本地保留「用户↔角色」关系资料与「我的表情库」；上游 v3.8.0 移除属上游删除动作，不采纳。
test('角色关系查询只返回角色之间的边，用户关系与表情库资料仍保留', async t => {
  const db = getDb();
  t.after(closeDb);
  const insert = db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)');
  const a = Number(insert.run('graph_a', '甲', '测试').lastInsertRowid);
  const b = Number(insert.run('graph_b', '乙', '测试').lastInsertRowid);
  db.prepare('INSERT INTO character_relationships (from_character_id, to_character_id, relationship_text, intimacy) VALUES (?, ?, ?, ?)').run(a, b, '朋友', 2);
  db.prepare('INSERT INTO user_relationships (character_id, relationship_text) VALUES (?, ?)').run(a, '同学');
  const result = await call(relationshipRouter, 'GET', '/', {}, { character_id: a });
  assert.equal(result.status, 200);
  // 本地在 edges（relationships）之外**额外**返回 userRelationship（给关系图画「角色↔用户」的连线）——
  // 上游「只返回角色之间的边」的口径不适用，这里改为钉住本地保留行为。
  assert.deepEqual(Object.keys(result.payload).sort(), ['relationships', 'userRelationship']);
  assert.equal(result.payload.relationships.length, 1);
  assert.equal(result.payload.relationships[0].to_character_id, b);
  assert.equal(result.payload.relationships[0].intimacy, 2);
  assert.equal(result.payload.userRelationship?.text, '同学', '用户↔角色关系随查询一并返回');
  assert.equal(db.prepare('SELECT relationship_text FROM user_relationships WHERE character_id = ?').get(a).relationship_text, '同学');
  // 本地保留「我的表情库」表（上游 v3.8.0 的删除动作不采纳）
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'user_emojis'").get(), 'user_emojis 表保留');
});
