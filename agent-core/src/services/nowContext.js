/**
 * nowContext.js — 「此刻」的唯一来源（阶段 8 · 文案层，2026-10-23）
 *
 * ── 为什么要有这个文件 ──
 * 阶段 8 的目标是「文案、配图、穿着三者对齐那一段日程」。穿着层早就接好了
 * （锚点吃 `activity` + `now`），但**文案层还是四条链路各拼一套**：
 *
 *   · 朋友圈 `momentForms.buildMomentScheduleContext`  → 只有「地点 + 在干什么」
 *   · 奇遇   `eventGenerator.scheduleContextLine`      → 另一套字段
 *   · 主动聊天 `proactiveChatScheduler.scheduleImgCtx`  → 有描述、有光照、有睡姿，最全
 *   · 日记   `diaryGenerator.formatScheduleForDiary`    → 用的是「整天」而不是此刻
 *
 * 字段不一带来的直接后果：同一个「此刻」，文案说"她在洗澡"、配图锚点按钟点选了常服。
 * 本文件把「几点 / 在哪 / 在做什么 / 进行到哪一步 / 穿什么 / 睡没睡」收敛成一份，
 * 文案与配图都读它 —— 两边天然同源，不需要各自再查一遍。
 *
 * ── 设计约束 ──
 * · **纯读取，不写库、不改状态**（`getCurrentActivity` 自带缓存，别在这里再包一层）
 * · **取不到就返回空**，绝不让"此刻"的缺失把整条链路打断
 * · `outfit` 走 `resolveAnchor`，**与配图锚点同一个函数** —— 这是"穿着同源"的保证
 */

import { getCurrentActivity } from './scheduleManager.js';
import { getTimeLight, getTimeLightInline } from './timeLight.js';
import { resolveAnchor } from './characterAnchor.js';

/** 'HH:MM' → 当天分钟数；解析不了返回 null */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return (h % 24) * 60 + mi;
}

/**
 * 这一段进行到哪了。
 *
 * 为什么要它：文案里"正在洗澡"和"刚洗完"是两句完全不同的话，
 * 而日程只给了 `startTime~endTime`。有了比例，模型才写得出"刚躺下还没睡着"。
 * 跨天（23:00–02:00）必须正确处理 —— `end <= start` 时把 end 顺延 24 小时。
 *
 * @returns {{phase:'start'|'mid'|'end'|'unknown', ratio:number|null}}
 */
export function progressOf(startTime, endTime, at = new Date()) {
  const s = toMinutes(startTime);
  const e = toMinutes(endTime);
  if (s == null || e == null || s === e) return { phase: 'unknown', ratio: null };

  let s2 = s;
  let e2 = e;
  let cur = at.getHours() * 60 + at.getMinutes();
  if (e2 <= s2) {
    e2 += 1440;                       // 跨天：23:00 → 02:00
    if (cur < s2) cur += 1440;        // 当前时刻已过零点
  }
  if (cur < s2 || cur > e2) return { phase: 'unknown', ratio: null };

  const total = e2 - s2;
  const ratio = total > 0 ? (cur - s2) / total : 0;
  const phase = ratio < 0.2 ? 'start' : ratio > 0.8 ? 'end' : 'mid';
  return { phase, ratio };
}

/**
 * 取「此刻」的完整上下文。
 *
 * @param {number} characterId
 * @param {object} [opts]
 * @param {Date} [opts.at] 画面/文案对应的时刻（补图、重绘历史帖时必须传，否则会按"现在"算）
 * @param {object|null} [opts.activity] 已知的那一段日程（比如奇遇绑定了一段，别让它再按时刻猜）
 * @param {boolean} [opts.withOutfit=true] 是否解析穿着（只写文案时关掉能省一次查询）
 * @returns {{
 *   at: Date, timeTag: string, timeStr: string, lightNote: string,
 *   activity: null|{location,activity,description,startTime,endTime,replyDelay,tags},
 *   progress: {phase,ratio}, isSleeping: boolean,
 *   outfit: null|{sceneKey,garment,source},
 * }}
 */
export function buildNowContext(characterId, opts = {}) {
  const { at = new Date(), activity = null, withOutfit = true } = opts;

  const tl = getTimeLight(at);
  const ctx = {
    at,
    timeTag: tl.timeDesc || '',
    timeStr: tl.timeStr || '',
    lightNote: '',
    activity: null,
    progress: { phase: 'unknown', ratio: null },
    isSleeping: false,
    outfit: null,
  };

  let act = activity;
  if (!act && characterId) {
    try { act = getCurrentActivity(characterId, at); } catch { act = null; }
  }

  if (act) {
    ctx.activity = {
      location: act.location || '',
      activity: act.activity || '',
      description: act.description || '',
      startTime: act.startTime || '',
      endTime: act.endTime || '',
      replyDelay: act.replyDelay,
      tags: Array.isArray(act.tags) ? act.tags : [],
    };
    ctx.progress = progressOf(act.startTime, act.endTime, at);
    // 项目里的既有约定：replyDelay === -1 表示这一段在睡觉（见 proactiveChatScheduler）
    ctx.isSleeping = act.replyDelay === -1;
  }

  try { ctx.lightNote = getTimeLightInline(at) || ''; } catch { ctx.lightNote = ''; }

  if (withOutfit && characterId) {
    try {
      const a = resolveAnchor(characterId, { activity: act || undefined, now: at });
      if (a) ctx.outfit = { sceneKey: a.sceneKey, garment: a.garment, source: a.source };
    } catch { /* 穿着取不到不该影响文案 */ }
  }

  return ctx;
}

/** 进度 → 人话（给文案用；'unknown' 不写，免得模型硬编） */
const PHASE_NOTE = {
  start: '刚开头',
  mid: '正做着',
  end: '快结束了',
  unknown: '',
};

/**
 * 文案用：把「此刻」压成一段提示词，
 * 与 `momentForms.buildMomentScheduleContext` 原来的输出形态保持一致（`【此刻正在做】…`）。
 *
 * ⚠ `withDescription` 默认 **false**，理由见 momentForms 里那段 A/B 实测：
 *   日程 description 常常逐字照抄世界观例句，LLM 会把它复读进正文。
 *
 * @param {object} ctx buildNowContext 的返回
 * @param {object} [opts]
 * @param {string} [opts.name] 角色名
 * @param {boolean} [opts.withDescription=false]
 * @param {boolean} [opts.withProgress=true] 是否带"刚开头/快结束了"
 */
export function formatNowForText(ctx, opts = {}) {
  const { name = '', withDescription = false, withProgress = true } = opts;
  if (!ctx?.activity) return '';
  const { location, activity, description } = ctx.activity;
  const doing = [String(location || '').trim(), String(activity || '').trim()].filter(Boolean).join('');
  if (!doing) return '';

  const phase = withProgress ? PHASE_NOTE[ctx.progress?.phase] || '' : '';
  const who = name ? `${name}此刻正在${doing}` : `此刻正在${doing}`;
  const descPart = withDescription && description
    ? `\n（以下描述只是背景，帮你确认此刻的处境；写文案时请换成人话，不要沿用它的句式、书面词或比喻。）\n背景：${description}`
    : '';
  return `\n**【此刻正在做】${who}**${phase ? `（这一段${phase}）` : ''}${descPart}`;
}

/**
 * 配图用：把「此刻」压成生图提示词里的一段（含光照与睡姿硬约束）。
 * 与 `proactiveChatScheduler` 里原有的 `scheduleImgCtx` 同形态，改为统一出口。
 *
 * ⚠ 睡觉那段的措辞是长期调出来的（闭眼 / 不开灯 / 换睡衣），别随手改写。
 */
export function formatNowForImage(ctx) {
  if (!ctx?.activity) return '';
  const { location, activity, description } = ctx.activity;
  const sleepNote = ctx.isSleeping
    ? '\n\n【极其重要】角色正在睡觉，双眼必须紧闭，**房间里没有灯光，睡觉时候不开灯**，不能睁眼。'
      + '表情安详放松，呈现深度睡眠的自然状态，盖被子。'
      + '睡姿、床、被子、**睡衣（睡觉时候绝对不会穿本来的衣服）**等细节贴合角色性格。'
    : '';
  const phase = PHASE_NOTE[ctx.progress?.phase] || '';
  const phaseNote = phase && !ctx.isSleeping ? `（这一段${phase}）` : '';
  return `【当前日程】角色正在【${location}】${activity}${phaseNote}。`
    + (description ? `${description}。` : '')
    + (ctx.lightNote ? `${ctx.lightNote}。` : '')
    + `照片里的角色要体现正在做的日程。${sleepNote}`;
}
