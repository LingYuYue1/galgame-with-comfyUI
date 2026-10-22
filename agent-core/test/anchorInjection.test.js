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

test('多个角色 → 一人一句，**每人都整段**且带位置（2026-10-22 夜间订正）', () => {
  // 订正原因：用户实报同框第二个人画得不像。原来第二人走 compact，
  // 只剩发型+瞳色（符玄 737→134 字），脸/衣服/体型全丢。
  // 判据：**稀释只是权重降低，缺字段是直接画错** —— 宁可长，不可缺。
  const a = makeCharacter();
  const b = makeCharacter();
  const out = applyAnchors(PROMPT, {
    anchors: [{ characterId: a, slot: 'self' }, { characterId: b, slot: 'other', side: 'right' }],
  });
  const lines = out.finalPrompt.split('\n');
  assert.equal(lines.length >= 3, true, '应该是两行锚点 + 原提示词');
  assert.ok(lines[0].includes('dark brown'), `第一人：${lines[0]}`);
  assert.ok(lines[1].startsWith('the girl on the right'), `第二人位置词：${lines[1]}`);
  assert.ok(lines[1].includes('dark brown'), '★ 第二人也必须有完整外观（这就是之前丢的）');
  assert.ok(lines[1].includes('red cheongsam'), '★ 第二人的衣服必须保留');
  assert.ok(lines[1].includes('petite slender build'), '★ 体型也不能丢');
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

test('锚点文本过长时被压缩，但发色/瞳色仍在（900 上限保护）', () => {
  const db = getDb();
  seq += 1;
  const name = `__inject_long_${Date.now()}`;
  const r = db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?,?,?)').run(name, name, '你是测试。');
  const id = Number(r.lastInsertRowid);
  const longBody = `long dark brown hair with pink gradient tips, fluorescent pink eyes, fair skin, petite slender build, ${'extra detail, '.repeat(60)}`;
  db.prepare('INSERT INTO character_outfits (character_id, name, description, scene, body) VALUES (?,?,?,?,?)')
    .run(id, '日常装', 'jacket', 'work', longBody);
  const out = applyAnchors(PROMPT, { anchors: [{ characterId: id, slot: 'self' }] });
  // ★ 2026-10-22：上限 450 → 900。实测最长锚点（符玄）737 字符，
  //   450 会把服装整段砍掉 —— 那不是"压缩"，是把人画错。
  assert.ok(out.anchorText.length <= 900, `锚点 ${out.anchorText.length} 字符，超过 900`);
  assert.ok(out.anchorText.includes('dark brown'), '压缩把发色弄丢了');
  assert.ok(/eyes?/i.test(out.anchorText), '压缩把瞳色弄丢了');
});
