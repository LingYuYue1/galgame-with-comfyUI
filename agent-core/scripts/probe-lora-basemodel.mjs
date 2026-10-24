/**
 * 换底模验证 LoRA 风格是否回来（2026-10-23）
 *
 * 现象：silvermoonmix 底模下，换三个不同 LoRA 画风几乎不变，只有细节（衣服长度/胸型/发量）变。
 * 怀疑：mix 底模削弱了外来 LoRA 的风格注入。
 * 验证：同一 LoRA 换到 anima_turboV10 底模（加速12 工作流）上，画风是否明显改变。
 *
 * 用法：node scripts/probe-lora-basemodel.mjs <工作流文件> <LoRA文件|none> [权重]
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

const [wfFile = '本地邻舍（加速12）.json', loraFile = 'none', weightArg = '0.7'] =
  process.argv.slice(2);

const backup = {
  template: config.workflow.customTemplate,
  lora: JSON.parse(JSON.stringify(config.comfyui.globalLora || [])),
};

async function shoot(tag, withLora) {
  config.workflow.customTemplate = wfFile;
  config.comfyui.globalLora = withLora
    ? [{ path: loraFile, weight: Number(weightArg), triggerWord: '', enabled: true, scenes: [] }]
    : [];
  const { wf } = buildWorkflow(PROMPT, { scene: 'avatar', width: 768, height: 768 });
  for (const n of wf.nodes || []) {
    if (n.type === 'KSampler' && Array.isArray(n.widgets_values)) {
      n.widgets_values[0] = SEED;
      n.widgets_values[3] = 3;   // 统一 cfg，排除干扰
    }
  }
  console.log(`\n[${tag}] ${wfFile}  ${withLora ? loraFile + '@' + weightArg : '不挂 LoRA'}  cfg=3`);
  const res = await submitWorkflow(wf);
  if (!res.images?.length) throw new Error(`${tag} 出图失败`);
  const url = saveBase64Image('avatargen', `lora_base_${tag}_${SEED}.png`, res.images[0].base64);
  console.log(`[${tag}] 落盘 ${path.resolve('data/images', url.replace(/^\/images\//, ''))}`);
}

try {
  await shoot('off', false);
  if (loraFile !== 'none') await shoot('on', true);
} finally {
  config.workflow.customTemplate = backup.template;
  config.comfyui.globalLora = backup.lora;
}
