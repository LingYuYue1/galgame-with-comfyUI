/**
 * LLM 额度策略护栏（2026-10-19 改写；原 F-62「短预算必须声明 thinking」已退役）
 *
 * ── 为什么改 ────────────────────────────────────────────────
 * 旧判据是「`max_tokens` 字面量 ≤1536 的调用块里必须出现 `thinking:`」——
 * 它成立的前提是**预算由调用点决定**。v3.10 起上游把额度统一收口到
 * `config.llm.maxTokens`（`applyOutputTokenLimit`），`_chatSyncInner` 的入参里
 * 已经没有 `max_tokens` 了：写它不报错、不警告、直接被丢弃。
 * 前提消失，旧判据就变成空过（源码里一个 max_tokens 都没有，它自然通过）。
 *
 * ── 现在的两条不变量 ───────────────────────────────────────
 * ① 源码里**不许再出现 `max_tokens:`**（死参数，写了也不生效，只会误导下一个读代码的人）；
 *    要覆盖额度请用 `maxTokens:`——它走 llm-client 的例外通道。
 * ② `maxTokens:` 只允许出现在**例外清单**里（合并方案 §5-1）：
 *    「短预算本身就是业务语义」的少数调用点。清单外的写法一律要论证后加进来，
 *    不允许悄悄多出一个。
 *
 * ── 这测不到什么（别当成万能）────────────────────────────────
 * · 它不判断额度取值合不合理（那是人的判断，记在方案 §5-1）；
 * · 它不检查全局额度 `config.llm.maxTokens` 的配置（见 config.js / settings）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** 例外清单（与 docs/上游合并-v3.10-施工方案.md §5-1 一一对应） */
const ALLOWED_LABELS = [
  'maibot-judge-image',   // 图像判定，只要 yes/no
  '判断需要图片',          // 同上
  '预测',                 // 结构化 JSON 短输出
  '奇遇紧急联络',          // 短联络
  '回评', '朋友首评', '发帖人回朋友', '朋友续评', '用户朋友圈评论', // 高频社交短文本
  '主动聊天',              // 高频
  'story:gen-line',       // 结构化短输出
  'story:outline-judge',  // 判定
  '网络搜索',              // 短查询
];

/** 按文件放行的「管道」位置（不是调用点预算，是机制本身） */
const ALLOWED_FILES = [
  'llm/llm-client.js',                    // applyOutputTokenLimit 内部实现
  'routes/config.js',                     // 设置接口转发字段
  'services/characterReactionPackService.js',
  'services/emotionEngine.js',
  'services/memoryExtractor.js',
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(SRC_DIR).map(abs => ({
  abs,
  rel: path.relative(SRC_DIR, abs).split(path.sep).join('/'),
  text: fs.readFileSync(abs, 'utf8'),
}));

test('★ 源码里不许再出现死参数 max_tokens（写它也不生效）', () => {
  const hits = [];
  for (const f of files) {
    f.text.split(/\r?\n/).forEach((line, i) => {
      if (/max_tokens\s*:/.test(line) && !/maxTokens/.test(line)) hits.push(`${f.rel}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `发现 ${hits.length} 处失效的 max_tokens，请改成 maxTokens 或删除：\n${hits.join('\n')}`);
});

test('★ maxTokens 只允许出现在例外清单（§5-1）', () => {
  const violations = [];
  const allowed = [];
  for (const f of files) {
    if (f.rel === 'config.js') continue;            // getter / setter 自身
    f.text.split(/\r?\n/).forEach((line, i) => {
      if (!/maxTokens\s*:/.test(line)) return;
      const byFile = ALLOWED_FILES.includes(f.rel);
      const byLabel = ALLOWED_LABELS.some(l => line.includes(`'${l}'`));
      (byFile || byLabel ? allowed : violations).push(`${f.rel}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(violations, [], `以下 maxTokens 不在例外清单里，先论证再登记到 §5-1：\n${violations.join('\n')}`);
  assert.ok(allowed.length > 0, '例外清单一个都没命中 —— 要么清单过时，要么扫描坏了');
});
