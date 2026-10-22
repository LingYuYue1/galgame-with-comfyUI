#!/usr/bin/env node
/**
 * probe-anchor-links.mjs — 阶段 4 各链路锚点「形态」探针（2026-10-22）
 *
 * 用途：不提交 ComfyUI，只走 `buildAnchorLines`（= `applyAnchors` 内部同一函数），
 * 把每条链路**实际传的那种 anchors 参数**喂一遍，看拼出来的锚点长什么样。
 *
 * 为什么需要它：`audit-anchor-wiring-calls.mjs` 只能证明"传了 anchors"，
 * 证明不了"传对了"——比如 scene 该用 activity 却传了默认 auto、多角色忘了标左右。
 *
 * 用法：
 *   node scripts/probe-anchor-links.mjs            # 用库里第一个有服装的角色
 *   node scripts/probe-anchor-links.mjs 15         # 指定角色 id（花火）
 */

import { getDb } from '../src/db/index.js';
import { buildAnchorLines, resolveAnchor } from '../src/services/characterAnchor.js';
import { getCurrentActivity } from '../src/services/scheduleManager.js';
import { listSceneOutfits } from '../src/services/outfitScene.js';

const argId = Number(process.argv[2]) || null;

const db = getDb();
const rows = db.prepare(`
  SELECT c.id, c.display_name,
         (SELECT COUNT(*) FROM character_outfits o WHERE o.character_id = c.id) AS outfit_count
  FROM characters c
  ORDER BY c.id
`).all();
const withOutfits = rows.filter(r => r.outfit_count > 0);
const char = argId ? rows.find(r => r.id === argId) : (withOutfits[0] || rows[0]);
if (!char) {
  console.log('库里没有角色，无法探针。');
  process.exit(0);
}
const other = withOutfits.find(r => r.id !== char.id) || null;

console.log(`探针角色：#${char.id} ${char.display_name}（服装 ${char.outfit_count} 套）`);
const scenes = listSceneOutfits(char.id).map(o => `${o.scene}${o.description ? '' : '(空)'}`);
console.log(`已配服装：${scenes.join(', ') || '无'}`);

function show(title, list) {
  const lines = buildAnchorLines(list);
  console.log(`\n── ${title} ──`);
  console.log(`  入参: ${JSON.stringify(list)}`);
  if (!lines.length) {
    console.log('  ⚠ 没有取到锚点（会退回"不注入"，出图将失去保护）');
    return;
  }
  lines.forEach((l, i) => console.log(`  [${i}] (${l.length}字) ${l}`));
}

// ① 朋友圈 / 聊天 / 日记 / 奇遇 / 表情包 / 主动聊天：单角色 auto
show('auto · 单角色（朋友圈/私聊/日记/奇遇/表情包/主动聊天）', [{ characterId: char.id, slot: 'self' }]);

// ② 头像 / 立绘默认：显式 work
show('work · 单角色（头像 / 默认立绘）', [{ characterId: char.id, slot: 'self', scene: 'work' }]);

// ③ 场景立绘：显式指定那一套
show('casual · 单角色（场景立绘「私服」）', [{ characterId: char.id, slot: 'self', scene: 'casual' }]);

// ④ 梦话：显式 sleep
show('sleep · 单角色（梦话配图）', [{ characterId: char.id, slot: 'self', scene: 'sleep' }]);

// ⑤ 日程 peek：带 activity（选装必须按那一段，不看此刻）
let activity = null;
try { activity = getCurrentActivity(char.id); } catch { activity = null; }
if (activity) {
  show(`activity · 日程「瞄一眼」(${activity.startTime}-${activity.endTime} ${activity.activity})`,
    [{ characterId: char.id, slot: 'self', activity }]);
  const picked = resolveAnchor(char.id, { activity });
  console.log(`  → 选中的是「${picked?.sceneKey || '?'}」(${picked?.source || '?'})`);
} else {
  console.log('\n── activity · 日程「瞄一眼」──\n  跳过：这个角色今天没有当前活动');
}

// ⑥ 多人同框：第一个整段 + 第二个精简并按左右标位置
if (other) {
  show(`多人同框（朋友圈/群聊/奇遇：${char.display_name} + ${other.display_name}）`, [
    { characterId: char.id, slot: 'self' },
    { characterId: other.id, slot: 'other', side: 'left' },
  ]);
} else {
  console.log('\n── 多人同框 ──\n  跳过：库里只有一个角色');
}
