/**
 * LoRA 开/关对照实验（2026-10-23，用户报「挂了 LoRA 但图没水印」）
 *
 * 前面的检查只能证明"节点提交了"（拓扑、文件、权重都对）。
 * 唯一能回答"到底有没有效果"的办法是：**同 seed，开/关各出一张，人眼看差别**。
 *
 * 用法：node scripts/probe-lora-ab.mjs
 * 产物：data/images/avatargen/lora_ab_{on,off}_<seed>.png
 */
import { getDb } from '../src/db/index.js';
import path from 'path';
import fs from 'fs';

getDb();
const { buildWorkflow } = await import('../src/services/imageSkill.js');
const { submitWorkflow } = await import('../src/services/comfyClient.js');
const { config } = await import('../src/config.js');
const { saveBase64Image } = await import('../src/services/imagePaths.js');

const SEED = 20261023;
const PROMPT = '1girl, solo, long pink hair, blue eyes, white shirt, standing, '
  + 'simple white background, flat lighting, best quality';

function fixSeed(wf, seed) {
  for (const n of wf.nodes || []) {
    if (n.type === 'KSampler' && Array.isArray(n.widgets_values)) n.widgets_values[0] = seed;
  }
}

/** 把 LoRA 从链路里摘掉：KSampler.model 直接指回 UNETLoader */
function stripLoras(wf) {
  const unet = wf.nodes.find(n => n.type === 'UNETLoader');
  const ks = wf.nodes.find(n => n.type === 'KSampler');
  if (!unet || !ks || !Array.isArray(ks.inputs)) return;
  const idx = ks.inputs.findIndex(i => i.name === 'model');
  if (idx < 0) return;
  ks.inputs[idx].link = null;
  // 删掉所有 LoraLoader* 节点
  const loraIds = wf.nodes.filter(n => String(n.type).startsWith('LoraLoader')).map(n => n.id);
  // KSampler.model 改为直连 UNET（用一条新 link）
  const newLinkId = new Set((wf.links || []).map(l => l[0]));
  let id = 0;
  while (newLinkId.has(id)) id++;
  wf.links = (wf.links || []).filter(l => !loraIds.includes(l[1]) && !loraIds.includes(l[3]));
  wf.links.push([0, unet.id, 0, ks.id, idx, 'MODEL']);
  ks.inputs[idx].link = 0;
  wf.nodes = wf.nodes.filter(n => !loraIds.includes(n.id));
}

async function shoot(tag, strip) {
  const { wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: 768, height: 768 });
  fixSeed(wf, SEED);
  if (strip) stripLoras(wf);
  const hasLora = (wf.nodes || []).some(n => String(n.type).startsWith('LoraLoader'));
  console.log(`\n[${tag}] LoRA 节点 ${hasLora ? '在' : '已移除'}，seed=${SEED}，提交中…`);
  const res = await submitWorkflow(wf);
  if (!res.images?.length) throw new Error(`${tag} 出图失败`);
  const url = saveBase64Image('avatargen', `lora_ab_${tag}_${SEED}.png`, res.images[0].base64);
  const abs = path.resolve('data/images', url.replace(/^\/images\//, ''));
  const size = fs.statSync(abs).size;
  console.log(`[${tag}] 落盘 ${abs}  (${size} 字节)`);
  return abs;
}

const a = await shoot('on', false);
const b = await shoot('off', true);
console.log('\n===== 对照 =====');
console.log(' 开 LoRA:', a);
console.log(' 关 LoRA:', b);
console.log(' 两张同 seed、同提示词 —— 若肉眼几乎一样，说明这个 LoRA 在当前底模上没起作用。');
