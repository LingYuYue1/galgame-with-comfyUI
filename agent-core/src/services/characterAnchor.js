/**
 * characterAnchor.js — 角色生图锚点的**唯一入口**（2026-10-22）
 *
 * ── 为什么要有这个文件 ──
 * 同一个"这个角色长什么样"的问题，原来分散在四个地方各写一遍：
 *   · `sceneOutfitParam(id,'work')`      （头像用，吃 body）
 *   · `resolveStandingOutfits(id,'work')`（立绘用，**work 返回 null → 退回人物卡旧外观段**）
 *   · `getSceneOutfitForNow(id)`          （剧情配图用，按日程选装）
 *   · `buildSubjectRef(char)`             （媒体用，只取发型 64 字符 —— **2026-10-22 已删**）
 * 四个口径不一致，于是"立绘默认形象和朋友圈里的她不是一个人"这种问题必然出现。
 *
 * 本模块把它们收敛成 `resolveAnchor()`，其它地方只许调它。
 *
 * ── 锚点的真源 ──
 * `character_outfits.body`（5~8 套共用一份身体描述）+ 该套的 `description`（只存衣服）。
 * 人物卡 `base_prompt` 里的 `## 你的外观` 段**只作兜底**：角色还没配任何服装行时才用，
 * 且明确标 `source: 'card'` 便于排查（用户 2026-10-22 定：以全身锚点为唯一基准）。
 */

import { getDb } from '../db/index.js';
import {
  composeOutfitText, getSceneOutfitForNow, sceneOutfitParam,
} from './outfitScene.js';

/** 取人物卡「## 你的外观」段（与 characterPersona.extractAppearanceSection 同口径） */
function cardAppearance(characterId) {
  try {
    const row = getDb().prepare('SELECT base_prompt FROM characters WHERE id = ?').get(characterId);
    const base = String(row?.base_prompt || '');
    const m = base.match(/^##\s*你的外观\s*\n([\s\S]*?)(?=\n##\s|$)/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * 取角色的生图锚点。
 *
 * @param {number} characterId
 * @param {object} [opts]
 * @param {'auto'|'work'|'casual'|'home'|'sleep'|'sport'|'swim'|'lingerie'|'nude'} [opts.scene='auto']
 *   `auto` = 按当前日程（或传入的活动）选装；显式传场景 = 钉死那一套
 * @param {Date} [opts.now] 用于 auto 定位"今天"
 * @param {object} [opts.activity] 指定日程里的某一段（配图必须传，避免"此刻"选错装）
 * @returns {{text:string, body:string, garment:string, sceneKey:string|null, source:string}|null}
 *   `source`：'scene'（显式场景）| 'schedule'/'sleep'/'fallback'（auto 的三种来源）| 'card'（兜底人物卡）
 */
export function resolveAnchor(characterId, opts = {}) {
  const { scene = 'auto', now = new Date(), activity = null } = opts;
  if (!characterId) return null;

  // ① 显式场景：直接取那一套（**包括 work** —— 这一步就是原来立绘缺的那个洞）
  if (scene && scene !== 'auto') {
    const hit = sceneOutfitParam(characterId, scene);
    const o = hit?.limited?.[0];
    if (o?.description) {
      return { text: o.description, body: '', garment: '', sceneKey: scene, source: 'scene' };
    }
    // 没配这一套 → 继续走 auto，而不是返回 null（生图不能因为少一套衣服就没锚点）
  }

  // ② auto：按日程选装
  const picked = activity
    ? getSceneOutfitForNow(characterId, now, activity)
    : getSceneOutfitForNow(characterId, now);
  if (picked?.outfit) {
    const o = picked.outfit;
    const text = o.text || composeOutfitText(o.body, o.description);
    if (text) {
      return { text, body: o.body || '', garment: o.description || '', sceneKey: picked.scene, source: picked.source };
    }
  }

  // ③ 兜底：人物卡外观段（新角色还没配服装行时唯一能用的东西）
  const card = cardAppearance(characterId);
  if (card) return { text: card, body: card, garment: '', sceneKey: null, source: 'card' };

  return null;
}

/** 去掉 body 开头的「角色名 (作品名)」前缀，用于精简版 */
function stripIdentityPrefix(text) {
  return String(text || '')
    .replace(/^\s*[^,()]{1,60}\s*\([^()]{1,80}\)\s*[,]?\s*/, '')
    .trim();
}

/**
 * 把锚点文本压成一行提示词。
 *
 * @param {string} text resolveAnchor().text
 * @param {object} [opts]
 * @param {boolean} [opts.compact=false] 精简版（多人同框时第二个角色起用）：
 *        只留「发型 + 瞳色」，约 100 字符 —— 两个 400 字符的锚点会互相稀释。
 * @param {number} [opts.maxLen=450] 硬上限保护（现有 body 最长 411，正常不会触发）
 * @param {string} [opts.side] 'left' / 'right' —— 多人同框时标明位置，避免特征串味
 * @returns {string}
 */
export function buildAnchorLine(text, opts = {}) {
  const { compact = false, maxLen = 450, side = '' } = opts;
  let s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';

  if (compact) {
    const body = stripIdentityPrefix(s);
    const parts = body.split(',').map(x => x.trim()).filter(Boolean);
    const hair = parts.find(p => /hair|头发|长发|短发/i.test(p));
    const eyes = parts.find(p => /eyes?\b|瞳/i.test(p));
    s = [hair, eyes].filter(Boolean).join(', ') || parts.slice(0, 2).join(', ');
    // 精简版可以过 100 字符，允许多一点
    if (s.length > 140) s = s.slice(0, 140).replace(/[,，]\s*[^,，]*$/, '');
  } else if (s.length > maxLen) {
    // 超长才截：按「体型 → 肤色 → 标志物」的逆序砍（发色/发型/瞳色留到最后）
    const parts = s.split(',').map(x => x.trim()).filter(Boolean);
    const dropOrder = [/build|figure|体型|身材/i, /skin|肤色/i, /tattoo|scar|痣|纹身|斑/i];
    let out = [...parts];
    for (const re of dropOrder) {
      if (out.join(', ').length <= maxLen) break;
      out = out.filter(p => !re.test(p));
    }
    while (out.join(', ').length > maxLen && out.length > 3) out.pop();
    s = out.join(', ');
    if (s.length > maxLen) s = s.slice(0, maxLen);
  }

  if (!side) return s;
  const pos = side === 'left' ? 'the girl on the left' : 'the girl on the right';
  // 已有身份前缀（`Name (Series), ...`）时不再加位置词，避免读起来打架
  if (/\([^()]{1,80}\)/.test(s.slice(0, 80))) return s;
  return `${pos}, ${s}`;
}

/**
 * 一次取多个角色的锚点（多人同框用）。
 * 第一个整段，第二个起精简 —— 见 buildAnchorLine 的 compact 说明。
 *
 * @param {Array<{characterId:number, scene?:string, side?:'left'|'right',
 *   activity?:object, now?:Date|number|string}>} list
 *   `activity` = 那一段日程（配图必须传，避免"此刻"选错装）
 *   `now`      = 画面发生的**时刻**（补图/重绘历史帖时用；不传＝现在）
 * @returns {string[]} 与入参同序、可能含空串（角色取不到锚点时）
 */
export function buildAnchorLines(list = []) {
  return (Array.isArray(list) ? list : []).map((item, i) => {
    const anchor = resolveAnchor(item?.characterId, {
      scene: item?.scene || 'auto',
      activity: item?.activity,
      // ★ 2026-10-22 补：没有它，补图/重绘只能按"此刻"选装 ——
      //   凌晨重绘一张下午的帖子，会给她换成睡衣。
      ...(item?.now != null ? { now: toDate(item.now) } : {}),
    });
    if (!anchor?.text) return '';
    return buildAnchorLine(anchor.text, { compact: i > 0, side: item?.side || '' });
  }).filter(Boolean);
}

/** 宽松转 Date：非法值退回"现在"，不让一个坏参数把整张图的锚点搞没 */
function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

