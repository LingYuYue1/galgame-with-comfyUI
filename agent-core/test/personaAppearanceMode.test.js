/**
 * personaAppearanceMode.test.js — 外观段分流（阶段 5，2026-10-22）
 *
 * ── 它守的是什么 ──
 * `buildCharacterPersona(..., { appearance })` 的三档语义：
 *   'card'（默认）→ 人设 + 人物卡「## 你的外观」段（聊天/叙事用，文字里要知道自己长什么样）
 *   'anchor'      → **丢掉人物卡外观正文**，只留结构化服装注入块（生图用，与代码注入的锚点同一口径）
 *   'none'        → 连服装块也不要
 *
 * 为什么必须守住 'anchor'：出图提示词最前已经有代码注入的锚点，
 * 人物卡那段中文是"老写法"，两者矛盾时（花火：卡里"浅粉色长发" vs 锚点"深棕+粉渐变发尾"），
 * 两份都给 LLM，它挑哪份是运气。
 *
 * 为什么 short 分支也要覆盖：立绘是所有生图链路里唯一走 `variant:'short'` 的，
 * 而 `appearance` 原来只在 full 分支生效 → 立绘根本无从切换口径（本轮补上）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

// 只 import 纯函数模块；不碰 DB（outfits 一律显式传对象）
const { buildCharacterPersona } = await import('../src/services/characterPersona.js');

const CHAR = {
  id: 999999,
  display_name: '花火',
  short_prompt: '花火，性格跳脱，爱玩。',
  base_prompt: `你是花火，来自《崩坏：星穹铁道》。

## 你的外观
- 浅粉色长发扎成双马尾
- 粉色眼睛

## 你的性格
爱玩、爱恶作剧。`,
};

// 锚点正典形状：body（英文）+ 那一套的衣服
const SCENE_OUTFITS = {
  limited: [{
    name: '常服',
    description: 'long dark brown hair with pink gradient tips, fluorescent pink eyes, sleeveless backless short red kimono with black straps',
  }],
  exclusive: null,
};
const NO_OUTFITS = { limited: [], exclusive: null };

// ── short 分支 ──────────────────────────────────────────────

test('short 默认（card）：保留人物卡外观段 —— 聊天/叙事不能失明', () => {
  const text = buildCharacterPersona(CHAR, { variant: 'short', person: '花火', outfits: SCENE_OUTFITS });
  assert.match(text, /浅粉色长发/, '默认档必须保留卡里的中文外观');
  assert.match(text, /深棕|red kimono/, '同时也要带上服装注入块');
  assert.match(text, /花火，性格跳脱/, '人设段要在');
});

test('short + anchor：丢掉人物卡外观段，只留锚点口径的服装块', () => {
  const text = buildCharacterPersona(CHAR, {
    variant: 'short', person: '花火', outfits: SCENE_OUTFITS, appearance: 'anchor',
  });
  assert.doesNotMatch(text, /浅粉色长发/, '★ 卡里的矛盾外观必须消失（就是这次要修的东西）');
  assert.doesNotMatch(text, /粉色眼睛/, '卡里的瞳色也不该留（锚点里有 fluorescent pink eyes）');
  assert.match(text, /pink gradient tips/, '锚点口径的发色要在');
  assert.match(text, /red kimono/, '那一套的衣服要在');
  assert.match(text, /花火，性格跳脱/, '人设段仍要在 —— anchor 只剥外观，不剥人设');
});

test('short + anchor 但角色一套服装都没配：退回原口径（不能把外观剥空）', () => {
  const text = buildCharacterPersona(CHAR, {
    variant: 'short', person: '花火', outfits: NO_OUTFITS, appearance: 'anchor',
  });
  assert.match(text, /浅粉色长发/, '没有服装行时她是"没有长相的人"，必须保住兜底');
});

test('short + none：纯人设', () => {
  const text = buildCharacterPersona(CHAR, {
    variant: 'short', person: '花火', outfits: SCENE_OUTFITS, appearance: 'none',
  });
  assert.doesNotMatch(text, /浅粉色长发/);
  assert.doesNotMatch(text, /red kimono/);
  assert.match(text, /花火，性格跳脱/);
});

// ── full 分支（既有行为，回归） ──────────────────────────────

test('full 默认（card）：保留人物卡外观段', () => {
  const text = buildCharacterPersona(CHAR, { variant: 'full', person: '花火', outfits: SCENE_OUTFITS });
  assert.match(text, /浅粉色长发/);
  assert.match(text, /red kimono/);
});

test('full + anchor：丢掉人物卡外观段，保留服装块', () => {
  const text = buildCharacterPersona(CHAR, {
    variant: 'full', person: '花火', outfits: SCENE_OUTFITS, appearance: 'anchor',
  });
  assert.doesNotMatch(text, /浅粉色长发/);
  assert.match(text, /pink gradient tips/);
  assert.match(text, /爱玩、爱恶作剧/, '人设其余段落（性格）不能被误删');
});

test('full + anchor 但无服装：退回原卡（保住兜底）', () => {
  const text = buildCharacterPersona(CHAR, {
    variant: 'full', person: '花火', outfits: NO_OUTFITS, appearance: 'anchor',
  });
  assert.match(text, /浅粉色长发/);
});

test('full + none：外观整段剥掉，但其余人设段留着', () => {
  const text = buildCharacterPersona(CHAR, {
    variant: 'full', person: '花火', outfits: SCENE_OUTFITS, appearance: 'none',
  });
  assert.doesNotMatch(text, /浅粉色长发/);
  assert.doesNotMatch(text, /red kimono/);
  assert.match(text, /爱玩、爱恶作剧/);
});
