/**
 * LoRA 拓扑探针（2026-10-23，用户报「挂了 LoRA 但图没水印」）
 *
 * 前面的探针只看"有没有 LoraLoader 节点"，**没看它有没有接进采样链路**。
 * 本探针走完整链路：buildWorkflow → guiToApi → 打印 API 格式里
 *   · 有哪些 LoraLoader 节点、权重多少
 *   · KSampler 的 model 输入最终指向谁（必须是最后一个 lora 节点）
 *   · 链条上有没有断点
 *
 * 用法：node scripts/probe-lora-topology.mjs
 */
import { getDb } from '../src/db/index.js';

getDb();
const { buildWorkflow } = await import('../src/services/imageSkill.js');
const { guiToApi } = await import('../src/services/comfyClient.js');
const { config } = await import('../src/config.js');

console.log('=== 全局 LoRA 配置 ===');
for (const l of config.comfyui.globalLora || []) {
  console.log(`  ${l.path}  weight=${l.weight}  enabled=${l.enabled}`);
}

const { wf, wfPath } = buildWorkflow('1girl, solo, test', { scene: 'avatar', width: 768, height: 768 });
console.log(`\n=== GUI 节点（工作流 ${wfPath.split(/[\\/]/).pop()}）===`);
const guiLoras = wf.nodes.filter(n => String(n.type).startsWith('LoraLoader'));
console.log(`  LoraLoader 节点：${guiLoras.length}`);
for (const n of guiLoras) console.log(`    #${n.id} ${n.type} ${JSON.stringify(n.widgets_values)}`);

const api = guiToApi(wf);
console.log('\n=== API 格式（真正提交给 ComfyUI 的）===');
const apiLoras = Object.entries(api).filter(([, v]) => String(v.class_type || '').startsWith('LoraLoader'));
console.log(`  LoraLoader 节点：${apiLoras.length}`);
for (const [id, v] of apiLoras) {
  console.log(`    #${id} ${v.class_type} lora_name=${v.inputs?.lora_name} strength=${v.inputs?.strength_model} model←${JSON.stringify(v.inputs?.model)}`);
}

// 找 KSampler，看它从谁拿 model
const ks = Object.entries(api).find(([, v]) => v.class_type === 'KSampler');
if (!ks) {
  console.log('\n✗ API 里没有 KSampler');
} else {
  console.log(`\n=== KSampler #${ks[0]} ===`);
  console.log('  model ←', JSON.stringify(ks[1].inputs?.model));
  // 顺着 model 输入往回走
  let cur = ks[1].inputs?.model;
  const chain = [];
  let guard = 0;
  while (Array.isArray(cur) && guard++ < 12) {
    const [srcId, slot] = cur;
    const node = api[srcId];
    chain.push(`#${srcId} ${node?.class_type || '?'}`);
    if (!node) break;
    cur = node.inputs?.model;
  }
  console.log('  model 链（从采样器往回）：', chain.join(' → '));
  const hasLora = chain.some(c => c.includes('LoraLoader'));
  console.log(hasLora ? '  ✅ 链路上有 LoRA 节点' : '  ❌ 链路上没有 LoRA 节点 —— 这就是"挂了但没效果"的原因');
}
