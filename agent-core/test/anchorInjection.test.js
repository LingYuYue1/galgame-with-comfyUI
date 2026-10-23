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
  // ★ 2026-10-23：人数标签由 applyAnchors 统一加在最前，所以锚点内容从首行的**第二段**开始
  assert.ok(out.finalPrompt.split('\n')[0].includes(out.anchorText), '锚点必须在最前面');
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

test('锚点超长：先砍体型/肤色，仍超也不硬砍（1500 软上限）', () => {
  // ★ 2026-10-23 实测订正：上限 450 → 900 → **1500 且不硬砍**。
  //   实测（scripts/probe-prompt-length.mjs）：955 / 2957 / 5956 / 9957 字符
  //   四档全部出图成功，~3000 以内全部内容生效，~6000 起末尾开始失真。
  //   ComfyUI 的 QwenImageTokenizer 是 max_length=99999999 —— 根本不会截断。
  //   所以这里只保留"砍体型/肤色"这一层（对认人贡献最小），绝不从尾部弹服装。
  const db = getDb();
  seq += 1;
  const name = `__inject_long_${Date.now()}`;
  const r = db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?,?,?)').run(name, name, '你是测试。');
  const id = Number(r.lastInsertRowid);
  const longBody = `long dark brown hair with pink gradient tips, fluorescent pink eyes, fair skin, petite slender build, ${'extra detail, '.repeat(200)}`;
  db.prepare('INSERT INTO character_outfits (character_id, name, description, scene, body) VALUES (?,?,?,?,?)')
    .run(id, '日常装', 'jacket', 'work', longBody);
  const out = applyAnchors(PROMPT, { anchors: [{ characterId: id, slot: 'self' }] });
  assert.ok(out.anchorText.includes('dark brown'), '把发色弄丢了');
  assert.ok(/eyes?/i.test(out.anchorText), '把瞳色弄丢了');
  assert.ok(!/petite slender|fair skin/i.test(out.anchorText), '体型/肤色该先被砍');
  assert.ok(out.anchorText.includes('jacket'), '★ 服装必须留着（原实现会从尾部弹掉它）');
  assert.ok(out.anchorText.length > 1500, '★ 超过软上限也不再硬砍');
});

// ── ★ 2026-10-23：锚点注入引发的「人数翻倍」bug ──
// 根因：finalizeCountTags 原来按 **累加** 统计人数。锚点注入后提示词必然出现
// 两处 `1girl`（锚点行 + LLM 场景词），累加得 2 → 提交的是 `2girls, … solo …`（自相矛盾）。
// 阶段 4 之后所有链路都会踩，只是 solo 在场时模型压过去了，才没露出来。
// 修法：人数由 **锚点条数** 决定，applyAnchors 剥掉各处人数标签后只写一个权威值。
test('★ 单人锚点：最终提示词只有 1girl，不出现 2girls', () => {
  const id = makeCharacter();
  const out = applyAnchors('1girl, solo, standing on a stage', {
    anchors: [{ characterId: id, slot: 'self' }],
  });
  const head = out.finalPrompt.split('\n')[0];
  assert.ok(head.startsWith('1girl'), `首行应以 1girl 开头，实得：${head.slice(0, 50)}`);
  assert.ok(!/\b2girls\b/.test(out.finalPrompt), '不该出现 2girls');
  // 场景词里原来那处 1girl 应被剥掉（避免重复计数）
  assert.equal((out.finalPrompt.match(/\b1girl\b/g) || []).length, 1, '1girl 只该出现一次');
  // 剥离不能把别的词弄坏
  assert.ok(out.finalPrompt.includes('solo'), 'solo 要留着');
  assert.ok(out.finalPrompt.includes('standing on a stage'), '场景词要留着');
});

test('★ 双人锚点：人数按锚点条数 → 2girls（不靠场景词猜）', () => {
  const a = makeCharacter();
  const b = makeCharacter();
  const out = applyAnchors('standing side by side', {
    anchors: [{ characterId: a, slot: 'self' }, { characterId: b, slot: 'other', side: 'left' }],
  });
  assert.ok(out.finalPrompt.startsWith('2girls'), `双人应以 2girls 开头：${out.finalPrompt.slice(0, 50)}`);
  assert.equal((out.finalPrompt.match(/\b1girl\b/g) || []).length, 0, '锚点行里的人数标签应被剥掉');
});
