/**
 * 生图配置生效性探针（2026-10-23 建，配合「全链路体检」用）
 *
 * 目的：不跑图，只回答三个问题
 *   ① 全局 LoRA 的 scenes 白名单对每个场景值放行了几个
 *   ② buildWorkflow 实际往工作流里塞了几个 LoRA 节点、权重是多少
 *   ③ 各链路传的 scene / promptScene 值，在白名单里能不能命中
 *
 * 用法：node scripts/probe-lora-inject.mjs
 *   ⚠ 必须让配置从库里加载出来，否则读到的是 config.js 的默认值（全局 LoRA 空、工作流是默认那个）。
 *   建议先复制真实库再指过去，别让探针碰生产库：
 *     cp data/agent.db /tmp/probe.db && DB_PATH=/tmp/probe.db node scripts/probe-lora-inject.mjs
 */
import { getDb } from '../src/db/index.js';

// 先把库打开，settings 才会被灌进 config；config 必须在之后取
getDb();
const { buildWorkflow, filterGlobalLoras } = await import('../src/services/imageSkill.js');
const { config } = await import('../src/config.js');

const g = config.comfyui.globalLora || [];

console.log('=== ① 全局 LoRA 原始配置 ===');
if (g.length === 0) console.log('  (空)');
for (const l of g) {
  console.log(`  ${l.path}`);
  console.log(`     weight=${l.weight}  enabled=${l.enabled}  triggerWord=${JSON.stringify(l.triggerWord)}`);
  console.log(`     scenes=${JSON.stringify(l.scenes)}  ${Array.isArray(l.scenes) && l.scenes.length === 0 ? '(空数组=全场景)' : ''}`);
}

// 这些是所有链路实际会传的场景值（含两个"不在官方注释列表里"的 avatar / standing）
const SCENES = [
  undefined, '', 'chat', 'group', 'portrait', 'moments', 'events',
  'schedule', 'mailbox', 'sticker', 'avatar', 'standing', 'media', 'paper', 'item',
];

console.log('\n=== ② filterGlobalLoras 各场景放行数 ===');
for (const sc of SCENES) {
  const r = filterGlobalLoras(g, sc);
  const label = sc === undefined ? '(undefined)' : sc === '' ? "(空串)" : sc;
  console.log(`  scene=${String(label).padEnd(12)} → ${r.length} 个${r.length ? '：' + r.map(x => x.path.slice(0, 24)).join(', ') : ''}`);
}

console.log('\n=== ③ buildWorkflow 实测 ===');
// 头像的真实调用方式：只传 promptScene，不传 scene（见 routes/characters.js generate-avatar）
// generateImageRaw 的 opts 里压根没有 scene 字段，所以 buildWorkflow 收到的是 undefined
for (const [name, ov] of [
  ['头像（现状：无 scene）', { width: 768, height: 768 }],
  ['头像（若显式传 scene=avatar）', { width: 768, height: 768, scene: 'avatar' }],
  ['朋友圈（scene=moments）', { width: 1600, height: 1200, scene: 'moments' }],
  ['立绘（scene=portrait）', { width: 768, height: 1536, scene: 'portrait' }],
]) {
  const { wf, wfPath } = buildWorkflow('1girl, probe', ov);
  const nodes = (wf.nodes || []).filter(n => String(n.type).includes('Lora') && n.type !== 'LoraLoader');
  const real = (wf.nodes || []).filter(n => String(n.type).startsWith('LoraLoader'));
  console.log(`\n  [${name}]`);
  console.log(`    工作流: ${wfPath.split(/[\\/]/).pop()}`);
  console.log(`    LoRA 节点: ${real.length} 个`);
  for (const n of real) {
    // LoraLoaderModelOnly 的 widget 顺序是 [lora_name, strength_model]
    const v = n.widgets_values || [];
    console.log(`      ${n.type}  lora=${String(v[0] || '')}  strength=${v[1]}`);
  }
  if (nodes.length && real.length === 0) {
    console.log(`      ⚠ 有 ${nodes.length} 个含 "Lora" 字样的节点但不是 LoraLoader*：`, nodes.map(n => n.type).join(', '));
  }
}
