/**
 * 换 LoRA 对比（2026-10-23，用户想试「可爱的那个」）
 *
 * 同 seed、同提示词、同 cfg，只换全局 LoRA —— 才能看出画风差异。
 * 只在内存改 config.comfyui.globalLora，**不写库**。
 *
 * 用法：node scripts/probe-lora-swap.mjs
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

const CANDIDATES = [
  { key: 'shiny',  file: '邻舍2闪亮shiny_nai_style_anima.safetensors',          weight: 0.7 },
  { key: 'cute',   file: 'animaSoftCutePainterlyE8BDAF.qBqa.safetensors',       weight: 0.7 },
  { key: 'cunny',  file: 'Anima_AI_Cunnyfunky.safetensors',                     weight: 0.7 },
];

const backup = JSON.parse(JSON.stringify(config.comfyui.globalLora || []));

async function shoot(c) {
  config.comfyui.globalLora = [{ path: c.file, weight: c.weight, triggerWord: '', enabled: true, scenes: [] }];
  const { wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: 768, height: 768 });
  for (const n of wf.nodes || []) {
    if (n.type === 'KSampler' && Array.isArray(n.widgets_values)) n.widgets_values[0] = SEED;
  }
  const ks = (wf.nodes || []).find(n => n.type === 'KSampler');
  console.log(`\n[${c.key}] ${c.file}  w=${c.weight}  cfg=${ks?.widgets_values?.[3]}  seed=${SEED}`);
  const res = await submitWorkflow(wf);
  if (!res.images?.length) throw new Error(`${c.key} 出图失败`);
  const url = saveBase64Image('avatargen', `lora_swap_${c.key}_${SEED}.png`, res.images[0].base64);
  console.log(`[${c.key}] 落盘 ${path.resolve('data/images', url.replace(/^\/images\//, ''))}`);
}

try {
  for (const c of CANDIDATES) await shoot(c);
} finally {
  config.comfyui.globalLora = backup;
}
