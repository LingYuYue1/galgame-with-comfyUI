#!/usr/bin/env node
/**
 * audit-anchor-wiring-calls.mjs — 生图调用点「锚点接线」守卫（2026-10-22，阶段 4）
 *
 * ── 它守的是什么 ──
 * 施工方案 §6 的硬标准：
 *   `grep -rn "generateImageRaw|generateImageSafe" src/` 出来的每一处，
 *   **要么传了 `anchors`，要么在注释里写明"这条链路画面里没有角色"**。不允许第三种情况。
 *
 * 为什么必须自动化：新增一条生图链路时，漏传 anchors 不会报错、不会挂测试，
 * 只会安静地画出一个"长得差不多的别人"——花火的头发变粉就是这么来的。
 *
 * ── 判定口径 ──
 * 在调用点前 6 行 ~ 后 28 行的窗口里，命中以下任一即算"已交代"：
 *   · `anchors`（含 `anchors: [...]` 与 `...(cond ? { anchors } : {})` 两种写法）
 *   · 声明词：无本作角色 / 无角色链路 / 画面里没有人
 * 窗口取 34 行是因为锚点常常带一段多行注释，窗口太小会误报。
 *
 * ── 用法 ──
 *   node scripts/audit-anchor-wiring-calls.mjs       # 有问题时退出码 1
 *   node scripts/audit-anchor-wiring-calls.mjs -v    # 逐条列出已交代的调用点
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

const CALL_RE = /await .*(generateImageRaw|generateImageSafe|generateImage)\s*\(/;
const DECLARED_RE = /anchors|无本作角色|无角色链路|画面里没有人/;
const BEFORE = 6;
const AFTER = 28;

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const wired = [];
const missing = [];

for (const file of walk(SRC)) {
  const src = fs.readFileSync(file, 'utf8');
  // 只查真正从 imageSkill 取生图函数的文件（别的模块里的同名变量不算）
  if (!/imageSkill\.js/.test(src)) continue;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CALL_RE.test(line)) continue;
    // 函数声明行（`export async function generateImageRaw(...)`）不是调用点
    if (/^\s*(export )?(async )?function/.test(line)) continue;

    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const at = `${rel}:${i + 1}`;
    const ctx = lines.slice(Math.max(0, i - BEFORE), Math.min(lines.length, i + AFTER)).join('\n');
    if (DECLARED_RE.test(ctx)) wired.push(at);
    else missing.push({ at, line: line.trim().slice(0, 90) });
  }
}

const total = wired.length + missing.length;
console.log(`生图调用点：${total}  已交代：${wired.length}  未交代：${missing.length}`);

if (VERBOSE) {
  console.log('\n── 已交代 ──');
  wired.forEach(w => console.log('  ✓', w));
}

if (missing.length) {
  console.log('\n── 未交代（漏接锚点，或没写明"画面里没有角色"）──');
  missing.forEach(m => console.log(`  ✗ ${m.at}\n      ${m.line}`));
  console.log('\n修法：传 `anchors: [{ characterId, slot: \'self\' }]`，');
  console.log('      或在调用上方补一行注释说明这条链路画面里没有角色。');
  process.exit(1);
}

console.log('\n✅ 全部调用点都已交代（传了 anchors 或声明了无角色）。');
