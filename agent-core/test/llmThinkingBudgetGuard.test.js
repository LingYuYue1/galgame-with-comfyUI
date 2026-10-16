/**
 * 静态护栏（F-62）：短预算的 `chatSync` 调用必须显式声明 `thinking`。
 *
 * ── 为什么要立这条规矩 ──────────────────────────────────────────────
 * 本机通道（opencode + deepseek-v4.1-flash）在 `LLM_THINKING_MODE=enabled` 下
 * **推理 token 计入 max_tokens**。调用方凡是按「正文长度」设预算的（≤ 1536 这批），
 * 思考一顶满就返回空正文 + `finish_reason='length'` —— 对调用方等同「模型没说话」：
 *   · wakeService / replyQueueScheduler：`throw new Error('Empty reply from LLM')`
 *   · peek 配图：落中文模板兜底 → 角色画成随机路人（F-60）
 *   · 日程生成：9400 token 的提示词思考吃满 2048 预算，必失败（F-58）
 * 上游默认注入的是 `disabled`，即这些调用点的**设计前提就是「预算全部归正文」**；
 * 本地把全局拨到 enabled 之后，需要逐个调用点显式找回原语义。
 *
 * ── 规矩（本测试钉住的不变量）────────────────────────────────────
 * `chatSync` 调用块内出现 `max_tokens` **字面量且 ≤ 1536** 时，必须同时出现 `thinking:`。
 * 新增这类调用时写 `thinking: { type: 'disabled' },` 即可；确实需要开思考的，
 * 请把预算抬到 1536 以上（思考 + 正文都要装得下）或显式写 `thinking: { type: 'enabled' }`。
 *
 * ── 已知边界（别把这条测试当成万能）──────────────────────────────
 * ① 只认**字面量**预算：`max_tokens: someVar` 不在覆盖范围（这类靠 llm-client 的
 *    F-62 降级重发兜底）；
 * ② 未显式写 `max_tokens` 的调用走 `_chatSyncInner` 默认 2048，不在本判据内；
 * ③ 扫描是正则近似（与 `scripts/f62-add-thinking-disabled.mjs` 同源），
 *    注释里的 `chatSync(` 用「本行之前有 // 或 *」的启发式排除。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
/** 预算 ≤ 此值视为「按正文长度设的预算」，必须显式声明思考开关 */
const THRESHOLD = 1536;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 简单启发式：匹配点所在行、其之前出现 // 或 * → 认为在注释里 */
function looksCommented(s, idx) {
  const lineStart = s.lastIndexOf('\n', idx) + 1;
  return /\/\/|\*/.test(s.slice(lineStart, idx));
}

function scanChatSyncCalls() {
  const calls = [];
  for (const file of walk(SRC_DIR)) {
    const s = fs.readFileSync(file, 'utf8');
    const re = /chatSync\(/g;
    let m;
    while ((m = re.exec(s))) {
      if (looksCommented(s, m.index)) continue;
      const seg = s.slice(m.index, m.index + 1500);
      const end = seg.search(/\}\s*\)/);
      const block = end > 0 ? seg.slice(0, end) : seg;
      const mt = block.match(/max_tokens\s*:\s*(\d+)/);
      calls.push({
        file: path.relative(SRC_DIR, file),
        line: s.slice(0, m.index).split('\n').length,
        hasThinking: /thinking\s*:/.test(block),
        maxTokens: mt ? Number(mt[1]) : null,
      });
    }
  }
  return calls;
}

test('短预算 chatSync 调用必须显式声明 thinking（F-58/F-60/F-62 同构缺口护栏）', () => {
  const calls = scanChatSyncCalls();

  // 非空性/非空转自检：扫描本身失效时必须报错，而不是「0 违规」地静默通过
  assert.ok(calls.length >= 80, `应扫描到 ≥80 个 chatSync 调用点（实际 ${calls.length}）—— 检查扫描逻辑是否被改坏`);
  const disabledCount = calls.filter(c => c.hasThinking).length;
  assert.ok(disabledCount >= 40, `显式声明 thinking 的调用点应 ≥40（实际 ${disabledCount}）—— 检查扫描逻辑是否被改坏`);

  const violations = calls
    .filter(c => !c.hasThinking && c.maxTokens !== null && c.maxTokens <= THRESHOLD)
    .map(c => `${c.file}:${c.line}（max_tokens=${c.maxTokens}）`);

  assert.deepEqual(
    violations,
    [],
    '这些调用点的预算按「正文长度」设置，思考会把预算吃光导致空返回。'
    + '请补 `thinking: { type: \'disabled\' },`（或把预算抬到 1536 以上）：\n  '
    + violations.join('\n  '),
  );
});
