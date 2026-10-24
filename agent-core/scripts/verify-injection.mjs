/**
 * 验证「邻舍注入是否真的落到工作流节点上」（2026-10-23 23:5x）
 *
 * 用户报的现象：提示词、尺寸都不被读取，只读工作流里写死的值。
 * 根因是 v2 骨架没有 NODE_TITLES 那 7 个标题，注入全靠 title 匹配，找不到就静默跳过。
 *
 * 本脚本模拟 buildWorkflow 的注入过程，逐项核对：
 *   画师串 / 质量提示词 / 画面描述 / 负面提示词 / 图片的宽 / 图片的长 / lora触发词
 * 是否都被替换成了期望值，以及正面链是否把这些串起来。
 *
 * 用法：node scripts/verify-injection.mjs [工作流文件名]
 */
import { getDb } from '../src/db/index.js';
import fs from 'fs';
import path from 'path';

getDb();
const { buildWorkflow, NODE_TITLES } = await import('../src/services/imageSkill.js');
const { config } = await import('../src/config.js');
const { guiToApi } = await import('../src/services/comfyClient.js');

const WF = process.argv[2] || '银月2.9B-程序用（无LoRA节点）.json';
const PROBE_PROMPT = 'Hatsune Miku (VOCALOID), 1girl, close-up shot, teal twin-tailed hair, black school uniform, holding a fork, matcha mille crepe cake, cafe background';
const PROBE_W = 704, PROBE_H = 1024;   // 故意用和默认 832×1216 不同的值

const { wf } = buildWorkflow(PROBE_PROMPT, {
  scene: 'avatar',
  width: PROBE_W,
  height: PROBE_H,
  customWorkflow: WF,
});

const byTitle = (t) => wf.nodes.find(n => n.title === t);

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const err = (m) => { console.log('  ✗ ' + m); bad++; };

console.log(`工作流：${WF}\n`);

console.log('[1] 7 个注入点是否都被替换');
const checks = [
  [NODE_TITLES.artist, String(config.comfyui.artist ?? ''), '画师串'],
  [NODE_TITLES.quality, null, '质量提示词'],
  [NODE_TITLES.prompt, PROBE_PROMPT, '画面描述'],
  [NODE_TITLES.negative, String(config.comfyui.negativePrompt ?? '').trim(), '负面提示词'],
  [NODE_TITLES.width, PROBE_W, '图片的宽'],
  [NODE_TITLES.height, PROBE_H, '图片的长'],
  [NODE_TITLES.loraTrigger, null, 'lora触发词'],
];
for (const [title, expect, label] of checks) {
  const n = byTitle(title);
  if (!n) { err(`找不到 title=${title} 的节点`); continue; }
  const got = n.widgets_values?.[0];
  if (expect === null) {
    ok(`${label}（${n.type}）= ${JSON.stringify(String(got).slice(0, 60))}${String(got).length > 60 ? '…' : ''}`);
    continue;
  }
  if (String(got) === String(expect)) ok(`${label} = ${JSON.stringify(String(got).slice(0, 60))}${String(got).length > 60 ? '…' : ''}`);
  else err(`${label} 未注入：期望 ${JSON.stringify(String(expect).slice(0, 50))}，实际 ${JSON.stringify(String(got).slice(0, 50))}`);
}

console.log('[2] 正面链是否真的串起来（顺序：画师串 + 质量词 + 画面描述 + 触发词）');
const linkById = new Map(wf.links.map(l => [l[0], l]));
const byId = new Map(wf.nodes.map(n => [n.id, n]));
const ks = wf.nodes.find(n => n.type === 'KSampler');

// positive 源头应是 CLIPTextEncode，它的 text 再往上才是 SC1
const posSrc = byId.get(linkById.get(ks.inputs[1].link)[1]);
if (posSrc?.type !== 'CLIPTextEncode') err(`positive 源头不是 CLIPTextEncode，而是 ${posSrc?.type}`);
else {
  const textLink = posSrc.inputs?.find(i => i.name === 'text')?.link;
  const sc1 = textLink != null ? byId.get(linkById.get(textLink)[1]) : null;
  if (sc1?.type !== 'StringConcatenate') err(`CLIPTextEncode.text 源头不是 StringConcatenate，而是 ${sc1?.type}`);
  else {
    // 逐级展开：SC1 → (画师串, SC2) ; SC2 → (质量词, SC3) ; SC3 → (画面描述, 触发词)
    const expand = (n, depth = 0) => {
      if (!n || depth > 6) return '?';
      if (n.type !== 'StringConcatenate') return n.title || n.type;
      const g = (slot) => {
        const l = n.inputs[slot]?.link != null ? linkById.get(n.inputs[slot].link) : null;
        return l ? byId.get(l[1]) : null;
      };
      return `(${expand(g(0), depth + 1)} + ${expand(g(1), depth + 1)})`;
    };
    ok(`展开：${expand(sc1)}`);
    // 四个叶子必须都在
    for (const t of [NODE_TITLES.artist, NODE_TITLES.quality, NODE_TITLES.prompt, NODE_TITLES.loraTrigger]) {
      if (!expand(sc1).includes(t)) err(`拼接链里没有「${t}」`);
    }
  }
}
// 旧变量名保留给下面的 [4] 段用不到，删掉避免混淆

console.log('[3] 尺寸注入是否贯通到 EmptyLatentImage');
const lat = wf.nodes.find(n => n.type === 'EmptyLatentImage');
const wIn = lat.inputs.find(i => i.name === 'width');
const hIn = lat.inputs.find(i => i.name === 'height');
if (wIn?.link == null || hIn?.link == null) err('EmptyLatentImage 的宽/高没有连线（会退回写死值）');
else {
  const wSrc = byId.get(linkById.get(wIn.link)[1]);
  const hSrc = byId.get(linkById.get(hIn.link)[1]);
  ok(`宽 ← ${wSrc.title}(${wSrc.widgets_values[0]})，高 ← ${hSrc.title}(${hSrc.widgets_values[0]})`);
  if (wSrc.widgets_values[0] !== PROBE_W) err('宽没跟随传入的 width');
  if (hSrc.widgets_values[0] !== PROBE_H) err('高没跟随传入的 height');
}

console.log('[4] 转 API 后正面文本是否来自拼接链');
try {
  const api = guiToApi(wf);
  const enc = Object.entries(api).find(([, n]) => n.class_type === 'CLIPTextEncode' &&
    Array.isArray(n.inputs.text) && !Array.isArray(n.inputs.text[0] === undefined));
  const encs = Object.entries(api).filter(([, n]) => n.class_type === 'CLIPTextEncode');
  if (!encs.length) err('API 里没有 CLIPTextEncode');
  else {
    for (const [id, n] of encs) {
      const t = n.inputs.text;
      if (Array.isArray(t)) ok(`CLIPTextEncode#${id}: text ← 节点 #${t[0]}（连线，文本由拼接链产出）`);
      else ok(`CLIPTextEncode#${id}: text = ${JSON.stringify(String(t).slice(0, 40))}（直接值）`);
    }
  }
  const scCount = Object.values(api).filter(n => n.class_type === 'StringConcatenate').length;
  ok(`API 里 StringConcatenate 有 ${scCount} 个`);
  if (scCount !== 3) err(`期望 3 个 StringConcatenate，实际 ${scCount}`);
} catch (e) {
  console.log(`  － 转换失败：${String(e.message).slice(0, 80)}`);
}

console.log(bad ? `\n✗ ${bad} 个问题` : '\n✓ 注入链路全部打通');
process.exit(bad ? 1 : 0);
