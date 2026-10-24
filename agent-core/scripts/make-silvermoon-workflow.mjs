/**
 * 生成「银月 2.9B 手工调试」工作流（2026-10-23）
 *
 * 背景：用户装完 remap 插件后，在 ComfyUI 工作流列表里找不到"新工作流"——
 * 因为程序侧的调参改的是内存里的 config，没有落成可打开的文件。
 * 他要的是**能在 ComfyUI 界面里点开、手动拖节点、改 LoRA** 的那种。
 *
 * 本脚本以 本地邻舍（银月16）.json 为基底，做三件事：
 *   1. 插入 LoraLoaderModelOnly（UNETLoader → LoRA → KSampler），权重 0.6
 *      —— remap 后官方建议从 0.5~0.7 起，0.9 容易过曝
 *   2. KSampler 改作者推荐档：er_sde/beta/16 → euler_ancestral/normal/20
 *      （er_sde 是 Turbo 版配方，银月 2.9B 非 Turbo 该用 Euler a）
 *   3. 加 Note 节点写清用法（@画师名、程序勿指向本文件等）
 *
 * 目标：ComfyUI/user/default/workflows/ 根目录（界面侧栏直接可见）
 *       + workflow/手工调试/ 归档（子目录不进设置页下拉，避免程序误选双 LoRA）
 *
 * 用法：node scripts/make-silvermoon-workflow.mjs [--dry]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'workflow', '本地邻舍（银月16）.json');
const OUT_NAME = '银月2.9B-手工调试（含LoRA）.json';

const COMFY_WF_DIR = 'D:/【新手二选一】带Anima-base（出图质量高）的秋叶整合包【记得内核升级到0.23】/ComfyUI-aki-v3/ComfyUI/user/default/workflows';
const ARCHIVE_DIR = path.join(ROOT, 'workflow', '手工调试');

const dry = process.argv.includes('--dry');

const NOTE_TEXT = `银月 2.9B · 手工调试版
─────────────────────
【程序请勿指向本文件】
邻舍程序跑图用「本地邻舍（银月16）.json」。
本文件自带 LoRA 节点，程序若指向它会变成双 LoRA。

【LoRA 现在真能用了】
已装 ComfyUI-Anima-LoRA-ControlNet-Patch：
2B 的 28 块 LoRA 会自动映射到 2.9B 的 40 块。
生效标志（ComfyUI 控制台）：
  remapped N target keys (up)

【参数 = 作者官方推荐】
Sampler  Euler a    （er_sde 是 Turbo 版配方，别用）
CFG      3
Steps    20         （官方 20–28；16 也够用，省显存）

【画风怎么控】
这个底模是「中性画风」，靠 @画师名 定风格。
必须带 @，不带效果极弱。例：@DOM

【LoRA 强度】
remap 之后行为不等同原底模，建议 0.5–0.7。
0.9 容易过曝、发糊。

【想要清透感】
把负面词节点清空 —— 作者示例图都没用负面词。

【改了默认提示词】
原工作流画师串默认是 @ebora（成人向画师），
配上空描述会自由发挥出不受控的画面。
已换成中性示例（#121 白衬衫立绘），画师串留空。
要用自己的风格就往 #119 填，记得带 @。`;

const wf = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// ---------- 1. 参数：KSampler ----------
const ks = wf.nodes.find(n => n.id === 63);
if (!ks) throw new Error('找不到 KSampler #63');
const before = { steps: ks.widgets_values[2], cfg: ks.widgets_values[3], sampler: ks.widgets_values[4], sched: ks.widgets_values[5] };
ks.widgets_values[2] = 20;                 // steps
ks.widgets_values[3] = 3;                  // cfg
ks.widgets_values[4] = 'euler_ancestral';  // sampler
ks.widgets_values[5] = 'normal';           // scheduler

// ---------- 2. 插入 LoraLoaderModelOnly ----------
const LINK_UNET_TO_KS = wf.links.find(l => l[1] === 44 && l[3] === 63 && l[5] === 'MODEL');
if (!LINK_UNET_TO_KS) throw new Error('找不到 UNETLoader → KSampler 的 MODEL 连线（预期不存在时说明工作流已含 LoRA 节点）');

const LORA_ID = 129;
const NOTE_ID = 130;
const LINK_IN = LINK_UNET_TO_KS[0];       // 原 217：44 → 63
const LINK_OUT = 221;                     // 新：129 → 63

// 原连线改为 44 → 129
LINK_UNET_TO_KS[3] = LORA_ID;
LINK_UNET_TO_KS[4] = 0;
// 新增 129 → 63
wf.links.push([LINK_OUT, LORA_ID, 0, 63, 0, 'MODEL']);

const unet = wf.nodes.find(n => n.id === 44);
unet.outputs[0].links = [LINK_IN];

ks.inputs.find(i => i.name === 'model').link = LINK_OUT;

wf.nodes.push({
  id: LORA_ID,
  type: 'LoraLoaderModelOnly',
  pos: [-2380, -880],
  size: [315, 82],
  flags: {},
  order: 0,
  mode: 0,
  inputs: [{ label: '模型', localized_name: '模型', name: 'model', type: 'MODEL', link: LINK_IN }],
  outputs: [{ label: '模型', localized_name: '模型', name: 'MODEL', type: 'MODEL', links: [LINK_OUT], slot_index: 0 }],
  properties: { 'Node name for S&R': 'LoraLoaderModelOnly' },
  // 默认挂当前在用的那个；界面下拉可直接换
  widgets_values: ['邻舍画风dim23_V5_epoch18.safetensors', 0.6],
});

// ---------- 3. 默认提示词改成中性示例 ----------
// 原值：119("#119 画师串")="@ebora"（成人向画师）、121/128 = 空。
// 画师串 + 空描述的结果是模型完全自由发挥，实测会出不可控内容。
// 换成「空画师串 + 一句安全的基础描述」，打开就能出一张正常立绘。
const pstr = (id) => wf.nodes.find(n => n.id === id);
pstr(119).widgets_values = [''];                                               // 画师串留空，用户自己填（必须带 @）
pstr(121).widgets_values = ['1girl, solo, standing, white shirt, black skirt, long hair, simple background'];
pstr(128).widgets_values = [''];

// ---------- 4. Note 节点 ----------
wf.nodes.push({
  id: NOTE_ID,
  type: 'Note',
  // 放输出节点右侧的空白区：靠近 KSampler/PreviewImage，打开就能看见，
  // 又不会压在原有节点上（不加 --fit-view 也能第一眼找到）
  pos: [-120, -1120],
  size: [430, 470],
  flags: {},
  order: 1,
  mode: 0,
  inputs: [],
  outputs: [],
  properties: { text: '' },
  widgets_values: [NOTE_TEXT],
  color: '#432',
  bgcolor: '#653',
});

// ---------- 5. 收尾 ----------
wf.last_node_id = NOTE_ID;
wf.last_link_id = LINK_OUT;
wf.id = 'c1f0a2e8-7b34-4d19-9a6e-2f5c8b0d7a41'; // 换 UUID，避免与基底被认成同一份
wf.extra = wf.extra || {};
// 视图保持原样：ds 的 offset 语义未经验证，乱改会让用户打开后看不到主体。
// 靠"Note 放在输出节点右侧"来保证第一眼可见，比猜缩放靠谱。
// wf.extra.ds 沿用基底的取值，不覆盖。

// ---------- 自检 ----------
const ids = new Set(wf.nodes.map(n => n.id));
if (ids.size !== wf.nodes.length) throw new Error('节点 id 重复');
const linkIds = wf.links.map(l => l[0]);
if (new Set(linkIds).size !== linkIds.length) throw new Error('连线 id 重复');
// 每条 link 的 target slot 必须真的指向它
const ksModelInput = ks.inputs.find(i => i.name === 'model');
if (ksModelInput.link !== LINK_OUT) throw new Error('KSampler.model 未指向 LoRA');
if (!wf.links.some(l => l[0] === LINK_IN && l[3] === LORA_ID)) throw new Error('UNET 未接到 LoRA');

const out = JSON.stringify(wf, null, 2);

console.log('参数变更：');
console.log(`  steps   ${before.steps} → 20`);
console.log(`  sampler ${before.sampler} → euler_ancestral`);
console.log(`  sched   ${before.sched} → normal`);
console.log(`  cfg    ${before.cfg} → 3`);
console.log(`新增节点：LoraLoaderModelOnly #${LORA_ID}（0.6）、Note #${NOTE_ID}`);
console.log(`连线：44 → #${LORA_ID} → 63`);
console.log('提示词：画师串 #119 "@ebora" → 空；#121 空 → 中性立绘示例');

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
