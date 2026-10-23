/**
 * 生图调用扫描器（2026-10-23）
 *
 * 把 `audit-image-call-params.mjs` 里的提取逻辑抽出来，**脚本与测试共用一份** ——
 * 否则测试的正则会和脚本的口径分叉（第一版就是：测试按全文正则扫 `scene:`，
 * 结果把锚点的 `scene:'work'`、服装的 `scene:'sleep'` 全当成生图场景抓了）。
 */

import fs from 'fs';
import path from 'path';

export const CALL_NAMES = ['generateImageRaw', 'generateImage', 'generateMediaImage'];
export const FIELDS = ['scene', 'promptScene', 'workflowScene', 'artist', 'width', 'height', 'anchors', 'loras', 'negativePrompt'];

/**
 * 把注释替换成等长空格（保持下标与换行不变），免得
 * `// 原先这里传 [{ …, scene: 'work' }]` 这类说明文字被当成真实参提取出来。
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\n)([ \t]*)\/\/[^\n]*/g, (m, p1, p2) =>
      p1 + p2 + ' '.repeat(Math.max(0, m.length - p1.length - p2.length)));
}

/** 从 openIdx（指向 '(' ）开始找配对的 ')'，跳过字符串/模板/注释 */
export function matchParen(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = src.length;
  let state = 'code';
  let tplDepth = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') { state = 'tpl'; tplDepth = 0; }
      else if (c === '/' && c2 === '/') { state = 'line'; i++; }
      else if (c === '/' && c2 === '*') { state = 'block'; i++; }
      else if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return i; }
    } else if (state === 'sq') {
      if (c === '\\') i++; else if (c === "'") state = 'code';
    } else if (state === 'dq') {
      if (c === '\\') i++; else if (c === '"') state = 'code';
    } else if (state === 'tpl') {
      if (c === '\\') i++;
      else if (c === '$' && c2 === '{') { tplDepth++; i++; }
      else if (c === '}' && tplDepth > 0) tplDepth--;
      else if (c === '`' && tplDepth === 0) state = 'code';
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
    } else if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i++; }
    }
    i++;
  }
  return -1;
}

/** 在实参块里找 `field: value`，只取到同层级的逗号/换行为止 */
export function pickField(block, field) {
  const re = new RegExp(`(?:^|[{,\\s])${field}\\s*:\\s*`, 'g');
  let m;
  while ((m = re.exec(block)) !== null) {
    const start = m.index + m[0].length;
    let depth = 0;
    let j = start;
    let state = 'code';
    while (j < block.length) {
      const c = block[j];
      if (state === 'code') {
        if (c === "'") state = 'sq';
        else if (c === '"') state = 'dq';
        else if (c === '`') state = 'tpl';
        else if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth--; }
        else if (c === ',' && depth === 0) break;
        else if (c === '\n' && depth === 0) break;
      } else if (state === 'sq') { if (c === "'") state = 'code'; }
      else if (state === 'dq') { if (c === '"') state = 'code'; }
      else if (state === 'tpl') { if (c === '`') state = 'code'; }
      j++;
    }
    return block.slice(start, j).trim().replace(/\s+/g, ' ');
  }
  return null;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * 扫一个目录下所有生图调用。
 * @returns {Array<{file:string,line:number,call:string,prompt:string,block:string,[k:string]:any}>}
 */
export function scanImageCalls(rootDir) {
  const rows = [];
  for (const file of walk(rootDir)) {
    const rawSrc = fs.readFileSync(file, 'utf8');
    if (!CALL_NAMES.some(c => rawSrc.includes(c + '('))) continue;
    const src = stripComments(rawSrc);
    const lines = rawSrc.split('\n');

    for (const call of CALL_NAMES) {
      const re = new RegExp(`(^|[^.\\w])${call}\\s*\\(`, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        const openIdx = src.indexOf('(', m.index);
        if (src[openIdx] !== '(') continue;
        const closeIdx = matchParen(src, openIdx);
        if (closeIdx < 0) continue;
        const block = src.slice(openIdx + 1, closeIdx);
        const lineNo = src.slice(0, m.index).split('\n').length;
        // 定义处（`export async function generateImage(`）不是调用，跳过
        const lineText = lines[lineNo - 1] || '';
        if (/function\s+$/.test(lineText.trim()) || /\bfunction\b/.test(lineText)) continue;

        const row = {
          file: path.relative(path.dirname(rootDir), file).replace(/\\/g, '/'),
          line: lineNo,
          call,
          prompt: lineText.trim().slice(0, 60),
          block,
        };
        for (const f of FIELDS) row[f] = pickField(block, f);
        rows.push(row);
      }
    }
  }
  // 去重
  const seen = new Set();
  return rows
    .filter(r => {
      const k = `${r.file}:${r.line}:${r.call}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
