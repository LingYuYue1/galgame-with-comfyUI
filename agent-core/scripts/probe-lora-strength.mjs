/**
 * LoRA 到底有没有作用（2026-10-23）
 *
 * 现象：三个不同 LoRA 出图几乎一样，但 lora_name 确实每次都换了。
 * 那就要分清两种可能：
 *   A. 这些 LoRA 在 silvermoon 底模上**完全无效**  → 权重 0 与 1.5 应该一样
 *   B. 只是权重太低/被底模吸收 → 权重 1.5 应该明显不同
 *
 * 用法：node scripts/probe-lora-strength.mjs <文件名> [权重...]
 *   默认测 animaSoftCutePainterly，权重 0 / 1.5
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

const args = process.argv.slice(2);
const FILE = args[0] || 'animaSoftCutePainterlyE8BDAF.qBqa.safetensors';
const WEIGHTS = args.slice(1).map(Number).filter(n => Number.isFinite(n));
const WS = WEIGHTS.length ? WEIGHTS : [0, 1.5];

const backup = JSON.parse(JSON.stringify(config.comfyui.globalLora || []));

async function shoot(w) {
  config.comfyui.globalLora = w === 0
    ? []   // 权重 0 等价于完全不挂
    : [{ path: FILE, weight: w, triggerWord: '', enabled: true, scenes: [] }];
  const { wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: 768, height: 768 });
  for (const n of wf.nodes || []) {
    if (n.type === 'KSampler' && Array.isArray(n.widgets_values)) n.widgets_values[0] = SEED;
  }
  const tag = `w${String(w).replace('.', 'p')}`;
  console.log(`\n[${tag}] ${w === 0 ? '不挂 LoRA' : FILE + ' @ ' + w}  cfg=3 seed=${SEED}`);
  const res = await submitWorkflow(wf);
  if (!res.images?.length) throw new Error(`${tag} 出图失败`);
  const url = saveBase64Image('avatargen', `lora_str_${tag}_${SEED}.png`, res.images[0].base64);
  console.log(`[${tag}] 落盘 ${path.resolve('data/images', url.replace(/^\/images\//, ''))}`);
}

try {
  for (const w of WS) await shoot(w);
} finally {
  config.comfyui.globalLora = backup;
}
