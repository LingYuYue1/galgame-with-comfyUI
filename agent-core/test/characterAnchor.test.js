/**
 * 角色锚点统一入口 characterAnchor.js（2026-10-22）
 *
 * 钉住三件事：
 *  ① `resolveAnchor` 优先吃 `character_outfits.body`，没有服装行才退回人物卡外观段
 *  ② `buildAnchorLine` 的两种形态（整段 / 多人精简）与长度保护
 *  ③ `buildCharacterPersona({appearance})` 的三种分流 —— 生图只吃锚点，聊天仍读人物卡
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db/index.js';
import { resolveAnchor, buildAnchorLine, buildAnchorLines } from '../src/services/characterAnchor.js';
import { GIRL_POSITION_REFS } from '../src/services/mediaService.js';
import { buildCharacterPersona, buildCharacterAppearanceSection } from '../src/services/characterPersona.js';

let seq = 0;
function makeCharacter({ appearance = '- 浅粉色长发扎成双马尾，紫红色眼睛', base = '' } = {}) {
  const db = getDb();
  seq += 1;
  const name = `__anchor_test_${Date.now()}_${seq}`;
  const basePrompt = base || `你是测试角色。\n来自《测试作品》。\n\n## 你的外观\n${appearance}\n`;
  const r = db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?,?,?)')
    .run(name, name, basePrompt);
  return Number(r.lastInsertRowid);
}

function addOutfit(characterId, scene, { description, body = 'test body, long dark brown hair with pink gradient tips, fluorescent pink eyes, fair skin, petite build' } = {}) {
  getDb().prepare(
    'INSERT INTO character_outfits (character_id, name, description, scene, body) VALUES (?,?,?,?,?)',
  ).run(characterId, scene, description, scene, body);
}

test('★ resolveAnchor 显式 work：吃 body（这正是立绘原来漏掉的那份）', () => {
  const id = makeCharacter();
  addOutfit(id, 'work', { description: 'black jacket, red cheongsam' });
  const a = resolveAnchor(id, { scene: 'work' });
  assert.ok(a, '应该取到锚点');
  assert.equal(a.source, 'scene');
  assert.ok(a.text.includes('dark brown'), `expected body 文本，实得：${a.text.slice(0, 80)}`);
  assert.ok(!a.text.includes('浅粉色长发'), '不该混入人物卡旧外观段');
});

test('resolveAnchor auto：按日程/兜底选装，仍以 body 为基准', () => {
  const id = makeCharacter();
  addOutfit(id, 'work', { description: 'black jacket' });
  const a = resolveAnchor(id, { scene: 'auto' });
  assert.ok(a);
  assert.equal(a.sceneKey, 'work');
  assert.ok(a.text.includes('dark brown'));
});

test('角色没有任何服装行 → 退回人物卡外观段，并标明 source=card', () => {
  const id = makeCharacter({ appearance: '- 栗色短发，灰色眼睛' });
  const a = resolveAnchor(id, { scene: 'auto' });
  assert.ok(a);
  assert.equal(a.source, 'card');
  assert.ok(a.text.includes('栗色短发'));
});

test('不存在的角色 id → 返回 null，不抛错（生图不能因为锚点崩）', () => {
  assert.equal(resolveAnchor(99999999), null);
  assert.equal(resolveAnchor(null), null);
});

test('buildAnchorLine：整段保留，不做无谓截断', () => {
  const text = 'Name (Series), long dark brown hair with pink gradient tips, fluorescent pink eyes';
  assert.equal(buildAnchorLine(text), text);
});

test('buildAnchorLine compact：只留发型+瞳色，且丢掉身份前缀', () => {
  const text = 'Sparkle (Honkai: Star Rail), long dark brown hair with pink gradient tips, fluorescent pink eyes, fair skin, petite slender build';
  const c = buildAnchorLine(text, { compact: true });
  assert.ok(c.includes('hair'), '精简版必须保留发型');
  assert.ok(/eyes?/i.test(c), '精简版必须保留瞳色');
  assert.ok(!c.includes('Honkai'), '精简版应去掉身份前缀');
  assert.ok(!c.includes('fair skin'), '精简版不该带肤色/体型');
  assert.ok(c.length < text.length);
});

test('★ buildAnchorLine 超长才截，且发色/发型/瞳色留到最后', () => {
  const body = 'Name (Series), long dark brown hair with pink gradient tips, fluorescent pink eyes, fair skin, petite slender build, ' +
    'a small cherry blossom tattoo on her right collarbone, ' + 'extra detail, '.repeat(40);
  const out = buildAnchorLine(body, { maxLen: 200 });
  assert.ok(out.length <= 200, `超长未截：${out.length}`);
  assert.ok(out.includes('dark brown'), '把发色砍掉了 —— 那是锚点里最不该丢的');
  assert.ok(/eyes?/i.test(out), '把瞳色砍掉了');
  assert.ok(!out.includes('tattoo'), '应该先砍标志物，结果还留着');
});

test('buildAnchorLine 带 side：多人同框时标位置', () => {
  const out = buildAnchorLine('long white hair, blue eyes', { compact: true, side: 'left' });
  assert.ok(out.startsWith('the girl on the left'), out);
});

test('★ buildCharacterPersona appearance:\'anchor\' —— 生图不读人物卡外观段', () => {
  const id = makeCharacter();
  addOutfit(id, 'work', { description: 'black jacket' });
  const char = getDb().prepare('SELECT * FROM characters WHERE id=?').get(id);
  const anchorPersona = buildCharacterPersona(char, {
    variant: 'full', outfits: { limited: [{ name: '日常装', description: 'body text, long dark brown hair' }], exclusive: null },
    appearance: 'anchor',
  });
  assert.ok(anchorPersona.includes('dark brown'), '缺锚点');
  assert.ok(!anchorPersona.includes('浅粉色长发'), '仍然带着人物卡旧外观段');
});

test('★ buildCharacterPersona appearance:\'card\'（默认）行为不变 —— 聊天仍能看到外观段', () => {
  const id = makeCharacter();
  const char = getDb().prepare('SELECT * FROM characters WHERE id=?').get(id);
  const cardPersona = buildCharacterPersona(char, {
    variant: 'full', outfits: { limited: [{ name: '日常装', description: 'body text, long dark brown hair' }], exclusive: null },
  });
  assert.ok(cardPersona.includes('浅粉色长发'), '默认口径被改了 —— 聊天会失去外观认知');
});

test('appearance:\'anchor\' 但角色没有服装行 → 退回原卡，别把外观也剥掉', () => {
  const id = makeCharacter({ appearance: '- 栗色短发' });
  const char = getDb().prepare('SELECT * FROM characters WHERE id=?').get(id);
  const out = buildCharacterPersona(char, { variant: 'full', outfits: null, appearance: 'anchor' });
  assert.ok(out.includes('栗色短发'), '没有锚点时应该保住兜底外观');
});

test('buildAnchorLines：第一个整段、第二个精简', () => {
  const a = makeCharacter();
  addOutfit(a, 'work', { description: 'jacket' });
  const b = makeCharacter();
  addOutfit(b, 'work', { description: 'hoodie' });
  const lines = buildAnchorLines([{ characterId: a }, { characterId: b, side: 'right' }]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('dark brown'));
  assert.ok(lines[1].startsWith('the girl on the right'));
  assert.ok(lines[1].length < lines[0].length, '第二人应该是精简版');
});

test('buildCharacterAppearanceSection 仍可用（聊天侧走它，不受 appearance 开关影响）', () => {
  const id = makeCharacter();
  addOutfit(id, 'work', { description: 'jacket' });
  const char = getDb().prepare('SELECT * FROM characters WHERE id=?').get(id);
  const sec = buildCharacterAppearanceSection(char);
  assert.ok(sec.includes('你的外观'));
  assert.ok(sec.includes('dark brown'), '外观段应含注入的 body');
});

test('★ 阶段 6：媒体的位置指代与锚点 side 词必须是同一套', () => {
  // 媒体图库（2 女体位）用 `the girl 1` / `the girl 2` 区分同框两人，
  // 替换词来自 mediaService.GIRL_POSITION_REFS；而"哪个是哪个"由锚点的 side 词给出。
  // 两处是独立字面量 —— 一旦有人只改一边，"指代说左边、锚点指右边"就会错位。
  // 这条把两处钉在一起：拿媒体的词，去比锚点的输出。
  const a = makeCharacter();
  addOutfit(a, 'work', { description: 'black jacket' });
  const b = makeCharacter();
  addOutfit(b, 'work', { description: 'white dress' });
  const lines = buildAnchorLines([
    { characterId: a, slot: 'self' },
    { characterId: b, slot: 'other', side: 'left' },
  ]);
  assert.equal(lines.length, 2);
  assert.ok(
    lines[1].startsWith(GIRL_POSITION_REFS[1]),
    `媒体指代 ${GIRL_POSITION_REFS[1]} 与锚点第二个角色的位置词不一致：${lines[1].slice(0, 60)}`,
  );
  assert.ok(!lines[0].startsWith('the girl on the'), '第一人不带位置词（整段 + 身份前缀）');
});
