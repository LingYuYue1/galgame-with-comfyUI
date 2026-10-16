#!/usr/bin/env node
/**
 * img-meta.mjs — ComfyUI 出图元数据取证工具
 *
 * 用法:
 *   node scripts/img-meta.mjs <PNG路径...>           # 打印关键参数摘要
 *   node scripts/img-meta.mjs <PNG路径...> --json    # 输出完整 API prompt JSON
 *
 * 读取 ComfyUI 保存的 PNG 内嵌 tEXt 块（prompt = 实际提交的 API 格式），
 * 解析并归纳：模型 / LoRA 链 / 采样参数 / 正负提示词全文 / 尺寸。
 *
 * 用途：生图质量研究时核对「系统实际提交了什么参数」——
 * 系统注入（imageSkill.js 按节点 title 覆盖画师串/负面/宽高）的结果全在这里。
 * 详见 docs/交接-生图研究.md。
 */

import { readFileSync } from "node:fs";

function readPngTextChunks(buf) {
  if (buf.subarray(0, 8).toString("latin1") !== "\x89PNG\r\n\x1a\n") throw new Error("不是 PNG 文件");
  const out = {};
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "tEXt") {
      const idx = data.indexOf(0);
      const key = data.subarray(0, idx).toString("latin1");
      out[key] = data.subarray(idx + 1).toString("utf8");
    }
    if (type === "IEND") break;
  }
  return out;
}

/** 递归解析节点引用 / StringConcatenate 拼接，得到最终文本 */
function resolveText(api, ref, depth = 0) {
  if (depth > 20) return "<递归过深>";
  if (typeof ref === "string") return ref;
  if (typeof ref === "number") return String(ref);
  if (!Array.isArray(ref)) return String(ref ?? "");
  const node = api[String(ref[0])];
  if (!node) return `<缺失节点 ${ref[0]}>`;
  const inputs = node.inputs || {};
  if (node.class_type === "PrimitiveString" || node.class_type === "PrimitiveInt") {
    return String(inputs.value ?? "");
  }
  if (node.class_type === "StringConcatenate") {
    const a = resolveText(api, inputs.string_a, depth + 1);
    const b = resolveText(api, inputs.string_b, depth + 1);
    return a + String(inputs.delimiter ?? "") + b;
  }
  if ("text" in inputs) return resolveText(api, inputs.text, depth + 1);
  for (const v of Object.values(inputs)) {
    if (typeof v === "string") return v;
  }
  return `<无法解析 ${node.class_type}#${ref[0]}>`;
}

/** 按 model 输入链重建 LoRA 顺序（UNETLoader → lora1 → lora2 → …） */
function orderLoras(api, loras) {
  const byId = new Map(Object.entries(api));
  const chained = [];
  for (const l of loras) {
    const srcRef = l.inputs?.model;
    const srcId = Array.isArray(srcRef) ? String(srcRef[0]) : null;
    const srcNode = srcId ? byId.get(srcId) : null;
    chained.push({ node: l, upstreamIsLora: srcNode?.class_type === "LoraLoaderModelOnly" });
  }
  const head = chained.filter(c => !c.upstreamIsLora).map(c => c.node);
  const tail = chained.filter(c => c.upstreamIsLora).map(c => c.node);
  return [...head, ...tail]; // 单 LoRA / 链短时够用；链很长再升级为拓扑排序
}

function summarize(meta, file) {
  const api = JSON.parse(meta.prompt || "{}");
  const nodes = Object.values(api);
  const find = (t) => nodes.filter(n => n.class_type === t);
  const sampler = find("KSampler")[0] || find("KSamplerAdvanced")[0];
  const latent = find("EmptyLatentImage")[0];
  const unet = find("UNETLoader")[0] || find("CheckpointLoaderSimple")[0];
  const clip = find("CLIPLoader")[0];
  const vae = find("VAELoader")[0];
  const loras = orderLoras(api, find("LoraLoaderModelOnly"));

  const lines = [];
  lines.push(`文件: ${file.split(/[\\/]/).pop()}`);
  lines.push(
    `模型: UNET=${unet?.inputs?.unet_name ?? unet?.inputs?.ckpt_name ?? "?"}` +
    ` | CLIP=${clip?.inputs?.clip_name ?? "?"}(type=${clip?.inputs?.type ?? "?"})` +
    ` | VAE=${vae?.inputs?.vae_name ?? "?"}`
  );
  if (loras.length) {
    lines.push(`LoRA(${loras.length}): ${loras.map(l => `${l.inputs.lora_name}@${l.inputs.strength_model}`).join(" + ")}`);
  }
  if (sampler) {
    lines.push(
      `采样: steps=${sampler.inputs.steps} cfg=${sampler.inputs.cfg} ` +
      `sampler=${sampler.inputs.sampler_name} sched=${sampler.inputs.scheduler} ` +
      `denoise=${sampler.inputs.denoise} seed=${sampler.inputs.seed}`
    );
  }
  if (latent) {
    const w = resolveText(api, latent.inputs.width);
    const h = resolveText(api, latent.inputs.height);
    lines.push(`尺寸: ${w}x${h} (batch ${latent.inputs.batch_size})`);
  }
  if (sampler) {
    lines.push(`正面: ${resolveText(api, sampler.inputs.positive)}`);
    lines.push(`负面: ${resolveText(api, sampler.inputs.negative)}`);
  }
  return { file, summary: lines.join("\n"), api };
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const files = args.filter(a => !a.startsWith("--"));
if (!files.length) {
  console.error("用法: node scripts/img-meta.mjs <PNG路径...> [--json]");
  process.exit(1);
}
for (const f of files) {
  try {
    const meta = readPngTextChunks(readFileSync(f));
    if (!meta.prompt) {
      console.log(`${f}: 无 prompt 元数据（非 ComfyUI 出图，或元数据被压缩器剥离）\n`);
      continue;
    }
    const r = summarize(meta, f);
    if (jsonOut) console.log(JSON.stringify(r.api, null, 2));
    else console.log(r.summary + "\n");
  } catch (e) {
    console.error(`${f}: ${e.message}`);
  }
}
