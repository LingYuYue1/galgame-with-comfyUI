/**
 * characterStanding.js — 六套场景立绘（常服 / 私服 / 居家 / 睡衣 / 运动装 / 泳装）
 *
 * ── 解决什么问题 ──
 *
 * 角色原本只有一张立绘（characters.standing_url）。做完「场景服装」之后，角色在不同场合
 * 穿不同衣服，但形象面板只能看到那一张 —— 本模块让每个角色在多个场景下各有一张立绘，
 * 详情页可以左右切换查看。
 *
 * ── 为什么是四套，而不是 OUTFIT_SCENES 的全部五套（F-19）──
 *
 * `outfitScene.js` 的 `OUTFIT_SCENES` 如今有五套，第五套是 `nude`（「全身」，私密场景的
 * 不穿衣形态）。那个枚举服务于**服装描述通道**（日程按场合选一套来驱动生图）；立绘是另一条
 * 通道，详情页那排左右切换的四格，设计上只对 work / casual / home / sleep 成立（见下面的
 * work 兜底规则），而且把「全身」做成一个可生成的立绘页签，与「这一套不参与用户输入」的既有
 * 口径相悖。所以本模块**不复用整表**，而是显式滤掉 `PRIVATE_SCENE`。
 * ⚠ 不要把这里改回 `OUTFIT_SCENES.map(...)`：枚举以后每加一套，立绘就会悄悄多一格
 *   —— 这正是 F-19 的成因（第五套一进枚举就自动长成了立绘页签，文案却仍写四套）。
 *
 * ── 三条数据的关系（别搞混）──
 *
 *   characters.standing_url      角色「默认形象」。全库各处（聊天 / 朋友圈 / 群聊 / 小镇）引用它，
 *                                本模块**不写它**，只在读 work 槽时拿它兜底。
 *   character_outfits(scene)     场景服装的**文字描述**，驱动生图。本模块出图时读它当穿着。
 *   character_standings(scene)   场景立绘的**图片**。本模块独占。
 *
 * ── 兜底规则 ──
 *
 * work（常服）槽没图时回落到 characters.standing_url —— 于是「用户已有的那张立绘」
 * 天然就是常服形象，切换过去不会是空白，用户不会觉得立绘凭空消失。
 */

import { getDb } from '../db/index.js';
import { OUTFIT_SCENES, PRIVATE_SCENE } from './outfitScene.js';

/**
 * 立绘独占的场景集 = 下面的显式白名单，顺序沿用 `OUTFIT_SCENES` 的枚举顺序
 * （work / casual / home / sleep / sport / swim）。套名/标签仍以 outfitScene 为单一真源。
 */
/**
 * 立绘做这六套（2026-10-24 用户要求加运动装/泳装）。
 *
 * 为什么是**显式白名单**而不是"整表减掉 nude"（2026-10-22）：
 * 服装枚举后来加了 运动/泳装/情趣 三套，如果继续用 filter 推导，立绘面板会突然多出三格，
 * 每个角色凭空多三张要画的图。立绘要的是**基准形象**，四套足够；
 * 新衣服只在剧情配图里"按需拿取"（用户原话），不强制出立绘。
 * 以后要加立绘槽位，在这里显式加，别靠推导。
 *
 * 2026-10-24 变更：用户「之前加了泳装那些，但（立绘）还没有对应的」→ 显式加 sport / swim。
 * `lingerie` 仍然不进（成人向方向已废除，保留描述即可）。
 */
const STANDING_SCENE_KEYS = ['work', 'casual', 'home', 'sleep', 'sport', 'swim'];
export const STANDING_SCENES = OUTFIT_SCENES.filter(s => STANDING_SCENE_KEYS.includes(s.key));
const SCENE_KEYS = STANDING_SCENES.map(s => s.key);
const LABEL_BY_KEY = Object.fromEntries(STANDING_SCENES.map(s => [s.key, s.label]));

/**
 * 该角色的六套场景立绘（行数始终齐全、顺序固定）。
 * work 槽用 characters.standing_url 兜底；is_fallback 标记该行的图其实是兜底来的
 * （「删除」时应清空 work 槽的显式记录，而不是去删那张默认立绘 —— 见路由层）。
 * @returns {Array<{scene, sceneLabel, image_url, prompt_text, is_fallback}>}
 */
export function listSceneStandings(characterId) {
  if (!characterId) return [];
  const db = getDb();
  const rows = db
    .prepare('SELECT scene, image_url, prompt_text FROM character_standings WHERE character_id = ?')
    .all(characterId);
  const byScene = new Map(rows.map(r => [r.scene, r]));
  const char = db.prepare('SELECT standing_url FROM characters WHERE id = ?').get(characterId);
  const fallback = String(char?.standing_url || '') || null;

  return STANDING_SCENES.map(s => {
    const hit = byScene.get(s.key);
    const explicit = String(hit?.image_url || '') || null;
    const useFallback = !explicit && s.key === 'work' && !!fallback;
    return {
      scene: s.key,
      sceneLabel: s.label,
      image_url: explicit || (useFallback ? fallback : null),
      prompt_text: hit?.prompt_text || '',
      is_fallback: useFallback,
    };
  });
}

/** 取某场景立绘的**原始行**（不含兜底），路由层据此决定要不要删旧文件 */
export function getSceneStandingRow(characterId, scene) {
  if (!characterId || !SCENE_KEYS.includes(scene)) return null;
  return getDb()
    .prepare('SELECT * FROM character_standings WHERE character_id = ? AND scene = ?')
    .get(characterId, scene) || null;
}

/** 写一套场景立绘（同场景覆盖）。imageUrl 传空表示清空该槽（保留行，便于记 prompt） */
export function upsertSceneStanding(characterId, scene, { imageUrl, promptText } = {}) {
  if (!characterId || !SCENE_KEYS.includes(scene)) return null;
  getDb()
    .prepare(
      `INSERT INTO character_standings (character_id, scene, image_url, prompt_text, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(character_id, scene)
       DO UPDATE SET image_url = excluded.image_url,
                     prompt_text = excluded.prompt_text,
                     updated_at = CURRENT_TIMESTAMP`
    )
    .run(characterId, scene, imageUrl || null, promptText || null);
  return listSceneStandings(characterId).find(s => s.scene === scene) || null;
}

/** 删掉某场景立绘那一行（文件由调用方负责删） */
export function deleteSceneStanding(characterId, scene) {
  if (!characterId || !SCENE_KEYS.includes(scene)) return false;
  const r = getDb()
    .prepare('DELETE FROM character_standings WHERE character_id = ? AND scene = ?')
    .run(characterId, scene);
  return r.changes > 0;
}

/**
 * 对外暴露的六套场景 key / 标签 —— 路由层用它做**入参校验**（generate / upload / delete），
 * 因此「全身」/nude 与「情趣」/lingerie 会在入口被拒（400 无效的场景），不会出现「能写不能看」的半态。
 */
export { SCENE_KEYS as STANDING_SCENE_KEYS, LABEL_BY_KEY as STANDING_SCENE_LABELS };
