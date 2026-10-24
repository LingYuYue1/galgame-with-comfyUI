/**
 * 负面提示词三版对比（2026-10-24 00:1x）
 *
 * 用户观察：「这个底模还是非常吃负面提示词的」—— 需要一份好的。
 *
 * 现状（config 里 404 字符）的三个毛病：
 *   1. 光影类 8 个词（shadows/highlights/strong lighting/dramatic lighting/
 *      rim light/backlighting/high contrast/volumetric lighting）
 *      → 把所有光影都压平，画面发死。这是"怕过曝"演化成的过度修正。
 *   2. 去水印类 12 个词重复度高，白占分量。
 *   3. 缺质量兜底（worst quality/low quality/lowres/blurry）和结构兜底（bad hands/extra digits）。
 *   4. censor/mosaic 会把遮挡物一起去掉，副作用大。
 *
 * 三版：
 *   A = 现状（404）
 *   B = 精简重构（质量 + 结构兜底，不压光影）
 *   C = 官方模板那句（最短，模型卡说示例图都没用负面词）
 *
 * 同 seed / 同 prompt / 同 LoRA / 同尺寸，只换负面词。
 *
 * 用法：node scripts/probe-negative-prompt.mjs [A B C]
 */
import { getDb } from '../src/db/index.js';
import path from 'path';

getDb();
const { buildWorkflow } = await import('../src/services/imageSkill.js');
const { submitWorkflow } = await import('../src/services/comfyClient.js');
const { config } = await import('../src/config.js');
const { saveBase64Image } = await import('../src/services/imagePaths.js');

const SEED = 20261027;
const PROMPT = '1girl, solo, upper body, long pink hair, blue eyes, white shirt, '
  + 'sitting by a cafe window, soft window light on face, warm afternoon, detailed background, best quality';
const W = 704, H = 1024;
const WF = '银月2.9B-程序用-int8.json';
const ALL = ['chat', 'group', 'portrait', 'avatar', 'moments', 'events', 'schedule',
  'mailbox', 'sticker', 'item', 'media', 'paper', 'proactive', 'gift', 'town'];

// A：当前线上那份
const NEG_A = 'score_1, score_2, score_3, bad anatomy, bad proportions, deformed anatomy, deformed face, deformed eyes, text, multiple fingers, watermark, artist name, signature, logo, artist logo, username, url, web address, patreon username, watermark text, text overlay, stamp, seal, censor, mosaic, shadows, highlights, strong lighting, dramatic lighting, rim light, backlighting, high contrast, volumetric lighting';

// B：精简重构。质量兜底 + 结构兜底 + 去水印（3 个够），刻意不压光影
const NEG_B = 'worst quality, low quality, lowres, blurry, jpeg artifacts, pixelated, '
  + 'bad anatomy, bad proportions, deformed, disfigured, extra limbs, missing limbs, '
  + 'extra digits, fewer digits, bad hands, mutated hands, long neck, '
  + 'watermark, signature, username, logo, text, '
  + 'monochrome, greyscale, 3d, photorealistic';

// C：ComfyUI 官方 Anima 模板原句
const NEG_C = 'worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia';

// D：官方短版 + 去水印/文字。不压光影，不加一堆结构词
const NEG_D = 'worst quality, low quality, lowres, score_1, score_2, score_3, blurry, jpeg artifacts, '
  + 'text, watermark, signature, logo';

const GROUPS = { A: NEG_A, B: NEG_B, C: NEG_C, D: NEG_D };
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['A', 'B', 'C'];

const backup = JSON.parse(JSON.stringify(config.comfyui.globalLora || []));
const backupNeg = config.comfyui.negativePrompt;
config.comfyui.globalLora = [
  { path: '邻舍画风dim23_V5_epoch18.safetensors', weight: 0.6, triggerWord: '', enabled: true, scenes: ALL },
];

try {
  for (const k of names) {
    const neg = GROUPS[k];
    if (neg == null) throw new Error(`没有 ${k} 这组`);
    config.comfyui.negativePrompt = neg;
    const { wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: W, height: H, customWorkflow: WF });
    const ks = wf.nodes.find(n => n.type === 'KSampler');
    ks.widgets_values[0] = SEED;

    // 确认负面词真的进了节点
    const negNode = wf.nodes.find(n => n.title === '负面提示词');
    const applied = negNode?.widgets_values?.[0] || '';

    const t0 = Date.now();
    const res = await submitWorkflow(wf);
    const sec = (Date.now() - t0) / 1000;
    if (!res.images?.length) throw new Error(`${k} 出图失败`);
    const url = saveBase64Image('avatargen', `neg_${k}_${SEED}.png`, res.images[0].base64);
    console.log(`[${k}] ${String(neg.length).padStart(3)} 字符 / ${neg.split(',').length} 个词 / ${sec.toFixed(1)}s / 实际注入 ${applied.length} 字符`);
    console.log(`     ${path.resolve('data/images', url.replace(/^\/images\//, ''))}`);
  }
} finally {
  config.comfyui.negativePrompt = backupNeg;
  config.comfyui.globalLora = backup;
}
