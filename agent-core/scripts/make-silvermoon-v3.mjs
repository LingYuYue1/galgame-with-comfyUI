/**
 * 从零搭「银月 2.9B 专用」工作流 · v3（2026-10-23 23:45）
 *
 * ── 为什么是这个结构 ────────────────────────────────────────────
 * v2 的教训：我把输入侧"优化"成了 CLIPTextEncode 直接带文本，
 * 结果邻舍灌进来的提示词 / 尺寸全部落空 —— 因为它**只按节点标题找注入点**：
 *   src/services/imageSkill.js  NODE_TITLES = {
 *     artist:'画师串', quality:'质量提示词', negative:'负面提示词',
 *     width:'图片的宽', height:'图片的长', prompt:'画面描述', loraTrigger:'lora触发词' }
 * 找不到对应 title 的节点，就静默沿用工作流里写死的值。
 * 典型症状：提示词写了没反应、尺寸不跟设置走、画师串失效。
 *
 * 所以「能被邻舍用」的硬约束是：**这 7 个 title 必须一字不差**。
 * 骨架其余部分（加载器/采样器/输出）仍然从零按官方模板 image_anima_base_v1 搭。
 *
 * ── 正面提示词的拼装顺序（沿用邻舍约定） ────────────────────────
 *   SC1 = 画师串 + SC2
 *   SC2 = 质量提示词 + SC3
 *   SC3 = 画面描述 + lora触发词
 *   SC1 → CLIPTextEncode(正面).text
 *
 * ── 参数 ──────────────────────────────────────────────────────
 *   Sampler euler_ancestral / normal   官方 euler+simple，银月卡 Euler a
 *   Steps   16                         官方 30 / 银月卡 20–28，但 24 步要 100s
 *   CFG     3                          官方 4 / 银月卡 2.9B 用 3
 *   尺寸    832×1216                   竖构图，6GB 显存下比 1024² 稳
 *   （尺寸与提示词都会被邻舍覆盖，这里只是工作流打开时的默认值）
 *
 * 用法：
 *   node scripts/make-silvermoon-v3.mjs              手工版（带 2 个 LoRA）
 *   node scripts/make-silvermoon-v3.mjs --program    程序版（0 个 LoRA 节点）
 *   加 --dry 只看自检不写盘
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const forProgram = process.argv.includes('--program');
const useInt8 = process.argv.includes('--int8');
const dry = process.argv.includes('--dry');

// bf16 = 5.5G（原精度），int8 = 3.0G（ConvRot 量化，INT8+ConvRot 由 BF16 转来）
// 用户 6GB 卡 + --lowvram，int8 权重体积小一半，理论上搬运更省，实际待实测
const OUT_NAME = forProgram
  ? (useInt8 ? '银月2.9B-程序用-int8.json' : '银月2.9B-程序用（无LoRA节点）.json')
  : (useInt8 ? '银月2.9B-专用-int8.json' : '银月2.9B-专用（全新搭建）.json');

const COMFY_WF_DIR = 'D:/【新手二选一】带Anima-base（出图质量高）的秋叶整合包【记得内核升级到0.23】/ComfyUI-aki-v3/ComfyUI/user/default/workflows';
// 程序版必须落在 workflow/ 根目录才会进设置页下拉（routes/workflows.js 用 readdirSync 不递归）
const ARCHIVE_DIR = forProgram ? path.join(ROOT, 'workflow') : path.join(ROOT, 'workflow', '手工调试');

// ---------------------------------------------------------------- 常量
const UNET = useInt8
  ? 'silvermoonmixAnimaEvolved_v2329B_int8.safetensors'
  : 'silvermoonmixAnimaEvolved_v2329B_bf16.safetensors';
const TE = 'anima_baseV10_txt.safetensors';
const VAE = 'qwen_image_vae.safetensors';
const LORA1 = '邻舍画风dim23_V5_epoch18.safetensors';
const LORA2 = 'animaSoftCutePainterlyE8BDAF.qBqa.safetensors';

const W = 832, H = 1216, STEPS = 16, CFG = 3, SEED = 20261023;
const DELIM = ', ';

// 节点标题 —— 与 NODE_TITLES 逐字一致，改一个字注入就断
const T = {
  artist: '画师串',
  quality: '质量提示词',
  negative: '负面提示词',
  width: '图片的宽',
  height: '图片的长',
  prompt: '画面描述',
  loraTrigger: 'lora触发词',
};

const NEG_TEXT = 'worst quality, low quality, blurry, jpeg artifacts, text, watermark, bad anatomy, bad hands, extra fingers';

const NOTE_HEAD = `银月 2.9B · ${forProgram ? '邻舍程序用（无 LoRA 节点）' : '手工调试版（含 2 个 LoRA）'} · ${useInt8 ? 'INT8 底模' : 'BF16 底模'}
──────────────────────────
【底模】${UNET}
${useInt8
    ? 'INT8 + ConvRot 量化版（3.0G，由 BF16 权重转来，出图细节可能有差异）'
    : 'BF16 原精度版（5.5G）'}
【千万别改这 7 个节点的标题】
邻舍靠「节点标题」找注入点，一字不差才行：
  画师串 / 质量提示词 / 画面描述 / lora触发词
  图片的宽 / 图片的长 / 负面提示词
改名或删掉 = 程序找不到注入点，会静默沿用本文件里写死的值。
典型症状：提示词写了没反应、尺寸不跟设置走、画师串失效。

【正面提示词怎么拼】
  画师串 + 质量提示词 + 画面描述 + lora触发词
（三个 StringConcatenate 串起来，顺序不要调）

【为什么节点菜单里找不到"新插件"】
ComfyUI-Anima-LoRA-ControlNet-Patch 不新增任何节点
（NODE_CLASS_MAPPINGS 是空的），是加载期 monkeypatch。
确认只能看 ComfyUI 控制台：
  [Anima LoRA/ControlNet Patch] LoRA remap installed (...)
应用时每次打一行：
  28-block LoRA on 40-block Anima host: remapped N target keys
`;

const NOTE_MANUAL = NOTE_HEAD + `
【这份是手工调试版】
程序请指向「银月2.9B-程序用（无LoRA节点）.json」。
本文件自带 2 个 LoRA，程序若指向它会在前面再串一份 → 双 LoRA。

【LoRA 叠加】
UNET → lora1(dim23 @0.6) → lora2(cute @0.45) → KSampler。
要单个就删一个节点；要更多就继续串 LoraLoaderModelOnly，
但接到 KSampler 的那根 model 线必须在最末端。
⚠ remap 后行为不等同原底模，建议 0.5–0.7；0.9 容易过曝发糊。

【参数】
Sampler euler_ancestral / normal（官方 euler+simple，银月卡写 Euler a）
Steps   16（官方 30 / 银月卡 20–28，但 24 步要 100s）
CFG     3（官方 4 / 银月卡 2.9B 用 3）
尺寸    832×1216（会被邻舍按设置覆盖）
画风    @画师名，必须带 @，否则极弱。例：@DOM
清透感  把「负面提示词」节点清空 —— 作者示例图都没用负面词
要更快  换官方 Turbo 底模（v2329BTurbo）+ 8~12 步 + CFG 1`;

const NOTE_PROGRAM = NOTE_HEAD + `
【这份是给程序用的】
LoRA 一律由「设置 → 生图 → 全局 LoRA」控制，
勾几个就叠几个，程序自动串成
  UNETLoader → lora1 → lora2 → ... → KSampler
工作流里刻意一个 LoRA 节点都不放：
injectLoraNodes() 是往 UNETLoader 后面插的，
这里若已有 LoRA 会接在前面 → 双份画风失控。

【参数】
Sampler euler_ancestral / normal / Steps 16 / CFG 3。
提示词、尺寸、画师串、LoRA 都会由程序覆盖，
下面这些默认值只在直接打开工作流手动跑时才有意义。`;

// ---------------------------------------------------------------- 节点工具
const nodes = [];
const links = [];
let linkId = 0;

function mkLink(from, fromSlot, to, toSlot, type) {
  const id = ++linkId;
  links.push([id, from.id, fromSlot, to.id, toSlot, type]);
  from.outputs[fromSlot].links = from.outputs[fromSlot].links || [];
  from.outputs[fromSlot].links.push(id);
  to.inputs[toSlot].link = id;
  return id;
}

function node(id, type, pos, size, inputs, outputs, widgets, extra = {}) {
  const n = {
    id, type, pos, size, flags: {}, order: nodes.length, mode: 0,
    inputs, outputs, properties: { 'Node name for S&R': type }, widgets_values: widgets,
    ...extra,
  };
  nodes.push(n);
  return n;
}

const wslot = (name, type) => ({ localized_name: name, name, type, widget: { name }, link: null });
const ONE_OUT = (name, type) => [{ localized_name: name, name, type, type, slot_index: 0, links: [] }];

// ---------------------------------------------------------------- 加载器
const unet = node(1, 'UNETLoader', [-2600, -1200], [320, 130],
  [wslot('unet_name', 'COMBO'), wslot('weight_dtype', 'COMBO')],
  ONE_OUT('MODEL', 'MODEL'), [UNET, 'default']);

const clipLoader = node(2, 'CLIPLoader', [-2600, -1020], [320, 150],
  [wslot('clip_name', 'COMBO'), wslot('type', 'COMBO'), wslot('device', 'COMBO')],
  ONE_OUT('CLIP', 'CLIP'), [TE, 'stable_diffusion', 'default']);

const vaeLoader = node(3, 'VAELoader', [-2600, -820], [320, 100],
  [wslot('vae_name', 'COMBO')], ONE_OUT('VAE', 'VAE'), [VAE]);

// ---------------------------------------------------------------- 输入侧（title 是硬约定）
const pArtist = node(4, 'PrimitiveString', [-2600, -640], [320, 70],
  [wslot('value', 'STRING')], ONE_OUT('字符串', 'STRING'), [''],
  { title: T.artist });

const pQuality = node(5, 'PrimitiveString', [-2600, -540], [320, 70],
  [wslot('value', 'STRING')], ONE_OUT('字符串', 'STRING'),
  ['masterpiece, best quality'], { title: T.quality });

const pPrompt = node(6, 'PrimitiveString', [-2600, -440], [420, 120],
  [wslot('value', 'STRING')], ONE_OUT('字符串', 'STRING'),
  ['1girl, solo, standing, white shirt, black skirt, long pink hair, blue eyes, simple background'],
  { title: T.prompt });

const pTrigger = node(7, 'PrimitiveString', [-2600, -300], [420, 70],
  [wslot('value', 'STRING')], ONE_OUT('字符串', 'STRING'), [''],
  { title: T.loraTrigger });

const sc3 = node(8, 'StringConcatenate', [-2100, -300], [320, 150],
  [wslot('string_a', 'STRING'), wslot('string_b', 'STRING'), wslot('delimiter', 'STRING')],
  ONE_OUT('字符串', 'STRING'), ['', '', DELIM], { title: 'SC3 画面描述+触发词' });

const sc2 = node(9, 'StringConcatenate', [-1700, -440], [320, 150],
  [wslot('string_a', 'STRING'), wslot('string_b', 'STRING'), wslot('delimiter', 'STRING')],
  ONE_OUT('字符串', 'STRING'), ['', '', DELIM], { title: 'SC2 质量词+SC3' });

const sc1 = node(10, 'StringConcatenate', [-1300, -560], [320, 150],
  [wslot('string_a', 'STRING'), wslot('string_b', 'STRING'), wslot('delimiter', 'STRING')],
  ONE_OUT('字符串', 'STRING'), ['', '', DELIM], { title: 'SC1 画师串+SC2' });

const posEnc = node(11, 'CLIPTextEncode', [-900, -560], [400, 180],
  [{ localized_name: 'clip', name: 'clip', type: 'CLIP', link: null },
   wslot('text', 'STRING')],
  ONE_OUT('条件', 'CONDITIONING'), [''], { title: '正面提示词（由 SC1 拼接）' });

const negEnc = node(12, 'CLIPTextEncode', [-900, -320], [400, 160],
  [{ localized_name: 'clip', name: 'clip', type: 'CLIP', link: null },
   wslot('text', 'STRING')],
  ONE_OUT('条件', 'CONDITIONING'), [NEG_TEXT], { title: T.negative });

// ---------------------------------------------------------------- LoRA 链（仅手工版）
let lora1 = null, lora2 = null;
if (!forProgram) {
  lora1 = node(13, 'LoraLoaderModelOnly', [-2150, -1200], [320, 100],
    [{ localized_name: '模型', name: 'model', type: 'MODEL', link: null },
     wslot('lora_name', 'COMBO'), wslot('strength_model', 'FLOAT')],
    ONE_OUT('模型', 'MODEL'), [LORA1, 0.6], { title: 'lora1 · 主画风' });
  lora2 = node(14, 'LoraLoaderModelOnly', [-1780, -1200], [320, 100],
    [{ localized_name: '模型', name: 'model', type: 'MODEL', link: null },
     wslot('lora_name', 'COMBO'), wslot('strength_model', 'FLOAT')],
    ONE_OUT('模型', 'MODEL'), [LORA2, 0.45], { title: 'lora2 · 叠加示例' });
}

// ---------------------------------------------------------------- 尺寸与采样
const pWidth = node(15, 'PrimitiveInt', [-900, -100], [300, 70],
  [wslot('value', 'INT')], ONE_OUT('整数', 'INT'), [W, 'fixed'], { title: T.width });

const pHeight = node(16, 'PrimitiveInt', [-900, -20], [300, 70],
  [wslot('value', 'INT')], ONE_OUT('整数', 'INT'), [H, 'fixed'], { title: T.height });

const latent = node(17, 'EmptyLatentImage', [-520, -140], [320, 130],
  [{ localized_name: '宽度', name: 'width', type: 'INT', widget: { name: 'width' }, link: null },
   { localized_name: '高度', name: 'height', type: 'INT', widget: { name: 'height' }, link: null },
   wslot('batch_size', 'INT')],
  ONE_OUT('LATENT', 'LATENT'), [W, H, 1]);

const ks = node(18, 'KSampler', [-140, -640], [320, 270], [
  { localized_name: '模型', name: 'model', type: 'MODEL', link: null },
  { localized_name: '正面条件', name: 'positive', type: 'CONDITIONING', link: null },
  { localized_name: '负面条件', name: 'negative', type: 'CONDITIONING', link: null },
  { localized_name: 'Latent图像', name: 'latent_image', type: 'LATENT', link: null },
  wslot('seed', 'INT'), wslot('steps', 'INT'), wslot('cfg', 'FLOAT'),
  wslot('sampler_name', 'COMBO'), wslot('scheduler', 'COMBO'), wslot('denoise', 'FLOAT'),
], ONE_OUT('LATENT', 'LATENT'),
  [SEED, 'randomize', STEPS, CFG, 'euler_ancestral', 'normal', 1]);

const decode = node(19, 'VAEDecode', [260, -640], [220, 60],
  [{ localized_name: '采样器', name: 'samples', type: 'LATENT', link: null },
   { localized_name: 'VAE', name: 'vae', type: 'VAE', link: null }],
  ONE_OUT('图像', 'IMAGE'), []);

const save = node(20, 'SaveImage', [540, -640], [420, 460],
  [{ localized_name: '图像', name: 'images', type: 'IMAGE', link: null },
   wslot('filename_prefix', 'STRING')],
  [], ['银月']);

const note = node(21, 'Note', [-2600, -1900], [700, 720], [], [],
  [forProgram ? NOTE_PROGRAM : NOTE_MANUAL], { color: '#432', bgcolor: '#653' });

// ---------------------------------------------------------------- 连线
// 输入侧拼接链
mkLink(pPrompt, 0, sc3, 0, 'STRING');      // 画面描述 → SC3.a
mkLink(pTrigger, 0, sc3, 1, 'STRING');     // lora触发词 → SC3.b
mkLink(pQuality, 0, sc2, 0, 'STRING');     // 质量提示词 → SC2.a
mkLink(sc3, 0, sc2, 1, 'STRING');          // SC3 → SC2.b
mkLink(pArtist, 0, sc1, 0, 'STRING');      // 画师串 → SC1.a
mkLink(sc2, 0, sc1, 1, 'STRING');          // SC2 → SC1.b
mkLink(sc1, 0, posEnc, 1, 'STRING');       // SC1 → 正面.text
mkLink(clipLoader, 0, posEnc, 0, 'CLIP');
mkLink(clipLoader, 0, negEnc, 0, 'CLIP');

// 尺寸
mkLink(pWidth, 0, latent, 0, 'INT');
mkLink(pHeight, 0, latent, 1, 'INT');

// 采样
mkLink(posEnc, 0, ks, 1, 'CONDITIONING');
mkLink(negEnc, 0, ks, 2, 'CONDITIONING');
mkLink(latent, 0, ks, 3, 'LATENT');
mkLink(ks, 0, decode, 0, 'LATENT');
mkLink(vaeLoader, 0, decode, 1, 'VAE');
mkLink(decode, 0, save, 0, 'IMAGE');

// model 链
if (forProgram) {
  mkLink(unet, 0, ks, 0, 'MODEL');
} else {
  mkLink(unet, 0, lora1, 0, 'MODEL');
  mkLink(lora1, 0, lora2, 0, 'MODEL');
  mkLink(lora2, 0, ks, 0, 'MODEL');
}

// ---------------------------------------------------------------- 组装
const wf = {
  id: forProgram ? 'd3a7f1c8-5e2b-4a90-b6d4-8f31c07e2a95' : 'a9c4e6b2-7f18-4d35-8c02-5b6e9d14f7a3',
  revision: 0,
  last_node_id: Math.max(...nodes.map(n => n.id)),
  last_link_id: linkId,
  nodes, links, groups: [], config: {},
  extra: { ds: { scale: 0.55, offset: [2900, 2100] } },
  version: 0.4,
};

// ---------------------------------------------------------------- 自检
{
  const ids = new Set(nodes.map(n => n.id));
  if (ids.size !== nodes.length) throw new Error('节点 id 重复');
  const lids = links.map(l => l[0]);
  if (new Set(lids).size !== lids.length) throw new Error('link id 重复');

  const byId = new Map(nodes.map(n => [n.id, n]));
  const linkById = new Map(links.map(l => [l[0], l]));
  for (const [id, from, fromSlot, to, toSlot, type] of links) {
    const s = byId.get(from), d = byId.get(to);
    if (!s?.outputs?.[fromSlot]) throw new Error(`link ${id} 起点无效`);
    if (!d?.inputs?.[toSlot]) throw new Error(`link ${id} 终点无效`);
    if (d.inputs[toSlot].link !== id) throw new Error(`link ${id} 终点未回指`);
    if (!s.outputs[fromSlot].links?.includes(id)) throw new Error(`link ${id} 起点未登记`);
    if (type === '*' || d.inputs[toSlot].type === '*') continue;
    if (d.inputs[toSlot].type !== type) throw new Error(`link ${id} 类型不符：${d.inputs[toSlot].type} vs ${type}`);
  }

  // ★ 硬约束：7 个注入点必须齐
  const titles = new Set(nodes.map(n => n.title).filter(Boolean));
  const missing = Object.values(T).filter(t => !titles.has(t));
  if (missing.length) throw new Error(`缺少邻舍注入点标题：${missing.join('、')}`);

  // 正面链顺序：KSampler.positive 的源头必须是 title=画面描述 那个 PrimitiveString 可达
  const posLink = linkById.get(ks.inputs[1].link);
  if (byId.get(posLink[1]) !== posEnc) throw new Error('KSampler.positive 没接正面 CLIPTextEncode');

  const expectSrc = forProgram ? unet.id : lora2.id;
  if (linkById.get(ks.inputs[0].link)[1] !== expectSrc) throw new Error('model 链末端不对');

  console.log('自检通过：');
  console.log(`  节点 ${nodes.length}，连线 ${links.length}`);
  console.log(`  注入点 ${Object.values(T).length} 个全部在位：${Object.values(T).join(' / ')}`);
  console.log(`  正面链：画面描述 + lora触发词 → SC3 → SC2 ← 质量提示词 → SC1 ← 画师串 → CLIPTextEncode`);
  console.log(`  尺寸：图片的宽/长 → EmptyLatentImage`);
  console.log(forProgram
    ? `  model：UNET#${unet.id} → KSampler#${ks.id}（无 LoRA 节点，等程序注入）`
    : `  model：UNET#${unet.id} → lora1#${lora1.id}(${lora1.widgets_values[1]}) → lora2#${lora2.id}(${lora2.widgets_values[1]}) → KSampler#${ks.id}`);
  console.log(`  KSampler：steps=${STEPS} cfg=${CFG} euler_ancestral/normal`);
}

const out = JSON.stringify(wf, null, 2);

if (dry) {
  console.log('\n[dry] 不写盘');
} else {
  for (const dir of [COMFY_WF_DIR, ARCHIVE_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, OUT_NAME);
    fs.writeFileSync(target, out, 'utf8');
    console.log(`写入 ${target}`);
  }
}
