/**
 * 按模型卡推荐参数 vs 当前工作流参数（2026-10-23）
 *
 * 作者对 SilvermoonMix-Anima-Evolved 2.9B 的推荐：
 *   Sampler = Euler a、CFG = 3、Steps = 20-28、**先不用负面词**
 * 当前工作流：er_sde / cfg 3（刚改）/ steps 16 / 404 字符负面词
 *   —— er_sde 是 Turbo 版的推荐采样器，用在非 Turbo 的 2.9B 上不对
 *
 * 用法：node scripts/probe-sampler-recommend.mjs [组名...]  默认跑 current / recommended
 */
import { getDb } from '../src/db/index.js';
import path from 'path';

getDb();
const { buildWorkflow } = await import('../src/services/imageSkill.js');
const { submitWorkflow } = await import('../src/services/comfyClient.js');
const { config } = await import('../src/config.js');
const { saveBase64Image } = await import('../src/services/imagePaths.js');

const SEED = 20261023;
const PROMPT = '1girl, solo, long pink hair, blue eyes, white shirt, standing, '
  + 'simple white background, flat lighting, best quality';

const GROUPS = {
  current:     { sampler: null,             steps: null, cfg: null, noNeg: false },
  recommended: { sampler: 'euler_ancestral', steps: 24,  cfg: 3,    noNeg: true  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(GROUPS);
const backupNeg = config.comfyui.negativePrompt;

async function shoot(name) {
  const g = GROUPS[name];
  if (!g) throw new Error(`没有这个组：${name}`);

  config.comfyui.negativePrompt = g.noNeg ? '' : backupNeg;
  let wf;
  try {
    ({ wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: 768, height: 768 }));
  } finally {
    config.comfyui.negativePrompt = backupNeg;
  }
  const ks = (wf.nodes || []).find(n => n.type === 'KSampler');
  ks.widgets_values[0] = SEED;
  if (g.steps != null) ks.widgets_values[2] = g.steps;
  if (g.cfg != null) ks.widgets_values[3] = g.cfg;
  if (g.sampler) ks.widgets_values[4] = g.sampler;

  console.log(`\n[${name}] sampler=${ks.widgets_values[4]} steps=${ks.widgets_values[2]} cfg=${ks.widgets_values[3]} 负面词=${g.noNeg ? '无' : '有'}`);
  const res = await submitWorkflow(wf);
  if (!res.images?.length) throw new Error(`${name} 出图失败`);
  const url = saveBase64Image('avatargen', `sampler_${name}_${SEED}.png`, res.images[0].base64);
  console.log(`[${name}] 落盘 ${path.resolve('data/images', url.replace(/^\/images\//, ''))}`);
}

for (const n of names) await shoot(n);
