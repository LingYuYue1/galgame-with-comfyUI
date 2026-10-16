/**
 * F-62 一次性迁移：给「短预算 chatSync 调用」补上 `thinking: { type: 'disabled' }`
 *
 * 背景：本机通道（opencode + deepseek-v4.1-flash、`.env` LLM_THINKING_MODE=enabled）下
 * **推理 token 计入 max_tokens**。凡调用方按「正文长度」设预算（≤1536）的调用点，
 * 思考一顶满就返回空正文（finish_reason=length），对调用方等同「模型没说话」。
 * F-58（日程生成/着装校对）、F-60（peek）是单点修复；本脚本做全仓一次收口。
 *
 * 判据（与 test/llmThinkingBudget.test.js 的护栏完全一致）：
 *   chatSync 调用块内「未出现 thinking:」且「max_tokens 为 ≤1536 的字面量」→ 应补声明。
 *
 * 行为：**幂等** —— 已有 thinking 声明的调用块一律跳过，可反复运行。
 *   1) max_tokens 独占一行（多行写法）→ 在其下一行插入同缩进的 thinking 属性
 *   2) max_tokens 与其他属性同行（单行写法）→ 就地插入（不加行内注释，避免注释吞掉后续属性）
 *
 * 用法：
 *   cd agent-core && node scripts/f62-add-thinking-disabled.mjs          # 干跑：只列改动
 *   cd agent-core && node scripts/f62-add-thinking-disabled.mjs --apply  # 应用
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const APPLY = process.argv.includes('--apply');
const THRESHOLD = 1536;
const INSERT = "thinking: { type: 'disabled' },";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 行内注释/JSDoc 里的 chatSync( 不算调用（简单启发式：本行匹配点之前出现 // 或 *） */
function looksCommented(s, idx) {
  const lineStart = s.lastIndexOf('\n', idx) + 1;
  const prefix = s.slice(lineStart, idx);
  return /\/\/|\*/.test(prefix);
}

const changes = [];

for (const file of walk(SRC_DIR)) {
  let s = fs.readFileSync(file, 'utf8');
  const original = s;
  const re = /chatSync\(/g;
  let m;
  // 收集改动点（从后往前应用，避免偏移错位）
  const spots = [];
  while ((m = re.exec(s))) {
    const start = m.index;
    if (looksCommented(s, start)) continue;
    const seg = s.slice(start, start + 1500);
    const blockEnd = seg.search(/\}\s*\)/);
    const block = blockEnd > 0 ? seg.slice(0, blockEnd) : seg;
    if (/thinking\s*:/.test(block)) continue;                 // 已显式声明 → 跳过
    const mt = block.match(/max_tokens\s*:\s*(\d+)/);
    if (!mt) continue;
    if (Number(mt[1]) > THRESHOLD) continue;                  // 预算够宽 → 不属本判据
    const mtAbs = start + mt.index + mt[0].length;            // max_tokens 数字之后
    const lineStart = s.lastIndexOf('\n', mtAbs) + 1;
    const lineEnd = s.indexOf('\n', mtAbs);
    const ownLine = /^\s*max_tokens\s*:\s*\d+\s*,?\s*$/.test(s.slice(lineStart, lineEnd === -1 ? s.length : lineEnd));
    const line = s.slice(0, start).split('\n').length;
    spots.push({ mtAbs, ownLine, line, maxTokens: Number(mt[1]), lineStart });
  }

  for (const sp of spots.reverse()) {
    const insertAt = sp.mtAbs;
    const lineEndIdx = s.indexOf('\n', insertAt);
    if (sp.ownLine) {
      // 多行写法：max_tokens 独占一行 → 在下一行插入同缩进属性
      const indent = s.slice(sp.lineStart, insertAt).match(/^\s*/)[0];
      s = s.slice(0, lineEndIdx) + '\n' + indent + INSERT + s.slice(lineEndIdx);
    } else {
      // 同行写法：就地插入。吃掉 max_tokens 之后原有的「空白 + 可选逗号」，
      // 再按「后面还有没有属性」决定新属性自己带不带的逗号。
      const after = s.slice(insertAt);
      const lead = after.match(/^[ \t]*,?[ \t]*/)[0];
      const hadComma = lead.includes(',');
      const rest = after.slice(lead.length);
      // 极少数「同行但 max_tokens 之后换行」的写法：用换行 + 缩进插，不并成一行
      const brk = after.match(/^\s*\n(\s*)/);
      if (brk && !hadComma) {
        s = s.slice(0, insertAt) + ',\n' + brk[1] + INSERT.replace(/,$/, '') + s.slice(insertAt + brk[0].length);
      } else {
        const ins = hadComma ? `, ${INSERT} ` : `, ${INSERT.replace(/,$/, '')} `;
        s = s.slice(0, insertAt) + ins + rest;
      }
    }
    changes.push({ file: path.relative(SRC_DIR, file), line: sp.line, maxTokens: sp.maxTokens, ownLine: sp.ownLine });
  }

  if (APPLY && s !== original) fs.writeFileSync(file, s, 'utf8');
}

changes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
console.log(`${APPLY ? '已应用' : '干跑（未写入）'}：${changes.length} 处${APPLY ? '' : '（确认后加 --apply）'}`);
for (const c of changes) console.log(`  ${c.file}:${c.line}  max_tokens=${c.maxTokens}  ${c.ownLine ? '独占行' : '同行'}`);
