/**
 * F-48 回归：memoryExtractor → memoryRepository 的调用契约「无死参数」护栏（2026-10-14）。
 *
 * 缺陷现场：`curateNow` 调 `applyMemoryActions` 时多传了一个**仓储签名里不存在**的形参
 * （一个回调，传给谁都不接的键被 JS 静默忽略）——无运行时影响，但属「契约脏 + 误导后人」：
 * 读代码者会误以为证据走那个回调通道。
 *
 * 现行契约（三段链路，F-47 结案时已核实完好）：
 *   闸门把 `_evidence` 挂在各 action 顶层（memoryEvidenceGate.js）
 *   → `validateMemoryAction` 合并进 `memory.evidence`（memoryRepository.js）
 *   → INSERT 写证据四列（evidence_text/count/msg_id/verified）。
 *
 * ⚠ 本测试不依赖闸门开关；static 部分读源码，行为部分走纯函数 `validateMemoryAction`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = path.join(os.tmpdir(), `linshe-extractor-contract-${Date.now()}.db`);
process.env.DB_PATH = TMP;
globalThis.fetch = async url => { throw new Error(`extractor contract test forbids network: ${url}`); };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');
const extractorSrc = fs.readFileSync(path.join(SRC, 'services/memoryExtractor.js'), 'utf8');

/** 提取 `fnName({ ... })` 的完整参数段（从 `(` 起配平最外层圆括号）。 */
function extractCallSegment(src, fnName) {
  const at = src.indexOf(`${fnName}({`);
  if (at < 0) return null;
  const open = at + fnName.length;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// ① 守卫：现行证据契约成立（不因删死参数而回归）
// ─────────────────────────────────────────────────────────

test('守卫：`_evidence` 通道是证据落库的现行契约（validateMemoryAction 合并四字段）', async () => {
  const { validateMemoryAction } = await import('../src/services/memory/memoryRepository.js');
  const out = validateMemoryAction({
    action: 'create',
    _evidence: { verified: 1, text: '一只叫豆豆的猫', count: 2, msgId: 7 },
    memory: { memoryType: 'knowledge', subject: 'user', judgment: '用户养了一只叫豆豆的猫', reasoning: 'r', tags: ['宠物'] },
  });
  assert.equal(out.memory.evidence?.text, '一只叫豆豆的猫', '引文应合入 memory.evidence');
  assert.equal(out.memory.evidence?.count, 2);
  assert.equal(out.memory.evidence?.msgId, 7);
  assert.equal(out.memory.evidence?.verified, 1);
});

test('守卫：调用段按预期形态存在、可被提取（防提取器失效的假绿）', () => {
  const seg = extractCallSegment(extractorSrc, 'applyMemoryActions');
  assert.ok(seg, '应能定位 applyMemoryActions({...}) 调用段');
  assert.ok(seg.includes('conversationId') && seg.includes('eventTime'),
    '调用段应含既有传参（提取有效性对照）');
});

// ─────────────────────────────────────────────────────────
// ② 主断言：不得再传无接收方的死参数（F-48）
// ─────────────────────────────────────────────────────────

test('★ F-48：调用侧不得出现仓储签名里不存在的死参数', () => {
  const seg = extractCallSegment(extractorSrc, 'applyMemoryActions');
  assert.ok(seg, '卫：调用段存在（本断言依赖 ① 的提取器）');
  assert.ok(!extractorSrc.includes('evidenceOf'),
    'memoryExtractor 全文件不应再出现该死参数——证据走 `_evidence` 通道，无回调形参');
  assert.ok(!seg.includes('evidenceOf'), '调用段内尤其不得出现');
});
