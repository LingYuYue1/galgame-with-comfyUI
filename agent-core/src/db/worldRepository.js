// 世界观 / 全局规则 / 系统规则仓储（独立模块，缩小 db/index.js 体积）。
// 依赖方向（单向）：db/index.js 打开数据库后注入句柄并再导出本模块的函数。
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { SYSTEM_RULES_CONTENT, IMAGE_PROMPT_RULE, BUILTIN_RULE_KEYS } from '../builtinRules.js';
import {
  scaffoldProject,
  writeWorldDoc,
  readProject,
  projectDirFor,
  slugForWorld,
  guessSlotsFromContent,
  neutralProject,
  getProjectCacheStats,
} from '../services/worldProjectLibrary.js';
// ★ 星图 T15：在途旅途语境（本模块只读它；tripRepository 不反向依赖本模块，无环）
import { getTripWorldContext } from './tripRepository.js';
// ★ 星图 T13：缓存代数（一个只装计数器的模块，谁都能 import，不成环）
import { bumpWorldCache, worldCacheEpoch, worldCacheLog } from './worldCacheSignal.js';

let _db = null;

/** db/index.js 打开数据库后注入句柄（此模块不反向依赖 db/index.js） */
export function initWorldRepository(db) {
  _db = db;
}

function handle() {
  if (!_db) throw new Error('worldRepository: db handle not initialized (initWorldRepository)');
  return _db;
}

// ── 世界文本 memo（星图 T13）────────────────────────────────
// 为什么值得缓存：`getWorldSetting` 是**所有** prompt 的必经之路（T08 之后 36 处调用点 +
// `getSystemRulesWithWorld` 46 处），每次都要：resolver 查角色行（T15 之后还要查旅程表）
// + 查世界行 + 读 project.json + 正则裁剪。同一角色在同一分钟内会被问几十次，结果却完全一样。
//
// 失效模型（两条腿）：
//   · **代数**（worldCacheSignal）：所有写入口主动 bump —— 建/改/删/激活世界、改绑角色、
//     发起/取消/结算旅程、写项目库。这是主路径，命中即刻生效。
//   · **TTL 3s**：兜住"没人 bump 的外部修改"（例如用户直接编辑 project.json）。
//     3 秒是权衡：再短等于没缓存，再长会让手工改库后要等一会儿才生效。
const WORLD_MEMO_TTL_MS = Number(process.env.WORLD_MEMO_TTL_MS) > 0
  ? Number(process.env.WORLD_MEMO_TTL_MS)
  : 3000;
const WORLD_MEMO_LIMIT = 200;
const _worldMemo = new Map(); // key -> { value, epoch, at }
const _worldStats = { hits: 0, misses: 0, builds: 0, lastBuildMs: 0, lastChars: 0 };

/** 缓存键：未传角色 = 单独一格（激活世界），不能和任何角色共用 */
function worldMemoKey(characterId) {
  if (characterId == null || characterId === '') return '__active__';
  const n = Number(characterId);
  return Number.isFinite(n) ? `c${n}` : `x${String(characterId)}`;
}

/** 读 memo：代数不一致或过期 → 当作未命中（惰性失效，不主动清表） */
function readWorldMemo(key) {
  const hit = _worldMemo.get(key);
  if (!hit) { _worldStats.misses++; return undefined; }
  if (hit.epoch !== worldCacheEpoch() || Date.now() - hit.at > WORLD_MEMO_TTL_MS) {
    _worldMemo.delete(key);
    _worldStats.misses++;
    return undefined;
  }
  _worldStats.hits++;
  return hit.value;
}

function writeWorldMemo(key, value, buildMs = 0) {
  if (_worldMemo.size >= WORLD_MEMO_LIMIT && !_worldMemo.has(key)) _worldMemo.clear();
  _worldMemo.set(key, { value, epoch: worldCacheEpoch(), at: Date.now() });
  _worldStats.builds++;
  _worldStats.lastChars = typeof value === 'string' ? value.length : 0;
  if (Number.isFinite(buildMs)) _worldStats.lastBuildMs = buildMs;
}

/**
 * 让世界文本缓存整体作废。
 * 写入口调用（本模块 CRUD / 角色改绑 / 旅程变更）；也供调试接口手动清。
 */
export function invalidateWorldCache(reason = 'manual') {
  return bumpWorldCache(reason);
}

/** 缓存统计（`GET /api/config/world-cache-stats`） */
export function getWorldCacheStats() {
  let project = null;
  try { project = getProjectCacheStats(); } catch { /* 项目库模块异常不影响主统计 */ }
  // 用量度量：谁的世界块最吃 token（只统计仍在缓存里的条目，够用且零额外记账）
  const topChars = [..._worldMemo.entries()]
    .map(([key, hit]) => ({ key, chars: typeof hit.value === 'string' ? hit.value.length : 0 }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5);
  return {
    epoch: worldCacheEpoch(),
    world: { ..._worldStats, entries: _worldMemo.size, limit: WORLD_MEMO_LIMIT, ttlMs: WORLD_MEMO_TTL_MS },
    project,
    topChars,
    recentInvalidations: worldCacheLog().slice(0, 10),
  };
}

/** 仅供测试：清空 memo 与计数 */
export function __resetWorldCacheForTest() {
  _worldMemo.clear();
  _worldStats.hits = 0;
  _worldStats.misses = 0;
  _worldStats.builds = 0;
  _worldStats.lastBuildMs = 0;
  _worldStats.lastChars = 0;
}

/**
 * 获取所有激活的全局规则内容（拼接为一个字符串）
 */
// image_intent / image_prompt 是元规则（非 LLM system prompt 内容），不拼入
// world_setting 单独追加到末尾，不在批量拼接中
// BUILTIN_RULE_KEYS 从 builtinRules.js 导入，统一管理所有硬编码规则

export function getActiveGlobalRules() {
  const database = handle();
  const excludeKeys = [...BUILTIN_RULE_KEYS, 'world_setting'];
  const rules = database.prepare(
    `SELECT rule_content FROM global_rules WHERE is_active = 1 AND rule_key NOT IN (${excludeKeys.map(() => '?').join(',')})`
  ).all(...excludeKeys);
  return rules.map(r => r.rule_content).join('\n\n');
}

/** 判断当前时间是否在指定时间段内（24 小时制，支持跨午夜） */
function isInDisturbTimeRange(now, startTime, endTime) {
  const toMinutes = (hhmm) => {
    const parts = String(hhmm).split(':');
    return parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
  };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = toMinutes(startTime);
  const endMin = toMinutes(endTime);
  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin < endMin;
  } else {
    return nowMin >= startMin || nowMin < endMin;
  }
}

/**
 * 获取世界观（独立消息注入，不拼入全局规则）。
 *
 * ⚠ 本函数返回**未经进化的原文**。要用"裁剪后的"版本请走 `getWorldSettingForPrompt()`
 *   或 `getSystemRulesWithWorld()`。
 *
 * ── ★★ 2026-10-07 为什么改成"默认已裁剪"（架构修正）────────────
 * 原先这里返回裸文本，裁剪只挂在 `getSystemRulesWithWorld()` 上 —— 结果全项目
 * **55 处调用点里有 22 处在裸用本函数**，裸文本直接进 prompt，**完全绕过保护**
 * （覆盖日程 / 网络 6 处 / 群聊 / 报纸 / 道具 / 小镇NPC / 叫醒 / 回复队列）。
 * 注释当时写着"所有链路自动生效"，实际没有 —— 因为更常用的入口没一起收口。
 *
 * 现在改为**在此单点收口**：本函数自身即返回裁剪后的文本，
 * 22 处一次性获得保护，且将来新链路不可能再"忘了 opt-in"。
 * 需要原文的场景走显式逃生口 `getWorldSettingRaw()`。
 *
 * 防打扰模式 hideWorld 开启时，时间段内返回 null 但不修改 DB 原值。
 * 优先从 world_settings 表读取激活项，兼容旧 global_rules.world_setting。
 *
 * ── ★★ 2026-10-17 星图 T07：按角色解析世界（**覆盖，不拼接**）────────────
 * `getWorldSetting(characterId)` —— 传了角色 id 就"这个角色此刻身处哪个世界"说了算：
 *   ① 角色 `world_setting_id` 有值且指向存在的世界 → **只用那个世界**，早返回。
 *      「覆盖」的具体含义：**激活世界的文本一个字都不进 prompt**，不是两份拼接、
 *      不是"现地为主 + 家乡摘要"。多世界下拼接会让 token 随世界数线性涨，
 *      且两套设定同时在场会让模型的行为与语气互相污染。
 *   ② 角色未绑定（NULL）/ 传空 / 指向已删世界 → 回落激活世界（= 改造前的行为）。
 *      ↳ 这一步是**零行为变化的护栏**：T07 不动任何调用点，老调用不传参即走此路。
 *   ③ 绑定世界的正文为空 → 返回 null（与"激活世界正文为空"同口径：
 *      用户建了空世界 = 主动选择"这个角色没有世界观"，不是错误，不回退激活世界）。
 *
 * @param {number|string|null} [characterId] 角色 id；不传 = 按激活世界（旧行为）
 */
/**
 * 主世界（框架）与具体世界同时存在时的关系说明。
 *
 * 没有这句，模型会把两个 <world_setting> 当成互相矛盾的两份设定，然后随机挑一段遵守。
 * 它的职责只有一条：**冲突时以具体世界为准，框架只兜底**。
 */
/**
 * 主世界（框架）与具体世界同时存在时的衔接语。
 *
 * ★ 2026-10-18 用户确认：「主世界是骨架，就像小说的开头，其他世界是内容。
 *   两者在一块是开头+内容的结构，直接加在一起不会有什么问题。」
 *   所以这里不再写"冲突时以 current 为准"那种仲裁口吻 —— 那反而在暗示两者会打架。
 *   只留一句结构标注，让模型知道这是"开头"与"正文"的关系，不是两个并列的世界。
 */
const FRAMEWORK_MERGE_HINT = [
  '以上是这个世界的通行框架，以下是本次所在世界的具体设定；',
  '按「开头」与「正文」的关系连着读，不要当成两套互相并列的世界。',
].join('');

/**
 * 防打扰模式下「此刻是否要隐藏世界观」。
 *
 * 2026-10-19 从 `getWorldSetting()` 里抽出来（合并 v3.10 需要：上游
 * `services/lorebook/runtime.js` 直接 import 这个函数）。抽取是纯重构，
 * 判据与原来逐字一致，`getWorldSetting` 改为调用本函数。
 *
 * ⚠ 这一层**不进缓存**：它随「当前时刻」变化（同一角色白天有世界、夜里没有），
 *   进缓存就得给"时间段"再造一套失效逻辑，得不偿失。它只是两次 Date 比较，很便宜。
 */
export function isWorldSettingHidden(now = new Date()) {
  if (!config.features.disturbMode || !config.disturb.hideWorld) return false;
  if (!isInDisturbTimeRange(now, config.disturb.startTime, config.disturb.endTime)) return false;
  if (config.disturb.skipWeekends && (now.getDay() === 0 || now.getDay() === 6)) return false;
  return true;
}

export function getWorldSetting(characterId = null) {
  // 防打扰隐藏世界观：不改 DB，仅在 prompt 构建时返回 null
  if (isWorldSettingHidden()) return null;

  // ★ 星图 T13：进程内 memo（命中直接返回，未命中重建后回填）
  //   失效靠 `worldCacheSignal` 的代数 + 3 秒 TTL 双保险：
  //     · 代数：建/改/删/激活世界、改绑角色、发起/取消/结算旅程 —— 都会 bump；
  //     · TTL ：兜住"手工改了 project.json 但没人 bump"这种外部修改。
  const memoKey = worldMemoKey(characterId);
  const memoHit = readWorldMemo(memoKey);
  if (memoHit !== undefined) return memoHit;

  // 构建耗时：只统计"未命中"的那一次（这正是缓存想省掉的工作量）
  const buildStart = Date.now();
  let out = null;
  // ① 主世界（骨架层）：**永远叠加**，包成 framework 块。
  //    它是所有角色共用的基础规则，不属于任何一个具体世界。
  const core = getCoreWorldSetting();
  const coreBlock = core?.content?.trim()
    ? adaptWorldText(
        `<world_setting role="framework">\n${core.content}\n</world_setting>`,
        'strip', safeSlotsFor(core))
    : '';

  // ② 角色绑定的具体世界（在途 → 旅途伪世界，走同一条解析链）
  const bound = resolveBoundWorld(characterId);
  let specificBlock = '';
  if (bound?.content?.trim()) {
    specificBlock = adaptWorldText(
      `<world_setting role="current">\n${bound.content}\n</world_setting>`,
      'strip', safeSlotsFor(bound));
  } else if (!core) {
    // ③ 老库兜底：还没有主世界（未跑 011 迁移）→ 维持改造前「激活世界当默认」的行为
    const active = getActiveWorldSetting();
    if (active?.content?.trim()) {
      specificBlock = adaptWorldText(
        `<world_setting>\n${active.content}\n</world_setting>`, 'strip', safeActiveSlots());
    } else {
      // 兼容旧表（仅 world_settings 表无激活项时）
      const world = getGlobalRule('world_setting');
      if (world?.rule_content && world.is_active) {
        specificBlock = adaptWorldText(world.rule_content, 'strip', safeActiveSlots());
      }
    }
  }

  // 主世界在前（框架先立），具体世界在后（细节覆盖框架）。
  // ★ 两块之间必须有一句关系说明：否则模型会把它们当成两个互相打架的世界。
  if (coreBlock && specificBlock) {
    out = `${coreBlock}\n\n${FRAMEWORK_MERGE_HINT}\n\n${specificBlock}`;
  } else {
    out = coreBlock || specificBlock || null;
  }

  writeWorldMemo(memoKey, out, Date.now() - buildStart);
  return out;
}

/**
 * 角色 → 绑定的世界行（T07 内部用）。
 *
 * 不依赖角色仓储，直接查表 —— 本模块的依赖方向是单向的（不可反向 import db/index.js）。
 * 任何异常（表没有该列 / 角色已删）都当作"未绑定"返回 null，绝不让解析失败拖垮 prompt 构建。
 *
 * ★ 星图 T15（2026-10-17）：**在途优先**。
 *   角色在路上时，她此刻的世界语境是「旅途本身」——不是出发地，也不是目的地。
 *   所以这里第一件事是问 tripRepository「她在途吗」，命中就返回**旅途伪世界**并早返回。
 *   把判断放在这个函数里而不是 `getWorldSetting` 里，是因为所有入口
 *   （getWorldSetting / getWorldSettingRaw / getWorldSlotsFor / getCharacterWorldSettingId）
 *   最终都汇到这里 —— 一处收口，全链路自动吃旅途语境，不必再逐个调用点改造。
 */
function resolveBoundWorld(characterId) {
  if (characterId == null || characterId === '') return null;
  const id = Number(characterId);
  if (!Number.isFinite(id)) return null;
  // ① 在途 → 旅途语境整体覆盖（覆盖不拼接：出发地与目的地的正文一个字都不进 prompt）
  try {
    const tripWorld = getTripWorldContext(id);
    if (tripWorld) return tripWorld;
  } catch (err) {
    // 旅程表未建 / 查询异常 → 当"不在途"，继续走正常绑定解析（绝不因旅程拖垮世界观）
    console.warn(`[worldRepository] 旅途语境解析失败，按正常绑定处理: ${err.message}`);
  }
  try {
    const row = handle().prepare(`SELECT world_setting_id FROM characters WHERE id = ?`).get(id);
    const wid = row?.world_setting_id;
    if (wid == null) return null;
    // 指向已删世界 → 返回 undefined → 当未绑定处理（T12 会加引用保护，这里必须先不崩）
    return getWorldSettingById(wid) || null;
  } catch {
    return null;
  }
}

/** 供 T10/T12 与测试使用：取角色绑定的世界 id（未绑定 → null） */
export function getCharacterWorldSettingId(characterId) {
  const bound = resolveBoundWorld(characterId);
  return bound ? bound.id : null;
}

/**
 * 取原文（**逃生口**）—— 只有确需例句/原始文本的场景才用。
 * 其余一律用 `getWorldSetting()`（已裁剪）。
 *
 * @param {number|string|null} [characterId] 传了按该角色绑定世界解析（同 getWorldSetting）
 */
export function getWorldSettingRaw(characterId = null) {
  // 与 getWorldSetting 同构：主世界（framework）+ 角色绑定世界（current）
  const core = getCoreWorldSetting();
  const coreBlock = core?.content?.trim()
    ? `<world_setting role="framework">\n${core.content}\n</world_setting>` : '';
  const bound = resolveBoundWorld(characterId);
  const specificBlock = bound?.content?.trim()
    ? `<world_setting role="current">\n${bound.content}\n</world_setting>` : '';
  if (coreBlock && specificBlock) return `${coreBlock}\n\n${FRAMEWORK_MERGE_HINT}\n\n${specificBlock}`;
  if (coreBlock || specificBlock) return coreBlock || specificBlock;

  // 老库兜底（没有主世界时维持旧行为）
  const active = getActiveWorldSetting();
  if (active) return active.content?.trim() ? `<world_setting>\n${active.content}\n</world_setting>` : null;
  const world = getGlobalRule('world_setting');
  return (world?.rule_content && world.is_active) ? world.rule_content : null;
}

/**
 * 媒体抽卡（星图设计定稿 §9.3-1，用户拍板「每个地方都应该有媒体」）：
 * 从「启用中」的**副世界**随机抽 min~max 个，各自按**自己的项目库槽位**裁剪后，
 * 分别包一层 `<world_setting name="世界名">`。连抽中的世界 id 一起返回。
 *
 * 为什么需要 id：媒体/报纸是「抽一个世界当背景 + 另外抽几个角色当作者」的两条独立线，
 * 不配对就会出现「二维市背景 + 仙舟作者」。要按世界筛作者池，就必须知道这轮抽中了谁。
 *
 * 边界：
 *   · 0 个可用副世界 → 老库回退激活世界；分层后返回 `{ text: null, ids: [] }`
 *   · 防打扰 hideWorld 命中 → `{ text: null, ids: [] }`（与 getWorldSetting 同口径）
 *   · 每个世界单独 try/catch：裁剪失败回落不裁（不因一个世界坏掉拖垮整批）
 *
 * ⚠ 使用纪律：同一次业务流程**只调一次**，结果存局部变量复用 ——
 *   否则会出现「作者取自 A 世界抽样、内容按 B 世界抽样」的错位。
 *
 * @returns {{text: string|null, ids: number[]}}
 */
export function sampleWorldSettings(min = 1, max = 3) {
  const sampled = sampleWorldSettingsImpl(min, max);
  return sampled;
}

/** `getWorldSettingSample` 的老契约：只要文本。 */
export function getWorldSettingSample(min = 1, max = 3) {
  return sampleWorldSettingsImpl(min, max).text;
}

function sampleWorldSettingsImpl(min = 1, max = 3) {
  // 防打扰：与 getWorldSetting 完全同口径
  if (config.features.disturbMode && config.disturb.hideWorld) {
    const now = new Date();
    if (isInDisturbTimeRange(now, config.disturb.startTime, config.disturb.endTime)) {
      if (!config.disturb.skipWeekends || (now.getDay() !== 0 && now.getDay() !== 6)) {
        return { text: null, ids: [] };
      }
    }
  }

  const database = handle();
  // ★ 2026-10-18 世界分层：抽卡池**必须排除主世界**。
  //   主世界是骨架（"世界群通则"），不是可以报道的具体地点 —— 分层前它不在池子里
  //   （那时它是"激活世界"，通常是具体世界），分层后它 is_enabled=1 且正文非空，
  //   不排除就会让媒体拿骨架当星球写新闻。
  const pool = database.prepare(
    `SELECT * FROM world_settings WHERE is_enabled = 1 AND is_core = 0 AND TRIM(content) <> ''`
  ).all();
  if (!pool.length) {
    // 池空兜底：
    //   · 老库（还没跑 011、没有主世界）→ 维持原行为，用激活世界
    //   · 分层后（有主世界）→ 返回 null：宁可没有世界背景，也不拿骨架顶替
    const core = getCoreWorldSetting();
    if (!core) {
      const w = getWorldSetting();
      return { text: w, ids: [] };
    }
    return { text: null, ids: [] };
  }

  const lo = Math.max(1, Math.min(min, max));
  const hi = Math.max(lo, max);
  const n = Math.max(1, Math.min(pool.length, lo + Math.floor(Math.random() * (hi - lo + 1))));

  // Fisher-Yates 洗牌后取前 n 个
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  const picked = arr.slice(0, n);
  const text = picked.map((w) => {
    const raw = `<world_setting name="${w.name}">\n${w.content}\n</world_setting>`;
    try {
      // ★ 按该世界**自己**的项目库槽位裁剪（不能用 safeActiveSlots —— 那是激活世界的）
      return adaptWorldText(raw, 'strip', readProject(slugForWorld(w.name, w.id)));
    } catch {
      return raw;
    }
  }).join('\n\n');
  return { text, ids: picked.map((w) => Number(w.id)) };
}

/** 读某个世界的槽位；任何异常都回落中性值（不阻断注入）。传 null = 无世界。 */
function safeSlotsFor(world) {
  try {
    if (!world) return neutralProject();
    return readProject(slugForWorld(world.name, world.id));
  } catch {
    return neutralProject();
  }
}

/** 读激活世界观的槽位；任何异常都回落中性值（不阻断注入） */
function safeActiveSlots() {
  try {
    return safeSlotsFor(getActiveWorldSetting());
  } catch {
    return neutralProject();
  }
}

/** 某角色该吃哪套槽位：绑定世界优先，未绑定回落激活世界（与 getWorldSetting 同口径） */
function slotsForCharacter(characterId) {
  try {
    const core = getCoreWorldSetting();
    const bound = resolveBoundWorld(characterId);
    // ★ 2026-10-18：主世界 + 具体世界同时存在时，两块文本在 getWorldSetting 里**已各自按自己的槽位裁过**。
    //   这里再拿具体世界的槽位去裁整段，会把主世界里同名章节误裁 —— 所以返回中性（=不再裁）。
    if (core && bound && Number(core.id) !== Number(bound.id)) return neutralProject();
    return safeSlotsFor(bound || getActiveWorldSetting());
  } catch {
    return neutralProject();
  }
}

/**
 * 世界观注入前的默认变换：**裁掉该世界观声明为"氛围节"的段落**。
 *
 * ── ★★ 2026-10-07 架构修正：从"引擎硬编码章节名"改为"由世界观自己声明" ──
 *
 * **修正前的问题**：本函数原先用 `WORLD_BEHAVIOR_HEADING_RE = /^#{1,6}\s*人们的行为\s*$/`
 * 识别要裁的段落 —— 而「人们的行为」**只是某一个世界观的章节名**。
 * 换成「武装JK世界」（用「日常规则」）或「少女与战车」（用「核心设定」），
 * 这道保护**完全不生效，而且是静默的**。
 * 这是"引擎内置具体世界观知识"的典型症状（详见 2026-10-07 引擎实例化污染审计）。
 *
 * **修正后**：要裁哪些节，由**该世界观的独立项目库**声明
 * （`data/world-projects/<slug>/project.json` 的 `ambienceSections`）。
 * 引擎不再认识任何具体章节名，只认识"用户声明了这一节是氛围节"这个**通用概念**。
 *
 * ── 为什么要裁（实测证据仍然成立，2026-10-04 A/B）────────────
 * 氛围节是十几条**例句**，文体是"示例"不是"规则"。它在 prompt 里的位置让 LLM 天然当
 * few-shot 示范，产生两类危害：
 *   1. **文字链路复读措辞** —— 产出「锅还开着」「报数报到三十七了」这类复读式文案；
 *   2. **生图链路搬错意象** —— 例句里塞满具体视觉道具与**自造名词**，LLM 把它们当
 *      "该画的画面清单"，自造名词不认识就退化成最接近的常见概念
 *      （实测：「肋侧还没画完的幻造种」→ 人类肋骨、「袖口里探出来的触手」→ 章鱼触手）。
 *      A/B：完整世界观 → 命中 `rib`+`tentacle`；裁掉后 → 零命中。
 *
 * ⚠ **默认不裁**：项目库缺失或 `ambienceSections` 为空时，**原样返回**。
 *   这是刻意的保守默认 —— 存量世界观还没建项目库，行为必须与"没有这套机制"一致。
 *
 * @param {string} worldSetting 原始 <world_setting> 文本
 * @param {'strip'|'annotate'|'keep'} mode
 *   - strip    ：整段剔除（默认）
 *   - annotate ：保留内容，但段首插一行"这是氛围不是台词"的警示
 *   - keep     ：原样返回
 * @param {{ambienceSections?: string[]}} [slots] 该世界观声明的槽位（来自项目库）
 */
export function adaptWorldText(worldSetting, mode = 'strip', slots = null) {
  const text = String(worldSetting || '');
  if (!text || mode === 'keep') return text;

  // ★ 引擎不认识具体章节名 —— 只认"被声明为氛围节"的标题集合
  const declared = (slots?.ambienceSections || []).map(s => String(s).trim()).filter(Boolean);
  if (declared.length === 0) return text;   // 没声明 → 不裁（保守默认）

  const isAmbience = (heading) => declared.includes(heading);

  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  let found = false;

  for (const line of lines) {
    // ★ 闭合标签是结构框架（不属于任何内容节）：即便它紧跟被裁的节，也必须保留，
    //   否则注入 prompt 的 <world_setting> 块会变成未闭合。
    //   （上游 v3.8.2 曾为此专加回归断言：closing tag must reach the model unchanged；本仓同样保证。）
    if (line.trim() === '</world_setting>') {
      skipping = false;
      out.push(line);
      continue;
    }
    const m = line.match(/^#{1,6}\s*(.+?)\s*$/);
    if (m) {
      if (isAmbience(m[1])) {
        found = true;
        if (mode === 'annotate') {
          out.push(line, '');
          out.push('> 【氛围参考，不是台词库，更不是画面清单】以下描述的是这个世界"平时是什么样"，用来理解这里的常态；**不要引用、复述或改写其中任何一句的措辞，也不要把其中的具体物件当作画面元素**。世界感靠"理所当然"透出来即可。');
          skipping = false;
        } else {
          skipping = true; // strip：标题也不保留
        }
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(line);
  }

  if (!found) return text; // 声明的节在这份世界观里不存在 → 原样返回，不动
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 取【当前激活世界观】的项目库槽位。
 * 读不到（存量世界观无项目库）→ 返回中性值，**等价于"没有这套机制"**。
 */
export function getActiveWorldSlots() {
  const active = getActiveWorldSetting();
  if (!active) return neutralProject();
  try {
    return readProject(slugForWorld(active.name, active.id));
  } catch (err) {
    console.warn(`[worldRepository] 读取世界观项目库失败，回落中性默认值: ${err.message}`);
    return neutralProject();
  }
}

/**
 * 取【某角色该吃哪套】项目库槽位（星图 T08）。
 *
 * 世界与它的槽位必须**成对**取：文本按角色所在世界解析、词表却按激活世界取，
 * 结果就是「用 A 世界的氛围节去裁 B 世界的文本」「B 世界的口头禅套在 A 世界的角色身上」。
 * 所以凡是"已经调用 getWorldSetting(characterId)"的链路，取槽位一律走这里。
 *
 * @param {number|string|null} [characterId] 不传 → 等同 getActiveWorldSlots()
 */
export function getWorldSlotsFor(characterId = null) {
  if (characterId == null || characterId === '') return getActiveWorldSlots();
  try {
    return slotsForCharacter(characterId);
  } catch (err) {
    console.warn(`[worldRepository] 读取角色所在世界的项目库失败，回落激活世界槽位: ${err.message}`);
    return getActiveWorldSlots();
  }
}

/** getSystemRules() + 世界观拼接，供需要世界设定的调用方使用。
 *
 * ★ 裁剪**由世界观自己声明**（项目库 `ambienceSections`），引擎不内置任何章节名。
 *   未声明 → 不裁（保守默认，保证存量行为不变）。
 *
 * @param {object} [opts]
 * @param {(world: string) => string|null} [opts.worldTransform] - 覆盖默认的世界观变换。
 *   - 不传 → 用默认的 `adaptWorldText`（按项目库声明裁剪）
 *   - 传函数 → 用传入的（如 `adaptWorldText.bind(null, ...)` 换 mode）
 *   - 传 `null` → **显式保留原文**（逃生口，仅供确需例句的场景）
 * @param {boolean} [opts.roleplay] - 透传给 getSystemRules()
 * @param {number|string} [opts.characterId] - 透传给 getWorldSetting：按该角色绑定世界解析（T07）
 */
export function getSystemRulesWithWorld(opts = {}) {
  const { worldTransform, characterId, ...ruleOpts } = opts;
  const rules = getSystemRules(ruleOpts);
  const rawWorld = getWorldSetting(characterId);
  // 注意：这里要能区分「没传」与「显式传 null」——用 in 判断，不能用默认参数
  const transform = 'worldTransform' in opts ? worldTransform : adaptWorldText;
  // ★ 槽位必须与"取到的那个世界"配对：角色在 A 世界，就不能拿激活世界 B 的槽位去裁
  const slots = slotsForCharacter(characterId);
  const world = rawWorld && typeof transform === 'function'
    // 默认变换需要槽位；用户自定义的 transform 按其自身签名调用，不替它塞参数
    ? (transform === adaptWorldText ? adaptWorldText(rawWorld, 'strip', slots) : transform(rawWorld))
    : rawWorld;
  return [rules, world].filter(Boolean).join('\n\n');
}

/** 获取单条全局规则（用于元规则如 judge_prompt）。内置规则直接返回硬编码常量。 */
export function getGlobalRule(key) {
  if (BUILTIN_RULE_KEYS.has(key)) {
    return key === 'image_prompt' ? IMAGE_PROMPT_RULE : null;
  }
  const database = handle();
  return database.prepare(`SELECT * FROM global_rules WHERE rule_key = ?`).get(key);
}

/**
 * 获取系统规则（破限词：system_context + core_rules），统一各场景的 jailbreak。
 *
 * @param {object} [options]
 * @param {boolean} [options.roleplay=true] - 是否包含 `<roleplay>` 内的角色扮演激活指令。
 *   为 false 时仅返回基础上下文（虚构文学定位、创作自由），适用于无需角色扮演的流程。
 */
export function getSystemRules({ roleplay = true } = {}) {
  const content = SYSTEM_RULES_CONTENT;

  // 基础内容
  let base = '';
  const rpMatch = content.match(/<roleplay>([\s\S]*?)<\/roleplay>/);
  if (!rpMatch) {
    base = content;  // 无标签（旧数据），向下兼容
  } else {
    const before = content.slice(0, rpMatch.index).trim();
    // 基础上下文始终保留，roleplay 指令按需包含
    base = roleplay ? before + '\n\n' + rpMatch[1].trim() : before;
  }

  return base;
}

// ── 世界观收藏 CRUD ──

export function listWorldSettings() {
  const database = handle();
  // 星图（2026-10-17 T01）：补两个聚合字段供卡片墙显示；原有字段全部保留（w.*），旧弹窗零影响。
  // characterCount 只数「已归属」的（world_setting_id = 本世界）；NULL 归属是「未归属」，不进任何世界计数。
  const worlds = database.prepare(`
    SELECT w.*,
           (SELECT COUNT(*) FROM world_maps m WHERE m.world_setting_id = w.id) AS mapCount,
           -- 2026-10-18：与卡片头像同口径 —— **归档角色不算居民**，否则卡片会
           -- 显示「2 个头像 · 3 角色」并多算一个 "+1"（那一个是被归档的，看不见也点不到）。
           (SELECT COUNT(*) FROM characters c
             WHERE c.world_setting_id = w.id AND COALESCE(c.archived, 0) = 0) AS characterCount
      FROM world_settings w
     ORDER BY w.is_core DESC, w.sort_order, w.id
  `).all();
  if (!worlds.length) return worlds;

  // ★ 2026-10-18：卡片左下角要显示居民头像。**一次查全表再分组**，不要按世界循环查
  //   （世界一多就是 N+1）。只取卡片要用的三列，每个世界最多带 8 个（够叠一行头像）。
  //   取不到（老库没这几列/表异常）就退化成空数组 —— 卡片照常渲染，不许因头像挂掉。
  const AVATAR_LIMIT = 8;
  let byWorld = new Map();
  try {
    const ids = worlds.map(w => w.id);
    const rows = database.prepare(`
      SELECT id, world_setting_id, display_name, name, avatar_path
        FROM characters
       WHERE world_setting_id IN (${ids.map(() => '?').join(',')})
         AND COALESCE(archived, 0) = 0
       ORDER BY id
    `).all(...ids);
    for (const r of rows) {
      const key = Number(r.world_setting_id);
      const list = byWorld.get(key) || [];
      if (list.length < AVATAR_LIMIT) {
        list.push({
          id: r.id,
          display_name: r.display_name || r.name || '',
          name: r.name || '',
          avatar_path: r.avatar_path || '',
        });
      }
      byWorld.set(key, list);
    }
  } catch (err) {
    console.warn(`[worldRepository] 世界居民头像聚合失败（卡片退回无头像）: ${err.message}`);
    byWorld = new Map();
  }

  return worlds.map(w => ({ ...w, characters: byWorld.get(Number(w.id)) || [] }));
}

/**
 * 主世界（骨架层）—— 全局唯一，取自 `is_core = 1`。
 *
 * 2026-10-18 世界分层：主世界不是"某个具体世界"，而是所有角色共用的**基础规则**。
 * 它永远叠加在 prompt 里，与角色绑定的具体世界并列（见 getWorldSetting）。
 */
export function getCoreWorldSetting() {
  try {
    return handle().prepare(`SELECT * FROM world_settings WHERE is_core = 1 ORDER BY id LIMIT 1`).get() || null;
  } catch {
    return null;
  }
}

/**
 * 「默认世界」= 主世界。
 *
 * ★ 2026-10-18 语义变更：这个函数以前返回 `is_active = 1` 的世界（一个具体世界），
 *   于是把「二维市」设为激活后，所有未归属角色都去按二维市说话。
 *   现在它返回**主世界（骨架）**：未归属角色吃骨架就够，不该被某个具体世界顶替。
 *   老库（还没跑 011 迁移、没有主世界）继续按 is_active 回退，行为与迁移前一致。
 */
export function getActiveWorldSetting() {
  const core = getCoreWorldSetting();
  if (core) return core;
  const database = handle();
  return database.prepare(`SELECT * FROM world_settings WHERE is_active = 1 ORDER BY id LIMIT 1`).get() || null;
}

export function getWorldSettingById(id) {
  const database = handle();
  return database.prepare(`SELECT * FROM world_settings WHERE id = ?`).get(id);
}

/**
 * 取「第一个副世界」（`is_core = 0`，按显示顺序）。
 *
 * 用途：需要"某个具体世界"时的默认值 —— 主世界是骨架，不能当地图归属、
 * 不能当旅程目的地，也不能当媒体抽卡池（见 getWorldSettingSample）。
 * 一个副世界都没有时返回 null，调用方负责提示用户先建一个世界。
 */
export function getDefaultSubWorld() {
  try {
    return handle().prepare(`
      SELECT * FROM world_settings
      WHERE is_core = 0
      ORDER BY sort_order, id
      LIMIT 1
    `).get() || null;
  } catch {
    return null;
  }
}

export function createWorldSetting({ name, content, tagline = '' }) {
  const database = handle();
  const maxOrder = database.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM world_settings`).get().m;
  const result = database.prepare(
    `INSERT INTO world_settings (name, content, tagline, is_active, sort_order) VALUES (?, ?, ?, 0, ?)`
  ).run(name, content, tagline, maxOrder + 1);
  const created = getWorldSettingById(result.lastInsertRowid);

  // ── 同步建立**独立项目库**（2026-10-07 用户裁定）────────────────
  // 目的：给这个世界观的专属知识一个"安放之处"，引擎从此只读取、不内置。
  // ⚠ 失败**不能**阻断创建：项目库只是增强，DB 才是真源（世界观建不出来才是事故）。
  try {
    const guessed = guessSlotsFromContent(content);
    scaffoldProject({ name, id: created.id, content, ambienceSections: guessed.ambienceSections });
  } catch (err) {
    console.warn(`[worldRepository] 世界观项目库建立失败（不影响创建）: ${err.message}`);
  }

  // ★ T13：新世界可能立刻成为某角色的回落目标 → 缓存整体作废
  invalidateWorldCache(`world.create#${created.id}`);
  return created;
}

export function updateWorldSetting(id, { name, content, tagline, visual_tone, is_enabled, cover_image, is_vehicle } = {}) {
  const database = handle();
  const sets = [];
  const params = [];
  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (content !== undefined) { sets.push('content = ?'); params.push(content); }
  // 星图（2026-10-17）：世界卡片/生图联动字段
  if (tagline !== undefined) { sets.push('tagline = ?'); params.push(tagline); }
  if (visual_tone !== undefined) { sets.push('visual_tone = ?'); params.push(visual_tone); }
  if (is_enabled !== undefined) { sets.push('is_enabled = ?'); params.push(is_enabled ? 1 : 0); }
  // ★ 2026-10-18：卡片封面图（存 /world-covers/xxx 短路径，不存 base64）
  if (cover_image !== undefined) { sets.push('cover_image = ?'); params.push(String(cover_image || '')); }
  // ★ 2026-10-18：移动型世界（载具）。改它会影响"日程从哪儿取地点" → 下面统一失效缓存
  if (is_vehicle !== undefined) { sets.push('is_vehicle = ?'); params.push(is_vehicle ? 1 : 0); }
  if (sets.length === 0) return null;
  sets.push("updated_at = datetime('now')");
  params.push(id);
  database.prepare(`UPDATE world_settings SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const updated = getWorldSettingById(id);

  // 项目库同步：正文镜像跟着写；**不改** project.json 里的槽位（那是用户/引擎的选择，正文编辑不该覆盖）
  try {
    const slug = slugForWorld(updated.name, updated.id);
    writeWorldDoc(slug, updated.name, updated.content);
    const pj = path.join(projectDirFor(slug), 'project.json');
    if (!fs.existsSync(pj)) {
      scaffoldProject({ name: updated.name, id: updated.id, content: updated.content });
    }
  } catch (err) {
    console.warn(`[worldRepository] 世界观项目库同步失败（不影响保存）: ${err.message}`);
  }

  // ★ T13：正文/名字/启用状态都可能改到注入结果 → 作废
  invalidateWorldCache(`world.update#${id}`);
  return updated;
}

export function deleteWorldSetting(id) {
  const database = handle();
  const count = database.prepare(`SELECT COUNT(*) AS c FROM world_settings`).get().c;
  if (count <= 1) return { ok: false, error: '不可删除最后一套世界观' };
  const target = getWorldSettingById(id);
  if (!target) return { ok: false, error: '世界观不存在' };

  // ★ 2026-10-18 世界分层：主世界是骨架层，删了所有角色就失去公共规则（且没有默认世界）
  if (target.is_core) {
    return {
      ok: false,
      code: 'CORE_WORLD',
      error: '这是主世界（骨架层），不能删除。先把别的世界设为主世界，再回来删它',
    };
  }

  // ── ★ 星图 T12：引用保护 ──────────────────────────────────────────
  // 删世界会把引用留在原地：角色的 world_setting_id 指向一个不存在的世界 →
  // getWorldSetting 会当"未绑定"回落激活世界（不崩，但界面会显示一个已删的世界名），
  // 地图则是彻底悬空。前端虽然拦了一道，但**绕开界面直接调接口**就能删出脏数据，
  // 所以真正的闸门必须在这里。
  const boundChars = (() => {
    try { return database.prepare(`SELECT COUNT(*) AS c FROM characters WHERE world_setting_id = ?`).get(id).c; }
    catch { return 0; }
  })();
  if (boundChars > 0) {
    return {
      ok: false,
      code: 'WORLD_IN_USE',
      characterCount: boundChars,
      error: `这个世界还有 ${boundChars} 个角色归属，先把角色改到别的世界（或改为「不指定」）再删`,
    };
  }
  const boundMaps = (() => {
    try { return database.prepare(`SELECT COUNT(*) AS c FROM world_maps WHERE world_setting_id = ?`).get(id).c; }
    catch { return 0; }
  })();
  if (boundMaps > 0) {
    return {
      ok: false,
      code: 'WORLD_IN_USE',
      mapCount: boundMaps,
      error: `这个世界还有 ${boundMaps} 张地图，先把地图改挂到别的世界再删`,
    };
  }
  // 小镇的 town_maps / town_assets 也存了 world_setting_id，但小镇是**独立系统**，
  // 星图界面里没有改绑入口 —— 所以只留痕不阻断（真要清理得去小镇侧操作）。
  try {
    const townRefs = database.prepare(`SELECT COUNT(*) AS c FROM town_maps WHERE world_setting_id = ?`).get(id).c
      + database.prepare(`SELECT COUNT(*) AS c FROM town_assets WHERE world_setting_id = ?`).get(id).c;
    if (townRefs > 0) {
      console.warn(`[worldRepository] 删除世界 #${id}：小镇侧仍有 ${townRefs} 条引用（town_maps / town_assets），已按独立系统口径放行`);
    }
  } catch { /* 老库可能没有小镇表 */ }

  database.prepare(`DELETE FROM world_settings WHERE id = ?`).run(id);
  if (target.is_active) {
    const first = database.prepare(`SELECT id FROM world_settings LIMIT 1`).get();
    if (first) {
      database.prepare(`UPDATE world_settings SET is_active = 1 WHERE id = ?`).run(first.id);
    }
  }

  // ── 项目库：**不删目录，改名为 .deleted-<时间戳>** ──────────────
  // 理由：项目库里可能有用户手写的槽位与素材（不可再生）。
  // 删世界观是常规操作，不该顺手毁掉人工内容 —— 归档可逆，删除不可逆。
  try {
    const slug = slugForWorld(target.name, target.id);
    const dir = projectDirFor(slug);
    if (fs.existsSync(dir)) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      fs.renameSync(dir, `${dir}.deleted-${stamp}`);
      console.log(`[worldRepository] 世界观项目库已归档: ${slug}.deleted-${stamp}`);
    }
  } catch (err) {
    console.warn(`[worldRepository] 项目库归档失败（已删世界观，目录留在原地）: ${err.message}`);
  }

  // ★ T13：删世界会改变"未绑定角色"的回落结果 → 作废
  invalidateWorldCache(`world.delete#${id}`);
  return { ok: true };
}

/**
 * 设为主世界（骨架层）。全局唯一 —— 会先把其他人的 is_core 清掉。
 *
 * ★ 2026-10-18：这个函数现在是「设为主世界」的唯一入口。
 *   历史上叫 activateWorldSetting（"激活"），语义已从"默认具体世界"改成"骨架层"。
 *   保留函数名是为了不惊动既有调用点；前端文案已改为「设为主世界」。
 */
export function activateWorldSetting(id) {
  const database = handle();
  const target = getWorldSettingById(id);
  if (!target) return null;
  const tx = database.transaction(() => {
    database.prepare(`UPDATE world_settings SET is_core = 0`).run();
    database.prepare(`UPDATE world_settings SET is_core = 1, is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
  });
  tx();
  // 主世界是所有角色 prompt 的前半段，换它等于换所有角色 —— 缓存必须整体失效
  invalidateWorldCache(`world.set-core#${id}`);
  return getWorldSettingById(id);
}
