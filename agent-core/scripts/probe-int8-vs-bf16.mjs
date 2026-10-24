/**
 * BF16 vs INT8 底模速度对比（2026-10-23 23:5x）
 *
 * 用户问：「8 的这个速度会不会更快一点？」
 *
 * 测四轮，分离「加载开销」和「推理开销」：
 *   bf16 第1次（冷，含 5.5G 权重加载）
 *   bf16 第2次（热，模型已在显存/缓存）
 *   int8 第1次（冷，要换出 bf16 再加载 3.0G）
 *   int8 第2次（热）
 *
 * 同 seed / 同提示词 / 同尺寸，只换底模。
 * 6GB 显存装不下两个 2.9B 模型，所以每次切换必然重新加载 —— 这正是用户切工作流的真实体验。
 *
 * 用法：node scripts/probe-int8-vs-bf16.mjs
 */
import { getDb } from '../src/db/index.js';
import path from 'path';

getDb();
const { buildWorkflow } = await import('../src/services/imageSkill.js');
const { submitWorkflow } = await import('../src/services/comfyClient.js');
const { config } = await import('../src/config.js');
const { saveBase64Image } = await import('../src/services/imagePaths.js');

const SEED = 20261023;
const PROMPT = 'Hatsune Miku (VOCALOID), 1girl, close-up shot, teal twin-tailed hair, blue eyes, '
  + 'black school uniform with tie, holding a fork, matcha mille crepe cake, cafe background, warm lighting';
const W = 704, H = 1024;
const ALL = ['chat', 'group', 'portrait', 'avatar', 'moments', 'events', 'schedule',
  'mailbox', 'sticker', 'item', 'media', 'paper', 'proactive', 'gift', 'town'];

const WF_BF16 = '银月2.9B-程序用（无LoRA节点）.json';
const WF_INT8 = '银月2.9B-程序用-int8.json';

const backup = JSON.parse(JSON.stringify(config.comfyui.globalLora || []));
config.comfyui.globalLora = [
  { path: '邻舍画风dim23_V5_epoch18.safetensors', weight: 0.6, triggerWord: '', enabled: true, scenes: ALL },
];

async function shoot(tag, wfName, round, seed) {
  const { wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: W, height: H, customWorkflow: wfName });
  const ks = wf.nodes.find(n => n.type === 'KSampler');
  ks.widgets_values[0] = seed;   // ← 每轮不同 seed，否则 ComfyUI 节点缓存直接复用，耗时会变成 0.2s
  const unet = wf.nodes.find(n => n.type === 'UNETLoader');
  const t0 = Date.now();
  const res = await submitWorkflow(wf);
  const sec = (Date.now() - t0) / 1000;
  if (!res.images?.length) throw new Error(`${tag} 出图失败`);
  const url = saveBase64Image('avatargen', `int8cmp_${tag}_${round}_${seed}.png`, res.images[0].base64);
  console.log(`  [${tag} #${round} seed=${seed}] ${sec.toFixed(1)}s  (${unet.widgets_values[0].includes('int8') ? 'int8' : 'bf16'})`);
  return { sec, url };
}

try {
  console.log('\n=== BF16 ===');
  const b1 = await shoot('bf16', WF_BF16, 1, SEED);
  const b2 = await shoot('bf16', WF_BF16, 2, SEED + 1);

  console.log('\n=== INT8 ===');
  const i1 = await shoot('int8', WF_INT8, 1, SEED + 2);
  const i2 = await shoot('int8', WF_INT8, 2, SEED + 3);

  console.log('\n=== 汇总（同尺寸 704×1024 / 16 步 / cfg3 / 1 个 LoRA @0.6）===');
  console.log(`  bf16 冷(含加载) ${b1.sec.toFixed(1)}s / 热 ${b2.sec.toFixed(1)}s`);
  console.log(`  int8 冷(含切换) ${i1.sec.toFixed(1)}s / 热 ${i2.sec.toFixed(1)}s`);
  const dHot = ((i2.sec - b2.sec) / b2.sec * 100).toFixed(1);
  const dCold = ((i1.sec - b1.sec) / b1.sec * 100).toFixed(1);
  console.log(`  热跑差 ${dHot}% ，冷启动差 ${dCold}%  （负数 = int8 更快）`);
  console.log(`  画质对照：${b2.url}  vs  ${i2.url}`);
} finally {
  config.comfyui.globalLora = backup;
}
