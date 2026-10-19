/**
 * 合并审计工具的公共层（2026-10-19）
 *
 * 为什么要有这一套：v3.8.0 的合并里，自动合并区**静默**丢过代码
 * （重复声明 / 丢导出 / 丢 import / 函数级删除 / 删除类动作静默生效 / 本地成果被覆盖）。
 * 六个扫描里，后两类靠行级对比才能发现 —— 而 git 的自动合并不会报错。
 *
 * 这里只提供「读三份文本 + 取行集合 + 取本地新增行」三件事，
 * 具体判据在三个 scan-*.mjs 里，各自可独立跑。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';

export const DEFAULT_BASE = '115ddd6'; // v3.9.1，上次合并收官点
export const DEFAULT_TAG = '7d2348c';  // v3.10.0

export function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** 某个 revision 下的全部文件路径（一次调用，替代逐文件 git show 的存在性判断） */
export function lsTreeNames(rev) {
  const out = sh(`git ls-tree -r --name-only ${rev}`);
  return new Set(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
}

/** 读某个 revision 下的文件内容；不存在返回 null */
export function gitText(rev, file) {
  try {
    return sh(`git show ${rev}:${file}`, { stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** 读工作区文件；不存在返回 null（优先读磁盘，避免读到索引里的旧版本） */
export function workText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    try {
      return sh(`git show :${file}`, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  }
}

export function lines(text) {
  if (text == null) return [];
  return String(text).split(/\r?\n/);
}

/** 归一化：去右空白。用于「这行还在不在」的判定，不做语义比较 */
export function norm(line) {
  return String(line).replace(/\s+$/, '');
}

/**
 * 琐碎行：括号、括号结尾、else、return; 之类。
 * 它们会在任何文件里重复出现，拿来做"丢失判定"必然噪声爆炸，一律排除。
 */
export function isTrivial(line) {
  const s = String(line).trim();
  if (!s) return true;
  if (s.length < 6) return true;
  if (/^[{}()[\];,]+$/.test(s)) return true;
  if (/^(\/\/|\*|\/\*)/.test(s)) return true;
  if (/^(else|try|catch|finally|return|break|continue|default)\b/.test(s)) return true;
  return false;
}

/** 某个区间内所有被改动的文件（含增删改，不含产物） */
export function changedFiles(a, b) {
  return sh(`git diff --name-only ${a}..${b}`)
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/** 文件在区间内被删除的列表 */
export function deletedFiles(a, b) {
  return sh(`git diff --diff-filter=D --name-only ${a}..${b}`)
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/**
 * 批量取「本地新增行」：一次 `git diff -U0` 解析全部文件。
 * ⚠ 不要改成逐文件 diff —— Windows 上 400 个子进程要 3 分钟以上。
 * @returns {Map<string, string[]>} 文件 → 非琐碎新增行
 */
export function bulkLocalAdded(base, head) {
  const map = new Map();
  let diff;
  try {
    diff = sh(`git diff -U0 ${base}..${head}`);
  } catch {
    return map;
  }
  let cur = null;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) { cur = null; continue; }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      cur = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (cur && !map.has(cur)) map.set(cur, []);
      continue;
    }
    if (!cur || !raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = norm(raw.slice(1));
    if (!isTrivial(line)) map.get(cur).push(line);
  }
  return map;
}

/** 统计某文件在区间内的增删行数 */
export function numstat(a, b, file) {
  try {
    const s = sh(`git diff --numstat ${a}..${b} -- "${file}"`).trim();
    if (!s) return null;
    const [add, del] = s.split(/\s+/);
    return { add: Number(add), del: Number(del) };
  } catch {
    return null;
  }
}

export function header(title) {
  console.log('\n' + '═'.repeat(64));
  console.log(title);
  console.log('═'.repeat(64));
}
