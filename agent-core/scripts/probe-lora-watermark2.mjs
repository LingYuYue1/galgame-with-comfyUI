/**
 * 水印闭环实验·第二步（2026-10-23）
 *
 * 第一步只去掉了用户配置的负面词，但**工作流自带的负面词里也有 watermark**，
 * 等于没去掉。这一步把负面词里所有"去水印"相关项**彻底删除**，其余不变。
 *   出现水印 → 证明 LoRA 一直在生效，水印是被负面词压掉的
 *   仍无水印 → 这个 LoRA 的水印不是必然产物，不能拿它当生效判据
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
config.comfyui.negativePrompt = '';
let wf;
try {
  ({ wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: 768, height: 768 }));
} finally {
  config.comfyui.negativePrompt = saved;
}
for (const n of wf.nodes || []) {
  if (n.type === 'KSampler' && Array.isArray(n.widgets_values)) n.widgets_values[0] = SEED;
}

// 把负面词里的去水印项彻底删掉
const negNode = (wf.nodes || []).find(n => n.type === 'CLIPTextEncode' && String(n.widgets_values?.[0] || '').includes('bad'));
if (!negNode) throw new Error('没找到负面词节点');
const before = String(negNode.widgets_values[0]);
const after = before
  .replace(/\bwatermark\b\s*,?\s*/gi, '')
  .replace(/\bartist name\b\s*,?\s*/gi, '')
  .replace(/\bsignature\b\s*,?\s*/gi, '')
  .replace(/\blogo\b\s*,?\s*/gi, '')
  .replace(/\bartist logo\b\s*,?\s*/gi, '')
  .replace(/\busername\b\s*,?\s*/gi, '');
negNode.widgets_values[0] = after;
console.log('删前含水印项:', /watermark|signature|logo|artist name/i.test(before));
console.log('删后含水印项:', /watermark|signature|logo|artist name/i.test(after));
console.log('删后负面词:', after.slice(0, 200));

const res = await submitWorkflow(wf);
if (!res.images?.length) throw new Error('出图失败');
const url = saveBase64Image('avatargen', `lora_bare_neg_${SEED}.png`, res.images[0].base64);
console.log('落盘:', path.resolve('data/images', url.replace(/^\/images\//, '')));
