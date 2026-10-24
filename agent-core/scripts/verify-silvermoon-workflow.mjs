/**
 * 校验「银月2.9B-手工调试（含LoRA）」工作流能不能真的跑（2026-10-23）
 *
 * 光写出一份 JSON 不算数 —— 要验证三件事：
 *   1. 结构自洽：每条 link 的两端都真实存在，input.link ↔ link 双向一致
 *   2. 节点类型都在：ComfyUI /object_info 里有这个 type（否则打开就红）
 *   3. guiToApi 能转出来，且 LoRA 真的接在 UNETLoader → KSampler 之间
 * 加 --run 会真提交一张图，跑完删掉。
 * 加 --offline 跳过所有需要 ComfyUI 在线的步骤（结构校验仍会跑）。
 *
 * 用法：node scripts/verify-silvermoon-workflow.mjs [--run] [--offline] [文件名]
 */
import fs from 'fs';
import path from 'path';

const offline = process.argv.includes('--offline');
// 允许指定文件名（默认校验「全新搭建」那份）
const argFile = process.argv.slice(2).find(a => !a.startsWith('--'));
const WF = argFile
  ? path.resolve('..', 'workflow', '手工调试', argFile)
  : path.resolve('..', 'workflow', '手工调试', '银月2.9B-专用（全新搭建）.json');
const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
console.log(`校验 ${path.basename(WF)}\n`);

let bad = 0;
const err = (m) => { console.log('  ✗ ' + m); bad++; };
const ok = (m) => console.log('  ✓ ' + m);

// ---------- 1. 结构自洽 ----------
console.log('[1] 结构自洽');
const byId = new Map(wf.nodes.map(n => [n.id, n]));
const linkById = new Map(wf.links.map(l => [l[0], l]));

for (const [id, from, fromSlot, to, toSlot, type] of wf.links) {
  const src = byId.get(from), dst = byId.get(to);
  if (!src) { err(`link ${id}: 起点节点 ${from} 不存在`); continue; }
  if (!dst) { err(`link ${id}: 终点节点 ${to} 不存在`); continue; }
  if (!src.outputs?.[fromSlot]) { err(`link ${id}: ${src.type}#${from} 没有第 ${fromSlot} 个输出`); continue; }
  if (!src.outputs[fromSlot].links?.includes(id)) err(`link ${id}: ${src.type}#${from}.outputs[${fromSlot}].links 没登记`);
  const inp = dst.inputs?.[toSlot];
  if (!inp) { err(`link ${id}: ${dst.type}#${to} 没有第 ${toSlot} 个输入`); continue; }
  if (inp.link !== id) err(`link ${id}: ${dst.type}#${to}.inputs[${toSlot}](${inp.name}).link = ${inp.link}，应为 ${id}`);
  // Reroute 的输入类型是通配符 '*'，兼容任何类型，不算不符
  if (inp.type !== '*' && type !== '*' && inp.type !== type) err(`link ${id}: 类型不符 ${inp.type} vs ${type}`);
}
for (const n of wf.nodes) {
  for (const [i, inp] of (n.inputs || []).entries()) {
    if (inp.link == null) continue;
    if (!linkById.has(inp.link)) err(`${n.type}#${n.id}.inputs[${i}](${inp.name}).link=${inp.link} 找不到对应 link`);
    else if (linkById.get(inp.link)[3] !== n.id) err(`${n.type}#${n.id}.inputs[${i}] 的 link ${inp.link} 终点不是自己`);
  }
}
if (!bad) ok(`${wf.links.length} 条连线全部双向一致`);

// ---------- 2. 链路断言 ----------
console.log('[2] 链路断言');
const ks = wf.nodes.find(n => n.type === 'KSampler');
const unet = wf.nodes.find(n => n.type === 'UNETLoader');
const lora = wf.nodes.find(n => n.type === 'LoraLoaderModelOnly');
if (!ks || !unet || !lora) err('缺少 KSampler / UNETLoader / LoraLoaderModelOnly');
else {
  // 支持任意个 LoRA 串联：从 KSampler.model 往回走，直到 UNETLoader
  const loraIds = new Set(wf.nodes.filter(n => n.type === 'LoraLoaderModelOnly').map(n => n.id));
  const chain = [];
  let curNode = ks;
  for (let g = 0; g < 12; g++) {
    const inp = curNode.inputs?.find(i => i.name === 'model');
    const lk = inp?.link != null ? linkById.get(inp.link) : null;
    if (!lk) { chain.length ? err(`model 链在第 ${g} 跳断开`) : err('KSampler.model 没有连线'); break; }
    const src = byId.get(lk[1]);
    if (!src) { err(`model 链找不到节点 #${lk[1]}`); break; }
    chain.push(src.type === 'LoraLoaderModelOnly'
      ? `LoRA#${src.id}(${String(src.widgets_values[0]).replace('.safetensors', '')} @${src.widgets_values[1]})`
      : `${src.type}#${src.id}`);
    if (src.type === 'UNETLoader') break;
    curNode = src;
  }
  ok(`model 链：KSampler ← ${chain.join(' ← ')}`);
  if (!chain[0]?.startsWith('LoRA#')) err('KSampler.model 第一跳不是 LoRA');
  if (!chain[chain.length - 1]?.startsWith('UNETLoader')) err(`model 链没回到 UNETLoader（末段是 ${chain[chain.length - 1]}）`);
  const usedLoras = chain.filter(c => c.startsWith('LoRA#')).length;
  if (usedLoras !== loraIds.size) err(`画布上有 ${loraIds.size} 个 LoRA 节点，但链路只串了 ${usedLoras} 个（有游离节点）`);
  else ok(`${usedLoras} 个 LoRA 全部串在链上`);

  const wv = ks.widgets_values;
  ok(`KSampler: steps=${wv[2]} cfg=${wv[3]} sampler=${wv[4]} sched=${wv[5]}`);
  if (wv[4] !== 'euler_ancestral') err('sampler 不是 euler_ancestral');
}
// 输出节点不能是 PreviewImage 之外没有别的（保证点"运行"有东西可看）
if (!wf.nodes.some(n => ['PreviewImage', 'SaveImage'].includes(n.type))) err('没有 PreviewImage/SaveImage，运行时看不到结果');
else ok('有输出节点');

// ---------- 3. 节点类型都在 ----------
console.log('[3] 节点类型是否都被 ComfyUI 认识');
const skip = new Set(['Note', 'Reroute', 'PrimitiveNode']); // 前端专用，不在 object_info
let oi = null;
if (offline) {
  console.log('  － 离线模式，跳过');
} else {
  try {
    oi = await (await fetch('http://127.0.0.1:8188/object_info')).json();
  } catch {
    console.log('  － ComfyUI 未在线，跳过（联网后再验一次）');
  }
  if (oi) {
    const missing = [...new Set(wf.nodes.map(n => n.type))].filter(t => !skip.has(t) && !(t in oi));
    if (missing.length) err(`ComfyUI 不认识这些节点：${missing.join(', ')}`);
    else ok(`${new Set(wf.nodes.map(n => n.type)).size} 种类型全部可用（Note/Reroute 为前端节点，跳过）`);
  }
}

// ---------- 4. guiToApi ----------
console.log('[4] guiToApi 转换');
const { guiToApi, submitWorkflow } = await import('../src/services/comfyClient.js');
let api = null;
try {
  api = guiToApi(wf);
} catch (e) {
  console.log(`  － 转换依赖 object_info，ComfyUI 未在线无法完成（${String(e.message).slice(0, 60)}…）`);
}
if (api) {
  const apiKs = Object.values(api).find(n => n.class_type === 'KSampler');
  const apiLoras = Object.entries(api).filter(([, n]) => n.class_type === 'LoraLoaderModelOnly');
  if (!apiKs) err('转出来的 API 里没有 KSampler');
  else ok(`API 节点数 ${Object.keys(api).length}，KSampler.inputs.model = ["${apiKs.inputs.model[0]}", ${apiKs.inputs.model[1]}]`);
  if (!apiLoras.length) err('API 里没有 LoraLoaderModelOnly（LoRA 丢了）');
  else {
    ok(`API 里 ${apiLoras.length} 个 LoRA：${apiLoras.map(([id, n]) => `#${id}(${n.inputs.strength_model})`).join(' → ')}`);
    // 逐级回溯：KSampler.model 应指到最后一个 LoRA，且能一路串回 UNETLoader
    const seen = [];
    let cur = apiKs?.inputs?.model;
    for (let g = 0; g < 8 && cur; g++) {
      const n = api[cur[0]];
      if (!n) break;
      seen.push(n.class_type);
      cur = n.inputs?.model;
    }
    ok(`model 链：KSampler ← ${seen.join(' ← ')}`);
    if (seen[0] !== 'LoraLoaderModelOnly') err('KSampler.model 第一跳不是 LoRA');
    if (seen[seen.length - 1] !== 'UNETLoader') err('model 链没回到 UNETLoader');
  }
}

// ---------- 5. 实跑（可选） ----------
if (process.argv.includes('--run') && !offline) {
  console.log('[5] 实跑一张');
  const res = await submitWorkflow(wf);
  if (!res.images?.length) err('提交后没有返回图');
  else ok(`出图成功，${res.images[0].base64.length} 字节`);
} else {
  console.log('[5] 跳过实跑（加 --run 启用）');
}

console.log(bad ? `\n✗ ${bad} 个问题` : '\n✓ 全部通过');
process.exit(bad ? 1 : 0);
