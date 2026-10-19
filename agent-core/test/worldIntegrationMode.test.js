/**
 * 世界观注入口径 · 两套模式（2026-10-19）
 *
 * 背景（实锤问题）：上游 `fbf7f29`（2026-08-05「修正世界观强化问题」）写的是**单世界假设**
 * ——「一个世界 + 一堆外来角色」，所以要求「人格中的原设身份、职业、组织、地点、经历
 * 一律作废」。本地是多世界结构（角色归属自己的世界，罗浮 / 列车 / 二维市都是真实世界），
 * 照抄那条会把角色的履历清空：景元在罗浮不是「罗浮将军」，而是「一个被罗浮重新定义的、
 * 恰好叫景元的人」——气质还在，履历没了。
 *
 * 现在拆成两套：
 *   · native（默认）—— 世界管环境/规则/常识，身份不冲突就照旧；
 *   · reset（显式）—— 上游原口径，留给「把角色扔进不属于她的世界并重造身份」。
 *
 * 本文件锁四件事：
 *   ① 默认是 native，且**不再出现**「一律作废」；
 *   ② `mode:'reset'` 仍能拿到上游原口径（不是被删掉，是被收进显式入口）；
 *   ③ 所有作用域都保留 `<world_integration priority="highest">` 包裹（下游/测试依赖标签名）；
 *   ④ 日程生成器里那段**独立复制**的身份重置文案不许复活 —— 它是 CORE 之外的另一处泄漏点。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

const { getWorldIntegrationRule } = await import('../src/builtinRules.js');

const SCOPES = [
  'interaction', 'moments', 'momentReply', 'relationships',
  'photo', 'schedule', 'event', 'eventConclusion', 'world_outfit', 'town_asset',
];

test('★ 默认 native：身份不冲突就照旧，不再出现「一律作废」', () => {
  const text = getWorldIntegrationRule('interaction');
  assert.ok(text.includes('照旧成立'), 'native 口径必须明说"照旧成立"');
  assert.ok(!text.includes('一律作废'), 'native 口径不许再把原设身份一律作废');
  assert.ok(text.includes('不要解释她如何来到这里'), '仍要防破第四面墙');
  assert.ok(text.includes('不要凭空发明一个替代身份'), '世界没写到的，按原本来历补齐');
});

test('★ reset 仍可显式取到上游原口径（收进入口，不是删除）', () => {
  const text = getWorldIntegrationRule('interaction', { mode: 'reset' });
  assert.ok(text.includes('一律作废'), 'reset 必须是上游原句');
  assert.ok(!text.includes('照旧成立'), 'reset 不能夹带兼容口径');
});

test('★ 十个作用域都能各自构建，且保留 <world_integration> 包裹', () => {
  for (const scope of SCOPES) {
    const native = getWorldIntegrationRule(scope);
    assert.ok(native.startsWith('<world_integration priority="highest">'), `${scope}: 包裹标签变了`);
    assert.ok(native.includes('</world_integration>'), `${scope}: 未闭合`);
    assert.ok(!native.includes('一律作废'), `${scope}: native 下仍有身份重置语`);

    const reset = getWorldIntegrationRule(scope, { mode: 'reset' });
    assert.ok(reset.includes('一律作废'), `${scope}: reset 未生效`);
  }
});

test('★ 未知作用域仍然抛错（别把拼错的 scope 静默吞成 interaction）', () => {
  assert.throws(() => getWorldIntegrationRule('nope'), /Unknown world integration scope/);
});

test('★ 日程生成器里那段自带的身份重置语不许复活（CORE 之外的第二处泄漏点）', () => {
  const file = path.join(SRC, 'services', 'scheduleGenerator.js');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('一律作废'), 'scheduleGenerator 里又写回「一律作废」了 —— 走 getWorldIntegrationRule("schedule") 即可');
  assert.ok(!text.includes('全部由<world_setting>重新定义'), 'scheduleGenerator 里又写回「全部由 world_setting 重新定义」了');
});
