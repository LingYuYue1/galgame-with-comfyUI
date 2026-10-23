/**
 * 「此刻」统一上下文 nowContext（阶段 8 · 文案层，2026-10-23）
 *
 * 目标：文案、配图、穿着三者对齐「那一段日程」。
 * 之前四条链路各拼一套，字段不一 —— 于是会出现"文案写她在洗澡、配图却穿着常服上班"。
 *
 * 本文件重点验四件事：
 *   ① 进度能算对（含**跨天** 23:00–02:00，这是最容易写错的一处）
 *   ② 睡觉判定跟项目既有约定一致（replyDelay === -1）
 *   ③ 穿着走 `resolveAnchor`，与配图**同一个函数** —— 这才是"同源"
 *   ④ 取不到日程时返回空，不打断调用方
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db/index.js';
import { resolveAnchor } from '../src/services/characterAnchor.js';
import {
  buildNowContext, formatNowForImage, formatNowForText, progressOf,
} from '../src/services/nowContext.js';

const at = (h, m = 0) => new Date(2026, 9, 23, h, m, 0); // 2026-10-23

const ACT = {
  location: '浴室',
  activity: '洗澡',
  description: '水汽把镜子糊住了一半',
  startTime: '21:00',
  endTime: '21:40',
  replyDelay: 0,
  tags: ['bath'],
};

// ── 进度 ──

test('progressOf：开头 / 中间 / 收尾', () => {
  assert.equal(progressOf('21:00', '21:40', at(21, 2)).phase, 'start');
  assert.equal(progressOf('21:00', '21:40', at(21, 20)).phase, 'mid');
  assert.equal(progressOf('21:00', '21:40', at(21, 38)).phase, 'end');
});

test('progressOf：不在这一段里 → unknown', () => {
  assert.equal(progressOf('21:00', '21:40', at(19, 0)).phase, 'unknown');
  assert.equal(progressOf('21:00', '21:40', at(23, 0)).phase, 'unknown');
});

test('progressOf：★ 跨天 23:00–02:00 要算对', () => {
  // 23:30 在段内，属于开头
  assert.equal(progressOf('23:00', '02:00', at(23, 30)).phase, 'start');
  // 00:30 也在段内，属于中段
  assert.equal(progressOf('23:00', '02:00', at(0, 30)).phase, 'mid');
  // 01:50 属于收尾
  assert.equal(progressOf('23:00', '02:00', at(1, 50)).phase, 'end');
  // 22:00 还没开始
  assert.equal(progressOf('23:00', '02:00', at(22, 0)).phase, 'unknown');
  // 03:00 已经结束
  assert.equal(progressOf('23:00', '02:00', at(3, 0)).phase, 'unknown');
});

test('progressOf：时间格式不合法 → unknown（不能抛）', () => {
  assert.equal(progressOf('', '', at(12)).phase, 'unknown');
  assert.equal(progressOf('abc', '21:00', at(12)).phase, 'unknown');
  assert.equal(progressOf('21:00', '21:00', at(21)).phase, 'unknown');
});

// ── 上下文 ──

test('buildNowContext：显式传 activity 时不再去查库', () => {
  const ctx = buildNowContext(1, { at: at(21, 20), activity: ACT, withOutfit: false });
  assert.equal(ctx.activity.location, '浴室');
  assert.equal(ctx.activity.activity, '洗澡');
  assert.equal(ctx.progress.phase, 'mid');
  assert.equal(ctx.isSleeping, false);
  assert.ok(ctx.timeStr, '应带时刻');
  assert.ok(ctx.lightNote, '应带光照描述');
  assert.equal(ctx.outfit, null, 'withOutfit:false 时不解析穿着');
});

test('buildNowContext：replyDelay === -1 → isSleeping', () => {
  const ctx = buildNowContext(1, {
    at: at(2, 0),
    activity: { ...ACT, activity: '睡觉', startTime: '23:00', endTime: '07:00', replyDelay: -1 },
    withOutfit: false,
  });
  assert.equal(ctx.isSleeping, true);
});

test('buildNowContext：没有日程也不抛，activity 为 null', () => {
  const ctx = buildNowContext(999999, { at: at(12), withOutfit: false });
  // 查不到角色/日程时要么 null，要么是"自由时间"那条兜底，都不该抛
  assert.ok(ctx);
  assert.ok(ctx.activity === null || typeof ctx.activity === 'object');
});

// ── 文案形态 ──

test('formatNowForText：地点 + 活动 + 进度', () => {
  const ctx = buildNowContext(1, { at: at(21, 20), activity: ACT, withOutfit: false });
  const s = formatNowForText(ctx, { name: '符玄' });
  assert.ok(s.includes('【此刻正在做】'), s);
  assert.ok(s.includes('符玄此刻正在浴室洗澡'), s);
  assert.ok(s.includes('正做着'), s);
});

test('formatNowForText：默认不注入 description（防复读世界观例句）', () => {
  const ctx = buildNowContext(1, { at: at(21, 20), activity: ACT, withOutfit: false });
  const noDesc = formatNowForText(ctx, { name: '符玄' });
  assert.ok(!noDesc.includes('水汽'), '默认不该带 description');
  const withDesc = formatNowForText(ctx, { name: '符玄', withDescription: true });
  assert.ok(withDesc.includes('水汽'), '显式要求时才带');
  assert.ok(withDesc.includes('不要沿用它的句式'), '带描述时必须同时给"改写"约束');
});

test('formatNowForText：没有活动 → 空串', () => {
  assert.equal(formatNowForText(null), '');
  assert.equal(formatNowForText({ activity: null }), '');
  assert.equal(formatNowForText({ activity: { location: '', activity: '' } }), '');
});

// ── 配图形态 ──

test('formatNowForImage：含地点、活动、光照', () => {
  const ctx = buildNowContext(1, { at: at(21, 20), activity: ACT, withOutfit: false });
  const s = formatNowForImage(ctx);
  assert.ok(s.includes('【当前日程】'), s);
  assert.ok(s.includes('【浴室】'), s);
  assert.ok(s.includes('洗澡'), s);
  assert.ok(s.includes('照片里的角色要体现正在做的日程'), s);
  assert.ok(!s.includes('正在睡觉'), '醒着时不该出现睡觉约束');
});

test('formatNowForImage：★ 睡觉时的硬约束必须齐全（闭眼/不开灯/换睡衣）', () => {
  const ctx = buildNowContext(1, {
    at: at(2, 0),
    activity: { location: '卧室', activity: '睡觉', description: '', startTime: '23:00', endTime: '07:00', replyDelay: -1 },
    withOutfit: false,
  });
  const s = formatNowForImage(ctx);
  assert.ok(s.includes('双眼必须紧闭'), s);
  assert.ok(s.includes('房间里没有灯光'), s);
  assert.ok(s.includes('睡衣'), s);
  // 睡觉时不要再叠"这一段正做着"这类进度词，读起来会打架
  assert.ok(!s.includes('这一段正做着'), s);
});

// ── 穿着同源 ──

test('★ 穿着走 resolveAnchor：与配图锚点同一个函数，不另起一套', () => {
  const db = getDb();
  const name = `__nowctx_test_${Date.now()}`;
  const r = db.prepare('INSERT INTO characters(name, display_name, base_prompt) VALUES (?,?,?)')
    .run(name, name, `你是${name}。\n\n## 你的外观\n- 浅粉色长发\n`);
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO character_outfits (character_id, name, description, scene, body) VALUES (?,?,?,?,?)')
    .run(id, '常服', 'white halter top', 'work', 'long pink hair, red eyes, fair skin');

  const ctx = buildNowContext(id, {
    at: at(15, 0),
    activity: { location: '书房', activity: '看书', startTime: '14:00', endTime: '17:00', replyDelay: 0 },
    withOutfit: true,
  });
  assert.ok(ctx.outfit, '应解析出穿着');
  assert.ok(ctx.outfit.garment.includes('white halter'), `实际：${JSON.stringify(ctx.outfit)}`);

  // ★ 真正验"同源"：拿同样的入参直接调 resolveAnchor，两边必须逐字一致。
  //   只断言 garment 里有某个词是不够的 —— 那证明不了它跟配图走的是同一条路。
  const direct = resolveAnchor(id, {
    activity: { location: '书房', activity: '看书', startTime: '14:00', endTime: '17:00', replyDelay: 0 },
    now: at(15, 0),
  });
  assert.equal(ctx.outfit.garment, direct.garment, '文案侧与配图侧取到的衣服必须一模一样');
  assert.equal(ctx.outfit.sceneKey, direct.sceneKey);
  assert.equal(ctx.outfit.source, direct.source);
});
