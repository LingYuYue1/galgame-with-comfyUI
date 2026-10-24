/**
 * B1-a · 日程「每段必填」契约（2026-10-24）
 *
 * ── 为什么换契约 ───────────────────────────────────────────────
 * 旧契约（2026-10-04 起）：**只在「换装的那一刻」标 outfit**，其余时段 `null` = 沿用上一段，
 * 消费端（`getSceneOutfitForNow`）靠**向前回溯**补出每段该穿什么。
 *
 * 问题不在这个设计本身，而在它的前提：**回溯链一旦断掉，角色就会穿错**。
 * 实测 29 份日程：4 份一个换装点都没有（`#4` 两天、`#171` 两天），那两天全靠兜底，
 * 而 `#171` 的根因是它当时只有 `work` 一套服装 —— `buildOutfitAnnotateLayer` 开头
 * `if (outfits.length < 2) return null` 直接不注入标注层，天然 0 标注。
 *
 * 新契约（2026-10-24 用户定）：**每个时段都写明确服装名**。
 * 语义同时降级 —— 日程的 `outfit` 是**保底层**，不是"此刻穿什么"的唯一真源：
 *   ① 日程 floor（每段必填，保底）→ ② 内容层 truth（朋友圈/媒体按内容选）→ ③ 硬边界 gate
 * 优先级 ② > ①，③ 压一切。详见施工方案 §4.0.1。
 *
 * ── 本文件钉住什么 ────────────────────────────────────────────
 * 1. 标注提示词**不许**再教模型"只在换装点标""填 null"
 * 2. 标注提示词的示例 JSON 必须**每行都带 outfit**（示例是模型最认的格式）
 * 3. 覆盖率判据：任何一段为空就必须判为需修复（旧判据是「换装点 < 4」）
 * 4. 回溯仍然可用 —— 那是旧 29 份数据的兼容路径，不许删
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from '../src/db/index.js';
import {
  buildOutfitAnnotateLayer, outfitCoverageGap, DEFAULT_NAME_BY_SCENE,
} from '../src/services/outfitScene.js';

let seq = 0;

/** 造一个「有 4 套服装」的测试角色 —— 少于 2 套时标注层直接返回 null */
function makeCharacterWithOutfits() {
  const db = getDb();
  seq += 1;
  const name = `__per_seg_test_${Date.now()}_${seq}`;
  const r = db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?,?,?)')
    .run(name, name, '你是测试角色。');
  const cid = Number(r.lastInsertRowid);
  const add = (scene, desc) => db.prepare(
    'INSERT INTO character_outfits (character_id, name, description, scene, body) VALUES (?,?,?,?,?)',
  ).run(cid, DEFAULT_NAME_BY_SCENE[scene] || scene, desc, scene, 'test body, long black hair');
  add('nude', 'completely nude');
  add('work', 'black blazer, white shirt');
  add('home', 'grey tee, shorts');
  add('sleep', 'white camisole, barefoot');
  return cid;
}

function cleanup(cid) {
  const db = getDb();
  db.prepare('DELETE FROM character_outfits WHERE character_id = ?').run(cid);
  db.prepare('DELETE FROM characters WHERE id = ?').run(cid);
}

test('★ 标注提示词必须改成「每段必填」，不许再教模型只标换装点', (t) => {
  const cid = makeCharacterWithOutfits();
  t.after(() => cleanup(cid));

  const layer = buildOutfitAnnotateLayer(cid);
  assert.ok(layer, '有 4 套服装时标注层必须生成');

  // ① 旧口径必须消失 —— 这两句是"只标换装点"的核心表述
  assert.ok(!/只在「换装的那一刻」填写/.test(layer),
    '旧口径「只在换装的那一刻填写」必须删掉，否则模型照旧留空');
  assert.ok(!/其余时段填\s*`?null`?/.test(layer),
    '旧口径「其余时段填 null」必须删掉');

  // ② 新口径必须出现
  assert.ok(/每个时段都必须给出值/.test(layer),
    '必须明确写「每个时段都必须给出值」');

  // ③ 「4 个时点必须标」这种写法会诱导模型只标那 4 个 —— 必须改写成"最容易标错"
  assert.ok(!/以下 4 个时点\*\*必须\*\*标 outfit/.test(layer),
    '「以下 4 个时点必须标」会被读成"只标这 4 个"，须改写');

  // ④ 自检里不许再出现「通常是 4~6 个」的数量暗示
  assert.ok(!/通常是\s*4~6\s*个/.test(layer),
    '「通常是 4~6 个」是旧契约的数量暗示，须删');
});

test('★ 标注提示词的示例 JSON：每一行都必须带 outfit（示例比规则更影响模型）', (t) => {
  const cid = makeCharacterWithOutfits();
  t.after(() => cleanup(cid));

  const layer = buildOutfitAnnotateLayer(cid);
  const exampleLines = String(layer).split('\n')
    .filter(l => l.trim().startsWith('{"startTime"'));
  assert.ok(exampleLines.length >= 5, `示例行应 ≥5 行，实际 ${exampleLines.length}`);

  const missing = exampleLines.filter(l => !/"outfit"\s*:\s*"/.test(l));
  assert.deepEqual(missing, [],
    `示例里这些行没带 outfit，模型会照着留空：\n${missing.join('\n')}`);
});

test('★ 覆盖率判据：任何一段为空 → 必须判为需修复（旧判据是换装点 < 4）', () => {
  const valid = new Set(['工作装', '居家服', '睡衣', '便装']);

  // 全段有值 → 合格
  assert.equal(outfitCoverageGap([
    { startTime: '00:00', endTime: '06:00', outfit: '睡衣' },
    { startTime: '06:00', endTime: '08:00', outfit: '居家服' },
    { startTime: '08:00', endTime: '18:00', outfit: '工作装' },
    { startTime: '18:00', endTime: '23:00', outfit: '居家服' },
  ], valid), null, '每段都有值时不该判为需修复');

  // 换装点很多（> 旧的 floor 4），但仍有空段 → 新契约下**必须**判为需修复
  const gap = outfitCoverageGap([
    { startTime: '00:00', endTime: '06:00', outfit: '睡衣' },
    { startTime: '06:00', endTime: '08:00', outfit: '居家服' },
    { startTime: '08:00', endTime: '12:00', outfit: '工作装' },
    { startTime: '12:00', endTime: '13:00', outfit: null },          // ← 空
    { startTime: '13:00', endTime: '18:00', outfit: '工作装' },
    { startTime: '18:00', endTime: '23:00', outfit: '居家服' },
  ], valid);
  assert.ok(gap, '有 1 段为空时必须判为需修复（旧判据 marked≥4 会放过它）');
  assert.match(gap, /未标注|为空|缺/, `原因应说明是"有空段"，实际：${gap}`);

  // 非法服装名仍然要抓
  assert.ok(outfitCoverageGap([{ outfit: '不存在的衣服' }], valid), '非法名必须判为需修复');
});
