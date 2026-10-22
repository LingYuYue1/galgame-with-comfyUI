/**
 * 锚点注入层 applyAnchors()（2026-10-22）
 *
 * 用户原话：「让所有生图链路生成对应角色时候使用其角色锚点」。
 * 实现要点：锚点由**代码**拼进最终提示词最前，不再靠 LLM 转述；
 * 同时必须保证"没传 anchors 的链路，提示词一个字节都不变"——否则会误伤所有已有出图。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db/index.js';
import { applyAnchors } from '../src/services/imageSkill.js';
import { config } from '../src/config.js';

let seq = 0;
function makeCharacter() {
  const db = getDb();
  seq += 1;
  const name = `__inject_test_${Date.now()}_${seq}`;
  const r = db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?,?,?)')
    .run(name, name, `你是${name}。\n\n## 你的外观\n- 浅粉色长发\n`);
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO character_outfits (character_id, name, description, scene, body) VALUES (?,?,?,?,?)')
    .run(id, '日常装', 'black jacket, red cheongsam', 'work',
      'long dark brown hair with pink gradient tips, fluorescent pink eyes, fair skin, petite slender build');
  return id;
}

const PROMPT = 'a street ramen counter at noon, warm light, steam';

test('★ 不传 anchors → 提示词逐字节不变（不能误伤已有链路）', () => {
  const out = applyAnchors(PROMPT, {});
  assert.equal(out.finalPrompt, PROMPT);
  assert.equal(out.anchorText, '');
});

test('★ 传了 anchors → 锚点在最前，场景词在后', () => {
  const id = makeCharacter();
  const out = applyAnchors(PROMPT, { anchors: [{ characterId: id, slot: 'self' }] });
  assert.ok(out.anchorText.includes('dark brown'), `锚点文本：${out.anchorText}`);
  assert.ok(out.finalPrompt.startsWith(out.anchorText), '锚点必须在最前面');
  assert.ok(out.finalPrompt.includes(PROMPT), '原提示词不能被吞掉');
  assert.ok(out.finalPrompt.indexOf('dark brown') < out.finalPrompt.indexOf('ramen'), '锚点应排在场景词之前');
});

test('总开关关闭 → 退回改造前行为（提示词不变）', () => {
  const id = makeCharacter();
  const saved = config.comfyui.anchorInjection;
  try {
    config.comfyui.anchorInjection = false;
    const out = applyAnchors(PROMPT, { anchors: [{ characterId: id, slot: 'self' }] });
    assert.equal(out.finalPrompt, PROMPT);
    assert.equal(out.anchorText, '');
  } finally {
    config.comfyui.anchorInjection = saved;
  }
});

test('多个角色 → 一人一句，第二个起是精简版且带位置', () => {
  const a = makeCharacter();
  const b = makeCharacter();
  const out = applyAnchors(PROMPT, {
    anchors: [{ characterId: a, slot: 'self' }, { characterId: b, slot: 'other', side: 'right' }],
  });
  const lines = out.finalPrompt.split('\n');
  assert.equal(lines.length >= 3, true, '应该是两行锚点 + 原提示词');
  assert.ok(lines[0].includes('dark brown'), `第一人：${lines[0]}`);
  assert.ok(lines[1].startsWith('the girl on the right'), `第二人：${lines[1]}`);
  assert.ok(lines[1].length < lines[0].length, '第二人应是精简版');
});

test('★ 角色 id 非法 → 不注入也不抛错（生图不能因为锚点崩）', () => {
  const out = applyAnchors(PROMPT, { anchors: [{ characterId: 99999999, slot: 'self' }] });
  assert.equal(out.finalPrompt, PROMPT);
  assert.equal(out.anchorText, '');
});

test('空的 anchors 数组 / null → 不注入', () => {
  assert.equal(applyAnchors(PROMPT, { anchors: [] }).finalPrompt, PROMPT);
  assert.equal(applyAnchors(PROMPT, { anchors: null }).finalPrompt, PROMPT);
});

test('锚点文本过长时被压缩，但发色/瞳色仍在（450 上限保护）', () => {
  const db = getDb();
  seq += 1;
  const name = `__inject_long_${Date.now()}`;
  const r = db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?,?,?)').run(name, name, '你是测试。');
  const id = Number(r.lastInsertRowid);
  const longBody = `long dark brown hair with pink gradient tips, fluorescent pink eyes, fair skin, petite slender build, ${'extra detail, '.repeat(60)}`;
  db.prepare('INSERT INTO character_outfits (character_id, name, description, scene, body) VALUES (?,?,?,?,?)')
    .run(id, '日常装', 'jacket', 'work', longBody);
  const out = applyAnchors(PROMPT, { anchors: [{ characterId: id, slot: 'self' }] });
  assert.ok(out.anchorText.length <= 450, `锚点 ${out.anchorText.length} 字符，超过 450`);
  assert.ok(out.anchorText.includes('dark brown'), '压缩把发色弄丢了');
  assert.ok(/eyes?/i.test(out.anchorText), '压缩把瞳色弄丢了');
});
