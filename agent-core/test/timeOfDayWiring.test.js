/**
 * 生图「时段锚点」接线护栏测试
 *
 * 背景（2026-10-06 用户报）：「日程写的是凌晨 2 点自慰，生图结果却是白天」。
 * `imagePromptPreparer.composeImagePrompt` 的时段锚点**只有调用方显式传 `timeOfDay`
 * 才会注入**（不传 = 与改动前逐字节一致，这是红线）——上游当时只接了朋友圈
 * （`moments.js` 传 `at`），日程（peek/retake）、聊天链路、特殊日程朋友圈都没接，
 * 导致同类 bug 在这些链路上仍然存在（F-15）。
 *
 * 本测试是「接线契约」：扫描生图调用点，断言**描绘角色生活时刻**的生图点
 * 都把时刻传给了生图链路。以后再新增生图点，不接时段锚点会在这里变红。
 *
 * ── 为什么用源码扫描而不是跑真实调用 ────────────────────────
 * 这些路由/服务跑起来依赖真实 LLM + ComfyUI（生图失败路径不返回 promptRefined），
 * 测试环境禁网，无法在行为层验证「传没传」；接线类修复用扫描护栏可穷举调用点。
 *
 * ── 豁免（有理由的白名单，新增豁免必须写清理由）──────────────
 * · `handleDreamTalkReply`（做梦配图）：梦境是超现实内容，光照属于梦的一部分，
 *   锚定现实时刻会把「白天草原的梦」在凌晨压成黑夜 —— 语义上就不该锚。
 * · `generateTownNpcMomentImages` / 小镇链路：小镇子系统未启用（maps=0），
 *   本次不接线，登记为遗留观察项，待小镇启用时一并处理。
 * 注意：豁免只按**被扫描到的调用**判定；豁免函数体内的调用会被跳过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * 从 `(` 起的调用参数整体（配对括号感知；跳过字符串与注释）。
 * 返回 { text, end }；无法配对时 end = -1。
 */
function extractCallArgs(src, openIdx) {
  let depth = 0, i = openIdx, n = src.length;
  let inS = null; // 字符串状态：' " `
  while (i < n) {
    const c = src[i], c2 = src.slice(i, i + 2);
    if (inS) {
      if (c === '\\') { i += 2; continue; }
      if (c === inS) inS = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inS = c; i++; continue; }
    if (c2 === '//') { const nl = src.indexOf('\n', i); i = nl === -1 ? n : nl; continue; }
    if (c2 === '/*') { const cl = src.indexOf('*/', i + 2); i = cl === -1 ? n : cl + 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return { text: src.slice(openIdx, i + 1), end: i }; }
    i++;
  }
  return { text: src.slice(openIdx), end: -1 };
}

/** 找 callee 的调用点（排除 import 行与函数定义行）；附行号与所在函数名 */
function findCalls(src, callee) {
  const re = new RegExp(`(?<![\\w$.])${callee}\\s*\\(`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 60), m.index);
    if (/function\s+$/.test(before)) continue;     // 函数定义行
    if (/import\b[\s\S]{0,40}$/.test(before)) continue; // import 行
    const openIdx = m.index + m[0].length - 1;
    const { text, end } = extractCallArgs(src, openIdx);
    // 所在函数名：向前找最近一个 function NAME(
    const prefix = src.slice(0, m.index);
    const fm = [...prefix.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
    const enclosing = fm.length ? fm[fm.length - 1][1] : null;
    out.push({ line: src.slice(0, m.index).split('\n').length, enclosing, args: text, end });
    re.lastIndex = Math.max(re.lastIndex, end > 0 ? end : m.index + m[0].length);
  }
  return out;
}

/** 检查调用参数里是否出现指定键（如 timeOfDay / at） */
function hasKey(args, key) {
  return new RegExp(`[{,\\s]${key}\\s*:`).test(args);
}

// ── 接线规则表 ─────────────────────────────────────────────
// keys：满足其一即可（朋友圈链路习惯用 `at` 传给包装函数，包装函数内部再转成 timeOfDay）
const RULES = [
  {
    file: 'routes/schedule.js',
    callee: 'generateImage',
    keys: ['timeOfDay'],
    expect: 2, // peek（瞄一眼）+ peek/retake（再拍一张）
    exempt: () => false,
  },
  {
    file: 'routes/chat.js',
    callee: 'generateImage',
    keys: ['timeOfDay'],
    expect: 2, // triggerImageGeneration（聊天配图）+ handleDreamTalkReply（做梦配图，豁免）
    exempt: (c) => c.enclosing === 'handleDreamTalkReply',
  },
  {
    file: 'routes/moments.js',
    callee: 'generateImageRaw',
    keys: ['timeOfDay'],
    expect: 2, // generateMomentImages 内 1 处 + generateTownNpcMomentImages 内 1 处（豁免）
    exempt: (c) => c.enclosing === 'generateTownNpcMomentImages',
  },
  {
    file: 'routes/moments.js',
    callee: 'generateMomentImages',
    keys: ['at', 'timeOfDay'],
    expect: 3, // 发帖即此刻 / 补图重绘 / 特殊日程朋友圈
    exempt: () => false,
  },
];

test('★ F-15 接线护栏：描绘角色生活时刻的生图点必须传时刻（否则不注入时段锚点）', () => {
  const violations = [];
  for (const rule of RULES) {
    const src = read(rule.file);
    const calls = findCalls(src, rule.callee);
    assert.equal(
      calls.length, rule.expect,
      `${rule.file} 中 ${rule.callee} 调用点数量变了（期望 ${rule.expect}，实际 ${calls.length}）——` +
      `新增/删除生图点后请同步更新本测试的规则表`,
    );
    for (const c of calls) {
      if (rule.exempt(c)) continue;
      if (!rule.keys.some((k) => hasKey(c.args, k))) {
        violations.push(
          `${rule.file}:${c.line} ${rule.callee}()${c.enclosing ? `（${c.enclosing} 内）` : ''} 未传 ${rule.keys.join(' / ')}`
        );
      }
    }
  }
  assert.deepEqual(
    violations, [],
    '以下生图点没有把「画面发生的时刻」传给生图链路，凌晨的活动/聊天会画成白天光：\n' + violations.join('\n'),
  );
});

test('扫描器自检：括号配对、字符串内括号不误判、定义行不误扫', () => {
  const fake = `
import { generateImage } from './x.js';
async function generateImage(a, b) { return a; }
const r = await generateImage(prompt, {
  scene: 'chat',
  note: 'a) tricky ) paren',
  onProgress: (p) => { fn(p); },
});
`;
  const calls = findCalls(fake, 'generateImage');
  assert.equal(calls.length, 1, '应只扫到 1 个调用点（定义行与 import 行排除）');
  assert.ok(calls[0].args.includes("note: 'a) tricky ) paren'"), '字符串里的括号不应打断配对');
  assert.equal(hasKey(calls[0].args, 'timeOfDay'), false);
});
