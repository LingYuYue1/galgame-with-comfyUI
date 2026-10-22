/**
 * 角色锚点「接线」审计 —— 哪些生图链路真的吃到了 character_outfits.body
 *
 * 背景（2026-10-22 用户实报）：花火锚点是深棕发 + 粉渐变发尾，但出图整头变粉。
 *
 * 排查发现锚点在库里有两份，且**互相矛盾**：
 *   character_outfits.body      ← 锚点工程的正典（5 套共用一份身体描述）
 *   characters.base_prompt 的「## 你的外观」段  ← 老写法，锚点工程没同步
 *
 * 各链路读哪一份不一样，所以这个脚本直接**跑真实拼装函数**，把结果打出来比对。
 *
 * 用法：
 *   node scripts/audit-anchor-wiring.mjs            # 全部角色概览
 *   node scripts/audit-anchor-wiring.mjs 花火        # 单个角色逐链路展开
 *
 * ⚠ 只读：只查库 + 调纯函数，不写库、不生成图。
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.resolve(HERE, '..', 'data', 'agent.db');

const db = new Database(DB_PATH, { readonly: true });

const { buildCharacterPersona, buildCharacterAppearanceSection, buildImageCrossRefInfo } =
  await import('../src/services/characterPersona.js');
const { buildStandingPersona } = await import('../src/services/expressionStandingAppearance.js');
const { buildSubjectRef } = await import('../src/services/mediaService.js');

/** 取「## 你的外观」段（与 characterPersona.extractAppearanceSection 同口径的粗版，只用于打印） */
function appearanceOf(basePrompt) {
  const s = String(basePrompt || '');
  const m = s.match(/^##\s*你的外观\s*\n([\s\S]*?)(?=\n##\s|$)/m);
  return m ? m[1].trim() : '';
}

/** 从英文 body 里取发型那一段 */
function hairOf(text) {
  const clause = String(text || '').split(',').map(s => s.trim()).find(s => /hair/i.test(s));
  return clause ? clause.slice(0, 90) : '';
}

/** 某段文本里是否同时出现「旧外观段」与「body 的发型段」——两份都在 = 靠裁定规则软约束 */
function verdict(text, bodyHair, cardAppearance) {
  const s = String(text || '');
  const hasBody = bodyHair ? s.includes(bodyHair.slice(0, 28)) : false;
  const hasCard = cardAppearance ? s.includes(String(cardAppearance).slice(0, 12)) : false;
  if (hasBody && !hasCard) return '✅ 只用 body';
  if (hasCard && !hasBody) return '❌ 只用旧外观段';
  if (hasBody && hasCard) return '⚠️ body + 旧外观段并存（软约束）';
  return '· 都没命中（可能是中文卡，人工看）';
}

const only = process.argv[2];
const chars = only
  ? db.prepare('select id,display_name,base_prompt from characters where display_name like ? order by id').all(`%${only}%`)
  : db.prepare('select id,display_name,base_prompt from characters order by id').all();

if (!chars.length) {
  console.error(`没找到角色：${only}`);
  process.exit(1);
}

for (const c of chars) {
  const body = String(db.prepare("select body from character_outfits where character_id=? and body is not null and trim(body)<>'' limit 1").get(c.id)?.body || '');
  const cardAppearance = appearanceOf(c.base_prompt);
  const bodyHair = hairOf(body);

  console.log('\n' + '='.repeat(72));
  console.log(`#${c.id} ${c.display_name}`);
  console.log('  body    :', bodyHair || '（无 body）');
  console.log('  外观段  :', (cardAppearance.split(/[，,。\n]/).find(s => /发|hair/i.test(s)) || '（空）').slice(0, 90));

  if (!only) continue;

  const rows = [
    ['朋友圈 / 奇遇 / 报纸 / 信箱 / 日记（full + auto）', buildCharacterPersona(c, { variant: 'full' })],
    ['对话配图 / 生图测试 / 表情包（crossRef）', buildImageCrossRefInfo(c)],
    ['主动聊天配图（appearanceSection）', buildCharacterAppearanceSection(c)],
    ['立绘 · 默认 work', buildStandingPersona(c, 'work')],
    ['立绘 · 私服 casual', buildStandingPersona(c, 'casual')],
    ['立绘 · 居家 home', buildStandingPersona(c, 'home')],
    ['立绘 · 睡衣 sleep', buildStandingPersona(c, 'sleep')],
  ];
  console.log('\n  ── 各链路实际拿到的文本 ──');
  for (const [label, text] of rows) {
    console.log(`  ${label}\n    ${verdict(text, bodyHair, cardAppearance)}`);
  }
  const ref = buildSubjectRef(c);
  console.log(`  媒体（图库）· buildSubjectRef\n    ${ref ? `「${ref}」\n    ${/eye/i.test(ref) ? '⚠️' : '❌'} 只有发型段，无瞳色/肤色/体型；且按 64 字符硬截断` : '    ❌ 取不到（body 无 hair 段）'}`);
}

console.log('\n' + '='.repeat(72));
console.log('口径：body = 锚点正典；「## 你的外观」段 = 老写法，锚点工程未同步。');
console.log('「并存」不算错，但它靠一段中文裁定规则让模型忽略旧段 —— 软约束，会偶发出错。');
