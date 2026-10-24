/**
 * 「程序版工作流」兼容性验证（2026-10-23 23:3x）
 *
 * 要回答用户那句「新工作流能否兼容邻舍和叠多个 lora」：
 *   1. 邻舍能不能用它 —— 用 customWorkflow 指定文件，走完整 buildWorkflow 链路
 *   2. 多 LoRA 叠加还成立吗 —— injectLoraNodes 往 UNETLoader 后面插，
 *      工作流本身没有 LoRA 节点，所以不会撞成双份
 *   3. 16 步在这分辨率下要多久 —— 用户嫌 24 步 100s
 *
 * 只在内存改 config，不写库；不动用户的 workflowPath 设置。
 *
 * 用法：node scripts/probe-program-compat.mjs [--no-run]
 */
import { getDb } from '../src/db/index.js';
import path from 'path';

getDb();
const { buildWorkflow } = await import('../src/services/imageSkill.js');
const { submitWorkflow } = await import('../src/services/comfyClient.js');
const { config } = await import('../src/config.js');
const { saveBase64Image } = await import('../src/services/imagePaths.js');

const WF = '银月2.9B-程序用（无LoRA节点）.json';
const SEED = 20261023;
const PROMPT = '1girl, solo, long pink hair, blue eyes, white shirt, black skirt, standing, simple background, best quality';
const ALL = ['chat', 'group', 'portrait', 'avatar', 'moments', 'events', 'schedule',
  'mailbox', 'sticker', 'item', 'media', 'paper', 'proactive', 'gift', 'town'];
const mk = (p, w) => ({ path: p, weight: w, triggerWord: '', enabled: true, scenes: ALL });

const backup = JSON.parse(JSON.stringify(config.comfyui.globalLora || []));
config.comfyui.globalLora = [
  mk('邻舍画风dim23_V5_epoch18.safetensors', 0.6),
  mk('animaSoftCutePainterlyE8BDAF.qBqa.safetensors', 0.45),
];

function traceModelChain(wf) {
  const ks = wf.nodes.find(n => n.type === 'KSampler');
  const linkById = new Map(wf.links.map(l => [l[0], l]));
  const byId = new Map(wf.nodes.map(n => [n.id, n]));
  const chain = [];
  let cur = ks;
  for (let g = 0; g < 20; g++) {
    const inp = cur.inputs?.find(i => i.name === 'model');
    const link = inp?.link != null ? linkById.get(inp.link) : null;
    if (!link) { chain.push('(断线)'); break; }
    const src = byId.get(link[1]);
    if (!src) { chain.push(`(缺节点 #${link[1]})`); break; }
    chain.push(src.type === 'LoraLoaderModelOnly'
      ? `lora#${src.id}(${String(src.widgets_values?.[0]).replace('.safetensors', '')} @${src.widgets_values?.[1]})`
      : `${src.type}#${src.id}`);
    if (src.type === 'UNETLoader') break;
    cur = src;
  }
  return chain;
}

try {
  const { wf } = buildWorkflow(PROMPT, {
    scene: 'avatar',
    width: 832,
    height: 1216,
    customWorkflow: WF,
  });

  const loras = (wf.nodes || []).filter(n => n.type === 'LoraLoaderModelOnly');
  const chain = traceModelChain(wf);
  const ks = wf.nodes.find(n => n.type === 'KSampler');

  console.log(`\n工作流：${WF}`);
  console.log(`  注入 LoRA 数：${loras.length}（期望 2，工作流自带 0 个）`);
  console.log(`  链路：${chain.join(' ← ')}`);
  console.log(`  KSampler：steps=${ks.widgets_values[2]} cfg=${ks.widgets_values[3]} ${ks.widgets_values[4]}/${ks.widgets_values[5]}`);
  const save = wf.nodes.find(n => n.type === 'SaveImage');
  console.log(`  输出节点：${save ? 'SaveImage' : (wf.nodes.find(n => n.type === 'PreviewImage') ? 'PreviewImage' : '无')}`);

  if (loras.length !== 2) console.log('  ✗ 注入数量不符');
  if (chain[0] !== `lora#${loras[loras.length - 1].id}(${loras[loras.length - 1].widgets_values[0].replace('.safetensors', '')} @${loras[loras.length - 1].widgets_values[1]})`) {
    console.log('  ⚠ 链路末端不是最后一个 LoRA（顺序可能不同，看上面的链路图）');
  }

  if (process.argv.includes('--no-run')) {
    console.log('\n[跳过实跑]');
  } else {
    for (const n of wf.nodes || []) {
      if (n.type === 'KSampler' && Array.isArray(n.widgets_values)) n.widgets_values[0] = SEED;
    }
    console.log('\n提交中…');
    const t0 = Date.now();
    const res = await submitWorkflow(wf);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    if (!res.images?.length) throw new Error('出图失败');
    const url = saveBase64Image('avatargen', `program_compat_${SEED}.png`, res.images[0].base64);
    console.log(`  出图成功 ${sec}s → ${path.resolve('data/images', url.replace(/^\/images\//, ''))}`);
    console.log(`  （用户报告 24 步 100s，本档 16 步）`);
  }
} finally {
  config.comfyui.globalLora = backup;
}
