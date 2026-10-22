/**
 * 场景服装枚举与「显式标注专用」兜底守卫（2026-10-22）
 *
 * 背景：用户要求加三套衣服 —— 运动 / 泳装 / 情趣。
 *
 * 这里最要紧的不是"加了三条数据"，而是**兜底不能落到它们身上**：
 * 日程里没写 outfit 的时段会兜底成"第一套白天服装"，一旦泳装/情趣进了候选池，
 * 角色就会穿着泳装去上班。所以把 `PRIVATE_SCENE` 单值拆成 `EXPLICIT_ONLY_SCENES` 集合，
 * 本文件就是从行为上把这套规则钉住 —— 以后再加"不能日常穿"的服装，忘了加到集合里会直接红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db/index.js';
import {
  OUTFIT_SCENES, DEFAULT_NAME_BY_SCENE, EXPLICIT_ONLY_SCENES, PRIVATE_SCENE,
  listSceneOutfits, getSceneOutfitForNow, planOutfitTargets, buildOutfitAnnotateLayer,
} from '../src/services/outfitScene.js';

let seq = 0;
function makeCharacter() {
  const db = getDb();
  seq += 1;
  const name = `__outfit_test_${Date.now()}_${seq}`;
  const r = db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?,?,?)')
    .run(name, name, '你是测试角色。');
  return Number(r.lastInsertRowid);
}

function addOutfit(characterId, scene, { name, description = '', body = 'test body, long black hair' } = {}) {
  getDb().prepare(
    'INSERT INTO character_outfits (character_id, name, description, scene, body) VALUES (?,?,?,?,?)',
  ).run(characterId, name || DEFAULT_NAME_BY_SCENE[scene] || scene, description, scene, body);
}

test('三套新服装都在枚举里，key 唯一，默认名齐全', () => {
  const keys = OUTFIT_SCENES.map(s => s.key);
  for (const k of ['sport', 'swim', 'lingerie']) {
    assert.ok(keys.includes(k), `缺场景 ${k}`);
  }
  assert.equal(new Set(keys).size, keys.length, '场景 key 有重复');
  for (const s of OUTFIT_SCENES) {
    assert.ok(DEFAULT_NAME_BY_SCENE[s.key], `${s.key} 缺默认名`);
    assert.ok(s.label, `${s.key} 缺 label`);
    assert.ok(s.desc, `${s.key} 缺 desc（模型靠它判断何时穿）`);
  }
});

test('★ 显式标注专用集合：必须含 nude / swim / lingerie，且不含 sport', () => {
  assert.ok(EXPLICIT_ONLY_SCENES.has(PRIVATE_SCENE));
  assert.ok(EXPLICIT_ONLY_SCENES.has('swim'), '泳装必须在里面 —— 否则会兜底成泳装上班');
  assert.ok(EXPLICIT_ONLY_SCENES.has('lingerie'), '情趣必须在里面');
  assert.ok(!EXPLICIT_ONLY_SCENES.has('sport'), '运动装是能穿出门的，不该被排除');
  // 能日常穿的几套一个都不能误伤
  for (const k of ['work', 'casual', 'home']) {
    assert.ok(!EXPLICIT_ONLY_SCENES.has(k), `${k} 被误排除，会导致兜底无衣可穿`);
  }
});

test('★ 只有泳装+情趣的角色：无日程时兜底不得返回它们（返回 null 也不许穿）', () => {
  const id = makeCharacter();
  addOutfit(id, 'swim', { description: 'blue one-piece swimsuit' });
  addOutfit(id, 'lingerie', { description: 'black lace lingerie' });
  const got = getSceneOutfitForNow(id, new Date('2026-05-01T12:00:00'));
  assert.equal(got, null, `兜底落到 ${got?.scene} 了 —— 角色会穿泳装/情趣上街`);
});

test('★ 同时有常服和泳装：兜底必须给常服', () => {
  const id = makeCharacter();
  addOutfit(id, 'swim', { description: 'blue one-piece swimsuit' });
  addOutfit(id, 'work', { description: 'white shirt, black skirt' });
  const got = getSceneOutfitForNow(id, new Date('2026-05-01T12:00:00'));
  assert.ok(got, '应该有兜底结果');
  assert.equal(got.scene, 'work');
  assert.equal(got.source, 'fallback');
});

test('场景排序稳定：nude → work → casual → home → sleep → sport → swim → lingerie', () => {
  const id = makeCharacter();
  // 故意乱序插入
  for (const scene of ['lingerie', 'sleep', 'swim', 'work', 'sport', 'nude', 'casual', 'home']) {
    addOutfit(id, scene, { description: `desc for ${scene}` });
  }
  const order = listSceneOutfits(id).map(o => o.scene);
  assert.deepEqual(order, ['nude', 'work', 'casual', 'home', 'sleep', 'sport', 'swim', 'lingerie']);
});

test('★ 自动补全不碰泳装/情趣/全身（模型写不准，交给用户自己写）', () => {
  const scenes = ['nude', 'work', 'casual', 'home', 'sleep', 'sport', 'swim', 'lingerie'];
  const seeds = scenes.map(scene => ({ scene, body: 'shared body text' }));
  const targets = planOutfitTargets(seeds);
  assert.deepEqual(targets.sort(), ['casual', 'home', 'sleep', 'sport', 'work'].sort());
  assert.ok(!targets.includes('swim'));
  assert.ok(!targets.includes('lingerie'));
});

test('日程标注提示词：配了运动/泳装/情趣才提，没配就别提', () => {
  const withNew = makeCharacter();
  addOutfit(withNew, 'work', { description: 'white shirt' });
  addOutfit(withNew, 'sport', { description: 'sports bra, leggings, sneakers' });
  const text1 = buildOutfitAnnotateLayer(withNew);
  assert.ok(text1.includes('运动装'), '配了运动装却没在提示词里说明场合');
  assert.ok(text1.includes('只在特定场合用'), '缺少场合限制段');
  assert.ok(!text1.includes('泳装'), '没配泳装却提到了它');

  const plain = makeCharacter();
  addOutfit(plain, 'work', { description: 'white shirt' });
  addOutfit(plain, 'home', { description: 'hoodie' });
  const text2 = buildOutfitAnnotateLayer(plain);
  assert.ok(!text2.includes('只在特定场合用'), '没配新场景却多出一段限制，会干扰模型');
});
