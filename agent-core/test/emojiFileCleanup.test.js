/**
 * F-45 回归测试：表情「图与记录解绑」的所有路径必须同时清理磁盘图。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * 表情图存 `/images/emoji/...`，记录在 `user_emojis` / `character_emojis`。
 * 「图与记录解绑」有三条路径，此前两条不清理磁盘图（删一个留一个的孤儿堆积）：
 *   ① `userEmoji.js` **DELETE**：只删 DB 记录，磁盘图留在原地（清单核心）；
 *   ② `userEmoji.js` **upload 覆盖同名**：旧 image_path 被新值覆盖，旧图成孤儿；
 *   ③ `emoji.js` **upload 覆盖同名**：同上。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 * ① 删记录前取 image_path → 删记录 → `deleteImageFileByUrl`（best-effort、不 500）；
 * ②③ 保存新图 + 写入新 image_path 之后，清理旧 image_path 的文件（**保守序**：
 *    任何失败点都不会破图，最坏=旧图残留；文件名含 Date.now()，与旧路径必不同——
 *    但守卫生效时（极端同毫秒撞名）绝不误删正在使用的新图）。
 * 同域先例：`emoji.js` 的 DELETE（清空）本就正确删图；`characters.js`「旧立绘先清掉」。
 *
 * ── 本文件钉住（真起 express + 隔离 IMAGES_DIR，打真实路由）──
 * ①②③ 三条路径的图清理（修复前红）；④ 不存在 key 的 404 语义守卫；
 * ⑤ 对照守卫：emoji DELETE（清空）删图（修复前后均绿——同域正确先例）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离：DB 用内存库；图片目录指到临时目录（imagePaths.js 模块级读 env，须先于 import）
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f45-emoji-'));
process.env.DB_PATH = ':memory:';
process.env.IMAGES_DIR = path.join(TEST_DIR, 'images');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TEST_DIR, 'world-projects');

// 假网络：只放行本测试自己起的 HTTP server，其余一律拒绝
const realFetch = globalThis.fetch;
let serverPort = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (serverPort && u.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`f45 test forbids network: ${u}`);
};

const express = (await import('express')).default;
const userEmojiRoutes = (await import('../src/routes/userEmoji.js')).default;
const emojiRoutes = (await import('../src/routes/emoji.js')).default;
const { getDb } = await import('../src/db/index.js');
const { saveBase64Image } = await import('../src/services/imagePaths.js');

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use('/api/user-emoji', userEmojiRoutes);
app.use('/api/characters/emoji', emojiRoutes);
const server = app.listen(0);
serverPort = server.address().port;

after(() => {
  server.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const db = getDb();
const DATA_URI = 'data:image/png;base64,' + Buffer.from('f45-fake-png-bytes').toString('base64');

const req = (method, p, body) => realFetch(`http://127.0.0.1:${serverPort}${p}`, {
  method,
  headers: { 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async r => ({ status: r.status, body: await r.json() }));

/** image_path（/images/emoji/x.png）→ 磁盘路径 */
const onDisk = (url) => path.join(TEST_DIR, 'images', String(url).replace(/^\/images\//, ''));

test('① userEmoji DELETE：删记录同时清磁盘图', async () => {
  const url = saveBase64Image('emoji', 'f45_user_delete.png', DATA_URI);
  db.prepare(`INSERT INTO user_emojis (emoji_key, prompt, image_path, status) VALUES ('待删表情', '', ?, 'done')`).run(url);
  assert.ok(fs.existsSync(onDisk(url)), '前置：图已落盘');

  const { status } = await req('DELETE', '/api/user-emoji/%E5%BE%85%E5%88%A0%E8%A1%A8%E6%83%85');   // 待删表情
  assert.equal(status, 200);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM user_emojis WHERE emoji_key='待删表情'`).get().n, 0, '记录已删');
  assert.ok(!fs.existsSync(onDisk(url)), '磁盘图应随记录一并清理（修复前：留在原地）');
});

test('② userEmoji upload 覆盖：旧图应被清理', async () => {
  const oldUrl = saveBase64Image('emoji', 'f45_user_old.png', DATA_URI);
  db.prepare(`INSERT INTO user_emojis (emoji_key, prompt, image_path, status) VALUES ('覆盖表情', '', ?, 'done')`).run(oldUrl);

  await new Promise(r => setTimeout(r, 5));   // 确保新文件名时间戳不同
  const { status, body } = await req('POST', '/api/user-emoji/%E8%A6%86%E7%9B%96%E8%A1%A8%E6%83%85/upload', { base64: DATA_URI });   // 覆盖表情
  assert.equal(status, 200);
  assert.ok(fs.existsSync(onDisk(body.image_path)), '新图应在');
  assert.ok(!fs.existsSync(onDisk(oldUrl)), '旧图应被清理（修复前：成为孤儿残留）');
});

test('③ emoji upload 覆盖（character 侧）：旧图应被清理', async () => {
  const charId = db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('c1', '测试角色', '测试用')`).run().lastInsertRowid;

  await new Promise(r => setTimeout(r, 5));
  const r1 = await req('POST', `/api/characters/emoji/${charId}/%E5%8D%96%E8%90%8C/upload`, { base64: DATA_URI });   // 卖萌
  assert.equal(r1.status, 200);
  const oldUrl = r1.body.image_path;
  assert.ok(fs.existsSync(onDisk(oldUrl)), '前置：第一张图已落盘');

  await new Promise(r => setTimeout(r, 5));
  const r2 = await req('POST', `/api/characters/emoji/${charId}/%E5%8D%96%E8%90%8C/upload`, { base64: DATA_URI });
  assert.equal(r2.status, 200);
  assert.ok(fs.existsSync(onDisk(r2.body.image_path)), '新图应在');
  assert.ok(!fs.existsSync(onDisk(oldUrl)), '覆盖后旧图应被清理（修复前：成为孤儿残留）');
});

test('④ 守卫：DELETE 不存在的 key 仍返回 404、不动任何文件', async () => {
  const { status } = await req('DELETE', '/api/user-emoji/%E4%B8%8D%E5%AD%98%E5%9C%A8');   // 不存在
  assert.equal(status, 404);
});

test('⑤ 对照守卫：emoji DELETE（清空）本就删图（同域正确先例，不回归）', async () => {
  const charId = db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('c2', '测试角色2', '测试用')`).run().lastInsertRowid;
  const up = await req('POST', `/api/characters/emoji/${charId}/%E5%A4%A7%E7%AC%91/upload`, { base64: DATA_URI });   // 大笑
  assert.equal(up.status, 200);
  const url = up.body.image_path;
  assert.ok(fs.existsSync(onDisk(url)), '前置：图已落盘');

  const { status } = await req('DELETE', `/api/characters/emoji/${charId}/%E5%A4%A7%E7%AC%91`);
  assert.equal(status, 200);
  assert.ok(!fs.existsSync(onDisk(url)), '清空表情图应删磁盘文件（对照：此先例本就正确）');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM character_emojis WHERE character_id=?`).get(charId).n, 1, '记录保留（清空≠删记录）');
});
