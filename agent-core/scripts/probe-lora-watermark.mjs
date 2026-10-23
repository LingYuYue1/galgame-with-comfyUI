/**
 * 水印闭环实验（2026-10-23）
 *
 * 用户用「图里有没有水印」判断全局 LoRA 是否生效（这个 LoRA 带水印）。
 * 但对照片显示 LoRA 生效、两张都没水印 —— 于是怀疑负面词把水印压掉了。
 *
 * 本脚本：同 seed、同提示词、同样开 LoRA，**只把「去水印负面词」拿掉**，
 * 用工作流自带的原始负面词出一张。
 *   出现水印 → 证明 LoRA 一直在生效，只是被自己的负面词压掉了
 *   仍无水印 → 说明这个 LoRA 的水印不是必然产物，用户的判据本身不成立
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

const saved = config.comfyui.negativePrompt;
config.comfyui.negativePrompt = '';   // 让工作流用它自带的原版负面词（不含去水印项）
let wf;
try {
  ({ wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: 768, height: 768 }));
} finally {
  config.comfyui.negativePrompt = saved;
}
for (const n of wf.nodes || []) {
  if (n.type === 'KSampler' && Array.isArray(n.widgets_values)) n.widgets_values[0] = SEED;
}

const negNode = (wf.nodes || []).find(n => n.type === 'CLIPTextEncode' && String(n.widgets_values?.[0] || '').includes('bad'));
console.log('使用的负面词（前 160 字符）:', String(negNode?.widgets_values?.[0] || '(没找到)').slice(0, 160));
console.log('其中是否含 watermark:', String(negNode?.widgets_values?.[0] || '').toLowerCase().includes('watermark'));

const res = await submitWorkflow(wf);
if (!res.images?.length) throw new Error('出图失败');
const url = saveBase64Image('avatargen', `lora_nowm_neg_${SEED}.png`, res.images[0].base64);
console.log('落盘:', path.resolve('data/images', url.replace(/^\/images\//, '')));
