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
import { config } from '../config.js';
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

/**
 * 取「用户本人」的生图锚点（阶段 7，2026-10-23）。
 *
 * ── 为什么需要它 ──
 * `config.user.appearance` 这段文字此前**只喂文案**（聊天/朋友圈/日程/信箱等 11 处都调它），
 * 生图链路一次都没用过 —— 图里该出现"我"的时候，模型是自由发挥的，
 * 于是同一个人每张图长得都不一样。用户 2026-10-23 明确要求把男性形象作为本人。
 *
 * ── 为什么不直接用中文那段 appearance（实测踩过）──
 * 一开始就是直接拿 `config.user.appearance`（用户自己写的中文描述型文本）当锚点用，
 * 结果**出图是个银发蓝西装的少年，与文字毫无关系**。
 * 结论：这个二次元微调模型对中文长段的约束力接近零 —— 它吃的是 tag，
 * 与 §18.2 那条"tag 与自然语言是两套先验"同源，只是这里连语言层都换了。
 * （角色锚点一直稳，正因为它是英文 tag 串。）
 * 所以拆成两个字段：`appearance` 继续管文案，`anchor{body,outfits}` 管画面。
 *
 * ⚠ 与角色锚点的关键差异：**这里不写 `1boy`**。
 *   施工方案 §18.2 已实测：`1girl/1boy` 开头的 tag 串会把模型切进"全身立绘"模式。
 *   性别人数由 `applyAnchors` 在最前面统一写一个权威值，锚点正文只描述长相。
 *
 * @param {object} [opts]
 * @param {string} [opts.gender] 覆盖 `config.user.gender`（'男'/'女'/'male'/'female'…）
 * @returns {{text:string, gender:'boy'|'girl', source:'user-anchor'|'user'}|null}
 */
export function resolveUserAnchor(opts = {}) {
  const gender = normalizeGender(opts.gender ?? config.user?.gender);

  // ① 结构化英文锚点优先（`{ body, outfits }`，与 character_outfits 同一套思路）
  const a = config.user?.anchor;
  if (a && typeof a === 'object') {
    const text = [a.body, a.outfits]
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .join(', ');
    if (text) return { text, gender, source: 'user-anchor' };
  }

  // ② 兜底：中文自述（能出图，但认不出是谁 —— 宁可这样，也不要凭空造一个人）
  const text = String(config.user?.appearance || '').trim();
  if (!text) return null;
  return { text, gender, source: 'user' };
}

/**
 * 性别归一：中文「男/女」、英文 male/female、以及 1boy/1girl 之类都收。
 * 认不出时**按 female 处理** —— 现有角色全是女性，这是安全默认；
 * 用户形象的性别认不出时，`user_gender` 一般都填了，真填错也能一眼看出来。
 */
export function normalizeGender(value) {
  const s = String(value || '').trim().toLowerCase();
  if (/^(男|男性|male|m|man|boy|1boy|男生)$/.test(s)) return 'boy';
  if (/^(女|女性|female|f|woman|girl|1girl|女生)$/.test(s)) return 'girl';
  return 'girl';
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
 * @param {boolean} [opts.compact=false] 精简版，**默认不用**：
 *        只留「发型 + 瞳色」，约 100 字符。
 *        ⚠ 2026-10-22 夜间用户实报后改了口径 —— 见 `buildAnchorLines` 里的说明：
 *        精简会让她"少了脸和衣服"，画出来完全是另一个人；宁可长，不可缺。
 * @param {number} [opts.maxLen=1500] 单角色锚点软上限（**不硬砍**，见下）
 * @param {string} [opts.side] 'left' / 'right' —— 多人同框时标明位置，避免特征串味
 * @param {'boy'|'girl'} [opts.gender='girl'] 位置词的性别。用户本人是男性，
 *        写 `the girl on the left` 会和 `1boy` 直接打架（阶段 7，2026-10-23）
 * @returns {string}
 */
export function buildAnchorLine(text, opts = {}) {
  const { compact = false, maxLen = 1500, side = '', gender = 'girl' } = opts;
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
    /**
     * 超长处理（2026-10-23 实测后重写）。
     *
     * 原实现：先砍体型/肤色/标志物，再从**尾部**逐个弹段 —— 而服装正好在尾部。
     * 那等于"太长就把衣服脱了"，正是要避免的画错。
     *
     * 新实现：只做**第一层**（砍体型/肤色/标志物，它们对"认人"贡献最小），
     * 砍完还超就**不再硬砍**，只告警。
     *
     * 依据（当日实测，见 `scripts/probe-prompt-length.mjs`）：
     *   955 / 2957 / 5956 / 9957 字符四档全部出图成功，9957 时只是末尾的场景词失效，
     *   最前面的锚点仍然画对。**锚点在最前，权重最高，长一点不会把它冲掉**；
     *   硬砍才会。判据同前：宁可长，不可缺。
     */
    const parts = s.split(',').map(x => x.trim()).filter(Boolean);
    const dropOrder = [/build|figure|体型|身材/i, /skin|肤色/i, /tattoo|scar|痣|纹身|斑/i];
    let out = [...parts];
    for (const re of dropOrder) {
      if (out.join(', ').length <= maxLen) break;
      out = out.filter(p => !re.test(p));
    }
    s = out.join(', ');
    if (s.length > maxLen) {
      console.warn(`[anchor] 锚点 ${s.length} 字符 > ${maxLen}，已跳过硬截断`
        + '（硬砍会伤到发色/服装，反而把人画错）');
    }
  }

  if (!side) return s;
  // `the man` 而不是 `the boy` —— 与 mediaService 里 `the boy → the man` 的既有转换保持一致
  const who = gender === 'boy' ? 'the man' : 'the girl';
  const pos = side === 'left' ? `${who} on the left` : `${who} on the right`;
  // ★ 2026-10-22 夜间修正：**身份前缀不再阻止位置词**。
  //   原来"已有 `Name (Series)` 就不加位置词"，是为了避免读起来打架；
  //   但媒体/体位模板要靠位置词区分同框的两人，缺了它就分不清谁是谁。
  //   现在位置词放最前，与身份前缀并存：
  //   `the girl on the left, Fu Xuan (Honkai: Star Rail), long bright pink hair…`
  return `${pos}, ${s}`;
}

/**
 * 解析「一条」锚点请求 —— 角色或用户本人，统一成一个口径。
 *
 * 存在的理由：`applyAnchors` 需要**同时**拿到「文本」和「性别」才能写对人数据，
 * 而原来的 `buildAnchorLines` 只返回文本（还把空串过滤掉了），
 * 于是人数只能拿 `list.length` 猜 —— 一旦某人取不到锚点，人数就会写多。
 *
 * @param {{kind?:'user'|'character', characterId?:number, gender?:string,
 *   scene?:string, side?:'left'|'right', activity?:object,
 *   now?:Date|number|string, compact?:boolean}} item
 * @returns {{text:string, gender:'boy'|'girl', source:string}|null}
 */
export function resolveAnchorItem(item) {
  if (!item) return null;

  // ① 用户本人（`kind:'user'` 与方案里的 `slot:'user'` 两种写法都收）
  if (item.kind === 'user' || item.slot === 'user') {
    const u = resolveUserAnchor({ gender: item.gender });
    return u ? { text: u.text, gender: u.gender, source: u.source } : null;
  }

  // ② 角色（默认。现有角色卡全是女性，性别未指定按 girl 处理）
  const anchor = resolveAnchor(item.characterId, {
    scene: item.scene || 'auto',
    activity: item.activity,
    ...(item.now != null ? { now: toDate(item.now) } : {}),
  });
  if (!anchor?.text) return null;
  return {
    text: anchor.text,
    gender: normalizeGender(item.gender ?? 'girl'),
    source: anchor.source,
  };
}

/**
 * 一次取多个角色的锚点（多人同框用）。
 * 每个角色都是整段 —— 见 buildAnchorLine 的 compact 说明。
 *
 * @param {Array<{characterId:number, kind?:'user', gender?:string, scene?:string,
 *   side?:'left'|'right', activity?:object, now?:Date|number|string, compact?:boolean}>} list
 *   `kind: 'user'` = 用户本人（此时不看 characterId，读 config.user.appearance）
 *   `activity` = 那一段日程（配图必须传，避免"此刻"选错装）
 *   `now`      = 画面发生的**时刻**（补图/重绘历史帖时用；不传＝现在）
 * @returns {string[]} 与入参同序、可能含空串（取不到锚点时）
 */
export function buildAnchorLines(list = []) {
  return (Array.isArray(list) ? list : []).map((item) => {
    const hit = resolveAnchorItem(item);
    if (!hit?.text) return '';
    /**
     * ★★ 2026-10-22 夜间修正（用户实报"图左侧的人不是符玄，差距挺大"）
     *
     * 原设计：多人同框时第 2 个起 `compact: true`，只留「发型 + 瞳色」，
     * 理由是"两个 400 字符的锚点会互相稀释"。
     *
     * **这个权衡是错的**，实测数据：
     *   花火 569 字 → 113 字（丢 80%）；符玄 737 字 → 134 字（丢 82%）。
     * 符玄精简后只剩「粉发 + 金簪 + 额间宝石」，脸型、瞳色、体型、**衣服**全没了 ——
     * 模型只能自由发挥，画出来就是"另一个粉发女孩"。
     *
     * 判据订正：**稀释只是权重降低，缺字段是直接画错**。宁可长，不可缺。
     * 现在默认整段；只有调用方显式传 `compact: true` 才精简（留给极端多人图）。
     */
    return buildAnchorLine(hit.text, {
      compact: item?.compact === true,
      side: item?.side || '',
      gender: hit.gender,
    });
  }).filter(Boolean);
}

/** 宽松转 Date：非法值退回"现在"，不让一个坏参数把整张图的锚点搞没 */
function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

