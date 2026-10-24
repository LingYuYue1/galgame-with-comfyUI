/**
 * 从零搭「银月 2.9B 专用」工作流（2026-10-23 23:xx）
 *
 * 为什么重搭而不是改：
 *   `本地邻舍（银月16）.json` 是邻舍作者为**他那个 2B 模型**搭的，里面每一处
 *   都带着针对 2B 的调优假设：
 *     - 负面词 `score_1, score_2, score_3` 顶在最前（2B 的评分体系）
 *     - `er_sde` + `beta` scheduler（Turbo 版配方）
 *     - 画师串默认 `@ebora`
 *     - 768×512 固定分辨率、PreviewImage 只预览不存盘
 *     - 质量词是 Illustrious/SDXL 时代的 `score_9, score_8, year 2025`
 *   在上面打补丁，改得越多越容易和原作者的意图打架。
 *
 * 基准：ComfyUI 官方模板 `image_anima_base_v1.json`（Text to Image (Anima Base v1.0)）
 *   那份的骨架是：UNETLoader + CLIPLoader + VAELoader + 双 CLIPTextEncode
 *                  + EmptyLatentImage + KSampler + VAEDecode + SaveImage
 *   参数取它 + 银月模型卡的交集：
 *     Sampler  官方 `euler`/`simple`，银月卡 `Euler a` → 取 `euler_ancestral`
 *     Steps    官方 30，银月卡 20–28 → 取 24（用户 6GB 显存，不取上限）
 *     CFG      官方 4，银月卡 3（2.9B）→ 取 3
 *     负面词   官方给了一套精简版，银月卡说「先不用」→ 留精简版但可一键清空
 *
 * 与旧「手工调试」版的区别：
 *   旧版 = 邻舍工作流 + 洛拉补丁；本版 = 独立骨架，不继承任何邻舍参数。
 *
 * 用法：node scripts/make-silvermoon-v2.mjs [--dry]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const forProgram = process.argv.includes('--program');
const OUT_NAME = forProgram
  ? '银月2.9B-程序用（无LoRA节点）.json'
  : '银月2.9B-专用（全新搭建）.json';

const COMFY_WF_DIR = 'D:/【新手二选一】带Anima-base（出图质量高）的秋叶整合包【记得内核升级到0.23】/ComfyUI-aki-v3/ComfyUI/user/default/workflows';
// 程序用那份必须落在 workflow/ 根目录：routes/workflows.js 用 readdirSync 不递归，
// 只有根目录的 json 才会进设置页下拉。手工那份反过来要避开下拉，放子目录。
const ARCHIVE_DIR = forProgram
  ? path.join(ROOT, 'workflow')
  : path.join(ROOT, 'workflow', '手工调试');

const dry = process.argv.includes('--dry');

// ---------------------------------------------------------------- 基础信息
const UNET = 'silvermoonmixAnimaEvolved_v2329B_bf16.safetensors';
const TE = 'anima_baseV10_txt.safetensors';
const VAE = 'qwen_image_vae.safetensors';
const LORA1 = '邻舍画风dim23_V5_epoch18.safetensors';
const LORA2 = 'animaSoftCutePainterlyE8BDAF.qBqa.safetensors';

const W = 832, H = 1216;   // 竖构图；6GB 卡上比 1024×1024 稳，比例接近立绘
// 16 步：官方模板 30、银月卡 20–28，但用户实测 24 步这张分辨率要 100s。
// 16 步是速度与质量的平衡点（与之前 er_sde/16 的出图观感差异极小）。
const STEPS = 16;
const SEED = 20261023;

const POS = `masterpiece, best quality, 1girl, solo, standing, white shirt, black skirt, long pink hair, blue eyes, simple background`;
const NEG = `worst quality, low quality, blurry, jpeg artifacts, text, watermark, bad anatomy, bad hands, extra fingers`;

const NOTE_MANUAL = `银月 2.9B · 专用工作流（全新搭建）
──────────────────────────
【为什么节点菜单里找不到"新插件"】
ComfyUI-Anima-LoRA-ControlNet-Patch 不新增任何节点
（它的 NODE_CLASS_MAPPINGS 就是空的）。
它是加载期 monkeypatch：装好 + 重启就自动生效，
节点菜单里永远看不到它，也不需要任何新节点。
确认它在工作，只看 ComfyUI 控制台：
  [Anima LoRA/ControlNet Patch] LoRA remap installed (...)
应用 LoRA 时每次还会打一行：
  28-block LoRA on 40-block Anima host: remapped N target keys

【这份是给「手工调试」用的，不是程序用】
邻舍程序请指向「银月2.9B-程序用（无LoRA节点）.json」。
本文件自带 LoRA 节点，程序若指向它会在前面再串一份 → 双 LoRA。
【这份是从零搭的，不是改邻舍那份】
邻舍作者的「本地邻舍（银月16）.json」是给他那个 2B 模型做的，
负面词、采样器、分辨率、画师串全是针对 2B 调的。
本文件照 ComfyUI 官方模板 image_anima_base_v1 的骨架重连，
参数按银月模型卡取，不继承邻舍那套假设。

【参数依据】
Sampler  euler_ancestral   ← 官方模板是 euler/simple；
                              银月卡写 Euler a，取 ancestral 更贴
Steps    16                ← 官方 30 / 银月卡 20–28。
                              但 24 步这张分辨率要 100s，16 步是平衡点
CFG      3                 ← 官方 4 / 银月卡 2.9B 用 3
分辨率   832×1216          ← 竖构图，6GB 显存下比 1024² 稳
批量     1

【LoRA 可以叠多个】
这里挂了两个（0.6 / 0.45）演示叠加：UNET → Lora1 → Lora2 → KSampler。
要单个就删掉一个节点；要更多就继续串 LoraLoaderModelOnly。
连到 KSampler 的 model 那根线必须最末端。
⚠ remap 后行为不等同原底模，建议 0.5–0.7；0.9 容易过曝发糊。

【画风怎么控】
银月是「中性画风」底模，靠 @画师名 定风格。
必须带 @，不带效果极弱。例：@DOM

【想要清透感】
把负面词节点清空 —— 作者示例图都没用负面词。

【要更快】
银月有官方 Turbo 版底模（v2329BTurbo），换它 + 8~12 步 + CFG 1。`;

const NOTE_PROGRAM = `银月 2.9B · 邻舍程序用（无 LoRA 节点）
──────────────────────────
【这份是给程序用的，别手工拿去调】
LoRA 一律由邻舍「设置 → 生图 → 全局 LoRA」控制，
可以勾选多个，程序会自动串成
  UNETLoader → lora1 → lora2 → ... → KSampler

工作流里故意一个 LoRA 节点都不放：
injectLoraNodes() 是往 UNETLoader 后面插的，
这里若已有 LoRA，它会接在前面 → "程序的 + 工作流的"双份，画风失控。

【为什么节点菜单里找不到"新插件"】
ComfyUI-Anima-LoRA-ControlNet-Patch 不新增任何节点
（它的 NODE_CLASS_MAPPINGS 就是空的）。
它是加载期 monkeypatch，装好 + 重启就生效，菜单里永远看不到。
确认方式只有 ComfyUI 控制台：
  [Anima LoRA/ControlNet Patch] LoRA remap installed (...)
应用 LoRA 时每次打一行：
  28-block LoRA on 40-block Anima host: remapped N target keys

【参数依据】
Sampler  euler_ancestral   ← 官方模板 euler/simple；银月卡写 Euler a
Steps    16                ← 官方 30 / 银月卡 20–28，但 24 步要 100s
CFG      3                 ← 官方 4 / 银月卡 2.9B 用 3
分辨率   832×1216          ← 竖构图，6GB 显存下比 1024² 稳

【要更快】
换官方 Turbo 底模（v2329BTurbo）+ 8~12 步 + CFG 1。`;

const NOTE = forProgram ? NOTE_PROGRAM : NOTE_MANUAL;

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
    id, type, pos, size,
    flags: {}, order: nodes.length, mode: 0,
    inputs, outputs,
    properties: { 'Node name for S&R': type },
    widgets_values: widgets,
    ...extra,
  };
  nodes.push(n);
  return n;
}

const widgetSlot = (name, type) => ({ localized_name: name, name, type, widget: { name }, link: null });

// ---------------------------------------------------------------- 加载器
const unet = node(1, 'UNETLoader', [-1400, -620], [320, 130], [widgetSlot('unet_name', 'COMBO'), widgetSlot('weight_dtype', 'COMBO')],
  [{ localized_name: 'MODEL', name: 'MODEL', type: 'MODEL', slot_index: 0, links: [] }],
  [UNET, 'default']);

const clipLoader = node(2, 'CLIPLoader', [-1400, -440], [320, 150],
  [widgetSlot('clip_name', 'COMBO'), widgetSlot('type', 'COMBO'), widgetSlot('device', 'COMBO')],
  [{ localized_name: 'CLIP', name: 'CLIP', type: 'CLIP', slot_index: 0, links: [] }],
  // 官方模板用 stable_diffusion。查过 comfy/sd.py：TE 是按 te_model 检测分发的，
  // 检测到 Qwen3-0.6B 就直接走 anima 的 TE，clip_type 根本不参与 —— 写哪个都等价。
  [TE, 'stable_diffusion', 'default']);

const vaeLoader = node(3, 'VAELoader', [-1400, -240], [320, 100],
  [widgetSlot('vae_name', 'COMBO')],
  [{ localized_name: 'VAE', name: 'VAE', type: 'VAE', slot_index: 0, links: [] }],
  [VAE]);

// ---------------------------------------------------------------- LoRA 链
// 手工版：两个 LoRA 串在链上，自己调权重。
// 程序版：一个 LoRA 节点都不放 —— 邻舍的 injectLoraNodes() 会往 UNETLoader 后面插，
//         工作流里若已有 LoRA，它会接在前面，变成"程序的 + 工作流的"双份。
const loraOut = () => [{ localized_name: '模型', name: 'MODEL', type: 'MODEL', slot_index: 0, links: [] }];

let lora1 = null, lora2 = null;
if (!forProgram) {
  lora1 = node(4, 'LoraLoaderModelOnly', [-1000, -620], [320, 100],
    [{ localized_name: '模型', name: 'model', type: 'MODEL', link: null },
     widgetSlot('lora_name', 'COMBO'), widgetSlot('strength_model', 'FLOAT')],
    loraOut(), [LORA1, 0.6], { title: 'lora1 · 主画风' });

  lora2 = node(5, 'LoraLoaderModelOnly', [-620, -620], [320, 100],
    [{ localized_name: '模型', name: 'model', type: 'MODEL', link: null },
     widgetSlot('lora_name', 'COMBO'), widgetSlot('strength_model', 'FLOAT')],
    loraOut(), [LORA2, 0.45], { title: 'lora2 · 叠加示例' });
}

// ---------------------------------------------------------------- 提示词
const posEnc = node(6, 'CLIPTextEncode', [-1000, -440], [420, 200],
  [{ localized_name: 'clip', name: 'clip', type: 'CLIP', link: null },
   { localized_name: '文本', name: 'text', type: 'STRING', widget: { name: 'text' }, link: null }],
  [{ localized_name: '条件', name: 'CONDITIONING', type: 'CONDITIONING', slot_index: 0, links: [] }],
  [POS], { title: '正面提示词' });

const negEnc = node(7, 'CLIPTextEncode', [-1000, -180], [420, 160],
  [{ localized_name: 'clip', name: 'clip', type: 'CLIP', link: null },
   { localized_name: '文本', name: 'text', type: 'STRING', widget: { name: 'text' }, link: null }],
  [{ localized_name: '条件', name: 'CONDITIONING', type: 'CONDITIONING', slot_index: 0, links: [] }],
  [NEG], { title: '负面提示词（想要清透感就清空）' });

// ---------------------------------------------------------------- 采样
const latent = node(8, 'EmptyLatentImage', [-260, -180], [320, 130],
  [widgetSlot('width', 'INT'), widgetSlot('height', 'INT'), widgetSlot('batch_size', 'INT')],
  [{ localized_name: 'LATENT', name: 'LATENT', type: 'LATENT', slot_index: 0, links: [] }],
  [W, H, 1]);

const ks = node(9, 'KSampler', [-260, -620], [320, 270], [
  { localized_name: '模型', name: 'model', type: 'MODEL', link: null },
  { localized_name: '正面条件', name: 'positive', type: 'CONDITIONING', link: null },
  { localized_name: '负面条件', name: 'negative', type: 'CONDITIONING', link: null },
  { localized_name: 'Latent图像', name: 'latent_image', type: 'LATENT', link: null },
  widgetSlot('seed', 'INT'), widgetSlot('steps', 'INT'), widgetSlot('cfg', 'FLOAT'),
  widgetSlot('sampler_name', 'COMBO'), widgetSlot('scheduler', 'COMBO'), widgetSlot('denoise', 'FLOAT'),
], [{ localized_name: 'LATENT', name: 'LATENT', type: 'LATENT', slot_index: 0, links: [] }],
  [SEED, 'randomize', STEPS, 3, 'euler_ancestral', 'normal', 1]);

const decode = node(10, 'VAEDecode', [140, -620], [220, 60],
  [{ localized_name: '采样器', name: 'samples', type: 'LATENT', link: null },
   { localized_name: 'VAE', name: 'vae', type: 'VAE', link: null }],
  [{ localized_name: '图像', name: 'IMAGE', type: 'IMAGE', slot_index: 0, links: [] }], []);

const save = node(11, 'SaveImage', [420, -620], [420, 460],
  // ⚠ widget 也必须在 inputs 里有对应 slot：guiToApi 是照着 inputs 找 widget 的，
  //   不是按 widgets_values 的顺序猜。漏了会报 `[SaveImage] filename_prefix`
  [{ localized_name: '图像', name: 'images', type: 'IMAGE', link: null },
   widgetSlot('filename_prefix', 'STRING')],
  [], ['银月']);

const note = node(12, 'Note', [-1400, -1450], [560, 640], [], [], [NOTE],
  { color: '#432', bgcolor: '#653' });

// ---------------------------------------------------------------- 连线
mkLink(unet, 0, lora1 ?? ks, 0, 'MODEL');   // 程序版：UNET 直连 KSampler
if (!forProgram) {
  mkLink(lora1, 0, lora2, 0, 'MODEL');      // lora1 → lora2
  mkLink(lora2, 0, ks, 0, 'MODEL');         // lora2 → KSampler.model
}
mkLink(clipLoader, 0, posEnc, 0, 'CLIP');
mkLink(clipLoader, 0, negEnc, 0, 'CLIP');
mkLink(posEnc, 0, ks, 1, 'CONDITIONING');
mkLink(negEnc, 0, ks, 2, 'CONDITIONING');
mkLink(latent, 0, ks, 3, 'LATENT');
mkLink(ks, 0, decode, 0, 'LATENT');
mkLink(vaeLoader, 0, decode, 1, 'VAE');
mkLink(decode, 0, save, 0, 'IMAGE');

// ---------------------------------------------------------------- 组装
const wf = {
  id: 'b7e4c2d1-3a8f-4e6b-9c05-7d21f8a6b3e2',
  revision: 0,
  last_node_id: Math.max(...nodes.map(n => n.id)),
  last_link_id: linkId,
  nodes,
  links,
  groups: [],
  config: {},
  extra: { ds: { scale: 0.72, offset: [1500, 1100] } },
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
    if (type === 'MODEL' && d.inputs[toSlot].type !== 'MODEL') throw new Error(`link ${id} 类型不符`);
  }
  // KSampler.model 必须来自 lora2
  const ksModelLink = linkById.get(ks.inputs[0].link);
  const expectSrc = forProgram ? unet.id : lora2.id;
  if (ksModelLink[1] !== expectSrc) throw new Error(`KSampler.model 应来自 #${expectSrc}，实际 #${ksModelLink[1]}`);
  if (forProgram && nodes.some(n => n.type === 'LoraLoaderModelOnly')) throw new Error('程序版不该有 LoRA 节点');
  if (!forProgram && !nodes.some(n => n.type === 'LoraLoaderModelOnly')) throw new Error('手工版缺少 LoRA 节点');
  console.log('自检通过：');
  console.log(`  节点 ${nodes.length}，连线 ${links.length}`);
  console.log(forProgram
    ? `  链路 UNET#${unet.id} → KSampler#${ks.id}（无 LoRA 节点，等 injectLoraNodes 注入）`
    : `  链路 UNET#${unet.id} → lora1#${lora1.id}(${lora1.widgets_values[1]}) → lora2#${lora2.id}(${lora2.widgets_values[1]}) → KSampler#${ks.id}`);
  console.log(`  KSampler: steps=${ks.widgets_values[2]} cfg=${ks.widgets_values[3]} ${ks.widgets_values[4]}/${ks.widgets_values[5]}`);
  console.log(`  分辨率 ${W}×${H}`);
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
