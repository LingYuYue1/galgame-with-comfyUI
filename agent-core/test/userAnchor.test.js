/**
 * 用户外观锚点（阶段 7，2026-10-23）
 *
 * 用户原话：「我打算把我的女性形象放在邻舍的角色里面，而自己的男性角色变为自己形象。
 * 男性选择青年时期的。」→ 生图里该出现"我"时，必须画成这个男性形象，
 * 不能再让模型自由发挥（此前 `config.user.appearance` 只喂文案，生图一次都没用过）。
 *
 * 本文件的重点不是"能取到字符串"，而是三件容易出错的事：
 *   ① 用户和女角色同框时人数必须写 `1boy, 1girl`，不能写成 `2girls`（否则男的也被画成女的）
 *   ② 锚点正文**不能**以 `1boy` 开头 —— 施工方案 §18.2 实测过，tag 串会把模型切进立绘模式
 *   ③ 某人取不到锚点时，人数要按**实际能画的人**算，不能拿 list.length 猜
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import {
  normalizeGender, resolveAnchorItem, resolveUserAnchor,
} from '../src/services/characterAnchor.js';
import { applyAnchors } from '../src/services/imageSkill.js';

/** 临时改 config.user，用完还原（config 是模块级单例，测试之间会互相污染） */
function withUser(patch, fn) {
  const backup = { ...config.user };
  Object.assign(config.user, patch);
  try {
    return fn();
  } finally {
    Object.assign(config.user, backup);
  }
}

const USER_APPEARANCE = '黑色长发及肩，自然垂落，异色瞳，左眼红、右眼蓝，180cm，'
  + '黑黄相间的长风衣，衣襟绣阴阳图，黑色长裤，黑色低帮靴，右腕缠朱砂绳';

let seq = 0;
function makeCharacter() {
  const db = getDb();
  seq += 1;
  const name = `__user_anchor_test_${Date.now()}_${seq}`;
  const r = db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?,?,?)')
    .run(name, name, `你是${name}。\n\n## 你的外观\n- 浅粉色长发\n`);
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO character_outfits (character_id, name, description, scene, body) VALUES (?,?,?,?,?)')
    .run(id, '常服', 'white halter top, black jacket', 'work',
      'long pink purple gradient hair, heterochromia, red left eye, blue right eye, fair skin');
  return id;
}

test('normalizeGender：中文/英文/tag 写法都收，认不出按 girl', () => {
  for (const v of ['男', '男性', 'male', 'Male', 'm', 'man', 'boy', '1boy']) {
    assert.equal(normalizeGender(v), 'boy', `应识别为 boy：${v}`);
  }
  for (const v of ['女', '女性', 'female', 'FEMALE', 'f', 'woman', 'girl', '1girl']) {
    assert.equal(normalizeGender(v), 'girl', `应识别为 girl：${v}`);
  }
  for (const v of ['', null, undefined, '未知', 'x']) {
    assert.equal(normalizeGender(v), 'girl', `认不出应回落 girl：${v}`);
  }
});

test('resolveUserAnchor：没填外观 → null（不能凭空造一个人出来）', () => {
  withUser({ appearance: '' }, () => {
    assert.equal(resolveUserAnchor(), null);
  });
  withUser({ appearance: '   \n  ' }, () => {
    assert.equal(resolveUserAnchor(), null);
  });
});

test('resolveUserAnchor：有外观 → 文本 + 性别', () => {
  withUser({ appearance: USER_APPEARANCE, gender: '男' }, () => {
    const u = resolveUserAnchor();
    assert.equal(u.text, USER_APPEARANCE);
    assert.equal(u.gender, 'boy');
    assert.equal(u.source, 'user');
  });
});

test('resolveAnchorItem：kind=user 走用户，其余走角色', () => {
  const id = makeCharacter();
  withUser({ appearance: USER_APPEARANCE, gender: '男' }, () => {
    const u = resolveAnchorItem({ kind: 'user' });
    assert.equal(u.gender, 'boy');
    assert.ok(u.text.includes('长风衣'));

    const c = resolveAnchorItem({ characterId: id });
    assert.equal(c.gender, 'girl', '角色未指定性别时默认 girl');
    assert.ok(c.text.includes('pink purple'));
  });
});

test('★ 单人用户 → 人数写 1boy（不是 1girl）', () => {
  withUser({ appearance: USER_APPEARANCE, gender: '男' }, () => {
    const out = applyAnchors('a rainy street at night', { anchors: [{ kind: 'user' }] });
    assert.ok(out.finalPrompt.startsWith('1boy,'), `实际开头：${out.finalPrompt.slice(0, 40)}`);
    assert.ok(!/\b1girl\b/.test(out.finalPrompt), '不应出现 1girl');
    assert.ok(out.finalPrompt.includes('长风衣'));
  });
});

test('★ 用户 + 一个女角色 → 1boy, 1girl（这是阶段 7 的核心断言）', () => {
  const id = makeCharacter();
  withUser({ appearance: USER_APPEARANCE, gender: '男' }, () => {
    const out = applyAnchors('standing together on a rooftop', {
      anchors: [{ kind: 'user', side: 'left' }, { characterId: id, side: 'right' }],
    });
    assert.ok(out.finalPrompt.startsWith('1boy, 1girl,'), `实际开头：${out.finalPrompt.slice(0, 50)}`);
    assert.ok(!/\b2girls\b/.test(out.finalPrompt), '不能把男的也算进 girls');
    // 位置词的性别必须跟着人走：男性写 the man，不能写 the girl（否则与 1boy 打架）
    assert.ok(out.finalPrompt.includes('the man on the left'), `应含 the man on the left：${out.finalPrompt.slice(0, 120)}`);
    assert.ok(out.finalPrompt.includes('the girl on the right'), `应含 the girl on the right：${out.finalPrompt.slice(0, 200)}`);
    assert.ok(!/the girl on the left/.test(out.finalPrompt), '男性不该被写成 the girl on the left');
  });
});

test('side 与 gender 一致：女角色的位置词仍是 the girl', () => {
  const a = makeCharacter();
  const out = applyAnchors('two girls', { anchors: [{ characterId: a, side: 'left' }] });
  assert.ok(out.finalPrompt.includes('the girl on the left'), out.finalPrompt.slice(0, 120));
});

test('用户 + 两个女角色 → 1boy, 2girls', () => {
  const a = makeCharacter();
  const b = makeCharacter();
  withUser({ appearance: USER_APPEARANCE, gender: '男' }, () => {
    const out = applyAnchors('a group photo', {
      anchors: [{ kind: 'user' }, { characterId: a }, { characterId: b }],
    });
    assert.ok(out.finalPrompt.startsWith('1boy, 2girls,'), `实际开头：${out.finalPrompt.slice(0, 50)}`);
  });
});

test('两个女角色（不传 user）→ 2girls，行为与改造前一致', () => {
  const a = makeCharacter();
  const b = makeCharacter();
  const out = applyAnchors('two girls talking', {
    anchors: [{ characterId: a }, { characterId: b }],
  });
  assert.ok(out.finalPrompt.startsWith('2girls,'), `实际开头：${out.finalPrompt.slice(0, 40)}`);
});

test('★ 某人取不到锚点 → 人数按实际能画的人算，不拿 list.length 猜', () => {
  const id = makeCharacter();
  withUser({ appearance: '', gender: '男' }, () => {
    // 用户没填外观 → 这一条取不到锚点；只剩一个女角色
    const out = applyAnchors('a quiet room', {
      anchors: [{ kind: 'user' }, { characterId: id }],
    });
    assert.ok(out.finalPrompt.startsWith('1girl,'), `实际开头：${out.finalPrompt.slice(0, 40)}`);
    assert.ok(!/\b2girls\b/.test(out.finalPrompt), '取不到锚点的人不该被算进人数');
  });
});

test('用户没填外观时，整条 user 锚点不注入，但场景词原样保留', () => {
  withUser({ appearance: '', gender: '男' }, () => {
    const out = applyAnchors('a rainy street', { anchors: [{ kind: 'user' }] });
    assert.equal(out.finalPrompt, 'a rainy street');
    assert.equal(out.anchorText, '');
  });
});

test('锚点正文里不出现 1boy / 1girl（人数只由代码写一次）', () => {
  withUser({ appearance: USER_APPEARANCE, gender: '男' }, () => {
    const out = applyAnchors('portrait', { anchors: [{ kind: 'user' }] });
    const body = out.finalPrompt.replace(/^1boy,\s*/, '');
    assert.ok(!/\b\d+\s*(?:boys?|girls?)\b/i.test(body), `正文不该再有人数 tag：${body.slice(0, 60)}`);
  });
});
