/**
 * BUG-04 回归：立绘 / 换装落图不写 image_tasks
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `recordCompletedImageTask` 只在 moments / diary / events / mailbox / media / newspaper
 * 等链路被调用；立绘（含换装场景，同为 standing 目录）漏了 ——
 * 实测 standing 目录 22 张，任务记录只有 7 条，其余 15 张「完全无迹」：
 * 相册里既没有来源，也无从追溯（BUG-03 修好后依然显示「未知来源」）。
 *
 * ── 修法 ────────────────────────────────────────────────────
 * 记录点放在 `commitImage`（立绘/换装的唯一落图口）：生成成功、DB 写回成功后写一条
 * `char_<id>_standing`。上传与裁剪**不算生成任务**（上传是用户素材、裁剪是既有图的派生），
 * 由调用方是否传 prompt 区分。记录失败只告警，不能把已落盘的立绘判成失败。
 *
 * ── 本文件钉住 ──────────────────────────────────────────────
 * ① 新生成一张立绘 → image_tasks 新增一行，conversation_id = char_X_standing；
 * ② 该行能被相册来源解析（BUG-03 链路）认成「立绘 · 角色名」；
 * ③ 用户上传不写生成记录（避免污染任务历史）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-image-task-gap-'));
process.env.DB_PATH = ':memory:';
process.env.IMAGES_DIR = imageRoot;
globalThis.fetch = async () => { throw new Error('network forbidden in image task gap tests'); };
const { getDb } = await import('../src/db/index.js');
const service = await import('../src/services/expressionStandingService.js');
const { buildImageSourceIndex, attachSource } = await import('../src/services/imageSourceResolver.js');
const db = getDb();
after(() => { db.close(); fs.rmSync(imageRoot, { recursive: true, force: true }); });

function newCharacter(name) {
  return Number(db.prepare(`INSERT INTO characters(name,display_name,base_prompt,emotion_baseline)
    VALUES(?,?,'A girl with brown hair.','')`).run(name, name).lastInsertRowid);
}

async function sourceImage() {
  return sharp({ create: { width: 32, height: 64, channels: 4, background: '#ffffff' } }).png().toBuffer();
}
const dataUrl = b => `data:image/png;base64,${b.toString('base64')}`;

async function waitForJob(id) {
  for (let i = 0; i < 300; i++) {
    const job = db.prepare('SELECT * FROM expression_standing_jobs WHERE id=?').get(id);
    if (['done', 'failed', 'partial_failed'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('standing job timed out');
}

test('新生成立绘会写 image_tasks，且相册来源能认成「立绘 · 角色名」', async () => {
  db.prepare('DELETE FROM image_tasks').run();
  const id = newCharacter('立绘记录回归');
  const image = dataUrl(await sourceImage());
  const { jobId } = service.startStandingBatch(id, { slotIds: ['normal'] }, {
    promptGenerator: async (_, slots) => new Map(slots.map(s => [s.id, '1girl, brown hair, white dress'])),
    imageGenerator: async () => ({ success: true, images: [{ base64: image }], wfMode: 'turbo12' }),
    touchLinesGenerator: async () => { throw new Error('fixture: no touch lines'); },
  });
  assert.equal((await waitForJob(jobId)).status, 'done');

  const rows = db.prepare("SELECT conversation_id, prompt_original, prompt_refined, output_paths, workflow_template FROM image_tasks WHERE conversation_id = ?").all(`char_${id}_standing`);
  assert.equal(rows.length, 1, '一张立绘必须且只能留一条任务记录');
  assert.match(rows[0].prompt_original, /brown hair/, '记录的是实际送进 ComfyUI 的提示词');
  assert.match(rows[0].prompt_refined, /brown hair/);
  assert.equal(rows[0].workflow_template, 'turbo12');
  const saved = JSON.parse(rows[0].output_paths);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /\/images\/(expression_)?standing\//, '落盘 URL 必须在立绘目录（老库叫 standing，新分类叫 expression_standing）');

  // 与 BUG-03 串起来：相册反查必须能认出来
  const index = buildImageSourceIndex(db);
  const resolved = attachSource({ url: saved[0] }, index);
  assert.equal(resolved.source, '立绘');
  assert.equal(resolved.source_label, '立绘 · 立绘记录回归');
});

test('用户上传不写生成任务记录（上传是素材，不是生成）', async () => {
  db.prepare('DELETE FROM image_tasks').run();
  const id = newCharacter('上传不记录');
  const image = dataUrl(await sourceImage());
  await service.editStandingImage(id, 'normal', 'upload', { image });
  const count = db.prepare('SELECT COUNT(*) FROM image_tasks WHERE conversation_id = ?').pluck().get(`char_${id}_standing`);
  assert.equal(count, 0, '上传不该往生成历史里塞记录');
});
