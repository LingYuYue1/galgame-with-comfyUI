#!/usr/bin/env node
/**
 * probe-prompt-length.mjs — 提示词长度阶梯实测（2026-10-23）
 *
 * ── 为什么要测 ──
 * 用户问「能不能容纳更多字符，少截断点，因为截断会影响场景质量」。
 * 查 ComfyUI 源码已知：`QwenImageTokenizer`（qwen_image 类型）的 `max_length=99999999`，
 * **不会截断**。所以真正的问题不是"装不装得下"，而是"多长之后后段内容画不出来"。
 *
 * ── 怎么判断 ──
 * 在每个档位的提示词**末尾**放一个显眼特征（`a giant glowing purple umbrella`），
 * 同时看主体的身份特征（花火的深棕+粉渐变发尾）是否还在：
 *   · 末尾特征出现 → 这个长度还"听得见"
 *   · 末尾特征消失但人还对 → 已经进入"尾巴被忽略"区
 *   · 人也不对了 → 长度把主体也稀释掉了
 *
 * ── 用法 ──
 *   node scripts/probe-prompt-length.mjs [角色id=15]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateImageRaw } from '../src/services/imageSkill.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'output', 'anchor-check');
const charId = Number(process.argv[2]) || 15;

// 有意义的填充（不是乱码）：重复的室内细节描述，长度可控
const FILL_UNIT = 'the room has a wide window with warm afternoon light, a wooden floor, '
  + 'a tall bookshelf filled with old novels, a small round table with a ceramic cup, '
  + 'dust motes drifting slowly through the light, a potted fern by the door, ';

const TAIL_FEATURE = 'she is holding a giant glowing purple umbrella high above her head';
const SCENE = 'standing in a bright modern room, full body, looking at viewer';

function filler(n) {
  if (n <= 0) return '';
  return FILL_UNIT.repeat(Math.ceil(n / FILL_UNIT.length)).slice(0, n).trimEnd();
}

const LEVELS = [0, 2000, 5000, 9000];

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(`角色 #${charId} · ${LEVELS.length} 档（填充 0 / 2000 / 5000 / 9000 字符）\n`);

const results = [];
for (const fillLen of LEVELS) {
  const prompt = [filler(fillLen), TAIL_FEATURE, SCENE].filter(Boolean).join(', ');
  const label = `len-${fillLen}`;
  const t0 = Date.now();
  let r = null;
  try {
    r = await generateImageRaw(prompt, {
      scene: 'moments', width: 512, height: 768, disableRAG: true,
      anchors: [{ characterId: charId, slot: 'self' }],
    });
  } catch (err) {
    results.push({ fillLen, ok: false, err: err.message, total: 0 });
    console.log(`✗ 填充 ${fillLen}：抛错 ${err.message}`);
    continue;
  }
  const total = String(r?.promptRefined || '').length;
  const ms = Date.now() - t0;
  const ok = Boolean(r?.success && r?.images?.[0]?.base64);
  if (ok) {
    const b64 = r.images[0].base64.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(OUT_DIR, `长度测试-${label}.png`), Buffer.from(b64, 'base64'));
  }
  results.push({ fillLen, ok, total, ms });
  console.log(`${ok ? '✓' : '✗'} 填充 ${String(fillLen).padStart(4)} → 最终提示词 ${String(total).padStart(5)} 字符`
    + `  ${(ms / 1000).toFixed(0)}s  ${ok ? '出图成功' : `失败：${r?.error || '无图'}`}`);
}

console.log('\n── 结论怎么看 ──');
console.log('打开 output/anchor-check/长度测试-len-*.png，逐张看两件事：');
console.log('  ① 有没有那把「巨大的紫色发光雨伞」（提示词末尾的特征）');
console.log('  ② 花火还像不像花火（深棕底 + 粉渐变发尾）');
console.log('\n汇总：', JSON.stringify(results.map(r => ({ 填充: r.fillLen, 总长: r.total, 出图: r.ok }))));
