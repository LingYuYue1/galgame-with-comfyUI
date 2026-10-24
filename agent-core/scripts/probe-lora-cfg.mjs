/**
 * CFG 对 LoRA 画风的影响（2026-10-23，用户提示「作者推荐 cfg=3」）
 *
 * 背景：银月16 的 KSampler 是 steps=16 / cfg=5.5。
 * 用户反馈这个画风 LoRA 应该是「肉感」的，现在没显出来。
 *
 * 原理：CFG 越高 → 负向条件的拉力越强 → LoRA 带的风格倾向越容易被"抹平"。
 * 所以同一个 LoRA，低 CFG 下风格更足。
 *
 * 本脚本**不改工作流文件**：只在内存里改 KSampler 的 cfg，同 seed 各出一张。
 * 用法：node scripts/probe-lora-cfg.mjs [cfgA] [cfgB]   默认 3 与 5.5
 */
import { getDb } from '../src/db/index.js';
import path from 'path';

getDb();
const { buildWorkflow } = await import('../src/services/imageSkill.js');
const { submitWorkflow } = await import('../src/services/comfyClient.js');
const { saveBase64Image } = await import('../src/services/imagePaths.js');

const SEED = 20261023;
const PROMPT = '1girl, solo, long pink hair, blue eyes, white shirt, standing, '
  + 'simple white background, flat lighting, best quality';

const cfgs = process.argv.slice(2).map(Number).filter(n => Number.isFinite(n));
const CFGS = cfgs.length ? cfgs : [3, 5.5];

async function shoot(cfg) {
  const { wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: 768, height: 768 });
  for (const n of wf.nodes || []) {
    if (n.type === 'KSampler' && Array.isArray(n.widgets_values)) {
      n.widgets_values[0] = SEED;
      n.widgets_values[3] = cfg;   // [seed, randomize, steps, cfg, sampler, scheduler, denoise]
    }
  }
  const ks = (wf.nodes || []).find(n => n.type === 'KSampler');
  console.log(`\n[cfg=${cfg}] steps=${ks?.widgets_values?.[2]} seed=${SEED} 提交中…`);
  const res = await submitWorkflow(wf);
  if (!res.images?.length) throw new Error(`cfg=${cfg} 出图失败`);
  const tag = String(cfg).replace('.', 'p');
  const url = saveBase64Image('avatargen', `lora_cfg_${tag}_${SEED}.png`, res.images[0].base64);
  console.log(`[cfg=${cfg}] 落盘 ${path.resolve('data/images', url.replace(/^\/images\//, ''))}`);
}

for (const c of CFGS) await shoot(c);
