/**
 * 多 LoRA 叠加验证（2026-10-23，用户强调「可以叠加多个 lora 的那种」）
 *
 * 要回答两件事：
 *   1. 程序侧：多个 globalLora 是不是真的串成 UNET → lora1 → lora2 → ... → KSampler
 *   2. 插件侧：每个 28 块 LoRA 是否都被独立 remap 到 40 块
 *      —— 判据是 ComfyUI 日志里出现几条 "28-block LoRA on 40-block Anima host: remapped"
 *
 * 只在内存改 config.comfyui.globalLora，不写库。
 *
 * 用法：node scripts/probe-multi-lora.mjs [组名...]
 *   默认跑 solo（单个）和 triple（三个叠加）两组，方便对照
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

const ALL = ['chat', 'group', 'portrait', 'avatar', 'moments', 'events', 'schedule',
  'mailbox', 'sticker', 'item', 'media', 'paper', 'proactive', 'gift', 'town'];

const mk = (p, w) => ({ path: p, weight: w, triggerWord: '', enabled: true, scenes: ALL });

const GROUPS = {
  solo: [mk('邻舍画风dim23_V5_epoch18.safetensors', 0.7)],
  dual: [
    mk('邻舍画风dim23_V5_epoch18.safetensors', 0.7),
    mk('animaSoftCutePainterlyE8BDAF.qBqa.safetensors', 0.6),
  ],
  triple: [
    mk('邻舍画风dim23_V5_epoch18.safetensors', 0.7),
    mk('animaSoftCutePainterlyE8BDAF.qBqa.safetensors', 0.6),
    mk('邻舍2闪亮shiny_nai_style_anima.safetensors', 0.5),
  ],
  // 三个权重全都与前面各组错开，保证不命中 ComfyUI 的节点缓存。
  // 如果这组记到 3 条 remap，说明 triple 只记 2 条是缓存复用（安全）；
  // 若仍不足 3 条，才是真的漏了 remap。
  triple_fresh: [
    mk('邻舍画风dim23_V5_epoch18.safetensors', 0.72),
    mk('animaSoftCutePainterlyE8BDAF.qBqa.safetensors', 0.61),
    mk('邻舍2闪亮shiny_nai_style_anima.safetensors', 0.51),
  ],
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : ['solo', 'triple'];
const backup = JSON.parse(JSON.stringify(config.comfyui.globalLora || []));

/** 从 KSampler 往回走 model 链，返回 ['UNETLoader', 'lora1', 'lora2', ...] */
function traceModelChain(wf) {
  const ks = wf.nodes.find(n => n.type === 'KSampler');
  if (!ks) return ['(无 KSampler)'];
  const linkById = new Map(wf.links.map(l => [l[0], l]));
  const byId = new Map(wf.nodes.map(n => [n.id, n]));
  const chain = [];
  let cur = ks;
  for (let guard = 0; guard < 20; guard++) {
    const inp = cur.inputs?.find(i => i.name === 'model');
    const link = inp?.link != null ? linkById.get(inp.link) : null;
    if (!link) { chain.push('(断线)'); break; }
    const src = byId.get(link[1]);
    if (!src) { chain.push(`(找不到 #${link[1]})`); break; }
    chain.push(src.type === 'LoraLoaderModelOnly'
      ? `lora#${src.id}(${String(src.widgets_values?.[0]).replace('.safetensors', '')} @${src.widgets_values?.[1]})`
      : `${src.type}#${src.id}`);
    if (src.type === 'UNETLoader') break;
    cur = src;
  }
  return chain;
}

async function shoot(name) {
  const loras = GROUPS[name];
  if (!loras) throw new Error(`没有这个组：${name}`);
  config.comfyui.globalLora = loras;

  const { wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: 768, height: 768 });
  for (const n of wf.nodes || []) {
    if (n.type === 'KSampler' && Array.isArray(n.widgets_values)) n.widgets_values[0] = SEED;
  }

  const chain = traceModelChain(wf);
  const loraCount = (wf.nodes || []).filter(n => n.type === 'LoraLoaderModelOnly').length;
  console.log(`\n[${name}] 期望 ${loras.length} 个 LoRA，实际注入 ${loraCount} 个`);
  console.log(`  链路: ${chain.join(' ← ')}`);
  if (loraCount !== loras.length) console.log(`  ✗ 数量不符！`);

  const t0 = Date.now();
  const res = await submitWorkflow(wf);
  if (!res.images?.length) throw new Error(`${name} 出图失败`);
  const url = saveBase64Image('avatargen', `multi_lora_${name}_${SEED}.png`, res.images[0].base64);
  console.log(`  落盘 ${path.resolve('data/images', url.replace(/^\/images\//, ''))}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

try {
  for (const n of names) await shoot(n);
} finally {
  config.comfyui.globalLora = backup;
}
