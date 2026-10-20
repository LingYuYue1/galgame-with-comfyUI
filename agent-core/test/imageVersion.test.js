/**
 * BUG-04 回归：图片被「重新生成」覆盖同一路径后，URL 必须换版本号。
 *
 * 复现的真实故障（2026-10-20 用户实测）：朋友圈点大图「重新生成」→ 确认覆盖 →
 * 图片正常显示 → 切窗口/刷新页面后又变回覆盖前的黑图。
 * 根因：覆盖只改了文件内容，URL 不变，客户端命中旧缓存。
 *
 * 口径：测试把 IMAGES_DIR 指到临时目录，不碰真实图片目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-imgver-'));
process.env.IMAGES_DIR = TMP;

const { withImageVersion, withImageVersions, invalidateImageVersionCache, toDiskPath } =
  await import('../src/utils/imageVersion.js');

test.after(() => {
  assert.equal(path.dirname(TMP), path.resolve(os.tmpdir()));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function write(name, bytes, mtimeMs) {
  const p = path.join(TMP, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 0x11));
  if (mtimeMs) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

test('存在的图片：URL 带 ?v=<mtimeMs>', () => {
  write('a.png', 100, 1_700_000_000_000);
  const url = withImageVersion('/images/a.png');
  assert.match(url, /^\/images\/a\.png\?v=\d+$/);
  assert.equal(url, `/images/a.png?v=${Math.round(fs.statSync(path.join(TMP, 'a.png')).mtimeMs)}`);
});

test('★ 覆盖同一路径后版本号必须变（本次故障的核心断言）', () => {
  const p = write('b.png', 100, 1_700_000_000_000);
  const first = withImageVersion('/images/b.png');

  // 模拟 applyEditTask：rename 覆盖同一路径，mtime 前进
  write('b.png', 200, 1_700_000_100_000);
  // applyEditTask 成功后调用它清缓存；TTL 内也必须能拿到新版本
  invalidateImageVersionCache();
  const second = withImageVersion('/images/b.png');

  assert.notEqual(first, second, '覆盖后 URL 必须变化，否则客户端会继续用旧缓存');
  assert.ok(fs.statSync(p).size === 200);
});

test('缓存失效前不重复 stat，失效后重新取', () => {
  write('c.png', 100, 1_700_000_000_000);
  invalidateImageVersionCache();
  const a = withImageVersion('/images/c.png');
  const b = withImageVersion('/images/c.png');
  assert.equal(a, b); // 命中缓存
  invalidateImageVersionCache();
  assert.equal(withImageVersion('/images/c.png'), a); // 文件没变，版本一样
});

test('文件不存在：原样返回，交给 404 / 占位逻辑', () => {
  assert.equal(withImageVersion('/images/not-exist-xyz.png'), '/images/not-exist-xyz.png');
});

test('外链与内联数据不碰', () => {
  for (const u of ['https://example.com/a.png', 'http://x/a.png?q=1', 'data:image/png;base64,AAA', 'blob:http://x/1']) {
    assert.equal(withImageVersion(u), u);
  }
});

test('空值与非字符串原样返回', () => {
  assert.equal(withImageVersion(null), null);
  assert.equal(withImageVersion(undefined), undefined);
  assert.equal(withImageVersion(''), '');
  assert.equal(withImageVersion(123), 123);
});

test('目录穿越不返回版本号', () => {
  assert.equal(toDiskPath('/images/../../secret.png'), null);
  assert.equal(withImageVersion('/images/../../secret.png'), '/images/../../secret.png');
});

test('PNG 已被 AVIF 替换：用同名 avif 的 mtime 兜底', () => {
  write('d.avif', 100, 1_700_000_000_000);
  const url = withImageVersion('/images/d.png');
  assert.match(url, /^\/images\/d\.png\?v=\d+$/);
});

test('批量版本化：保序、非字符串原样', () => {
  write('e1.png', 10, 1_700_000_000_000);
  write('e2.png', 10, 1_700_000_000_000);
  const out = withImageVersions(['/images/e1.png', null, '/images/none-xyz.png', '/images/e2.png']);
  assert.match(out[0], /\?v=\d+$/);
  assert.equal(out[1], null);
  assert.equal(out[2], '/images/none-xyz.png');
  assert.match(out[3], /\?v=\d+$/);
});
