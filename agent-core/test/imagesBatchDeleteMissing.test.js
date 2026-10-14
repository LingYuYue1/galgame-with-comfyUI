/**
 * F-41 回归守卫：POST /api/images/delete-batch 的响应必须区分 deleted / missing。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * deleteOneImage 对「文件本就不存在」（幽灵引用——DB 还存着 URL 但文件早没了）返回
 * `{ ok: true, missing: true }`（幂等，语义正确），单删路由也如实回传 `missing`。
 * 但 delete-batch 的统计只写 `if (r.ok) deleted++` —— **missing 被计入 deleted**：
 *   · 前端 Gallery 的提示「已删除 N 张」把"其实没删到文件"的也算进删除数；
 *   · 更隐蔽的：缓存失效条件 `if (deleted > 0)` —— **整批全是幽灵时 deleted=0**，
 *     但幽灵引用照样被清（deleteOneImage 对 chat 类照常清 messages.images），
 *     相册列表已变化而缓存不失效 → 前端重载拿回旧列表（「删了还在」边缘形态）。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 * 响应区分 `deleted`（真删了文件）与 `missing`（本就已不存在、幂等通过），
 * 缓存失效条件放宽为 `deleted > 0 || missing > 0`。
 *
 * 本文件钉住（真起 express + 隔离 IMAGES_DIR，打真实路由）：
 * ① 真文件+幽灵混合 → deleted 只计真删、missing 单列；② 全幽灵 → deleted 0、missing 全数；
 * ③ 非法 URL 仍进 failed（不因新口径混淆）；④（静态）缓存失效条件覆盖 missing。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离：DB 用内存库；图片目录指到临时目录（imagePaths.js 模块级读 env，须先于 import）
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'img-batch-del-'));
process.env.DB_PATH = ':memory:';
process.env.IMAGES_DIR = path.join(TEST_DIR, 'images');

// 假网络：只放行本测试自己起的 HTTP server，其余一律拒绝
const realFetch = globalThis.fetch;
let serverPort = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (serverPort && u.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`f41 test forbids network: ${u}`);
};

const express = (await import('express')).default;
const imagesRoutes = (await import('../src/routes/images.js')).default;

const app = express();
app.use(express.json());
app.use('/api/images', imagesRoutes);
const server = app.listen(0);
serverPort = server.address().port;

after(() => {
  server.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function postJson(p, body) {
  return realFetch(`http://127.0.0.1:${serverPort}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));
}

// 造两个真文件（chat 目录），内容不重要（删除链路不解析内容）
const chatDir = path.join(TEST_DIR, 'images', 'chat');
fs.mkdirSync(chatDir, { recursive: true });
const fileA = path.join(chatDir, 'f41-a.png');
const fileB = path.join(chatDir, 'f41-b.png');
fs.writeFileSync(fileA, 'fake-png-bytes');
fs.writeFileSync(fileB, 'fake-png-bytes');

test('F-41 ①：真文件 + 幽灵混合 —— deleted 只计真删，missing 单列', async () => {
  const { status, body } = await postJson('/api/images/delete-batch', {
    urls: ['/images/chat/f41-a.png', '/images/chat/f41-ghost.png', '/images/chat/f41-b.png'],
  });
  assert.equal(status, 200);
  assert.equal(body.deleted, 2, 'deleted 应只计"真的删掉了文件"的 2 张（当前把幽灵也算进去=病）');
  assert.equal(body.missing, 1, '文件本就不存在的 1 张应单列 missing，而不是混进 deleted');
  assert.equal(body.failed, 0);
  assert.ok(!fs.existsSync(fileA) && !fs.existsSync(fileB), '真文件应被删除');
});

test('F-41 ②：全幽灵（文件都不存在）—— deleted 0、missing 全数（幂等依然 success）', async () => {
  const { body } = await postJson('/api/images/delete-batch', {
    urls: ['/images/chat/f41-g1.png', '/images/chat/f41-g2.png'],
  });
  assert.equal(body.deleted, 0, '一张真文件都没删到 → deleted 必须是 0');
  assert.equal(body.missing, 2, '两张幽灵应全部计入 missing');
  assert.equal(body.failed, 0);
  assert.equal(body.success, true, '幂等语义：目标"这些图不存在"已达成，仍是成功');
});

test('F-41 ③：非法 URL 仍进 failed（不因新增 missing 口径而混淆）', async () => {
  const { body } = await postJson('/api/images/delete-batch', {
    urls: ['', '/images/unknown-folder/x.png', '/images/chat/f41-g3.png'],
  });
  assert.equal(body.failed, 2, '空串与未知目录应失败');
  assert.equal(body.missing, 1, '幽灵的合法 URL 仍算 missing');
  assert.equal(body.deleted, 0);
});

test('F-41 ④（静态）：相册缓存失效条件覆盖 missing（幽灵引用被清后列表也已变化）', () => {
  const src = fs.readFileSync(new URL('../src/routes/images.js', import.meta.url), 'utf8');
  assert.match(
    src, /if \(deleted > 0 \|\| missing > 0\) invalidateGalleryCache\(\)/,
    'deleted 与 missing 都会改动相册数据（幽灵引用照常清 DB 引用），任一非零都应失效缓存',
  );
});
