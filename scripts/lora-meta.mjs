#!/usr/bin/env node
/**
 * lora-meta.mjs — LoRA (safetensors) 元数据取证工具
 *
 * 用法:
 *   node scripts/lora-meta.mjs <目录或文件路径...>        # 打印摘要（基底/维度/训练信息/top标签）
 *   node scripts/lora-meta.mjs <路径...> --json           # 输出完整 metadata JSON
 *
 * 读取 safetensors 头部 JSON 的 __metadata__（kohya 训练元数据）：
 *   基底（ss_base_model_version）、架构、dim/alpha、title、训练步数/图数、
 *   训练集 top 标签（ss_tag_frequency）——用于判断 LoRA 适用基底与风格倾向。
 *
 * 背景：2026-10-16 邻舍生图研究——用本工具实锤「Anima_AI_Cunnyfunky 实为 SDXL 基底」
 *       （名字带 Anima 但给 anima 用近无效果）。
 */

import { openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

function readHeader(fp) {
  const fd = openSync(fp, "r");
  try {
    const lb = Buffer.alloc(8);
    readSync(fd, lb, 0, 8, 0);
    const len = Number(lb.readBigUInt64LE(0));
    const hb = Buffer.alloc(len);
    readSync(fd, hb, 0, len, 8);
    return JSON.parse(hb.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function topTags(md, n = 10) {
  try {
    const tf = JSON.parse(md["ss_tag_frequency"] || "{}");
    const counts = {};
    for (const folder of Object.values(tf)) for (const [t, c] of Object.entries(folder)) counts[t] = (counts[t] || 0) + c;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t, c]) => `${t}(${c})`);
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const paths = args.filter((a) => !a.startsWith("--"));

const files = [];
for (const p of paths) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const f of readdirSync(p)) if (f.endsWith(".safetensors")) files.push(join(p, f));
  } else {
    files.push(p);
  }
}

for (const fp of files) {
  const name = basename(fp);
  try {
    const hdr = readHeader(fp);
    const md = hdr.__metadata__ || {};
    if (jsonOut) {
      console.log(JSON.stringify({ file: name, metadata: md, tensorCount: Object.keys(hdr).length - 1 }, null, 2));
      continue;
    }
    const sizeMB = (statSync(fp).size / 1048576).toFixed(1);
    console.log(`===== ${name}（${sizeMB} MB）`);
    console.log(`  基底: ${md["ss_base_model_version"] || "未标注"} | 架构: ${md["modelspec.architecture"] || "?"} | dim/alpha: ${md["ss_network_dim"] || "?"}/${md["ss_network_alpha"] || "?"}`);
    console.log(`  title: ${md["modelspec.title"] || md["ss_output_name"] || "?"} | 步数: ${md["ss_steps"] || md["ss_max_train_steps"] || "?"} | 训练图: ${md["ss_num_train_images"] || "?"}`);
    const tags = topTags(md);
    console.log(`  top标签: ${tags.length ? tags.join(", ") : "（无）"}`);
  } catch (e) {
    console.log(`===== ${name} → 解析失败: ${e.message}`);
  }
}
