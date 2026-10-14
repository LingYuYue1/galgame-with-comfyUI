/**
 * F-50 回归测试：大纲编辑器载荷「节点 ↔ 原文块」对齐（残缺块不再引发错位）
 *
 * 缺陷路径：raw 里可能存在「要素不全」的残缺块——用户在 Scene 弹窗把 Scene 清空时，
 * 该行被删、块留在原文（StoryOutlineSceneModal 明示「留空会删掉这一节点的 Scene ——
 * 节点要素不全后将不再被识别为有效节点（**但不影响已写内容**）」）。
 * parseCompleteOutline 会把残缺块过滤掉，但 getOutlineForEditor 原先的配对约定是
 * 「前端按 beats[i] ↔ blocks[i] 下标对齐」——一旦存在残缺块，从它开始**整体错位**：
 * 后续节点会拿到**别人的原文块**，编辑器往返保存（未改动节点原样回传 raw）时
 * 把别人的块写到自己的位置、自己的原文丢失 —— 直接违反上述「不影响已写内容」承诺。
 *
 * 修复：服务端为每个完整 Beat 附 `rawIndex`（它在原始块序列中的真实下标），
 * 前端按 rawIndex 取块。
 *
 * ⚠ 全部内存库；不调 LLM。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`outline align test forbids network: ${url}`); };

// 迁移在 app.js 里加载；测试不跑 app.js → 显式按同一序列跑一遍
const { loadFeatureMigrations } = await import('../src/db/migrations/index.js');
const { runRegisteredMigrations } = await import('../src/db/migrationRegistry.js');
const { getDb } = await import('../src/db/index.js');
await loadFeatureMigrations();
runRegisteredMigrations(getDb());

const svc = await import('../src/services/story/outlineService.js');

/** 一个完整块 */
function fullBlock(t, title, sceneTag) {
  return [
    `Beat: ${t}|${title}|主线|A线|结果`,
    `Scene: ${sceneTag}的场景内容`,
    `Subtext: ${title}的潜台词`,
    `Think: ${title}的叙事作用`,
  ].join('\n');
}

/** 一个残缺块（缺 Scene —— 模拟「被清空 Scene」的节点） */
function brokenBlock(t, title) {
  return [
    `Beat: ${t}|${title}|主线|A线|结果`,
    `Subtext: ${title}的潜台词`,
    `Think: ${title}的叙事作用`,
  ].join('\n');
}

/** 甲✓ / 乙✗ / 丙✓ —— 残缺块在中间，丙的块在下标 2 */
function rawWithBrokenMiddle() {
  return [
    '<outline_widget>',
    fullBlock('第一天', '甲标题', '甲'),
    brokenBlock('第二天', '乙标题'),
    fullBlock('第三天', '丙标题', '丙'),
    '</outline_widget>',
  ].join('\n');
}

test('F-50 主断言：残缺块在中间时，后续节点拿到自己的原文块（rawIndex 对齐）', () => {
  svc.saveOutline({ raw: rawWithBrokenMiddle() });
  const ed = svc.getOutlineForEditor();
  assert.equal(ed.blocks.length, 3, '三个原始块');
  assert.equal(ed.beats.length, 2, '两个完整节点（残缺的乙被过滤）');
  assert.equal(ed.beats[0].title, '甲标题');
  assert.equal(ed.beats[1].title, '丙标题');
  assert.equal(ed.beats[0].rawIndex, 0);
  assert.equal(ed.beats[1].rawIndex, 2, '丙的真实块下标 = 2（修复前无此字段 → 前端退回下标 1、配到乙的残块）');
  assert.ok(ed.blocks[ed.beats[1].rawIndex].includes('丙的场景内容'), 'rawIndex 指向的必须是丙自己的块');
});

test('F-50 主断言（行为）：编辑器往返保存后，丙的原文不丢、乙的残块不串位', () => {
  svc.saveOutline({ raw: rawWithBrokenMiddle() });
  const ed = svc.getOutlineForEditor();
  // 模拟前端 submit：未改动的节点按 rawIndex 回传自己的原文块
  const items = ed.beats.map((b, i) => ({ raw: ed.blocks[b.rawIndex ?? i] }));
  svc.saveOutlineFromEditor({ prefix: ed.prefix, suffix: ed.suffix, separator: ed.separator, items });
  const cur = svc.getOutline();
  assert.ok(cur.raw.includes('丙的场景内容'), '丙的完整内容必须保留（修复前会被乙的残块顶掉、丙原文丢失）');
  assert.ok(!cur.raw.includes('乙的潜台词'), '残缺块不在编辑器序列里、不该被当作丙的原文写入（修复前会）');
});

test('F-50 守卫：无残缺块时编辑器往返保存逐字节一致（修复前后均应为绿）', () => {
  const clean = [
    '<outline_widget>',
    fullBlock('第一天', '甲标题', '甲'),
    fullBlock('第二天', '乙标题', '乙'),
    fullBlock('第三天', '丙标题', '丙'),
    '</outline_widget>',
  ].join('\n');
  svc.saveOutline({ raw: clean });
  const ed = svc.getOutlineForEditor();
  // 模拟前端（带旧服务端回落）：无残缺时 rawIndex 与下标一致，两版行为必须相同
  const items = ed.beats.map((b, i) => ({ raw: ed.blocks[b.rawIndex ?? i] }));
  svc.saveOutlineFromEditor({ prefix: ed.prefix, suffix: ed.suffix, separator: ed.separator, items });
  assert.equal(svc.getOutline().raw, clean, '无缺失场景下必须逐字节一致（编辑器红线）');
});

test('F-50 契约：无残缺块时 rawIndex = 0..n-1（新字段的主路径）', () => {
  svc.saveOutline({ raw: [
    '<outline_widget>',
    fullBlock('第一天', '甲标题', '甲'),
    fullBlock('第二天', '乙标题', '乙'),
    fullBlock('第三天', '丙标题', '丙'),
    '</outline_widget>',
  ].join('\n') });
  const ed = svc.getOutlineForEditor();
  assert.deepEqual(ed.beats.map(b => b.rawIndex), [0, 1, 2], '完整序列不引入额外偏移');
});

test('F-50 守卫：残缺块在末尾时，前置完整节点的配对不受影响（修复前后均应为绿）', () => {
  const raw = [
    '<outline_widget>',
    fullBlock('第一天', '甲标题', '甲'),
    fullBlock('第二天', '乙标题', '乙'),
    brokenBlock('第三天', '丙标题'),
    '</outline_widget>',
  ].join('\n');
  svc.saveOutline({ raw });
  const ed = svc.getOutlineForEditor();
  assert.equal(ed.blocks.length, 3);
  assert.equal(ed.beats.length, 2);
  assert.equal(ed.beats[1].title, '乙标题');
  assert.ok(ed.blocks[1].includes('乙的场景内容'), '末尾残缺不影响前面块的配对');
});
