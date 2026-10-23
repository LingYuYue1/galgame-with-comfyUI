/**
 * 图像生成 Skill
 *
 * 流程:
 *   1. 接收 {"prompt":"..."} 中的中文画面描述
 *   2. 按条件注入参数（画师串/质量提示词/画面描述/宽/高/lora）
 *   3. 提交 ComfyUI → 轮询 → 下载 base64
 *   4. 兜底: 本地 output/bot/ 文件夹
 *
 * Lora 加载方式:
 *   不再使用 Lora Loader (LoraManager) 节点 + <lora:xxx:1> 标签
 *   改为动态注入 ComfyUI 官方 LoraLoaderModelOnly 节点
 *   多个 lora 通过堆叠多个 LoraLoaderModelOnly 节点实现
 *   链路: UNETLoader → Lora1 → Lora2 → ... → KSampler
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { submitWorkflow, apiToGui } from './comfyClient.js';
import { config, getNovelaiApiKey } from '../config.js';
import { generateNovelaiImage } from './novelaiClient.js';
import { acquireSlot, releaseSlot } from './llmConcurrency.js';
import { buildAnchorLines } from './characterAnchor.js';
import { prepareImagePrompt } from './imagePromptPreparer.js';

const _limitEnabled = () => config.features.serializeBackgroundLLM;
import { ACTIVE_WORKFLOW, PRO_WORKFLOW, checkWorkflowHealth, resolveCustomWorkflowPath } from './workflowTemplates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(__dirname, '..', '..', '..', 'workflow');
const BASE_WORKFLOW_PATH = path.join(WORKFLOW_DIR, ACTIVE_WORKFLOW);
const PRO_WORKFLOW_PATH = path.join(WORKFLOW_DIR, PRO_WORKFLOW);

let lastUsedWorkflowMode = (config.workflow?.mode === 'base') ? 'base' : 'turbo';

function pathToMode(wfPath) {
  const name = path.basename(wfPath);
  if (name === PRO_WORKFLOW) return 'base';
  if (name === ACTIVE_WORKFLOW) return 'turbo';
  // 自定义工作流：以文件名本身作为标识，供 image_tasks.workflow_template 记录、HiresFix 继承
  return name;
}

export function getLastWorkflowMode() {
  return lastUsedWorkflowMode;
}

/** Freeze the configurable inputs for a multi-image batch without changing global settings. */
export function captureImageGenerationConfig(scene, workflowScene = null) {
  return {
    customWorkflow: path.basename(resolveWorkflowPath(workflowScene)),
    globalLoraSnapshot: structuredClone(filterGlobalLoras(config.comfyui.globalLora || [], scene)),
    qualityPrompt: config.comfyui.qualityPrompt || '',
    negativePrompt: config.comfyui.negativePrompt || '',
  };
}

export { checkWorkflowHealth };

/**
 * 根据全局模式和场景选择工作流文件
 * @param {'chat'|'group'|'portrait'|'moments'|'events'|'schedule'|'mailbox'|'sticker'} [scene]
 * @returns {string} 工作流文件路径
 */
function resolveWorkflowPath(scene) {
  const mode = config.workflow?.mode || 'turbo';
  if (mode === 'turbo') return BASE_WORKFLOW_PATH;
  if (mode === 'base') return PRO_WORKFLOW_PATH;

  // custom: 全局自定义工作流；文件缺失时回退 turbo，保证生图不中断
  if (mode === 'custom') {
    const custom = resolveCustomWorkflowPath(config.workflow?.customTemplate);
    if (custom) return custom;
    console.warn(`[imageSkill] Custom workflow "${config.workflow?.customTemplate || ''}" not found, falling back to turbo`);
    return BASE_WORKFLOW_PATH;
  }

  // hybrid: 根据场景选择
  if (mode === 'hybrid' && scene) {
    const scenePref = config.workflow.scene?.[scene] || 'turbo';
    return scenePref === 'base' ? PRO_WORKFLOW_PATH : BASE_WORKFLOW_PATH;
  }
  // hybrid + 无 scene: 沿用上一次实际使用的模式
  return lastUsedWorkflowMode === 'base' ? PRO_WORKFLOW_PATH : BASE_WORKFLOW_PATH;
}

const PROMPT_PLACEHOLDER = '请输入画面描述';

// 按节点 title 注入参数（而非硬编码节点 ID）
export const NODE_TITLES = {
  artist: '画师串',
  quality: '质量提示词',
  negative: '负面提示词',
  width:  '图片的宽',
  height: '图片的长',
  prompt: '画面描述',
  loraTrigger: 'lora触发词',
};

/** 顺着 KSampler negative 输入找到源头 CLIPTextEncode 节点（跳过 Reroute），用于无 title 的工作流兜底 */
export function findNegativeEncodeNode(wf) {
  const sampler = wf.nodes.find(n => n.type === 'KSampler' || n.type === 'KSamplerAdvanced');
  if (!sampler) return null;
  const negInp = (sampler.inputs || []).find(i => i.name === 'negative');
  let linkId = negInp?.link;
  for (let hop = 0; linkId != null && hop < 10; hop++) {
    const link = (wf.links || []).find(l => l[0] === linkId);
    if (!link) return null;
    const src = wf.nodes.find(n => n.id === link[1]);
    if (!src) return null;
    if (src.type === 'Reroute') { linkId = src.inputs?.[0]?.link; continue; }
    return src.type === 'CLIPTextEncode' ? src : null;
  }
  return null;
}

async function submitNovelaiImage(promptText, { onProgress } = {}) {
  const novelaiArtist = String(config.comfyui.novelaiArtist || '').trim();
  const qualityPrompt = String(config.comfyui.novelaiQualityPrompt || '').trim();
  const finalPrompt = [qualityPrompt, novelaiArtist, finalizeCountTags(String(promptText || '').trim())]
    .filter(Boolean)
    .join(', ');
  if (!finalPrompt) throw new Error('画面描述为空');
  onProgress?.({ stage: 'submitting' });
  onProgress?.({ phase: 'submitted' });
  onProgress?.({ phase: 'started' });
  const settings = config.comfyui;
  const payload = await generateNovelaiImage(finalPrompt, {
    apiFormat: settings.novelaiApiFormat, url: settings.novelaiUrl,
    apiKey: getNovelaiApiKey(), proxyUrl: settings.novelaiProxyUrl,
    model: settings.novelaiModel, width: settings.novelaiWidth, height: settings.novelaiHeight,
    steps: settings.novelaiSteps, sampler: settings.novelaiSampler,
    noiseSchedule: settings.novelaiNoiseSchedule, scale: settings.novelaiGuidance,
    negativePrompt: settings.novelaiNegativePrompt || '',
  });
  const { images } = payload;
  onProgress?.({ phase: 'executed' });
  onProgress?.({ phase: 'done', imageCount: images.length, progress: 1 });
  return {
    success: true,
    images,
    source: 'novelai',
    promptId: payload.created || `novelai_${Date.now()}`,
    wfMode: 'novelai',
  };
}

/**
 * 按场景过滤全局 LoRA。
 * scenes 缺失或空数组 = 所有场景生效；currentScene 为空 = 不过滤。
 * @param {Array} loras - config.comfyui.globalLora
 * @param {string} [currentScene]
 * @returns {Array} 已归一化 path 的生效 LoRA
 */
export function filterGlobalLoras(loras, currentScene) {
  return (loras || [])
    .map(l => ({ ...l, path: normalizeLoraValue(l.path) }))
    .filter(l => {
      if (!l.path || typeof l.path !== 'string') return false;
      if (l.enabled === false) return false;
      if (!currentScene) return true;
      if (!Array.isArray(l.scenes) || l.scenes.length === 0) return true;
      return l.scenes.includes(currentScene);
    });
}

/**
 * 构建注入参数后的 workflow 副本
 *
 * @param {string}   promptText  - 优化后的画面描述
 * @param {object}   [overrides]
 * @param {string}   [overrides.artist]
 * @param {number}   [overrides.width]
 * @param {number}   [overrides.height]
 * @param {Array}    [overrides.loras]  - [{path, weight, triggerWord}]
 * @param {string}   [overrides.customWorkflow] - 自定义工作流文件名（单人时替代基础工作流）
 * @param {string}   [overrides.scene] - 全局 LoRA 的场景过滤；未指定 workflowScene 时也用于选择工作流
 * @param {string|null} [overrides.workflowScene] - hybrid 模式下单独用于选择工作流；
 *        显式传 null 表示不按场景选择（沿用上次模式），与 scene 解耦
 */
/**
 * 按工作流模板 + 本次覆盖值装配出最终 wf。
 *
 * 对外导出**只为测试**：尺寸/画师串是否真的写进了图（而不是被 title 对不上静默吞掉），
 * 只有在装配结果上才验得出来 —— 见 `test/imageSizeWiring.test.js`。
 */
export function buildWorkflow(promptText, overrides = {}) {
  // 用 undefined 区分"没传"与"显式不按场景选工作流"：后者传 null
  const workflowScene = overrides.workflowScene !== undefined ? overrides.workflowScene : overrides.scene;
  let wfPath = overrides.customWorkflow
    ? (fs.existsSync(path.join(WORKFLOW_DIR, overrides.customWorkflow))
        ? path.join(WORKFLOW_DIR, overrides.customWorkflow)
        : resolveWorkflowPath(workflowScene))
    : resolveWorkflowPath(workflowScene);
  // 全局 LoRA 前置 + 角色 LoRA，按 path 去重（全局优先），关闭的 LoRA 跳过
  const globalLoras = overrides.globalLoraSnapshot ?? filterGlobalLoras(config.comfyui.globalLora || [], overrides.scene);
  const providedLoras = (overrides.loras || [])
    .map(l => ({ ...l, path: normalizeLoraValue(l.path) }))
    .filter(l => l.path && typeof l.path === 'string');
  const seen = new Set();
  const loras = [...globalLoras, ...providedLoras].filter(l => {
    if (seen.has(l.path)) return false;
    seen.add(l.path);
    return true;
  });
  const hasLoras = loras.length > 0;

  if (overrides.customWorkflow) {
    const customPath = path.join(WORKFLOW_DIR, overrides.customWorkflow);
    if (fs.existsSync(customPath)) {
      wfPath = customPath;
      console.log(`[imageSkill] Using custom workflow: ${overrides.customWorkflow}`);
    } else {
      console.warn(`[imageSkill] Custom workflow not found: ${overrides.customWorkflow}, using base workflow`);
    }
  }

  if (!fs.existsSync(wfPath)) {
    throw new Error(`Workflow not found: ${wfPath}`);
  }

  const workflow = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  let wf = apiToGui(workflow);
  if (!Array.isArray(wf.nodes)) {
    throw new Error(`Workflow "${path.basename(wfPath)}" is invalid: missing "nodes" array and could not be parsed as an API-format workflow. Please use ComfyUI's regular "Save" (not "Export (API)") to export the workflow.`);
  }
  wf = JSON.parse(JSON.stringify(wf));

  const defaults = {
    [NODE_TITLES.artist]: overrides.artist ?? config.comfyui.artist,
    [NODE_TITLES.width]:  overrides.width  ?? config.comfyui.width,
    [NODE_TITLES.height]: overrides.height ?? config.comfyui.height,
  };
  // 质量提示词：非空才覆盖工作流节点里的默认值，留空不注入
  const qualityValue = overrides.qualityPrompt ?? config.comfyui.qualityPrompt;
  const qualityPrompt = typeof qualityValue === 'string' ? qualityValue.trim() : '';
  if (qualityPrompt) defaults[NODE_TITLES.quality] = qualityPrompt;
  // 负面提示词：非空才覆盖工作流节点里的默认值，留空不注入
  const negativeValue = overrides.negativePrompt ?? config.comfyui.negativePrompt;
  const negativePrompt = typeof negativeValue === 'string' ? negativeValue.trim() : '';
  if (negativePrompt) defaults[NODE_TITLES.negative] = negativePrompt;

  for (const node of wf.nodes || []) {
    if (!Array.isArray(node.widgets_values)) continue;

    // KSampler seed 随机化
    if (node.type === 'KSampler' && node.widgets_values.length > 1 && node.widgets_values[1] === 'randomize') {
      node.widgets_values[0] = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    }

    // lora触发词节点：注入所有 lora 的 triggerWord 拼接
    if (node.title === NODE_TITLES.loraTrigger && hasLoras) {
      const triggerWords = loras.map(l => l.triggerWord || '').filter(Boolean).join(', ');
      if (triggerWords) {
        node.widgets_values[0] = triggerWords;
      }
      continue;
    }

    // 画面描述节点：替换占位符，无占位符则写入第一个 widget
    if (node.title === NODE_TITLES.prompt) {
      const idx = node.widgets_values.findIndex(
        v => typeof v === 'string' && v.includes(PROMPT_PLACEHOLDER)
      );
      if (idx >= 0) {
        node.widgets_values[idx] = promptText;
      } else if (node.widgets_values.length > 0) {
        node.widgets_values[0] = promptText;
      }
      continue;
    }

    // 画师串 / 宽 / 高 / 质量提示词 / 负面提示词：替换第一个 widget
    const val = defaults[node.title];
    if (val !== undefined && node.widgets_values.length > 0) {
      node.widgets_values[0] = val;
    }
  }

  // 负面提示词兜底：存量工作流文件的负面 CLIPTextEncode 节点没有「负面提示词」title，
  // 顺着 KSampler negative 输入找到它并注入
  if (negativePrompt && !wf.nodes.some(n => n.title === NODE_TITLES.negative)) {
    const negNode = findNegativeEncodeNode(wf);
    if (negNode && Array.isArray(negNode.widgets_values) && negNode.widgets_values.length > 0) {
      negNode.widgets_values[0] = negativePrompt;
    }
  }

  // 动态注入 LoraLoaderModelOnly 节点链
  if (hasLoras) {
    injectLoraNodes(wf, loras);
  }

  console.log(`[imageSkill] Workflow built: ${path.basename(wfPath)} (${pathToMode(wfPath)})${hasLoras ? ` (${loras.length} lora(s))` : ''}`);
  lastUsedWorkflowMode = pathToMode(wfPath);
  return { wf, wfPath, wfMode: lastUsedWorkflowMode };
}

/**
 * 在工作流中动态插入 LoraLoaderModelOnly 节点
 * 链路: UNETLoader → Lora1 → Lora2 → ... → 原始下游节点
 * 自动适配：无论 UNETLoader 直连 KSampler 还是中间有用户插入的节点，都正确链入。
 * （放大细化 imageRefine.js 复用同一注入逻辑）
 */
export function injectLoraNodes(wf, loras) {
  const unetNode = wf.nodes.find(n => n.type === 'UNETLoader');
  const samplerNode = wf.nodes.find(n => n.type === 'KSampler' || n.type === 'UltimateSDUpscaleNoUpscale');

  if (!unetNode || !samplerNode) {
    console.warn('[imageSkill] Cannot inject lora nodes: UNETLoader or KSampler not found in workflow');
    return;
  }

  // 查找 UNETLoader MODEL 输出当前连到的节点
  const unetModelOutput = unetNode.outputs.find(o => o.name === 'MODEL');
  const oldLinkId = unetModelOutput?.links?.[0];

  if (!oldLinkId) {
    console.warn('[imageSkill] Cannot inject lora nodes: no MODEL link from UNETLoader');
    return;
  }

  // 从 links 中定位完整的 link 条目，获取原始下游节点
  const oldLink = wf.links.find(l => l[0] === oldLinkId);
  const downstreamNodeId = oldLink ? oldLink[3] : null;
  const downstreamNode = downstreamNodeId ? wf.nodes.find(n => n.id === downstreamNodeId) : null;

  if (!downstreamNode) {
    console.warn('[imageSkill] Cannot inject lora nodes: downstream node not found for link #' + oldLinkId);
    return;
  }

  const isDirectToSampler = downstreamNodeId === samplerNode.id;
  if (!isDirectToSampler) {
    console.log(`[imageSkill] UNETLoader MODEL has intermediate nodes before ${downstreamNode.type}#${downstreamNodeId}, lora chain will be inserted before them`);
  }

  // 删除 UNETLoader → 下游节点的旧 link
  wf.links = wf.links.filter(l => l[0] !== oldLinkId);

  // 清除下游节点的 model 输入 link
  const downstreamModelInput = downstreamNode.inputs.find(inp => inp.name === 'model');
  if (downstreamModelInput) downstreamModelInput.link = null;

  // 生成新 ID（确保不冲突）
  let maxNodeId = Math.max(wf.last_node_id || 0, ...(wf.nodes || []).map(n => n.id));
  let maxLinkId = Math.max(wf.last_link_id || 0, ...(wf.links || []).map(l => l[0]));

  const loraNodeIds = [];
  const outputLinkIds = [];

  for (let i = 0; i < loras.length; i++) {
    const lora = loras[i];
    const nodeId = ++maxNodeId;
    loraNodeIds.push(nodeId);

    const inputLinkId = ++maxLinkId;
    const outputLinkId = ++maxLinkId;
    outputLinkIds.push(outputLinkId);

    const loraNode = {
      id: nodeId,
      type: 'LoraLoaderModelOnly',
      pos: [-2680 + (i * 360), -960],
      size: [280, 100],
      flags: {},
      order: 14 + i,
      mode: 0,
      inputs: [
        { localized_name: '模型', name: 'model', type: 'MODEL', link: inputLinkId },
        { localized_name: 'LoRA名称', name: 'lora_name', type: 'COMBO', widget: { name: 'lora_name' }, link: null },
        { localized_name: '模型强度', name: 'strength_model', type: 'FLOAT', widget: { name: 'strength_model' }, link: null },
      ],
      outputs: [
        { localized_name: '模型', name: 'MODEL', type: 'MODEL', links: [outputLinkId] },
      ],
      title: `lora${i + 1}`,
      properties: {
        cnr_id: 'comfy-core',
        ver: '0.24.0',
        'Node name for S&R': 'LoraLoaderModelOnly',
      },
      widgets_values: [lora.path, lora.weight ?? 0.6],
    };

    wf.nodes.push(loraNode);

    // 上游来源：UNETLoader(第一个lora) 或 上一个 lora 节点
    const sourceNodeId = i === 0 ? unetNode.id : loraNodeIds[i - 1];
    wf.links.push([inputLinkId, sourceNodeId, 0, nodeId, 0, 'MODEL']);
    // GUI socket 元数据必须与 links 一致，否则导出回 ComfyUI 后 LoRA 链会显示断线。
    if (i === 0) {
      unetModelOutput.links = unetModelOutput.links.map(id => id === oldLinkId ? inputLinkId : id);
    } else {
      wf.nodes.find(n => n.id === sourceNodeId).outputs[0].links = [inputLinkId];
    }
  }

  // 最后一个 lora → 原始下游节点（保留用户中间链路）
  const finalLinkId = outputLinkIds[outputLinkIds.length - 1];
  const finalLoraNodeId = loraNodeIds[loras.length - 1];
  const targetSlot = downstreamNode.inputs.findIndex(inp => inp.name === 'model');

  if (targetSlot >= 0) {
    downstreamNode.inputs[targetSlot].link = finalLinkId;
  }
  wf.links.push([finalLinkId, finalLoraNodeId, 0, downstreamNode.id, targetSlot >= 0 ? targetSlot : 0, 'MODEL']);

  // 更新 workflow 元数据
  wf.last_node_id = maxNodeId;
  wf.last_link_id = maxLinkId;
}

/**
 * 最终阀门：统计 prompt 中所有 "数字+单词" 样式标签，汇总后拼到最前面
 */
/**
 * 人数标签归一：把提示词里的 `1 girl` / `2girls` / `3 girls` 统一成规范写法并前置。
 *
 * ★★ 2026-10-23 修 bug：原来是**累加**，导致「同一个人被描述两次」被算成两个人。
 *
 *   现象（建牢凌卡时实测）：单人锚点注入后，提示词必然有两处 `1girl`
 *   （锚点第一行一个、LLM 场景词一个）→ 累加得 2 → 最终提交给 ComfyUI 的是 `2girls, …`
 *   （而 `solo` 还在，自相矛盾）。画面当时没崩，是因为模型让 solo 压过了 2girls ——
 *   换个构图就会真的画出两个人。
 *
 *   为什么之前没暴露：没有锚点的时候，提示词里通常只出现一次 `1girl`。
 *   **只要接了 anchors，这个坑必然被踩到**（阶段 4 之后所有链路都有风险）。
 *
 *   修法：**取最大值**，不是求和。
 *     · 单人：锚点 1girl + 场景 1girl → max = 1 ✅
 *     · 双人：锚点两行各 1girl + 场景 "two girls" → max(1,1,2) = 2 ✅
 *       （多人场景的人数由场景词决定，锚点只负责"每人长什么样"）
 */
export function finalizeCountTags(prompt) {
  const tagRe = /\b(\d+)\s*([a-z]{3,})s?\b/gi;
  const counts = new Map();

  let m;
  while ((m = tagRe.exec(prompt)) !== null) {
    const num = parseInt(m[1], 10) || 1;
    const word = m[2].toLowerCase();
    const stem = word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word;
    // ★ 取最大值：同一 stem 出现多次时，人数取"最多提到的那个"，不累加
    counts.set(stem, Math.max(counts.get(stem) || 0, num));
  }

  if (counts.size === 0) return prompt;

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stem, count]) => count === 1 ? `1${stem}` : `${count}${stem}s`);

  let cleaned = prompt.replace(/\b\d+\s*[a-z]{3,}s?\b\s*,?\s*/gi, '');
  cleaned = cleaned.replace(/^,\s*/, '').replace(/,\s*$/, '').trim();

  return parts.join(', ') + (cleaned ? ', ' + cleaned : '');
}

// ComfyUI 提交最大重试次数
const MAX_SUBMIT_RETRIES = 2;

/**
 * 提交 ComfyUI 生图（含 workflow 构建、重试循环）
 *
 * @param {string}   rawPrompt               - 画面描述
 * @param {object}   [opts]
 * @param {Array}    [opts.loras]              - [{path, weight, triggerWord}]
 * @param {string}   [opts.customWorkflow]       - 自定义工作流文件名（单人兼容）
 * @param {string}   [opts.scene]                - 全局 LoRA 的场景过滤；默认也用于工作流选择
 * @param {string}   [opts.workflowScene]        - hybrid 模式下单独用于工作流选择
 * @param {string}   [opts.artist]
 * @param {number}   [opts.width]
 * @param {number}   [opts.height]
 * @param {function} [opts.onProgress]
 * @param {number}   [opts.submitRetries=2]
 * @returns {Promise<{success, images, source, promptId}>}
 */
async function submitWithRetry(rawPrompt, {
  artist, width, height, onProgress, submitRetries = MAX_SUBMIT_RETRIES,
  loras, customWorkflow, scene, workflowScene, globalLoraSnapshot, qualityPrompt, negativePrompt,
  imageProvider = config.comfyui.imageProvider,
} = {}) {
  if (imageProvider === 'novelai') {
    // NovelAI receives the same prepared scene description and artist tags as ComfyUI,
    // but does not use either character or global LoRA data.
    return submitNovelaiImage(rawPrompt, { artist, onProgress });
  }

  // 1. 最终阀门
  let finalPrompt = finalizeCountTags(rawPrompt);
  console.log(`[imageSkill] Final prompt: ${finalPrompt}`);

  // 2. 构建 workflow
  const { wf, wfMode } = buildWorkflow(finalPrompt, {
    artist, width, height, loras, customWorkflow, scene, workflowScene, globalLoraSnapshot, qualityPrompt, negativePrompt,
  });
  if (onProgress) onProgress({ stage: 'submitting' });

  // 3. 提交 ComfyUI，带重试循环
  let lastResult = null;

  for (let attempt = 0; attempt <= submitRetries; attempt++) {
    if (attempt > 0) {
      console.log(`[imageSkill] ComfyUI submit retry ${attempt}/${submitRetries} — re-randomizing seed`);
      for (const node of wf.nodes || []) {
        if (node.type === 'KSampler' && node.widgets_values.length > 1 && node.widgets_values[1] === 'randomize') {
          node.widgets_values[0] = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        }
      }
      if (onProgress) onProgress({ stage: 'retrying', attempt, maxRetries: submitRetries });
    }

    try {
      const result = await submitWorkflow(wf, (p) => {
        if (onProgress) onProgress({ stage: 'generating', ...p });
      });
      if (result.images.length > 0) {
        console.log(`\n🎨 [imageSkill] 图片生成完成: ${result.images.length} 张 (workflow: ${wfMode}, promptId: ${result.promptId})`);
        return { success: true, images: result.images, source: 'api', promptId: result.promptId, wfMode };
      }
      lastResult = result;
    } catch (err) {
      console.error(`[imageSkill] ComfyUI attempt ${attempt + 1} failed:`, err.message);
      lastResult = { success: false, images: [], source: null, error: err.message };
    }

    if (attempt < submitRetries) {
      const waitMs = 2000 + attempt * 1000;
      console.log(`[imageSkill] Waiting ${waitMs}ms before retry...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  console.log('[imageSkill] All ComfyUI submit attempts exhausted, generation failed');
  return { success: false, images: [], source: null, error: lastResult?.error || 'All ComfyUI attempts exhausted', wfMode };
}

// ── 优先级队列 ──
let activeTaskCount = 0;
let lowQueue = [];           // { rawPrompt, opts, resolve, reject }
let processingLow = false;
let lastHighTime = 0;
const QUIET = 180_000;        // 高优任务后 180s 内不派发低优

/**
 * 把角色锚点拼到提示词最前（纯函数，**导出只为测试**）。
 *
 * 抽出来的原因：`generateImageRaw` 在测试里会被 `testGuardBlocksComfy()` 提前短路，
 * 直接测调用拿不到最终提示词。锚点注入是这次改造的核心，必须能单独验。
 *
 * @param {string} promptRefined RAG 之后的提示词
 * @param {object} opts 含 anchors / 无 anchors
 * @returns {{finalPrompt:string, anchorText:string}}
 */
export function applyAnchors(promptRefined, opts = {}) {
  const prompt = String(promptRefined || '');
  const list = Array.isArray(opts.anchors) ? opts.anchors : null;
  if (!list || !list.length) return { finalPrompt: prompt, anchorText: '' };
  if (config.comfyui.anchorInjection === false) return { finalPrompt: prompt, anchorText: '' };
  let anchorText = '';
  try {
    anchorText = buildAnchorLines(list).join('\n');
  } catch (err) {
    // 锚点取不到不该让整张图失败 —— 宁可不注入，也要出图
    console.warn('[imageSkill] 锚点解析失败，本次不注入:', err.message);
    return { finalPrompt: prompt, anchorText: '' };
  }
  if (!anchorText) return { finalPrompt: prompt, anchorText: '' };
  /**
   * ★★ 人数标签统一（2026-10-23，修「单人变双人」bug）
   *
   * 背景：`submitWithRetry` 会调 `finalizeCountTags` 归一人数标签，而它原来按**累加**统计。
   * 锚点注入后提示词必然出现两处 `1girl`（锚点行 + LLM 场景词）→ 累加得 2 → `2girls`，
   * 与 `solo` 自相矛盾。阶段 4 之后每条链路都会踩，只是 solo 在场时没露出来。
   *
   * 为什么不能只在 `finalizeCountTags` 里改成取最大值：那样双人同框会退化成 1girl
   * （锚点是"每人一行各 1girl"，行数才是人数）。它看不到行数语义。
   *
   * 所以在这里统一：**人数由锚点条数决定**，把锚点行与场景词里的人数标签全部剥掉，
   * 只在最前面写一个权威值。`finalizeCountTags` 之后看到的就是这一个值，不会被翻倍。
   *
   * ⚠ 局限：目前只处理 girl（角色锚点都是女角色）。用户形象（男）接入时要扩展 boy。
   */
  const people = list.length;
  const countTag = people === 1 ? '1girl' : `${people}girls`;
  const stripGirlCount = (s) => String(s)
    .split('\n')
    .map(line => line
      .replace(/\b\d+\s*girls?\b/gi, '')
      .replace(/^[\s,]+/, '')
      .replace(/,\s*,+/g, ', ')
      .trim())
    .filter(Boolean)
    .join('\n');
  const anchorBody = stripGirlCount(anchorText);
  const promptBody = stripGirlCount(prompt);
  const finalPrompt = anchorBody || promptBody
    ? `${countTag}, ${anchorBody}${anchorBody && promptBody ? '\n' : ''}${promptBody}`
    : countTag;
  /**
   * ★ 2026-10-23 实测出的软阈值（`scripts/probe-prompt-length.mjs`）
   *
   * ComfyUI 侧不截断（`QwenImageTokenizer.max_length=99999999`），四档全部出图成功：
   *   955 / 2957 / 5956 / 9957 字符。
   * 但**画质分水岭在 3000 附近**（用户实看后判定，比我最初的判断保守）：
   *   · ~2957 → 锚点、场景、末尾特征全部生效
   *   · ~5956 → 角色边缘开始模糊，末尾特征失真（紫伞被画成红伞）
   *   · ~9957 → **角色本身变了**：双马尾散开、粉渐变发尾几乎消失
   *
   * ⚠ 订正记录：我最初只看"发色 + 衣服"就判定"四档角色都对"，漏了双马尾和发尾渐变 ——
   *   长提示词**不是只让末尾失效，它会把锚点内部的特征也一起摊薄**。
   *   判断"像不像"必须由人看（尤其是最标志性的发型特征），不能只核颜色。
   *
   * 所以这里按 3000 告警（不是截断，截断会伤关键字段更狠）。
   */
  if (finalPrompt.length > 3000) {
    console.warn(`[imageSkill] ⚠ 最终提示词 ${finalPrompt.length} 字符（锚点 ${anchorText.length}）—— `
      + '实测超过约 3000 后角色细节开始摊薄（发型/渐变发色会先丢），超过约 6000 会明显换人。'
      + '要压的是锚点之外的场景描述，别压锚点。');
  }
  return { finalPrompt, anchorText };
}

async function _execute(rawPrompt, opts) {
  activeTaskCount++;
  let slotAcquired = false;
  try {
    const preparation = await prepareImagePrompt(rawPrompt, {
      ragQuery: opts.ragQuery,
      disableRAG: opts.disableRAG === true,
      scene: opts.promptScene || opts.scene || 'chat',
      alreadyPrepared: opts.alreadyPrepared === true,
      skipOptimization: opts.skipOptimization === true,
      ragTimeoutMs: opts.ragTimeoutMs,
      // ★ 时段锚点：调用方传入该画面发生的时刻（日程/朋友圈/聊天），
      //   把光照钉在正确时段 —— 修「凌晨 2 点的活动生成出白天图」。
      timeOfDay: opts.timeOfDay,
    });
    // ★ 时段锚点命中日志（F-15）：排查「凌晨出白天图」的第一现场 ——
    //   这行出现 = 锚点已注入；没出现 = 调用方没传 timeOfDay（或时刻非法）。
    if (preparation.timeOfDay) {
      console.log(`[image] 时段锚点 ${preparation.timeOfDay.label}(${preparation.timeOfDay.key}) scene=${opts.promptScene || opts.scene || 'chat'}`);
    }
    /**
     * ★ 角色锚点强制注入（2026-10-22）
     *
     * 为什么在这一层做（而不是继续靠 persona 喂给 LLM）：
     *   锚点原来是"给 LLM 的素材"，靠它转述进提示词 —— 少写一句、换个词（"深棕+粉渐变"写成"粉"），
     *   代码层完全无从纠正。实测花火在朋友圈/奇遇被画成整头粉，就是转述损耗。
     *   放在这里，无论上游怎么写，最终送给 ComfyUI 的提示词一定带锚点。
     *
     * 位置：RAG 之后、提交之前。RAG 的检索与改写不受影响，锚点也不会被它改写掉。
     * 顺序：锚点在**最前**（模型对开头更敏感，也避免被场景词挤到后面）。
     * 开关：config.comfyui.anchorInjection（默认开），关掉即回到改造前。
     */
    const { finalPrompt, anchorText } = applyAnchors(preparation.promptRefined, opts);

    opts.onPromptPrepared?.(finalPrompt);
    if (_limitEnabled()) {
      await acquireSlot();
      slotAcquired = true;
    }
    const result = await submitWithRetry(finalPrompt, opts);
    return {
      ...result,
      promptOriginal: preparation.promptOriginal,
      promptRagQuery: preparation.ragQuery,
      // 落库的是**最终提示词**（含锚点段），便于事后查"这张图当时用的哪份锚点"
      promptRefined: finalPrompt,
      anchorUsed: anchorText,
      promptKnowledgeIds: preparation.retrieval.knowledgeIds,
      promptKnowledgeVersion: preparation.retrieval.knowledgeVersion,
      promptRetrievalMode: preparation.retrieval.mode,
      promptOptimizationStatus: preparation.status,
    };
  } finally {
    activeTaskCount--;
    if (activeTaskCount === 0) processLowQueue();
    if (slotAcquired) releaseSlot();
  }
}

function processLowQueue() {
  if (processingLow || lowQueue.length === 0) return;
  if (activeTaskCount > 0) return;

  const remaining = QUIET - (Date.now() - lastHighTime);
  if (remaining > 0) {
    setTimeout(processLowQueue, remaining + 100);
    return;
  }

  processingLow = true;
  const { rawPrompt, opts, resolve, reject } = lowQueue.shift();
  _execute(rawPrompt, opts).then(resolve, reject).finally(() => {
    processingLow = false;
    if (lowQueue.length > 0) processLowQueue();
  });
}

export function isUserQuiet(quietMs = QUIET) {
  return Date.now() - lastHighTime >= quietMs;
}

export async function generateImage(rawPrompt, opts = {}) {
  if (opts.priority === 'low') {
    return new Promise((resolve, reject) => {
      lowQueue.push({ rawPrompt, opts, resolve, reject });
      processLowQueue();
    });
  }
  lastHighTime = Date.now();
  return _execute(rawPrompt, opts);
}

// ★ 2026-10-20 硬 bug 修复：**测试进程不许向真实 ComfyUI 提单**。
//
//   现象：用户报「邻舍时不时向 ComfyUI 申请部位图/商品图，但不落库」，给了任务 id 一查——
//   提示词是 `tag_a, no humans, plain white background, product photograph…`，
//   而 `tag_a` 是 `test/lootTakeStatus.test.js` 里**测试数据**的商品 tag。
//   机制：该测试调 `takeItems()` → `enqueueImage()`（fire-and-forget 队列）→
//   `generateOneImage()` → 真的连 8188 出图。结果写进测试临时目录，跑完即弃，
//   所以「生成过、但库里/盘上什么都没有」。
//
//   测试里沿用真实地址时直接拒绝，并给出清晰原因；显式设 `LINSHE_ALLOW_REAL_COMFY=1`
//   或把 `COMFYUI_URL` 指向桩服务时仍可放行（有些测试就是要验这条路）。
function isDefaultRealComfy(url) {
  try {
    const u = new URL(url);
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) && u.port === '8188';
  } catch {
    return false;
  }
}

function testGuardBlocksComfy() {
  if (!process.env.NODE_TEST_CONTEXT) return false;          // 非测试进程，放行
  if (process.env.LINSHE_ALLOW_REAL_COMFY === '1') return false; // 显式放行
  return isDefaultRealComfy(config.comfyui?.url || '');
}

const PLACEHOLDER_PROMPT_RE = /^\s*(tag_[a-z]\b|请输入画面描述|\{\{?\s*tag\s*\}?\}|<\s*tag\s*>)/i;

export async function generateImageRaw(rawPrompt, opts = {}) {
  if (PLACEHOLDER_PROMPT_RE.test(String(rawPrompt || ''))) {
    const stack = new Error('placeholder prompt').stack?.split('\n').slice(2, 7).join('\n') || '';
    console.warn(`[imageSkill] ⚠ 疑似占位提示词，可能未做变量替换：${String(rawPrompt).slice(0, 80)}\n${stack}`);
  }
  if (testGuardBlocksComfy()) {
    console.warn(`[imageSkill] 测试进程拒绝连真实 ComfyUI（${config.comfyui?.url}）；` +
      `prompt=${String(rawPrompt).slice(0, 60)}… 如确需真实出图请设 LINSHE_ALLOW_REAL_COMFY=1`);
    return { success: false, images: [], error: 'COMFY_SKIPPED_IN_TEST', promptRefined: rawPrompt };
  }
  if (opts.priority === 'low') {
    return new Promise((resolve, reject) => {
      lowQueue.push({ rawPrompt, opts, resolve, reject });
      processLowQueue();
    });
  }
  lastHighTime = Date.now();
  return _execute(rawPrompt, opts);
}
function getComfyLorasRoot() {
  try {
    const projectRoot = path.resolve(__dirname, '..', '..', '..');
    const launcherConfigPath = path.resolve(projectRoot, '..', 'launcher_config.json');
    const launcherConfig = JSON.parse(fs.readFileSync(launcherConfigPath, 'utf8'));
    if (!launcherConfig.comfyui_exe) return null;
    const rootDir = path.dirname(launcherConfig.comfyui_exe);
    const lorasRoot = path.join(rootDir, 'ComfyUI', 'models', 'loras');
    return fs.existsSync(lorasRoot) ? lorasRoot : null;
  } catch {
    return null;
  }
}

// 兼容历史数据：ComfyUI 只接受模型根目录相对名，不接受本机绝对路径。
function normalizeLoraValue(value) {
  const raw = String(value || '').trim();
  if (!raw || !path.isAbsolute(raw)) return raw;

  const lorasRoot = getComfyLorasRoot();
  if (lorasRoot) {
    const rel = path.relative(lorasRoot, raw);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }

  const marker = /[\\/]models[\\/]loras[\\/]/i.exec(raw);
  return marker ? raw.slice(marker.index + marker[0].length) : raw;
}
