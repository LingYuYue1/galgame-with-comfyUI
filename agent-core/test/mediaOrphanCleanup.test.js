/**
 * 传媒孤儿图清理 —— F-02 回归测试（2026-10-12）。
 *
 * 「F-02」= 首轮筛查报告 P0-②：cleanupOrphanMediaImages 的「被引用」集合只查
 * media_posts.image 列，而海报面板图 / 门户分节图只存在 payload_json 里
 * （panels[].image / sections[].image）→ 被当孤儿删除，DB 仍指向已删文件，
 * 海报小图 / 门户板块图永久空白（且自动补图因 panel.image 为真值而跳过重生成）。
 * 真实库实测损失：15 个 payload 引用点的文件全部被删（只剩 8 张主图）。
 *
 * 本测试钉住的不变量：
 *   ① 主图 / panels[].image / sections[].image 三类引用都被保护，不因清理删除；
 *   ② 无引用的老文件仍会被清（修复没有把清理器变成摆设）；
 *   ③ 文件名口径与 deleteImageFileByUrl 对齐（URL 带 query / 编码也能匹配）；
 *   ④ maxAgeMs 语义不变：新文件豁免，maxAge=0 时立即清理（F-31 依赖此语义）。
 *
 * ⚠ 全程临时库 + 临时图片目录（IMAGES_DIR 环境变量，见 imagePaths.js），不碰真实数据。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-mediaclean-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');   // ⚠ 必须先于 imagePaths.js 加载（模块级求值）
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

const MEDIA_DIR = path.join(TMP_DIR, 'images', 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 3600 * 1000);

function putFile(name, mtime = TWO_HOURS_AGO) {
  const p = path.join(MEDIA_DIR, name);
  fs.writeFileSync(p, PNG);
  fs.utimesSync(p, mtime, mtime);
  return p;
}
const exists = (name) => fs.existsSync(path.join(MEDIA_DIR, name));

// 老文件（mtime 2 小时前，超出默认 1h 豁免期 → 属于清理范围）
const F_MAIN = 'media_1000_main.png';        // 引用：media_posts.image
const F_PANEL = 'media_1001_panel.png';      // 引用：payload.panels[].image（修复前被误删）
const F_SECTION = 'media_1002_section.png';  // 引用：payload.sections[].image（修复前被误删）
const F_ORPHAN = 'media_1003_orphan.png';    // 无引用 → 应被清
const F_CN = 'media_中文_1004.png';           // 引用：URL 经 encodeURIComponent + 带 query
const F_OTHER = 'other_keep.png';            // 非 media_ 前缀 → 清理器不该碰
putFile(F_MAIN); putFile(F_PANEL); putFile(F_SECTION); putFile(F_ORPHAN); putFile(F_CN); putFile(F_OTHER);

const { getDb, closeDb } = await import('../src/db/index.js');
const { cleanupOrphanMediaImages } = await import('../src/services/mediaService.js');

const db = getDb();
const outletId = Number(db.prepare(`INSERT INTO media_outlets (name) VALUES ('测试媒体')`).run().lastInsertRowid);
const insPost = db.prepare(
  `INSERT INTO media_posts (outlet_id, title, content, image, image_status, payload_json)
   VALUES (?, ?, '正文', ?, 'done', ?)`
);
insPost.run(outletId, '主图帖', `/images/media/${F_MAIN}`, null);
insPost.run(outletId, '海报帖', null, JSON.stringify({ panels: [{ image: `/images/media/${F_PANEL}` }, { image: null }] }));
insPost.run(outletId, '门户帖', null, JSON.stringify({ sections: [{ image: `/images/media/${F_SECTION}` }] }));
insPost.run(outletId, '编码帖', null, JSON.stringify({ panels: [{ image: `/images/media/${encodeURIComponent(F_CN)}?t=1` }] }));

test('★ F-02①：三类引用（主图/面板/分节）都被保护，老孤儿仍被清', () => {
  const r = cleanupOrphanMediaImages();   // 默认 maxAgeMs = 1h
  assert.ok(exists(F_MAIN), '主图（image 列引用）应保留');
  assert.ok(exists(F_PANEL), '海报面板图（payload.panels[].image 引用）应保留 —— 修复前被误删');
  assert.ok(exists(F_SECTION), '门户分节图（payload.sections[].image 引用）应保留 —— 修复前被误删');
  assert.ok(!exists(F_ORPHAN), '无引用的老文件应被清（清理器仍在工作）');
  assert.equal(r.scanned, 5, '只扫 media_ 前缀文件（5 个）');
  assert.equal(r.removed, 1, '只删了 1 个真孤儿');
});

test('★ F-02②：文件名口径与 deleteImageFileByUrl 对齐（query + 编码）', () => {
  assert.ok(exists(F_CN), 'DB 里是编码 URL（%XX + ?t=1）时，磁盘上的中文名文件应被正确保护');
  assert.ok(exists(F_OTHER), '非 media_ 前缀文件不参与清理');
});

test('★ F-02③：maxAgeMs 语义不变 —— 新文件豁免、maxAge=0 立即清', () => {
  putFile('media_2000_fresh.png', new Date());   // mtime=now，无引用
  const r1 = cleanupOrphanMediaImages();          // 默认 1h → 新文件豁免
  assert.ok(exists('media_2000_fresh.png'), '1h 内的新文件应豁免（防误删正在写入的图）');
  const r2 = cleanupOrphanMediaImages(0);         // 显式 0 → 立即清
  assert.ok(!exists('media_2000_fresh.png'), 'maxAge=0 时应立即清理无引用文件');
  assert.equal(r1.removed, 0);
  assert.equal(r2.removed, 1);
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
