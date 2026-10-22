/**
 * mediaService.js — 媒体内容页（传媒 / 数字媒体）的生成引擎
 *
 * ── 这是什么 ──
 *
 * 一个「媒体」是一个内容源（报纸 / 论坛 / 匿名职场社区 / 暗网 …），自带一份生成提示词；
 * 每个媒体下有若干**板块**。用户点「刷新」就抽取一批新帖子铺到瀑布流上。
 *
 * ── 与《邻舍日报》(newspaperService) 的关系 ──
 *
 * 报纸是**单一固定媒体 + 每天一期 + 有注入链路**（世界状态影响全镇、特稿主角当天会被提起）。
 * 本模块是**多媒体 + 按需刷新 + 纯展示**：不注入任何提示词、不影响角色行为，只做内容展示。
 * 配图沿用报纸那套「文字先落库、后台逐张补」的做法（fillPaperImages）。
 *
 * ── 角色怎么参与（用户要求「活跃角色随机在帖子里」）──
 *
 * 两个方向都用：
 *   ① 作为**发帖人**：随机抽 1~2 个活跃角色（排除归档），由 LLM 用其人格与口吻写一条帖，
 *      落库时带 character_id 与头像 —— 且**流量更高**（浏览/点赞按角色影响力放大）。
 *   ② 作为**被讨论对象**：其余帖子由匿名 NPC 发，内容里会提到这些角色（八卦/见闻）。
 * 为避免靠名字匹配出错，发帖人**按下标指派**：提示词里明确「第 N 条由『某某』本人发布」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb, getSystemRules, getWorldSettingSample, sampleWorldSettings, getGlobalRule } from '../db/index.js';
// 媒体删除墓碑要落库（补种逻辑据此跳过"用户删过的"媒体）
import { getSetting, setSetting } from '../db/settings.js';
import { chatSync } from '../llm/llm-client.js';
import { chatWithPreset } from './presets/narrative.js';
import { generateImageRaw } from './imageSkill.js';
import { saveBase64Image, deleteImageFileByUrl, getImageDir } from './imagePaths.js';
import { invalidateGalleryCache } from './galleryCache.js';
import { recordCompletedImageTask } from './imageTaskRecorder.js';
import { broadcast } from './unifiedStreamBus.js';
import { MEDIA_PUBLICATION_ORDER, publishMediaPostIfReady, isMediaPostPublished } from './mediaPublication.js';
// ★ 2026-10-21：媒体配图也能被「重新生成」覆盖同一路径（/media/posts/:id/regenerate-image），
//   与 BUG-04 同一条链路 —— URL 带 mtime 版本，客户端切页/刷新才不会拿旧缓存。
import { withImageVersion } from '../utils/imageVersion.js';
import { config } from '../config.js';
import { GALLERY_ASPECTS } from '../data/galleryAspects.js';
import { resolveGalleryAspects } from './galleryAspectResolver.js';
import { extractFirstJson, repairJson } from './eventGenerator.js';
import { buildCharacterPersona } from './characterPersona.js';
import { charArtistOverrideWithFallback } from './characterImageOpts.js';
import { buildAliasRuleBlock, collectUsedAliases, disambiguateAliases } from './forumAlias.js';
import { SEX_POSITIONS } from '../data/sexPositions.js';
// 规则34：图库文本（作品名/备注/署名）里不得出现角色名 —— 出口统一清洗
import { stripCharacterNames } from '../utils/characterNameGuard.js';
// 规则34：环境层（场景/光影/视角/景别/表情/状态/道具）—— 7 维随机 + 耦合约束
import { pickGalleryEnvelope } from './galleryEnvelope.js';
import {
  PHOTO_CATEGORIES, CITYSCAPE_FRAMES, PHOTO_ATMOSPHERE, SELFIE_VIEWS,
  FOOD_ITEMS, POSTER_TOPICS, PHOTO_ASPECTS, PHOTO_QUALITY_SUFFIX, PHOTO_NEGATIVE,
} from '../data/photoScenes.js';
import { deriveBuild } from './characterBuild.js';
// T5：媒体操作日志 —— 删除/创建类操作留审计痕迹（曾有一条真实产物消失无法追溯）
import { recordMediaOp } from './mediaOpLog.js';
// 上游 v3.8.3（ac6f521）：媒体路人头像库 —— 匿名作者/评论者头像统一由它解析
import { mediaAvatarLibrary } from './mediaAvatarLibrary.js';

/** 一次刷新默认抽多少条 */
export const DEFAULT_BATCH_SIZE = 6;
export const MAX_BATCH_SIZE = 12;

/**
 * 自动抓帖频率档位（分钟）。前端滑块直接用这份表，后端据此校验。
 *
 * 为什么档位化而不是连续滑块：间隔跨度从「关闭」到 12 小时，
 * 连续拖动既拖不准也说不清（要拖到 37 分钟还是 40 分钟？）；
 * 档位还能顺手把生成成本写在标签上，用户一眼知道自己在选什么。
 */
/**
 * 自动抓帖档位：**每晚几批**（0 = 关闭）。
 *
 * ★ 2026-10-05 由「固定间隔（分钟）」改成「每晚几批 + 夜间窗口内错峰随机」：
 *   旧模型每 N 分钟无条件抓一批（每批 3 条），24 小时均匀铺开 —— 既不像"有人的社区"，
 *   也是全天持续烧 token。新模型：
 *     · 只在**夜间窗口**（20:00 → 次日 02:00）内动手，白天不产新内容；
 *     · 窗口按批数等分成时段，**在时段内随机**取时刻 → 错峰、不扎堆；
 *     · **一批只出 1 条**（见 AUTO_BATCH_SIZE），细水长流。
 *   与「朋友圈发帖频率」同一取向（那边是 `momentFreq` × 基准间隔）。
 */
export const MEDIA_AUTO_STEPS = [
  { value: 0,  label: '关闭',      hint: '不自动抓帖，只有你点「刷新」时才生成。' },
  { value: 1,  label: '每晚 1 批', hint: '一晚上随机补 1 条，几乎无感。' },
  { value: 2,  label: '每晚 2 批', hint: '一晚上随机补 2 条。' },
  { value: 4,  label: '每晚 4 批', hint: '一晚上随机补 4 条，社区慢慢有动静。' },
  { value: 8,  label: '每晚 8 批', hint: '一晚上随机补 8 条，比较活跃。' },
  { value: 16, label: '每晚 16 批', hint: '一晚上随机补 16 条，LLM 消耗明显上升。' },
];
/** 校验用：允许的「每晚批数」集合 */
export const ALLOWED_MEDIA_AUTO_VALUES = MEDIA_AUTO_STEPS.map(s => s.value);

/** 夜间窗口：20:00 → 次日 02:00（本地时间）。白天不产新内容。 */
export const MEDIA_NIGHT_START_HOUR = 20;
export const MEDIA_NIGHT_END_HOUR = 2;
/** 两批之间的最小间隔 —— 防止窗口很小时两次抓取挤在一起 */
export const MEDIA_MIN_GAP_MS = 5 * 60 * 1000;

/**
 * 自动抓帖**每批生成几条**。
 *
 * ★ 用户口径（2026-10-05）：社交平台 / 网络论坛 / 规则34「一次生成不要太多帖子」。
 *   原来是 3 条/批；改成 1 条/批，靠"晚上多来几批"补总量 —— 这样内容在时间上是散开的，
 *   而不是每隔几小时突然涌进来三条。
 */
export const AUTO_BATCH_SIZE = 1;

/**
 * 求 `t` 落在（或即将到来）的那个夜间窗口。
 *
 * 窗口跨午夜，所以三种情况：
 *   · 20:00 之后 → 今晚的窗口（今天 20:00 → 明天 02:00）
 *   · 02:00 之前 → 仍在**昨晚**开始的窗口里（昨天 20:00 → 今天 02:00）
 *   · 02:00~20:00 → 白天，返回**即将到来**的窗口（今天 20:00 → 明天 02:00）
 *
 * 纯函数（只读入参与本地时区），便于单测。
 *
 * @param {number} t - 毫秒时间戳
 * @returns {{start:number, end:number}} 窗口起止（毫秒时间戳）
 */
export function nightWindowFor(t) {
  const d = new Date(t);
  const h = d.getHours();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const DAY = 24 * 3600_000;
  const at = (base, hour) => base + hour * 3600_000;

  if (h >= MEDIA_NIGHT_START_HOUR) {
    // 今晚
    return { start: at(dayStart, MEDIA_NIGHT_START_HOUR), end: at(dayStart + DAY, MEDIA_NIGHT_END_HOUR) };
  }
  if (h < MEDIA_NIGHT_END_HOUR) {
    // 昨晚开始的窗口还没结束
    return { start: at(dayStart - DAY, MEDIA_NIGHT_START_HOUR), end: at(dayStart, MEDIA_NIGHT_END_HOUR) };
  }
  // 白天：下一个窗口在今晚
  return { start: at(dayStart, MEDIA_NIGHT_START_HOUR), end: at(dayStart + DAY, MEDIA_NIGHT_END_HOUR) };
}

/** `t` 是否落在夜间窗口内（用于"到点了但已经天亮"的兜底判断） */
export function isWithinNightWindow(t) {
  const { start, end } = nightWindowFor(t);
  return t >= start && t < end;
}

/**
 * 排下一次自动抓帖时刻：**在夜间窗口内错峰随机**。
 *
 * 做法：把整个夜间窗口**等分成 `perNight` 个固定的格**；这次用「now 之后的第一格」，
 * **并把时刻随机落在格内任意位置**。这样
 *   · 一晚恰好 `perNight` 批（一格一批），不会越排越密、也不会把前面的格跳过去；
 *   · 具体时刻每晚不同（格内随机 → 相邻两批的间隔在 0~2 格之间浮动）—— 就是"错峰随机刷"；
 *   · 相邻两批不会贴在一起（有 `MEDIA_MIN_GAP_MS` 兜底）。
 *
 * ⚠ 两次改错都记在这里，免得再走回头路：
 *   ① 最初按「**从 now 起还剩多少时间**」重新分格 —— 每排一次剩余时间就变短、格子跟着变多，
 *      一晚 2 批实际排出 4 批（越排越密）。
 *   ② 改成「在**剩余格子里随机挑一格**」—— 第一抽就可能跳到最后一格，把中间几格全跳过，
 *      一晚 4 批实际只出 2 批（越排越稀）。
 *   正确做法是这两者的中间：**格子按窗口绝对划分**（保证总数），**只在格内随机**（保证错峰）。
 *
 * 纯函数：随机源由 `rand` 注入，便于单测。
 *
 * @param {number} now - 当前毫秒时间戳
 * @param {number} perNight - 每晚批数（>0）
 * @param {() => number} [rand] - 返回 [0,1) 的随机源
 * @returns {number} 下次抓帖的毫秒时间戳（必然落在某个夜间窗口内）
 */
export function nextAutoAt(now, perNight, rand = Math.random) {
  const n = Math.max(1, Math.floor(Number(perNight) || 1));
  const win = nightWindowFor(now);
  const slot = (win.end - win.start) / n;

  // now 之后第一个可用的格下标（0..n-1；已经过去几格就跳过几格）
  const fromIdx = Math.max(0, Math.ceil((now - win.start) / slot));

  if (fromIdx < n) {
    // ★ 就取这一格，**只在格内**随机 —— 不额外跳格，否则会把中间的格浪费掉
    let t = win.start + fromIdx * slot + rand() * slot;
    // 兜底：不能离 now 太近（格很小时两批可能贴着）
    if (t < now + MEDIA_MIN_GAP_MS) t = now + MEDIA_MIN_GAP_MS;
    // 也不能越过窗口末尾（`fromIdx < n` 保证 now 至少还差一整格，所以这里不会越界）
    return Math.min(t, win.end - 1);
  }

  // 本窗口的格都过完了 → 落到**下一个**窗口里的随机一格
  const nextWin = nightWindowFor(win.end + 1);
  const nextSlot = (nextWin.end - nextWin.start) / n;
  const k2 = Math.floor(rand() * n);
  return nextWin.start + k2 * nextSlot + rand() * nextSlot;
}

/** 当前生效的「每晚批数」；0 表示关闭自动 */
function autoPerNight() {
  const n = Number(config.features.mediaAutoPerNight ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(ALLOWED_MEDIA_AUTO_VALUES[ALLOWED_MEDIA_AUTO_VALUES.length - 1], Math.floor(n));
}

// ── 并发守卫 ──
let generating = null;          // 当前批次生成任务
let imageQueue = Promise.resolve(); // 配图请求串行排队，忙碌时不丢掉新批次
let portalImageQueue = Promise.resolve();
const manualImagePosts = new Set(); // 手动刷新批次由高优通道负责，后台扫描不能抢走。
// 本进程内「这条帖子从什么时候开始生成」——BUG-02 的 generating 超时重置靠它。
// 为什么不加数据库列：生成是**进程内**行为，进程重启时所有 generating 都是中断遗留
// （启动自愈会全部重置），所以内存里的时间戳足够；加列要动全量 schema，代价不成比例。
const imageClaims = new Map();      // postId -> 抢占时刻(ms)

// ── 配图自愈闸（BUG-02）──
// 补图队列只在内存里：进程重启、ComfyUI 忙住或异常中断后，卡在 pending/generating
// 的帖子没有任何定时器来管（只有「生成新批次」和「打开传媒页」两个按需入口）。
// 调度器每分钟 tick 一次，但真正补图每 5 分钟最多一次、每次最多 2 张。
// ⚠ 红线：历史事故是「每分钟无条件 fillPendingImages(8)」+ 橱窗预生成，
//   30 分钟内派单 46 次、同一 prompt 重生 4 次，把 ComfyUI 打满。
//   这三个常数只能更保守，不许放宽。
const IMAGE_HEAL_INTERVAL_MS = 5 * 60 * 1000;   // 每 5 分钟最多补一次
const IMAGE_HEAL_LIMIT = 2;                     // 每次最多补 2 张
const IMAGE_HEAL_STALE_MS = 30 * 60 * 1000;     // generating 卡满 30 分钟才判超时
let lastImageHealAt = 0;
let lastAutoAt = 0;             // 上次自动补充时间

function imagePostScope(postIds) {
  return {
    sql: `AND p.id ${postIds ? 'IN' : 'NOT IN'} (SELECT value FROM json_each(?))`,
    ids: JSON.stringify(postIds || [...manualImagePosts]),
  };
}

function fillBatchImages(limit, postIds, manual, portal = false) {
  // 门户延续下一轮事件循环补图的行为，先让文字生成请求完成。
  const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));
  if (!manual) return portal
    ? nextTurn().then(() => fillPortalImages(limit, postIds))
    : fillPendingImages(limit, postIds);
  // 不排在正在等待低优队列的后台批次之后；只提升本次新建内容的所有配图。
  for (const id of postIds) manualImagePosts.add(id);
  const task = portal
    ? nextTurn().then(() => fillPortalImagesNow(limit, postIds, 'high'))
    : fillPendingImagesNow(limit, postIds, 'high');
  return task.finally(() => {
    for (const id of postIds) manualImagePosts.delete(id);
  });
}

function safeParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function clampText(v, max) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : '';
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// ══════════════════════════════════════════
// 媒体 / 板块 CRUD
// ══════════════════════════════════════════

/** 全部媒体（含板块数量与帖子数），供设置页与标签页用 */
export function listOutlets({ onlyEnabled = false } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM media_boards b WHERE b.outlet_id = o.id) AS board_count,
      (SELECT COUNT(*) FROM media_posts p WHERE p.outlet_id = o.id AND p.published_seq IS NOT NULL) AS post_count
    FROM media_outlets o
    ${onlyEnabled ? 'WHERE o.enabled = 1' : ''}
    ORDER BY o.sort_order, o.id
  `).all();
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    tagline: r.tagline,
    prompt: r.prompt,
    icon: r.icon,
    // 形态：feed=社交平台（帖子流）/ portal=数字报刊（按「期」出刊，含 portfolio 板块正文）
    // weekly / poster 是 portal 之前的旧形态，仍可能存在于老数据里，前端据此选渲染组件
    layout: r.layout || 'feed',
    sort_order: r.sort_order,
    enabled: !!r.enabled,
    board_count: r.board_count,
    post_count: r.post_count,
  }));
}

export function getOutlet(id) {
  const r = getDb().prepare('SELECT * FROM media_outlets WHERE id = ?').get(id);
  if (!r) return null;
  return { ...r, enabled: !!r.enabled, layout: r.layout || 'feed' };
}

/**
 * 分类的**唯一真源**（前端三档 ↔ 后端过滤）。
 *
 * 与前端 `MediaView.vue` 的 CATEGORIES 一一对应：
 *   print   →「官方传媒」：官方/印刷形态的物料 —— 海报(poster) 与旧周刊(weekly)
 *             （这一档原叫「报纸物料」，2026-10-05 改名为「官方传媒」；key 未变）
 *   digital →「数字报刊」：门户(portal)，可点开各板块看正文
 *   social  →「社交平台」：帖子流(feed)
 *
 * ⚠ 这张表也被 `routes/media.js` 用来做入参白名单 ——
 *   **别再在路由里硬编码分类字面量**（曾经因此漏掉 print，导致该分类不过滤、返回全部帖子）。
 */
export const MEDIA_CATEGORIES = ['print', 'digital', 'social', 'forum', 'photos', 'gallery'];

/**
 * 分类 → 形态 的映射（**单一真源**）。
 *
 * 分类不是独立字段，是由 `media_outlets.layout` 推导出来的 —— 加新媒体时按形态自动归类，
 * 不用手动维护。但**推导规则必须只有一份**：曾经前端（MediaView 的 isDigitalOutlet/
 * isPrintOutlet）与后端（listPosts 的 if/else）各自硬编码，结果门户从 weekly 迁移成 portal 时
 * 只改了后端，两个刊在前端被算成"非数字"而掉进社交平台；后来 `digital` 又漏了把 poster
 * 摘出去，于是同一张海报**同时**出现在「数字报刊」和「官方传媒」两档里。
 *
 * `null` 表示"老库里 layout 为 NULL 的行"（与 `feed` 同义）—— SQL 侧统一写成
 * `COALESCE(o.layout,'feed')`，所以这里把 NULL 归到 social 即可。
 */
export const CATEGORY_LAYOUTS = {
  print: ['poster', 'weekly'],   // 官方传媒：印刷/实体形态的物料
  digital: ['portal'],           // 数字报刊：可点开板块的数字刊物
  social: [null],                // 社交平台：帖子流（NULL 与 feed 同义）
  forum: ['forum'],              // 网络论坛：版聊主题帖（文字为主、少量图片）
  photos: ['photos'],            // 哈托比亚：**SFW 图片站**（城市风光/自拍/美食/海报；确定性画面，无 NSFW）
  gallery: ['gallery'],          // 规则34：成人图片站（1 排 4 张，随机画师串 + 随机题材）
};

/**
 * 分类过滤的 SQL 条件（计数与列表**共用**同一份）。
 * @param {string} category 分类 key
 * @param {string} [alias] layout 所在表的别名（默认 `o`，与 listPosts 的 JOIN 对齐）
 * @returns {{sql: string, params: string[]}|null} 未知/空分类返回 null = 不过滤
 */
function categoryFilter(category, alias = 'o') {
  const layouts = CATEGORY_LAYOUTS[category];
  if (!layouts) return null;
  const list = layouts.map(l => l || 'feed');
  return {
    // COALESCE 是必须的：老库可能有 layout IS NULL 的行，直接 `layout = 'feed'` 会漏掉它们
    sql: `COALESCE(${alias}.layout, 'feed') IN (${list.map(() => '?').join(', ')})`,
    params: list,
  };
}

/**
 * 媒体的**产物形态**（差别很大，不能混同）：
 *   · `feed`   —— 社交平台：一批独立帖子（瀑布流），一次生成多条
 *   · `portal` —— 数字报刊：按「期」出刊。门户版只跑 1 次短 LLM，正文点开板块才按需生成
 *   · `poster` —— 海报：一张只讲一个瓜。热点速报条 → 大标题 → 主图 → 爆点气泡 → 短文案 → 小图组
 *                 （《狸狸八卦》就是这种：它的提示词明确写「每期出一张海报（不是文章）」，
 *                  一度被错设成 portal 而做成了门户网，现已归位）
 *   · `forum`  —— 网络论坛：**版聊**。一条 = 一个主题帖（标题 + 正文 + 楼层回复）。
 *                 文字为主、图片只是偶尔出现（不是每帖都有图）。
 *   · `gallery`—— 规则34：**成人图片站**。一条 = 一个图集条目（1 排 4 张）。
 *                 特征是**每条随机换画师串**（画风各异）+ 随机色情题材组合。
 * `weekly` 是 portal 之前的旧形态，渲染分支仍兼容（老数据），但新建时不再提供。
 *
 * 与前端分类的对应：feed →「社交平台」；forum →「网络论坛」；gallery →「规则34」；
 *                    portal →「数字报刊」；poster/weekly →「官方传媒」。
 *
 * ★ 本清单是「新建媒体选项」的**唯一权威**（经 `GET /media/layouts` 下发）。
 *   前端兜底 `MediaSettingsModal.FALLBACK_LAYOUTS` 必须与本清单**逐字一致**
 *   —— 有跨端一致性测试钉住（web-ui/test/layoutCatalogSync.test.js）；改动要整段同步。
 */
export const OUTLET_LAYOUTS = [
  { key: 'feed', label: '社交平台', hint: '一批独立帖子（瀑布流）· 一次生成多条' },
  { key: 'forum', label: '网络论坛', hint: '版聊主题帖（标题 + 正文 + 楼层回复）· 文字为主、少量图片' },
  { key: 'photos', label: '图片站（全年龄）', hint: '城市风光 / 美少女自拍 / 美食打卡 / 宣传海报 · 画面确定性生成' },
  { key: 'gallery', label: '图片站（成人）', hint: '图集条目（1 排 4 张）· 每条随机画师串与题材组合' },
  { key: 'portal', label: '数字报刊', hint: '按「期」出刊：门户版 + 板块正文（点开才生成）' },
  { key: 'poster', label: '海报', hint: '一张只讲一个瓜：热点速报条 → 大标题 → 主图 → 爆点气泡 → 短文案 → 小图组' },
];
const OUTLET_LAYOUT_KEYS = OUTLET_LAYOUTS.map(l => l.key);
/** 老形态：仍是有效的 layout（渲染分支兼容），只是新建时不提供 */
const LEGACY_LAYOUT_KEYS = ['weekly'];
/**
 * 全部合法 layout（含老形态）。
 * 导出是给回归测试用的：**每个形态都必须恰好归属一个分类**，
 * 将来新增形态却忘了归类时，测试会失败（而不是"这个形态的帖子在三个分类里都找不到"）。
 */
export const ALL_LAYOUT_KEYS = [...OUTLET_LAYOUT_KEYS, ...LEGACY_LAYOUT_KEYS];
/** 规范化形态：非法或缺失时回落 `feed`（历史默认值，保证兼容旧调用方） */
function normalizeLayout(v) {
  const s = String(v || '').trim();
  return (OUTLET_LAYOUT_KEYS.includes(s) || LEGACY_LAYOUT_KEYS.includes(s)) ? s : 'feed';
}

/** 是不是「按期出刊」的形态（门户 / 海报 / 旧周刊）—— 出刊与期号导航都适用于它们 */
export function isPeriodicalLayout(layout) {
  return ['portal', 'poster', 'weekly'].includes(String(layout || ''));
}

/**
 * 校验媒体形态入参 —— 非法值直接 400（含显式传入的 `null`）。
 *
 * ⚠ 白名单是**新建可选的全部形态**（`OUTLET_LAYOUT_KEYS`，与设置页下拉同源）：
 *   feed / forum / photos / gallery / portal / poster。
 *   不含旧形态 `weekly` —— 老数据仍能正常渲染（`normalizeLayout` 兼容），但不允许**新写**。
 *   曾经形态名散在路由/服务各处硬编码而漏判，这里收成单点。
 *
 * @param {*} layout 待校验的形态
 * @returns {string} 规范化后的合法形态 key
 */
function validateOutletLayout(layout) {
  const s = String(layout ?? '').trim();
  if (!OUTLET_LAYOUT_KEYS.includes(s)) {
    throw Object.assign(new Error('媒体类型不在允许的六种形态之内'), { statusCode: 400 });
  }
  return s;
}

export function createOutlet({ name, tagline = '', prompt = '', icon = '', layout = 'feed', enabled = true, boards = [] }) {
  /**
   * 形态兼容策略（两条口径并存，两个回归测试各自钉住，缺一不可）：
   *   · **显式 `null`** → 400：调用方明确给了个空类型，属入参错误，不静默兜底；
   *   · 其余非法/缺失 → `normalizeLayout` 回落 `feed`（保持本地「兼容旧调用方」契约）。
   *   （mediaOutletLayout 测「null 抛 400」；local-patch-regression 测「脏字符串回落 feed」。）
   */
  if (layout === null) validateOutletLayout(layout);
  const layoutKey = normalizeLayout(layout);
  const nm = clampText(name, 24);
  if (!nm) throw Object.assign(new Error('媒体名称不能为空'), { statusCode: 400 });
  if (!clampText(prompt, 8000)) throw Object.assign(new Error('媒体提示词不能为空'), { statusCode: 400 });
  if (!Array.isArray(boards) || boards.length > 12 || boards.some(b => !b || typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 16 || (b.desc != null && (typeof b.desc !== 'string' || b.desc.length > 60)))) {
    throw Object.assign(new Error('板块最多12个，名称需为1至16字，定位不超过60字'), { statusCode: 400 });
  }
  if (new Set(boards.map(b => b.name.trim())).size !== boards.length) throw Object.assign(new Error('板块名称不能重复'), { statusCode: 400 });
  const db = getDb();
  const dup = db.prepare('SELECT id FROM media_outlets WHERE name = ?').get(nm);
  if (dup) throw Object.assign(new Error('同名媒体已存在'), { statusCode: 400 });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM media_outlets').get().m;
  return db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO media_outlets (name, tagline, prompt, icon, sort_order, enabled, layout)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(nm, clampText(tagline, 60), clampText(prompt, 8000), clampText(icon, 8), maxOrder + 1, enabled ? 1 : 0, layoutKey);
    const id = Number(r.lastInsertRowid);
    // 用户又亲手把同名媒体建回来了 → 撤掉删除墓碑，语义才算一致
    forgetDeletedOutlet(nm);
    // T5：留一条创建痕迹（谁建的、什么形态）
    recordMediaOp({
      opType: 'create', targetType: 'outlet', targetId: id,
      targetName: nm, outletName: nm, detail: `新建媒体「${nm}」（形态 ${layoutKey}）`,
      snapshot: { name: nm, layout: layoutKey, tagline: clampText(tagline, 60) },
    });
    // 上游 v3.8.1：草稿可带板块，随媒体一次性原子落库（失败整体回滚）
    for (const board of boards) createBoard(id, board);
    return getOutlet(id);
  })();
}

export function updateOutlet(id, patch = {}) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM media_outlets WHERE id = ?').get(id);
  if (!cur) return null;
  // 形态：显式传入才校验（非法值 400）；undefined = 不动，沿用当前值（含老形态兼容）
  const layout = patch.layout === undefined ? normalizeLayout(cur.layout) : validateOutletLayout(patch.layout);
  const name = patch.name !== undefined ? clampText(patch.name, 24) : cur.name;
  if (!name) throw Object.assign(new Error('媒体名称不能为空'), { statusCode: 400 });
  if (patch.name !== undefined) {
    const dup = db.prepare('SELECT id FROM media_outlets WHERE name = ? AND id != ?').get(name, id);
    if (dup) throw Object.assign(new Error('同名媒体已存在'), { statusCode: 400 });
  }
  db.prepare(`
    UPDATE media_outlets SET name = ?, tagline = ?, prompt = ?, icon = ?, enabled = ?, layout = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name,
    patch.tagline !== undefined ? clampText(patch.tagline, 60) : cur.tagline,
    patch.prompt !== undefined ? clampText(patch.prompt, 8000) : cur.prompt,
    patch.icon !== undefined ? clampText(patch.icon, 8) : cur.icon,
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
    layout,
    id,
  );
  return getOutlet(id);
}

/**
 * 删除一个媒体（连同帖子与板块，靠 ON DELETE CASCADE）。
 *
 * ★ **必须留一条「已删除」墓碑**。
 *
 *   背景：`db/index.js` 的 `LATE_SEEDED` 会在**每次启动**把"默认清单里有、库里没有"的
 *   媒体补种回来（用于给老库补上后续版本新增的媒体）。但它**分不清**
 *   「这个库里还没有」和「用户主动删掉了」—— 于是：
 *
 *     用户删掉《狸狸八卦》→ 后端重启（`node --watch` 下改个文件就会重启）
 *     → 补种逻辑把它又建回来（新 id）→ 用户看到"删了又回来"，以为删除没生效。
 *
 *   实测踩过：用户 14:2x 删掉《狸狸八卦》，14:30 一次重启后它就以 id 545 复活了。
 *
 *   所以删除时把名字记进 `system_settings.media_outlets_deleted`，
 *   补种时跳过墓碑里的名字 —— 这才是"尊重用户的删除"的完整实现。
 *
 *   ⚠ 图片文件留着不删（可能被别处引用，且删文件不可逆）。
 *
 * @param {number} id
 * @returns {boolean} 是否真的删掉了（不存在时 false）
 */
export function deleteOutlet(id) {
  const db = getDb();
  // 删之前先取一份快照（删完 CASCADE 子行就没了，事后无从追溯）
  const row = db.prepare('SELECT name, tagline, layout, icon FROM media_outlets WHERE id = ?').get(id);
  const postCount = db.prepare('SELECT COUNT(*) AS c FROM media_posts WHERE outlet_id = ?').get(id)?.c || 0;
  const boardCount = db.prepare('SELECT COUNT(*) AS c FROM media_boards WHERE outlet_id = ?').get(id)?.c || 0;
  const changed = db.prepare('DELETE FROM media_outlets WHERE id = ?').run(id).changes > 0;
  if (changed && row?.name) {
    rememberDeletedOutlet(row.name);
    // T5：留一条删除痕迹 —— 曾有一条真实产物消失却查无实据
    recordMediaOp({
      opType: 'delete', targetType: 'outlet', targetId: id,
      targetName: row.name, outletName: row.name,
      count: postCount,
      detail: `删除媒体「${row.name}」（连带 ${boardCount} 板块 / ${postCount} 帖）`,
      snapshot: { name: row.name, tagline: row.tagline, layout: row.layout, icon: row.icon, boardCount, postCount },
    });
  }
  return changed;
}

/** 媒体删除墓碑的 setting key（值为 JSON 数组，存名字） */
export const DELETED_OUTLETS_KEY = 'media_outlets_deleted';

/** 读墓碑名单（拿不到就返回空数组，绝不抛错 —— 不能因为墓碑坏了就打不开媒体页） */
function readDeletedOutlets() {
  try {
    const raw = getSetting(DELETED_OUTLETS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x) : [];
  } catch { return []; }
}

/** 记下"这个媒体是用户删的"，补种时不再复活它 */
export function rememberDeletedOutlet(name) {
  try {
    const n = String(name || '').trim();
    if (!n) return;
    const list = readDeletedOutlets();
    if (!list.includes(n)) list.push(n);
    setSetting(DELETED_OUTLETS_KEY, JSON.stringify(list));
    // 墓碑重新登记 → 之前那条"已跳过"的一次性提示也要重来一次
    // （否则用户删 A、建回 A、再删 A，第二次启动就静默了，他会以为没生效）
    clearSkipReportedFlag(n);
  } catch { /* 记不上也不该阻断删除本身 */ }
}

/**
 * 用户手工新建同名媒体时，把墓碑撤掉 ——
 * 否则他删掉 A、又自己建回 A，之后 A 再被删就不会留墓碑（语义不一致）。
 */
export function forgetDeletedOutlet(name) {
  try {
    const n = String(name || '').trim();
    if (!n) return;
    const list = readDeletedOutlets();
    if (!list.includes(n)) return;
    setSetting(DELETED_OUTLETS_KEY, JSON.stringify(list.filter(x => x !== n)));
  } catch { /* ignore */ }
}

/**
 * 一次性「已提示跳过补种」标记的 key。
 * ⚠ 与墓碑（`media_outlets_deleted`）配对使用：墓碑是**持久状态**，
 *   而"跳过"是**每次启动都会算出的同一结果** —— 每次都念一遍等于对着没变化报警。
 *   所以只上报第一次，之后静默（2026-10-07 用户实报的启动日志噪音）。
 */
export function skipReportedKey(name) {
  return `media_late_seed_skip_reported_${String(name || '').trim()}`;
}

/** 清除"已提示"标记（墓碑被重新登记时调用，让提示能再来一次） */
export function clearSkipReportedFlag(name) {
  try {
    const n = String(name || '').trim();
    if (!n) return;
    const db = getDb();
    db.prepare('DELETE FROM system_settings WHERE setting_key = ?').run(skipReportedKey(n));
  } catch { /* ignore */ }
}

/** 该名字是否被用户删过（供补种逻辑判断） */
export function isOutletDeletedByUser(name) {
  return readDeletedOutlets().includes(String(name || '').trim());
}

export function listBoards(outletId) {
  const rows = getDb().prepare(`
    SELECT b.*, (SELECT COUNT(*) FROM media_posts p WHERE p.board_id = b.id) AS post_count
    FROM media_boards b WHERE b.outlet_id = ? ORDER BY b.sort_order, b.id
  `).all(outletId);
  return rows.map(r => ({ id: r.id, outlet_id: r.outlet_id, name: r.name, desc: r.desc, sort_order: r.sort_order, post_count: r.post_count }));
}

export function createBoard(outletId, { name, desc = '' }) {
  const nm = clampText(name, 16);
  if (!nm) throw Object.assign(new Error('板块名称不能为空'), { statusCode: 400 });
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM media_outlets WHERE id = ?').get(outletId)) {
    throw Object.assign(new Error('媒体不存在'), { statusCode: 404 });
  }
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM media_boards WHERE outlet_id = ?').get(outletId).m;
  const r = db.prepare('INSERT INTO media_boards (outlet_id, name, desc, sort_order) VALUES (?, ?, ?, ?)')
    .run(outletId, nm, clampText(desc, 60), maxOrder + 1);
  return listBoards(outletId).find(b => b.id === Number(r.lastInsertRowid)) || null;
}

export function updateBoard(boardId, { name, desc }) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM media_boards WHERE id = ?').get(boardId);
  if (!cur) return null;
  db.prepare('UPDATE media_boards SET name = ?, desc = ? WHERE id = ?')
    .run(name !== undefined ? (clampText(name, 16) || cur.name) : cur.name,
         desc !== undefined ? clampText(desc, 60) : cur.desc, boardId);
  return listBoards(cur.outlet_id).find(b => b.id === Number(boardId)) || null;
}

export function deleteBoard(boardId) {
  // 该板块下的帖子不删，只把 board_id 置空（避免用户删个板块连带丢内容）
  const db = getDb();
  const cur = db.prepare('SELECT b.*, o.name AS outlet_name FROM media_boards b LEFT JOIN media_outlets o ON o.id = b.outlet_id WHERE b.id = ?').get(boardId);
  if (!cur) return false;
  const detached = db.prepare('SELECT COUNT(*) AS c FROM media_posts WHERE board_id = ?').get(boardId)?.c || 0;
  db.prepare('UPDATE media_posts SET board_id = NULL WHERE board_id = ?').run(boardId);
  const changed = db.prepare('DELETE FROM media_boards WHERE id = ?').run(boardId).changes > 0;
  if (changed) {
    // T5：板块删除留痕（帖子未删、仅转未分类，快照记下这个事实以免日后误解）
    recordMediaOp({
      opType: 'delete', targetType: 'board', targetId: boardId,
      targetName: cur.name, outletName: cur.outlet_name || '',
      count: 1,
      detail: `删除板块「${cur.name}」（${detached} 帖转为未分类，未丢失）`,
      snapshot: { name: cur.name, desc: cur.desc, outletId: cur.outlet_id, detachedPosts: detached },
    });
  }
  return changed;
}

// ══════════════════════════════════════════
// 帖子查询
// ══════════════════════════════════════════

function mapPostRow(r) {
  return {
    id: r.id,
    is_favorite: r.favorited_at != null,
    favorited_at: r.favorited_at ?? null,
    published_seq: r.published_seq || r.id,
    outlet_id: r.outlet_id,
    outlet_name: r.outlet_name || null,
    board_id: r.board_id,
    board_name: r.board_name || null,
    title: r.title,
    content: r.content,
    tags: safeParse(r.tags_json, []) || [],
    author_type: r.author_type,
    character_id: r.character_id,
    author_name: r.author_name,
    author_avatar: r.author_type === 'anonymous'
      ? mediaAvatarLibrary.resolve(r.outlet_id, r.author_name)
      : r.author_avatar,
    likes: r.likes,
    views: r.views,
    comments: (safeParse(r.comments_json, []) || []).map(comment => ({
      ...comment,
      author_avatar: comment.author_type === 'character'
        ? comment.author_avatar
        : mediaAvatarLibrary.resolve(r.outlet_id, comment.author),
    })),
    image: withImageVersion(r.image),
    // 配图状态：图库形态要用它区分「排队生图中」与「生成失败」（否则两种都是空白格）
    image_status: r.image_status || null,
    image_error: r.image_error || null,
    // 周刊/海报的结构化正文（feed 形态为 null）
    payload: safeParse(r.payload_json, null),
    layout: r.layout || 'feed',
    // ★ 这条内容**能否重新生图** —— 由后端同判据（`canRegenerateImage`）算好下发。
    //
    // 为什么在服务端算、而不是前端自己判断：`image_prompt` 恰恰是 `mapPostRow` **不下发**的字段，
    // 前端拿不到它就无法本地判断。若为此额外下发整个 image_prompt，既多传数据，
    // 又会把"什么算可生图"这条口径复制到第二处（红线 8）。
    // 这里直接复用**重新生图端点用的同一个函数**，口径天然不漂。
    // 用户 2026-10-06 实报：论坛是纯文字版面却还挂着「重新生图」按钮（点了只会报错）。
    can_regenerate: canRegenerateImage(r),
    created_at: r.created_at,
  };
}

/** 按现有设备级已读游标统计；只查主键和分类，不加载正文或配图。 */
export function getMediaUnread(seen = {}) {
  const db = getDb();
  const categories = {};
  for (const category of ['digital', 'social']) {
    const value = Number(seen[category]);
    const cursor = Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const condition = category === 'digital'
      ? "o.layout IN ('weekly','poster','portal')"
      : "(o.layout IS NULL OR o.layout = 'feed')";
    categories[category] = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(MAX(${MEDIA_PUBLICATION_ORDER}), ?) AS latestId
      FROM media_posts p LEFT JOIN media_outlets o ON o.id = p.outlet_id
      WHERE p.published_seq IS NOT NULL AND ${MEDIA_PUBLICATION_ORDER} > ? AND ${condition}
    `).get(cursor, cursor);
  }
  return { categories, count: categories.digital.count + categories.social.count };
}

/**
 * 分页取帖子（跨媒体，或指定媒体/板块）。
 * @param {object} opts
 * @param {'print'|'digital'|'social'|null} [opts.category] - 分类过滤，取值与映射见 `CATEGORY_LAYOUTS`：
 *   `print` = 官方传媒（poster/weekly）；`digital` = 数字报刊（portal）；`social` = 社交平台（feed/NULL）。
 *   传 null 或未知值 = **不过滤**（「全部」标签）。
 *   注意《邻舍日报》不走这里（它是独立的整版报纸，不存 media_posts）。
 */
export function listPosts({ outletId = null, boardId = null, category = null, favoritesOnly = false, limit = 40, offset = 0 } = {}) {
  const db = getDb();
  const where = ['p.published_seq IS NOT NULL'];
  const params = [];
  if (outletId) { where.push('p.outlet_id = ?'); params.push(outletId); }
  if (boardId) { where.push('p.board_id = ?'); params.push(boardId); }
  // 分类过滤走**唯一一张映射表**（CATEGORY_LAYOUTS），
  // 别再在这里写 if/else 硬编码形态名 —— 那正是「digital 漏摘 poster」的成因。
  const cf = categoryFilter(category);
  if (cf) { where.push(cf.sql); params.push(...cf.params); }
  // 上游 v3.9.0（0d8fd1f）：媒体收藏——只看收藏过的帖子
  if (favoritesOnly) where.push('p.favorited_at IS NOT NULL');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // ★ 分类过滤引用 o.layout，所以**计数查询也必须带上同一套 JOIN**。
  //   踩过的坑：计数只写 `FROM media_posts p` → SQLite 报 `no such column: o.layout`
  //   → 整个 listPosts() 抛错 → 前端 catch 后把列表置空 → 分类标签有数字但正文区
  //   显示「还没有任何帖子」。两个查询共用 fromSql，从结构上杜绝再次跑偏。
  //   LEFT JOIN 对 outlet/board 都是 1:1（外键指向唯一主键），COUNT 不会重复计数。
  const fromSql = `
    FROM media_posts p
    LEFT JOIN media_outlets o ON o.id = p.outlet_id
    LEFT JOIN media_boards  b ON b.id = p.board_id
  `;

  const total = db.prepare(`SELECT COUNT(*) AS n ${fromSql} ${whereSql}`).get(...params).n;
  const rows = db.prepare(`
    SELECT p.*, o.name AS outlet_name, o.layout AS layout, b.name AS board_name
    ${fromSql}
    ${whereSql}
    ORDER BY ${favoritesOnly ? 'p.favorited_at DESC, p.id' : MEDIA_PUBLICATION_ORDER} DESC
    LIMIT ? OFFSET ?
  `).all(...params, Math.min(Math.max(1, limit), 100), Math.max(0, offset));

  return { posts: rows.map(mapPostRow), total };
}

/** 待补配图的帖子（供后台补印） */
export function listPostsNeedingImage(limit = 8, postIds = null) {
  const scope = imagePostScope(postIds);
  // ⚠ 必须排除门户：门户由 fillPortalImages 负责逐块补图，而门户帖的 image_prompt 存的是
  //   「第一块的头图提示词」，被这里捞到会**额外多生一张重复的主图**（正是两层设计要避免的浪费）。
  //   ★ 判据用**帖子自身的 `payload.portal`**，而不是媒体当前的 `layout` ——
  //     否则媒体从 feed 改成 portal 后，它名下的**普通帖**也会被一并排除，永远配不上图。
  //     （回归测试 mediaOutletLayout.test.js「changing type moves old posts」钉住此行为。）
  return getDb().prepare(`
    SELECT p.id, p.image_prompt, p.character_id, p.payload_json, p.title, p.content FROM media_posts p
    LEFT JOIN media_outlets o ON o.id = p.outlet_id
    WHERE (p.image_status = 'pending' OR (p.published_seq IS NULL AND p.image_status = 'failed'))
      AND p.image_prompt IS NOT NULL AND p.image_prompt != ''
      AND COALESCE(json_extract(CASE WHEN json_valid(p.payload_json) THEN p.payload_json ELSE '{}' END, '$.portal'), 0) != 1
      ${scope.sql}
    ORDER BY p.id DESC LIMIT ?
  `).all(scope.ids, limit);
}

/**
 * 写帖子配图状态。
 *
 * **未传 url 时不动 image 字段** —— 原实现用 `url = null` 当默认值，
 * 「置为 generating」这种不带 url 的调用会把已有图片清空，是个隐患。
 * @param {number} postId
 * @param {{url?: string|null, status?: string, error?: string|null}} patch
 */
export function updatePostImage(postId, { url, status, error = null } = {}) {
  const db = getDb();
  if (url === undefined) {
    // 只改状态，保留已有图片
    db.prepare('UPDATE media_posts SET image_status = ?, image_error = ? WHERE id = ?')
      .run(status, error, postId);
    return;
  }
  db.prepare('UPDATE media_posts SET image = ?, image_status = ?, image_error = ? WHERE id = ?')
    .run(url, status, error, postId);
}

/**
 * 原子抢占一条待配图的帖子（CAS）。
 * 只有当前仍是 `pending` 的才抢得到 —— 防止同一帖子被两条补图路径同时捞走、各生成一张，
 * 后者覆盖前者、前者的文件变成永远没人引用的孤儿。
 * @returns {boolean} 是否抢到（false = 别人已在处理或已完成，应跳过）
 */
function claimPostForImage(postId) {
  const r = getDb().prepare(`
    UPDATE media_posts SET image_status = 'generating', image_error = NULL
    WHERE id = ? AND (image_status = 'pending' OR (published_seq IS NULL AND image_status = 'failed')) AND (image IS NULL OR image = '')
  `).run(postId);
  // 记下开跑时刻：generating 卡死时按它判断超时（见 resetStaleMediaGenerating）。
  if (r.changes === 1) imageClaims.set(postId, Date.now());
  return r.changes === 1;
}

// ══════════════════════════════════════════
// 生成
// ══════════════════════════════════════════

/**
 * 抽参与本次生成的活跃角色（排除归档：归档 = 不参与任何主动行为）。
 * 返回带人格与头像的行，供提示词与落库使用。
 *
 * @param {number} count
 * @param {{worldIds?: number[]}} [opts]
 *   `worldIds` —— 本轮媒体抽中的世界。给了就**只从这些世界的居民 + 未归属角色里抽**。
 *
 *   ★ 2026-10-18（用户第 5 问）：此前这里是无条件 `ORDER BY RANDOM()` 全库随机，
 *     和 `getWorldSettingSample()` 是完全独立的两条抽签线 —— 于是会出现
 *     「媒体背景是二维市，作者却是仙舟的景元」。抽世界不配角色，等于角色被忽略。
 *     现在按世界收窄池子：归属该世界的 + 未归属的（未归属吃主世界骨架，放哪个世界都不算串味）。
 *     不传 `worldIds`（老调用点）时行为与从前逐字节一致。
 */
export function pickActiveCharacters(count = 2, { worldIds = null } = {}) {
  const n = Math.max(0, Math.min(3, count));
  if (!n) return [];
  const cols = `id, display_name, avatar_path, short_prompt, base_prompt, loras, custom_workflow, artist_override,
           forum_alias, forum_persona`;
  const ids = Array.isArray(worldIds)
    ? worldIds.map(Number).filter((v) => Number.isSafeInteger(v) && v > 0)
    : [];

  if (!ids.length) {
    return getDb().prepare(`
      SELECT ${cols}
      FROM characters
      WHERE COALESCE(archived, 0) = 0
      ORDER BY RANDOM() LIMIT ?
    `).all(n);
  }

  const holes = ids.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT ${cols}
    FROM characters
    WHERE COALESCE(archived, 0) = 0
      AND (world_setting_id IN (${holes}) OR world_setting_id IS NULL)
    ORDER BY RANDOM() LIMIT ?
  `).all(...ids, n);
}

/**
 * 全库角色名（**含归档**）—— 供图库把标题/备注/署名里的角色名洗掉。
 *
 * 为什么不是只取本次出镜的那几位：模型在图上认人，但它也可能把**别处**看来的名字
 * 顺手写进作品名（系统提示词与世界设定里到处都是角色名）。既然口径是
 * 「规则34 不许出现人名/角色名」，那就对**全部**名字设防。
 */
function listCharacterDisplayNames() {
  try {
    return getDb().prepare(`SELECT display_name FROM characters`).all()
      .map(r => String(r.display_name || '').trim())
      .filter(Boolean);
  } catch { return []; }
}

/**
 * 该媒体近期用过的网名（发帖人 + 评论者），供下一批去重。
 *
 * 为什么要回灌给模型而不是只靠后端消歧：
 *   后端消歧会把 `小明` 改成 `小明2`，虽然保住了内容，但连着一串
 *   `小明2 小明3 小明4` 反而假。真正的解法是让模型**一开始就别重复**，
 *   后端只做兜底。取最近 40 条帖子，够覆盖"这一屏还能看到"的范围。
 */
function recentUsedAliases(outletId, limit = 40) {
  if (!outletId) return [];
  const rows = getDb().prepare(`
    SELECT author_name, comments_json FROM media_posts
    WHERE outlet_id = ? ORDER BY id DESC LIMIT ?
  `).all(outletId, limit);
  return collectUsedAliases(rows.map(r => ({
    author_name: r.author_name,
    comments: safeParse(r.comments_json, []) || [],
  })));
}

/**
 * 提示词：让 LLM 产出 { posts: [...] }
 * @param {object} [opts]
 * @param {string[]} [opts.usedAliases] 该媒体近期用过的网名 —— 喂回规则里做去重
 */
export function buildFormatPrompt(outlet, boards, authors, opts = {}) {
  const boardNames = boards.map(b => b.name);
  const boardRule = boardNames.length
    ? `"board" 必须从这个媒体的板块里选：${boardNames.map(x => `「${x}」`).join('、')}`
    : `"board" 填 ""（本媒体还没有板块）`;

  // 角色的帖子在论坛里用**马甲**署名（没填马甲才退回真名）。
  // 注意这里只是"告诉模型第 N 条是谁写的" —— 真正落库的 author_name 由
  // normalizeMediaDraft 按 authors[i] 覆盖，不依赖模型有没有把名字填对。
  const authorRule = authors.length
    ? authors.map((a, i) => `第 ${i + 1} 条帖子的作者必须是「${a.display_name}」本人（论坛马甲：${a.forum_alias || a.display_name}）`).join('；')
      + `。这几条要用 Ta 自己的口吻与身份写，author 字段填 Ta 的论坛马甲，不要填真名；`
      + `其余帖子的 author 填一个符合该媒体气质的网名。`
    : `author 填一个符合该媒体气质的网名。`;

  const aliasRule = buildAliasRuleBlock({ used: opts.usedAliases || [] });
  const imageRules = String(getGlobalRule('image_prompt')?.rule_content || '').trim();

  return `请严格按照以下 JSON 格式输出，不要输出任何解释或 JSON 以外的文字：

${JSON.stringify({
  posts: [{
    board: `板块名（${boardRule}）`,
    title: '帖子标题（≤30字，符合该媒体的标题风格）',
    content: '帖子正文（60~300字，有具体细节，符合该媒体的文体）',
    tags: ['标签1', '标签2'],
    author: '发布者名（见下方作者要求）',
    likes: 1200,
    views: 14400,
    comments: [{ author: '评论者名', content: '评论内容（20~80字）' }],
    image_prompt: '英文插画描述（一段完整英文：写清画面主体、动作、地点、光线；不出现任何文字、边框或水印；必填非空字符串）',
  }],
}, null, 2)}

字段要求：
- ${boardRule}。
- 作者要求：${authorRule}
- 同一批次内每条帖子的**板块、主题、作者都必须明显不同**，禁止同质化与模板化。
- "likes"/"views" 必须为 JSON 整数（示例为 1200/14400）：普通帖子点赞 20~3000；由上面点名的那几位角色本人发的帖子，因为有关注度，点赞要给到 800~12000。views 相应放大。
- "comments"：每条帖子 1~4 条评论，观点要有支持、反对、质疑、调侃、歪楼等不同声音，禁止清一色附和、禁止"同上/+1"这类无信息量回复。
- "image_prompt" 每条帖子必填，必须是非空英文字符串，不得省略、留空或填 null。
- 所有 title/content/comments 用中文；所有 image_prompt 用英文。
- 内容必须符合 <world_setting> 的时代感与生活细节，不出现世界观之外的事物。

${aliasRule}${imageRules ? `\n\n生图规则（所有 image_prompt 必须遵守）：\n${imageRules}` : ''}`;
}

/** 提示词：本次素材（世界观由 stage 层注入，这里给板块与角色资料） */
function buildMaterialsPrompt(outlet, boards, authors, count) {
  const boardList = boards.length
    ? boards.map(b => `- ${b.name}${b.desc ? `：${b.desc}` : ''}`).join('\n')
    : '（本媒体暂无板块，全部帖子 board 填空字符串）';

  const authorBlock = authors.length
    ? `\n【本次由以下角色本人发帖（按顺序对应第 1~${authors.length} 条）】\n`
      + authors.map((a, i) => {
        const head = `${i + 1}. ${a.display_name}（论坛马甲：${a.forum_alias || a.display_name}）`
        // 网上人设只影响**这一条帖子**的调门（爱逛什么板、什么话题会下场），不并入人格本身
        const net = a.forum_persona ? `\nTa 在网上的人设：${a.forum_persona}` : ''
        // ★ person 仍传真名：模型需要知道角色的真实身份才能写出符合人设的内容，
        //   马甲只决定「署名显示什么」，不改变 Ta 是谁。
        return `${head}\n${buildCharacterPersona(a, { variant: 'short', person: a.display_name }) || '（无补充资料）'}${net}`
      }).join('\n\n')
    : '';

  return `本次要为「${outlet.name}」生成 ${count} 条新帖子。
${outlet.tagline ? `媒体定位：${outlet.tagline}\n` : ''}
【本媒体的板块】
${boardList}
${authorBlock}

请开始生成。`;
}

/**
 * 规整 LLM 输出 → 可落库的帖子数组。不合法的条目丢弃；一条都没有则抛错。
 * @param {object} raw - LLM 返回的对象
 * @param {Array} boards - 该媒体的板块（用于把 board 名映射成 id）
 * @param {Array} authors - 本次指派的角色（按下标对应）
 */
export function normalizeMediaDraft(raw, boards, authors = []) {
  const list = Array.isArray(raw?.posts) ? raw.posts : null;
  if (!list) throw new Error('LLM 输出缺少 posts 数组');

  const boardByName = new Map(boards.map(b => [b.name, b]));
  const out = [];

  list.forEach((item, i) => {
    const title = clampText(item?.title, 60);
    const content = clampText(item?.content, 1200);
    if (!title || !content) return;   // 标题/正文缺一不可
    const rawImagePrompt = item?.image_prompt ?? item?.imagePrompt;
    if (typeof rawImagePrompt !== 'string' || !rawImagePrompt.trim()) {
      throw new Error(`第 ${i + 1} 条帖子缺少有效的 image_prompt（必须是非空英文字符串）`);
    }

    const boardName = clampText(item?.board, 16);
    const board = boardByName.get(boardName) || null;

    // 按下标指派角色作者：绝不靠名字匹配（LLM 会给名字加后缀、改大小写）
    const author = authors[i] || null;

    const likesRaw = Number(item?.likes);
    const viewsRaw = Number(item?.views);
    const likes = Number.isFinite(likesRaw) && likesRaw >= 0 ? Math.floor(likesRaw) : randInt(20, 3000);

    const comments = (Array.isArray(item?.comments) ? item.comments : [])
      .map(c => ({ author: clampText(c?.author, 24) || '匿名', content: clampText(c?.content, 200) }))
      .filter(c => c.content)
      .slice(0, 6);

    out.push({
      board_id: board?.id ?? null,
      title,
      content,
      tags: (Array.isArray(item?.tags) ? item.tags : []).map(t => clampText(t, 12)).filter(Boolean).slice(0, 5),
      author_type: author ? 'character' : 'anonymous',
      character_id: author ? author.id : null,
      // 角色在论坛用**马甲**署名（没填马甲才退回真名）。author_type 仍是 'character'，
      // 前端照旧打「角色」徽标 —— 玩家知道是谁，看到的名字却是网名，
      // 正好是「不点名但大家都心里有数」那种论坛感。
      author_name: author ? (author.forum_alias || author.display_name) : (clampText(item?.author, 24) || '匿名用户'),
      author_avatar: author ? (author.avatar_path || null) : null,
      likes,
      views: Number.isFinite(viewsRaw) && viewsRaw > 0 ? Math.floor(viewsRaw) : likes * randInt(8, 25),
      comments,
      image_prompt: clampText(rawImagePrompt, 1200),
    });
  });

  if (!out.length) throw new Error('没有可用的帖子');

  // ── 同批网名消歧 ──
  // 跨帖子查重（发帖人与评论者共用一套名字空间）。规则里已经把"已用名单"喂给了模型，
  // 这里是兜底：重名不丢弃、只追加序号（`小明` → `小明2`，真实互联网撞名就这么干），
  // 这样评论区不会凭空少内容。
  //
  // 用「槽位」而不是手动推进下标：名字散落在 post.author_name 与 comments[].author 两处，
  // 手算索引一旦错位就会张冠李戴地改名（而且很难看出来）。
  // ★ 角色马甲不进槽位（不改名），但要作为 `reserved` **预占**名字空间 ——
  //   否则评论者可能恰好也叫这个马甲，出现「匿名网友顶着角色马甲说话」的场面。
  const slots = []
  const reservedAliases = []
  for (const p of out) {
    // 角色帖的作者名 = 马甲：预占名字空间，但自己不参与改名
    if (p.author_type === 'character') reservedAliases.push(p.author_name)
    else slots.push({ read: () => p.author_name, write: v => { p.author_name = v } })
    // 评论者无论帖子是谁发的，都要参与消歧
    for (const c of p.comments) {
      slots.push({ read: () => c.author, write: v => { c.author = v } })
    }
  }
  const fixedNames = disambiguateAliases(slots.map(s => s.read()), { reserved: reservedAliases })
  slots.forEach((s, i) => {
    if (fixedNames[i] && fixedNames[i] !== s.read()) s.write(fixedNames[i])
  })

  return out;
}

/**
 * 生成一批草稿并落库，配图齐全后才发布。
 * @param {object} opts
 * @param {number} [opts.outletId] - 不传则随机挑一个启用的媒体
 * @param {number} [opts.count] - 条数
 * @param {boolean} [opts.withCharacters] - 是否让活跃角色参与发帖（默认 true）
 * @returns {Promise<{outletId:number, batchId:string, inserted:number}>}
 */
// ══════════════════════════════════════════
// 论坛形态（网络论坛）—— 版聊主题帖
// ══════════════════════════════════════════

/**
 * 论坛主题帖的输出格式约束。
 *
 * 与 feed 的差别（这是"论坛感"的来源，别抄成 feed 的格式）：
 *   · 一条 = **一个主题帖**（标题 + 楼主正文 + N 层回复），不是一条独立动态；
 *   · 回复有**楼层号**，可以「引用」上面某一层（`quote` 填那一层的楼层号）；
 *   · **文字为主、图片只是偶尔出现** —— 明确要求只有约 1/4 的帖子给 image_prompt；
 *   · 论坛有「顶楼」「前排」「爬楼」「沙发」这类站点黑话与抬杠氛围。
 */
function buildForumFormatPrompt(outlet, boards, authors, opts = {}) {
  const boardNames = boards.map(b => b.name);
  const boardRule = boardNames.length
    ? `"board" 必须从这个论坛的板块里选：${boardNames.map(x => `「${x}」`).join('、')}`
    : `"board" 填 ""（本论坛还没有板块）`;

  const authorRule = authors.length
    ? authors.map((a, i) => `第 ${i + 1} 个主题帖的楼主必须是「${a.display_name}」本人（论坛马甲：${a.forum_alias || a.display_name}）`).join('；')
      + `。这几个帖要用 Ta 自己的口吻与身份写，author 字段填 Ta 的论坛马甲，不要填真名；`
      + `其余帖子的楼主与回复者都填符合该论坛气质的网名。`
    : `楼主与回复者都填符合该论坛气质的网名。`;

  const aliasRule = buildAliasRuleBlock({ used: opts.usedAliases || [] });
  const imageRules = String(getGlobalRule('image_prompt')?.rule_content || '').trim();

  return `请严格按照以下 JSON 格式输出，不要输出任何解释或 JSON 以外的文字：

{
  "posts": [
    {
      "board": "板块名（${boardRule}）",
      "title": "主题帖标题（≤30字，论坛标题风格：可带【求助】【讨论】【实况】这类前缀）",
      "content": "楼主正文（80~400字，第一人称，有具体细节与情绪）",
      "tags": ["标签1", "标签2"],
      "author": "楼主名（见下方作者要求）",
      "likes": 数字（点赞/收藏数，见下方热度要求）,
      "views": 数字（浏览数，通常为 likes 的 15~60 倍；论坛帖的浏览量远高于点赞）,
      "replies": [
        { "floor": 1, "author": "网名", "content": "回复内容（15~120字）", "quote": 楼层号或 null }
      ],
      "image_prompt": "**一律填空字符串 \\"\\"**（论坛是纯文字版面，不出图）"
    }
  ]
}

字段要求：
- ${boardRule}。
- 作者要求：${authorRule}
- "replies"：每个主题帖 **2~8 层**回复。这是论坛，重点在**你来我往**，不是清一色附和：
  · 要有不同的声音——赞同、抬杠、质疑、玩梗、歪楼、版主警告、二楼抢沙发都行；
  · 后面的楼层要**接住前面楼层的话**（可以 @ 某人或引用），像真的在爬楼，而不是各说各话；
  · "floor" 从 1 开始递增，连续不跳号；"quote" 填被引用的楼层号（不引用就填 null）；
  · 允许出现「+1」「mark」「先回再看」这类短回复，但**全帖不能只有这种**。
- "likes"/"views"：普通主题帖 likes 5~800；由上面点名的那几位角色本人发的帖子给到 300~5000。
- ★★ **论坛是纯文字版面，一律不配图**：image_prompt 全部填**空字符串**（两个双引号，中间无内容）。
  （2026-10-05 用户口径。此前写的是「约四分之一可有图」，实测 12 条里 5 条配了图 → 版面变成图文混排，
  与「论坛＝文字版」的定位不符。**只有社交平台与规则34才配图**。）
- 同一批次内每个主题帖的**板块、主题、楼主都必须明显不同**，禁止同质化与模板化。
- 所有 title/content/replies 用中文；image_prompt 用英文。
- 内容必须符合 <world_setting> 的时代感与生活细节，不出现世界观之外的事物。

${aliasRule}${imageRules ? `\n\n生图规则（有图片的那几条 image_prompt 必须遵守）：\n${imageRules}` : ''}`;
}

/** 规整论坛主题帖 → 可落库的帖子数组 */
export function normalizeForumDraft(raw, boards, authors = []) {
  const list = Array.isArray(raw?.posts) ? raw.posts : null;
  if (!list) throw new Error('LLM 输出缺少 posts 数组');

  const boardByName = new Map(boards.map(b => [b.name, b]));
  const out = [];

  list.forEach((item, i) => {
    const title = clampText(item?.title, 60);
    const content = clampText(item?.content, 1600);
    if (!title || !content) return;

    const boardName = clampText(item?.board, 16);
    const board = boardByName.get(boardName) || null;
    const author = authors[i] || null;

    const likesRaw = Number(item?.likes);
    const viewsRaw = Number(item?.views);
    const likes = Number.isFinite(likesRaw) && likesRaw >= 0 ? Math.floor(likesRaw) : randInt(5, 800);

    // ── 楼层 ──
    // floor 一律按数组顺序**重新编号**（不信模型给的号）：模型偶尔会跳号/重复，
    // 而前端的「引用 #N」是按号去找层的，号一乱引用就指错人。
    const replies = (Array.isArray(item?.replies) ? item.replies : [])
      .map(r => ({
        author: clampText(r?.author, 24) || '匿名',
        content: clampText(r?.content, 400),
        quote: Number.isFinite(Number(r?.quote)) && Number(r?.quote) > 0 ? Math.floor(Number(r.quote)) : null,
      }))
      .filter(r => r.content)
      .slice(0, 12);
    replies.forEach((r, idx) => { r.floor = idx + 1 });
    // 引用号必须落在实际存在的楼层范围内，否则前端会显示「引用 #9」而根本没有 9 楼
    for (const r of replies) if (r.quote !== null && r.quote > replies.length) r.quote = null;
    // ── 楼层的赞/踩 ──
    // ★ 由**服务端确定性生成**（不让模型写）：模型在温度下倾向于给所有楼层差不多的数，
    //   而且经常会写出 "3 楼：12 赞" 这种自相矛盾的号。这里按楼层内容长度与"是否有争议词"
    //   派生一个合理的量级，保证：① 赞数随楼层序号递减（越靠前越显眼，符合真实论坛）；
    //   ② **有踩说明有争议** —— 反对意见（杠精/被戳痛处/版主拉架）本就会有踩，
    //   ③ 同一帖内不出现完全相同的数字（否则看着像假数据）。
    replies.forEach((r, idx) => {
      const base = Math.max(0, 96 - idx * 13 - randInt(0, 6));   // 主楼之后逐层递减
      r.likes = base + randInt(0, 9);
      // 约 1/3 的楼层有踩（争议感），且其赞数略低 —— 有争议的发言不会全是好评
      const disputed = Math.random() < 0.34 || /杠|不同意|然而|其实|未必|真的吗|笑了/i.test(r.content);
      r.dislikes = disputed ? randInt(1, Math.max(2, Math.round(r.likes * 0.12))) : 0;
    });

    out.push({
      board_id: board?.id ?? null,
      title,
      content,
      tags: (Array.isArray(item?.tags) ? item.tags : []).map(t => clampText(t, 12)).filter(Boolean).slice(0, 5),
      author_type: author ? 'character' : 'anonymous',
      character_id: author ? author.id : null,
      author_name: author ? (author.forum_alias || author.display_name) : (clampText(item?.author, 24) || '匿名用户'),
      author_avatar: author ? (author.avatar_path || null) : null,
      likes,
      // 论坛浏览量的量级远高于点赞（feed 是 8~25 倍，这里 15~60 倍）
      views: Number.isFinite(viewsRaw) && viewsRaw > 0 ? Math.floor(viewsRaw) : likes * randInt(15, 60),
      comments: [],
      // ★ 论坛是**纯文字版面**（用户口径）——出口层强制清空 image_prompt。
      //   只改提示词不够：模型有惯性（此前一直允许"约四分之一配图"），
      //   实测仍会零星产出，于是版面变成图文混排。这里做兜底，让口径可被保证。
      image_prompt: null,
      payload: { forum: { replies } },
    });
  });

  if (!out.length) throw new Error('没有可用的主题帖');

  // 网名消歧：楼主（角色马甲预占）与所有回复者共用一套名字空间。
  // 论坛帖的回复者数量是 feed 评论的数倍，撞名概率显著更高，这一步不能省。
  const slots = [];
  const reservedAliases = [];
  for (const p of out) {
    if (p.author_type === 'character') reservedAliases.push(p.author_name);
    else slots.push({ read: () => p.author_name, write: v => { p.author_name = v } });
    for (const r of p.payload.forum.replies) {
      slots.push({ read: () => r.author, write: v => { r.author = v } });
    }
  }
  const fixedNames = disambiguateAliases(slots.map(s => s.read()), { reserved: reservedAliases });
  slots.forEach((s, i) => {
    if (fixedNames[i] && fixedNames[i] !== s.read()) s.write(fixedNames[i]);
  });

  return out;
}

/** 生成一批论坛主题帖 */
async function generateForumBatch(outlet, count, withCharacters) {
  const db = getDb();
  const n = Math.max(1, Math.min(MAX_BATCH_SIZE, count));
  const boards = listBoards(outlet.id);
  const authorCount = !withCharacters ? 0 : Math.min(3, Math.max(1, Math.floor(n / 3)));
  // ★ 2026-10-18：先抽世界，再按世界的居民抽作者 —— 两条线必须配对
  const sampled = sampleWorldSettings();
  const worldSetting = sampled.text;
  const authors = pickActiveCharacters(authorCount, { worldIds: sampled.ids });
  const msgs = [
    { role: 'system', content: [getSystemRules({ roleplay: false }), worldSetting].filter(Boolean).join('\n\n') },
    { role: 'system', content: outlet.prompt },
    { role: 'system', content: buildForumFormatPrompt(outlet, boards, authors, { usedAliases: recentUsedAliases(outlet.id) }) },
    { role: 'user', content: buildMaterialsPrompt(outlet, boards, authors, n) },
  ];

  const raw = await chatSync(msgs, {
    temperature: 0.9,
    response_format: { type: 'json_object' },
    label: `media-forum:${outlet.name}`,
  });
  const jsonStr = extractFirstJson(raw);
  if (!jsonStr) throw new Error('LLM 未返回 JSON');
  const drafts = normalizeForumDraft(JSON.parse(repairJson(jsonStr)), boards, authors);
  return insertDrafts(outlet, drafts, n);
}

// ══════════════════════════════════════════
// 图库形态（规则34）—— 随机画师串 + 随机题材组合
// ══════════════════════════════════════════

/**
 * 画师串池 = `artist_favorites`（设置页「画师串收藏夹」）。
 *
 * 这是本形态的核心特征：**每条图的画风都不一样**，所以画师串必须逐条随机，
 * 而不是所有图都套同一个 `config.comfyui.momentsArtist`。
 * 池子为空时回落到当前配置的画师串，保证功能不会因为没收藏过画师而崩。
 */
export function listArtistPool() {
  try {
    const rows = getDb().prepare('SELECT artist FROM artist_favorites ORDER BY sort_order, id').all();
    const list = rows.map(r => String(r.artist || '').trim()).filter(Boolean);
    if (list.length) return list;
  } catch { /* 表可能还没建 */ }
  const fb = String(config.comfyui?.momentsArtist || '').trim();
  return fb ? [fb] : [];
}

/** 从池子里不重复地抽 n 个画师串（池子不够就允许重复） */
function pickRandomArtists(n) {
  // 设置页里给媒体填了画师串 → 所有媒体图都用它（用户主动收窄风格时的行为）。
  // 留空才走「收藏夹逐条随机」，那是图库形态的核心特征，不能默认丢掉。
  const fixed = String(config.comfyui?.mediaArtist || '').trim();
  if (fixed) return Array.from({ length: n }, () => fixed);
  const pool = listArtistPool();
  if (!pool.length) return [];
  const bag = [...pool];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!bag.length) bag.push(...pool);
    const k = Math.floor(Math.random() * bag.length);
    out.push(bag.splice(k, 1)[0]);
  }
  return out;
}

/**
 * ★ 画幅比例池 —— **每条随机**。
 * 尺寸按同一像素预算（长边 ~1600、约 1.9MP）给出，避免个别比例把显存吃爆。
 * 竖幅留给「全身/站立」类，横幅留给「横躺/侧卧」类（由抽取时按体位画幅倾向加权）。
 */
// 画幅池单独成模块（纯计算），避免测试 import 本文件时白白拉起 comfyClient 去连 ComfyUI。
// 对外接口保持不变：调用方仍从 mediaService 拿 GALLERY_ASPECTS / resolveGalleryAspects。
export { GALLERY_ASPECTS, GALLERY_SMALL_ASPECTS, GALLERY_ALL_ASPECTS } from '../data/galleryAspects.js';
export { resolveGalleryAspects } from './galleryAspectResolver.js';

/** 横躺类体位（适合横幅）—— 按体位名/判定里出现的「卧/躺/侧」等字样加权 */
const LYING_RE = /卧|躺|侧|睡|仰|俯|趴/;

/**
 * 图库条目的**标签上限**。
 *
 * ★ 6 是"只有体位"时代的值。环境层（7 维）一上来就占 7~8 个，
 *   还按 6 截会把环境层与体位 core 词整段砍掉 = 白扩。
 *   卡片上只显示前 3 个（`MediaGallery.vue`），多出来的用于左栏标签云与筛选。
 */
const MAX_GALLERY_TAGS = 12;

/** 抽 n 个比例：把池子洗成袋，抽完再续（保证同批内尽量不重复） */
function pickRandomAspects(n) {
  const aspects = resolveGalleryAspects();   // 池子每批算一次，别在循环里重复过滤
  const bag = [];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!bag.length) bag.push(...aspects);
    out.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
  }
  return out;
}

// ── 体位池 ──────────────────────────────────────────────────

/**
 * 随机抽 n 个体位（**不重复优先**；池子不够才允许重复）。
 * 全部来自 `src/data/sexPositions.js`（由 `tools/parse-sex-positions.mjs` 从
 * 《体位生图参考.md》解析生成，源文件在只进不改库里，只读）。
 */
export function pickRandomPoses(n) {
  const bag = [...SEX_POSITIONS];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!bag.length) bag.push(...SEX_POSITIONS);
    out.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
  }
  return out;
}

/** 每个 `[a / b / c]` 变体组随机取一项，并去掉方括号 */
export function resolvePoseVariants(prompt) {
  return String(prompt || '').replace(/\[([^\]]*)\]/g, (_, group) => {
    const opts = group.split('/').map(s => s.trim()).filter(Boolean);
    return opts.length ? opts[Math.floor(Math.random() * opts.length)] : '';
  });
}

/**
 * 把体位模板变成一条可直接生图的英文 image_prompt。
 * @param {object} pose - SEX_POSITIONS 里的一条
 * @param {object} [opts]
 * @param {string} [opts.subject] - 女方的视觉指代（**英文**，如 'the girl with long black hair'）
 * @param {string[]} [opts.girlRefs] - 多女体位按序的英文指代；缺项回落到 subject/泛称
 * @param {{sentence:string}} [opts.envelope] - 环境层（`pickGalleryEnvelope` 的返回值）；
 *        其 `sentence` 会被**追加**在体位描述之后 —— 它是正交的（管"在哪/什么光/什么镜头"），
 *        **不改写**体位原文，所以逐字校准过的体位提示词不会被污染。
 * @returns {{prompt:string, frame:string, negative:string}}
 */
/**
 * 同框女方的位置指代（阶段 6）：与 `characterAnchor.buildAnchorLine` 的 `side` 词一致 ——
 * 指代说"是哪位"，锚点说"长什么样"，两者用同一套词才不会各说各的。
 */
export const GIRL_POSITION_REFS = ['the girl', 'the girl on the left', 'the girl on the right'];

export function buildPoseImagePrompt(pose, opts = {}) {
  const frame = (pose.frames && pose.frames.length)
    ? pose.frames[Math.floor(Math.random() * pose.frames.length)]
    : 'cowboy shot';

  let text = resolvePoseVariants(pose.prompt);

  // 视觉指代替换：源模板里 `the girl` / `the girl 1` / `the girl 2` / `the boy`。
  // ★ 必须**单遍**替完（编号与裸的一把正则），否则会级联：
  //   若先替 `the girl 2` → `the girl with silver hair`，再替裸 `the girl`，
  //   后一遍会命中刚插入的指代里的 `the girl`，把结果串成
  //   `the girl with long black hair with silver hair`（已实测踩过）。
  //   String.replace 的 /g 只扫原串、不回扫插入文本，所以单遍天然免疫级联。
  const refs = Array.isArray(opts.girlRefs) ? opts.girlRefs : [];
  const fallback = opts.subject || 'the girl';
  const pickRef = (i) => refs[i - 1] || fallback;
  text = text.replace(/\bthe girl(?: (\d))?\b/g, (_, d) => (d ? pickRef(Number(d)) : fallback));
  // 男方保持泛称（图站匿名男性），不指派角色
  text = text.replace(/\bthe boy(?: (\d))?\b/g, (_, d) => (d ? `the man ${d}` : 'the man'));

  /*
   * ★ 出镜条件（源文件标题里的「（小马限定）/（小车限定）」）——**被抱起/被驮的那一方**必须明显娇小。
   *   方向由 `pose.limitOn` 决定：'male'（女方抱男方）／'female'（男方抱起或倒提女方）。
   *   ⚠ 不能一律写成「男方娇小」：048/049/080 恰恰相反，写错会与前半句的
   *     "the man is lifting the girl" 自相矛盾（画面必崩）。
   *   源文件的「负向」只写 `muscular male/female`（压"别画壮"),生不出「明显小一圈」，
   *   所以在提示词里补正向描述。图站男方是匿名的，这里只约束体型、不指派角色。
   */
  const positiveLimit = (pose.limitTags && pose.limitTags.length)
    ? (pose.limitOn === 'male'
      ? `The male is clearly smaller than the girl: ${pose.limitTags.join(', ')}.`
      : `The girl is clearly smaller than the male: ${pose.limitTags.join(', ')}.`)
    : '';

  // 环境层插在**体位描述之后、画幅之前**：先讲清"人怎么摆"，再补"在哪/什么光/什么镜头"
  const envSentence = String(opts.envelope?.sentence || '').trim();
  const parts = [text.trim(), positiveLimit, envSentence, `${frame}.`];
  return {
    prompt: parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
    frame,
    negative: String(pose.negative || '').trim(),
  };
}

/** 该体位需要几名女方（用于挑角色） */
export function girlsNeeded(pose) {
  return Math.max(1, Number(pose?.girls) || 1);
}

/**
 * 出镜条件为「女方须娇小」时，优先从娇小档角色里挑。
 *
 * ★ 为什么不是「过滤成一个必空的分支」：
 *   项目红线 —— 过滤后可能为空的分支**绝不能静默返回空**（用户只会看到"点了没反应"）。
 *   所以这里是**优先 + 显式兜底**：有娇小档就用娇小档；一个都没有就退回全池，
 *   宁可画面比例不完美，也不能把这一格图丢掉。
 *
 * @param {Array} pool 候选角色
 * @param {object} pose 体位
 * @returns {Array} 用于抽取的池子（永远非空，除非入参本身为空）
 */
export function preferPetitePool(pool, pose) {
  const all = Array.isArray(pool) ? pool : [];
  if (!all.length) return all;
  if (pose?.limitOn !== 'female') return all;
  const tiny = all.filter(c => {
    try { return ['petite', 'short'].includes(deriveBuild(c)?.bucket); } catch { return false; }
  });
  return tiny.length ? tiny : all;
}

/**
 * ⚠ **已删除**（2026-10-22，阶段 6）：这里原来是 `buildSubjectRef(character)` ——
 * 从 `character_outfits.body` 抠出含发型的那一段、截到 64 字符，拼成
 * `the girl with long dark brown hair with pink gradient tips tied into two high`。
 *
 * 为什么删：① 只取发型，瞳色/体型/发饰全丢；② 64 字符硬截会切出 `...two high` 这种断尾；
 * ③ 它是全项目最后一条"人工拼角色外观"的老路 —— 别处早已统一到 `characterAnchor`。
 * 现在外观由 `generateMediaImage(..., { anchors })` 代码级整段注入，
 * 媒体自己只用**位置指代**（`GIRL_POSITION_REFS`）区分同框的几个人。
 * 需要外观请调 `characterAnchor.resolveAnchor`，不要在这里再造一份。
 */

/**
 * 图库条目的输出格式约束。
 *
 * ★ 本形态的**画面**由服务端决定，不由模型决定：
 *   体位（84 条池子里随机抽）· 变体（每组随机取一）· 画幅比例（随机）· 画师串（收藏夹随机）
 *   —— 这四样都是**确定性分配**，模型只负责给每条起个作品名与一句备注。
 *
 * 这样做的理由：
 *   ① 体位提示词是**逐字校准过**的（含负向标签与「不可组合」约束），交给模型转写必然漂移；
 *   ② 「随机」要真的随机 —— 模型在温度下会自我重复（同批十张都在同一个场景）；
 *   ③ 模型只写 40 字标题 + 60 字备注，token 便宜且输出稳定。
 */
/**
 * 「哈托比亚」条目的输出格式约束。
 *
 * 与 `buildGalleryFormatPrompt` 的关键差别：**这里画面不由模型定**，所以清单里
 * 只给"这一张拍的是什么"（题材 + 地点/食物名），**不给画面提示词原文**（那是英文、
 * 又长又是给我们看的），也不给角色名（保持"图站匿名"的目录感）。
 */
export function buildPhotoFormatPrompt(outlet, boards, plan) {
  const boardNames = boards.map(b => b.name);
  const boardRule = boardNames.length
    ? `"board" 必须从这个站点的分区里选：${boardNames.map(x => `「${x}」`).join('、')}`
    : `"board" 填 ""（本站点还没有分区）`;

  // ★ 只给"拍的是什么"，不给英文提示词、**也不给角色名**。
  //
  // ⚠ 自拍条曾经写「出镜：某某」把角色名交给模型 —— 模型于是照抄进作品名，
  //   产出「蓝调时刻·爻光」这类标题（用户 2026-10-06 口径：图片站禁止出现任何角色名）。
  //   现在与规则34 同一口径：**人数可以给**（那是画面构成，不是身份），**姓名一律不给**。
  const catLabel = Object.fromEntries(PHOTO_CATEGORIES.map(c => [c.key, c.label]));
  const list = plan.map((it, i) => {
    const parts = [`题材：${catLabel[it.category] || it.category}`];
    if (it.category === 'cityscape' && it.placeName) parts.push(`地点：${it.placeName}`);
    if (it.category === 'selfie') parts.push('出镜：一名少女（画面里只有她一个人）');
    if (it.tags?.length) parts.push(`关键词：${it.tags.filter(Boolean).join('/')}`);
    return `${i + 1}. ${parts.join('｜')}`;
  }).join('\n');

  return `你是图片站「${outlet.name}」的目录编辑。下面 ${plan.length} 张图**画面已经拍好了**，
你只需要为每一张写**作品名**与**一句简短描述**，不要改动画面内容。

【本批图片清单】（按顺序对应输出数组的下标）
${list}

请严格按照以下 JSON 格式输出，不要输出任何解释或 JSON 以外的文字：

{
  "posts": [
    {
      "board": "分区名（${boardRule}）",
      "title": "作品名（≤24字）",
      "content": "一句描述（20~50字）",
      "author": "上传者网名",
      "likes": 数字（点赞数）,
      "views": 数字（浏览数，通常为 likes 的 10~40 倍）
    }
  ]
}

字段要求：
- ${boardRule}。分区尽量分散，别整批都塞一个区。
- ★ **作品名**：像图片站的作品命名 —— 短、有画面感、可以带地点或时间（如「夜街雨景 03」「雨天的天台」）。
  **不要**写成小说标题或抒情诗；**不要**用「禁忌」「秘密」这类空词。
- ⛔ **绝对禁止出现任何人名 / 角色名 / 出处名**：本站条目一律匿名，你看不到、也不许猜画里的人是谁。
  **自拍条尤其注意** —— 出镜的少女只是"一个少女"，不是某某人。作品名只讲**画面**，不讲**身份**：
  写「蓝调时刻·某人的名字」是**错的**，写「蓝调时刻」才对。要指人就写「她」「少女」「女孩」。
  ⚠ 提示词里**不会出现任何角色名字**，你也**不要自己发明**一个 —— 全部用无名称呼。
  ⚠ 注意：清单里给出的**地点名**本身就是地图地名，可能自带人名（「某人的办公室」这类）——
  照抄**地点**不算违规；但**不要**因为地点名而顺带把那个人的名字写进作品名。
- ★ **描述**：像上传者随口说的一句 —— 在哪拍的、什么心情、和谁去的、求不要求点评。
  可以写地方与季节，**不要复述画面细节**（画面已定）。风格轻松、生活化。
  同样**不许出现任何人名/角色名**（同样用「她」「同行的人」这类说法）。
- ★ 这是**全年龄图片站**：描述里**不要出现性相关词汇**，也不要写心理分析长段落。
- ★ **同一批里的作品名必须互不相同**，别都用同一个句式。
- "author" 填符合该站点气质的网名（摄影师、美食博主、路人、无意义字符串都可以）。
- "likes"/"views"：likes 20~8000；views 相应放大。
- 所有文本用**中文**。
- 输出数组长度必须正好 ${plan.length}，顺序与上面的清单一一对应。`;
}

/**
 * 规整「哈托比亚」条目。**画面不再是模型给的，而是 plan 里的确定性内容**。
 *
 * 与 `normalizeGalleryDraft` 的差别：
 *   · 标签是**题材词**（城市风光/地点/美食名…），**不含 NSFW 体位词、不含画面参数**。
 *   · 标签**不受 `MAX_GALLERY_TAGS` 限制**（那是规则34 为环境层扩的额度）。
 *
 * ★ 角色名清洗（2026-10-06 用户口径变更）：
 *   本站**与规则34 同一口径 —— 禁止出现任何角色名**。
 *   早先这里刻意"不清洗"（当时的取舍是"自拍鼓励出现角色名"），但实测模型把它当挡箭牌：
 *   自拍条「出镜：爻光」→ 产出作品名「蓝调时刻·爻光」+ 上传者「爻光本人」。
 *   用户明确要求禁止，故补上出口兜底（与 gallery 同源，复用 `stripCharacterNames`）。
 *
 * ⚠ 清洗**只作用于可见文本**（title / content / tags / author_name）。
 *   `payload.photos.castIds / castNames` **保留原名** —— 那是给生图挂 LoRA 用的内部字段，
 *   前端不展示（实测 `web-ui` 未读取 `castNames`），清了反而会丢出镜身份。
 *   `payload.photos.placeName` 同理保留 —— 它是地图**地名**，可能本来就叫「真珠办公室」。
 *
 * @param {object} raw - LLM 输出（只有 title/content/author/likes/views/board）
 * @param {Array} boards
 * @param {Array} plan
 * @param {{forbiddenNames?: string[]}} [opts] - 角色名清单（不传则不做清洗，保持向后兼容）
 */
export function normalizePhotoDraft(raw, boards, plan = [], opts = {}) {
  const list = Array.isArray(raw?.posts) ? raw.posts : [];
  const boardByName = new Map(boards.map(b => [b.name, b]));
  const out = [];
  const catLabel = Object.fromEntries(PHOTO_CATEGORIES.map(c => [c.key, c.label]));
  const isAspectLike = (s) => /^\d+(?:\.\d+)?\s*[:：xX×]\s*\d+(?:\.\d+)?$/.test(String(s));

  // ★ 出口兜底：模型仍可能自己编出角色名（提示词里已经不给了）。与 gallery 同一实现。
  const forbidden = Array.isArray(opts?.forbiddenNames) ? opts.forbiddenNames : [];

  /**
   * 显示用清洗：先走 `stripCharacterNames`，再收尾"被洗名字后残留的虚词/标点"。
   *
   * 为什么需要额外一步：地图地名里含角色名时（「姬子的个人房间」），
   * 直接清洗会留下以虚词开头的残句「的个人房间」。这里把开头的
   * 「的/之/·」等一并收掉 → 「个人房间」。
   *
   * ⚠ 只在本模块用，**不动共享的 `stripCharacterNames`**（它被 gallery 与迁移复用，
   *   `的` 不在它的分隔符集合里是刻意的，改它会影响规则34 的既有行为）。
   */
  const cleanDisplay = (s, max) => {
    const v = stripCharacterNames(clampText(s, max), forbidden);
    if (!v) return '';
    return v.replace(/^[\s·•×、|/]+/, '').replace(/^[的之]\s*/, '').trim();
  };

  plan.forEach((it, i) => {
    const item = list[i] || null;
    if (!it?.prompt) return;

    // 模型没写标题也不丢条目：用**题材 + 地点/食物名**兜底（图站常见"未命名"作品）
    const fallbackTitle = it.placeName || it.tags?.[0] || catLabel[it.category] || '随手拍';
    // ⚠ 兜底标题也可能含角色名（地点名如「真珠办公室」）→ 与模型输出走同一道清洗
    const title = cleanDisplay(item?.title, 80)
      || cleanDisplay(fallbackTitle, 80)
      || '随手拍';

    const likesRaw = Number(item?.likes);
    const viewsRaw = Number(item?.views);
    const likes = Number.isFinite(likesRaw) && likesRaw >= 0 ? Math.floor(likesRaw) : randInt(20, 8000);

    // 标签：题材 + 关键词（**画面参数绝不进标签** —— 与规则34 同一口径）
    const tags = [catLabel[it.category], ...(it.tags || [])]
      .filter(Boolean).map(String)
      .filter(t => !isAspectLike(t))
      // 标签也过一遍清洗（洗空的直接丢弃，宁可少一个标签也不留一个名字）
      .map(t => cleanDisplay(t, 40))
      .filter(Boolean);
    const uniqTags = [...new Set(tags)].slice(0, 10);

    const boardName = clampText(item?.board, 16);
    const board = boardByName.get(boardName) || null;

    out.push({
      board_id: board?.id ?? null,
      title,
      content: cleanDisplay(item?.content, 300) || `${title}。`,
      tags: uniqTags,
      author_type: 'anonymous',      // 图片站上传者是第三方分享者（与角色出镜与否无关）
      character_id: null,
      author_name: cleanDisplay(item?.author, 24) || '匿名用户',
      author_avatar: null,
      likes,
      views: Number.isFinite(viewsRaw) && viewsRaw > 0 ? Math.floor(viewsRaw) : likes * randInt(10, 40),
      comments: [],
      image_prompt: it.prompt,
      payload: {
        photos: {
          category: it.category,
          categoryLabel: catLabel[it.category] || it.category,
          placeName: it.placeName || '',
          aspect: it.aspect.key,
          width: it.aspect.w,
          height: it.aspect.h,
          negative: PHOTO_NEGATIVE,
          artist: it.artist || null,
          // 自拍条出镜的角色（生图挂 LoRA 用）；其余题材为空。
          // ⚠ 保留**原名**：内部字段、前端不展示，清了会丢出镜身份。
          castIds: it.castId ? [it.castId] : [],
          castNames: it.castName ? [it.castName] : [],
        },
      },
    });
  });

  if (!out.length) throw new Error('没有可用的图片条目（每条都必须有 image_prompt）');
  return out;
}

export function buildGalleryFormatPrompt(outlet, boards, plan) {
  const boardNames = boards.map(b => b.name);
  const boardRule = boardNames.length
    ? `"board" 必须从这个站点的分区里选：${boardNames.map(x => `「${x}」`).join('、')}`
    : `"board" 填 ""（本站点还没有分区）`;

  // ★ 清单里**只给"画面是什么"，不给"里面是谁"**（用户口径：规则34 不许出现角色名）。
  //   早先这里带 `｜出镜：某某`，模型便把它照抄进作品名 → 「爻光·毒龙 01」。
  //   人数可以给（它是画面构成，不是身份），姓名一律不给。
  const list = plan.map((it, i) =>
    `${i + 1}. 体位：${it.pose.name}（${it.pose.frozen.slice(0, 60)}…）${it.girls >= 2 ? `（${it.girls} 名女性）` : ''}${it.pose.boys ? ` 与 ${it.pose.boys} 名匿名男性` : '（无男性）'}`
  ).join('\n');

  return `你是成人图片站「${outlet.name}」的目录编辑。下面 ${plan.length} 张图**画面已经定好了**，
你只需要为每一张写**作品名**与**一句作者备注**，不要改动画面内容。

【本批画面清单】（按顺序对应输出数组的下标）
${list}

请严格按照以下 JSON 格式输出，不要输出任何解释或 JSON 以外的文字：

{
  "posts": [
    {
      "board": "分区名（${boardRule}）",
      "title": "作品名（≤30字）",
      "content": "作者备注（20~50字，一句话）",
      "author": "上传者网名",
      "likes": 数字（收藏/点赞数）,
      "views": 数字（浏览数，通常为 likes 的 10~40 倍）
    }
  ]
}

字段要求：
- ${boardRule}。分区尽量分散，别整批都塞一个区。
- ★ **作品名**：像图站的作品命名 —— 「动作/体位 + 一句视角或状态」，短、直、有检索感。
  例：「后入跪位 03」「双人乳交」「颜面骑乘」「压墙站位 02」。**不要写成小说标题**，
  不要用「禁忌」「秘密」这类空词。可以带编号（01/02/03）。
- ⛔ **绝对禁止出现任何人名 / 角色名 / 出处名**：本站条目一律匿名，你看不到、也不许猜
  画里的人是谁。作品名与备注里**一个字都不许点名**（不许出现「XX·后入」「XX 压墙式」
  「XX×YY」这类写法）。要写就直接写动作与状态。
- ★ **备注**：作者口吻的一句话，随口说点什么 —— 画了多久、为什么画这个、求不要求续作、
  对画面的自嘲。**不要描述画面本身**（画面已定，你在重复劳动），更不要写小说段落，
  同样不许出现任何人名/角色名。
- ★ **同一批里的作品名必须互不相同**，别都用同一个句式。
- "author" 填符合该站点气质的网名（可以是绘师名、收藏者马甲、无意义字符串）。
- "likes"/"views"：likes 20~6000；views 相应放大。
- 所有文本用**中文**。
- 输出数组长度必须正好 ${plan.length}，顺序与上面的清单一一对应。`;
}

/**
 * 规整图库条目。**画面不再是模型给的，而是 plan 里的确定性内容**。
 * @param {object} raw - LLM 输出（只有 title/content/author/likes/views/board）
 * @param {Array} boards
 * @param {Array<{pose, artist, aspect, imagePrompt, negative, girls, girlNames}>} plan
 */
export function normalizeGalleryDraft(raw, boards, plan = [], opts = {}) {
  const list = Array.isArray(raw?.posts) ? raw.posts : [];
  const boardByName = new Map(boards.map(b => [b.name, b]));
  const out = [];
  // ★ 出口兜底：模型仍可能自己编出角色名（提示词里已经不给了）。
  //   凡是进标题/正文/署名的文本都过一遍清洗（`stripCharacterNames`）。
  const forbidden = Array.isArray(opts?.forbiddenNames) ? opts.forbiddenNames : [];

  plan.forEach((it, i) => {
    const item = list[i] || null;   // 按**下标**对齐，不靠模型自己排序
    if (!it?.imagePrompt) return;

    // 模型没写标题也不丢条目：用**体位名**兜底（图站常见「未命名」作品）。
    // ⚠ 早先兜底是 `${角色名}·${体位名}` —— 那是角色名的另一个泄漏口，已去掉。
    const title = stripCharacterNames(clampText(item?.title, 80), forbidden)
      || it.pose.name;

    const likesRaw = Number(item?.likes);
    const viewsRaw = Number(item?.views);
    const likes = Number.isFinite(likesRaw) && likesRaw >= 0 ? Math.floor(likesRaw) : randInt(20, 6000);

    // ── 标签：以 NSFW 体位为主（用户口径：标签要重点在 NSFW 上）──
    // 中文体位名 + 出镜人数 + 体位的核心英文 NSFW 标签（去重、限量）
    //
    // ★ 画面元信息（画幅比例等）**不进标签**（用户口径）。标签是**检索维度**，
    //   比例只是这条的生成参数、不是题材；混进来会污染标签云与筛选。
    //   比例另有正路：存 `payload.gallery.aspect/width/height`，前端贴在图片上展示。
    //   这里加一道拦截，防止源文件/模型日后往 core 里写了 `1:1`、`4:3` 这类值。
    const isAspectLike = (s) => /^\d+(?:\.\d+)?\s*[:：xX×]\s*\d+(?:\.\d+)?$/.test(s);

    /*
     * 标签组成（顺序 = 优先级，超出上限时从**尾部**截断）：
     *   ① 体位中文名（检索主键，永远第一）
     *   ② 人数（2女 / 3男 / 单人）
     *   ③ 环境层 —— 场景/光影/视角/焦点/摄影效果/表情/状态/道具（**英文**，用户口径）
     *   ④ 体位 core 的英文 NSFW 词（补足）
     *
     * ★ 上限为什么从 6 提到 12：6 是"只有体位"时代的值。环境层一上来就占 7~8 个，
     *   还按 6 截会把 ③④ 整段砍掉 —— 那就等于白扩了。卡片上本来就只显示前 3 个
     *   （`MediaGallery.vue` 的 `.slice(0, 3)`），多出来的用于左栏标签云与筛选。
     */
    const tags = [it.pose.name];
    if (it.girls >= 2) tags.push(`${it.girls}女`);
    if (it.pose.solo) tags.push('单人');
    else if (it.pose.boys >= 2) tags.push(`${it.pose.boys}男`);

    for (const e of (it.env || [])) {
      if (e?.en && !tags.includes(e.en)) tags.push(e.en);
    }

    for (const t of (it.pose.core || [])) {
      const clean = String(t).replace(/（[^）]*）/g, '').trim();
      if (!clean) continue;
      if (/^\d*girls?$|^\d*boys?$/.test(clean)) continue;   // 人数已单列
      if (isAspectLike(clean)) continue;                     // ★ 比例尺绝不作为标签
      if (tags.includes(clean)) continue;
      tags.push(clean);
      if (tags.length >= MAX_GALLERY_TAGS) break;
    }

    const boardName = clampText(item?.board, 16);
    const board = boardByName.get(boardName) || null;

    // ★ 标签也过一遍清洗（体位名/核心词理论上不含角色名，这里只做防御；
    //   洗空的项直接丢弃，宁可少一个标签也不留一个名字）
    const safeTags = tags.map(t => stripCharacterNames(t, forbidden)).filter(Boolean);

    out.push({
      board_id: board?.id ?? null,
      title,
      content: stripCharacterNames(clampText(item?.content, 300), forbidden) || `${it.pose.name}。`,
      tags: safeTags.slice(0, MAX_GALLERY_TAGS),
      author_type: 'anonymous',      // 图站上传者不是角色本人（角色是被画的对象）
      character_id: null,
      author_name: stripCharacterNames(clampText(item?.author, 24), forbidden) || '匿名用户',
      author_avatar: null,
      likes,
      views: Number.isFinite(viewsRaw) && viewsRaw > 0 ? Math.floor(viewsRaw) : likes * randInt(10, 40),
      comments: [],
      image_prompt: it.imagePrompt,
      payload: {
        gallery: {
          artist: it.artist || null,
          aspect: it.aspect.key,
          width: it.aspect.w,
          height: it.aspect.h,
          negative: it.negative || '',
          pose: it.pose.name,
          poseNo: it.pose.no,
          frame: it.frame,
          // 环境层（场景/光影/视角/焦点/摄影效果/表情/状态/道具）——
          // 前端左栏**按维度分组**要用它，光看扁平的 tags 反推不出维度（会被体位名挤掉）。
          env: (it.env || []).map(e => ({ dim: e.dim, en: e.en, cn: e.cn })),
          // 出镜角色（生图挂 LoRA 用）；作者仍是匿名上传者
          castIds: it.castIds || [],
          castNames: it.girlNames || [],
        },
      },
    });
  });

  if (!out.length) throw new Error('没有可用的图库条目（每条都必须有 image_prompt）');
  return out;
}

/**
 * ══════════════════════════════════════════════════════════════
 *  哈托比亚（`photos` 形态）—— **SFW 图片站**
 * ══════════════════════════════════════════════════════════════
 *
 * 与 `gallery`（规则34）**同一套架构、不同的题材池**：
 *   服务端 → 抽题材 · 决定画面 · 抽画幅 · 抽画师串
 *   模型   → 只写作品名 / 一句备注 / 上传者 / 热度
 *
 * 画面之所以不让模型写，是规则34 验证过的理由（换到 SFW 站同样成立）：
 *   ① 「随机」要真随机 —— 模型在温度下会自我重复（同批十张同一个场景）；
 *   ② 画面提示词是逐字校准过的（含 no people / 视角 / 画幅），交给模型转写必然漂移；
 *   ③ 出口可控 —— **SFW 站绝不能因为模型一时兴起就画出奇怪的东西**，
 *      题材池里没有 NSFW 词，画面就不可能跑偏（这是"不使用 NSFW 内容"的技术保证）。
 *
 * ★ 城市风光的画面主体来自**世界地图** `world_map_places.scene_prompt`
 *   （全库 101/101 已补齐），不是本文件里的泛泛街景 —— 见 `photoScenes.js` 文件头。
 */

/** 从数组里不重复地抽 n 个（池子不够则放回续抽）；返回浅拷贝数组 */
function pickUnique(pool, n) {
  const bag = [...pool];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!bag.length) bag.push(...pool);
    out.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
  }
  return out;
}

/**
 * 取地图上可用的场景（城市风光的画面源）。
 * 只取 **lv3 场景**（最具体、画面描述最细），且 `scene_prompt` 非空。
 * 读不到就返回 []（调用方会退化到"通用城市风光"包裹语，绝不因此不出图）。
 */
function listMapScenePrompts() {
  try {
    return getDb().prepare(`
      SELECT p.name AS name, p.scene_prompt AS scene_prompt
      FROM world_map_places p
      WHERE p.level = 3 AND p.scene_prompt IS NOT NULL AND TRIM(p.scene_prompt) != ''
    `).all().map(r => ({ name: String(r.name || '').trim(), prompt: String(r.scene_prompt || '').trim() }))
      .filter(r => r.name && r.prompt);
  } catch { return []; }
}

/**
 * 城市风光取景：`{SCENE}` 用地图场景填充。
 * 若地图无数据 → 退化为通用都市语，保证仍能出图（红线：绝不空手）。
 */
function buildCityscapeItem(frame, atmosphere, mapScenes) {
  const picked = mapScenes.length ? mapScenes[Math.floor(Math.random() * mapScenes.length)] : null;
  const sceneText = picked
    ? picked.prompt
    : 'a dense modern city at street level, glass towers, overhead signage, ambient glow';
  const prompt = `${frame.en.replace('{SCENE}', sceneText)}, ${atmosphere.en}, ${PHOTO_QUALITY_SUFFIX}`;
  return {
    category: 'cityscape',
    placeName: picked?.name || '',
    sceneText,
    prompt,
    tags: [picked?.name, frame.cn, atmosphere.cn].filter(Boolean),
  };
}

/**
 * 美少女自拍：`{subject}` 用中性指代填充。
 *
 * ★ 2026-10-22（阶段 6）：原来这里填 `buildSubjectRef(cast)` —— 从 `character_outfits.body`
 *   抠发型那一段、截到 64 字符，拼成 `the girl with long dark brown hair with pink gradient…`。
 *   那条路有两个硬伤：① 只取发型，瞳色/体型/发饰全丢；② 64 字符硬截，
 *   实测会切出 `...two high` 这种断尾。
 *   现在外观全部交给 `anchors`（`generateMediaImage` 注入，代码级、整段），
 *   这里只留中性指代，不再自带一份"残缺外观"。
 */
function buildSelfieItem(view, atmosphere, cast) {
  const ref = 'the girl';
  const prompt = `${view.en.replace('{subject}', ref)}, ${atmosphere.en}, ${PHOTO_QUALITY_SUFFIX}`;
  return {
    category: 'selfie',
    castId: cast?.id || null,
    castName: cast?.display_name || '',
    prompt,
    tags: [view.cn, atmosphere.cn, '自拍'].filter(Boolean),
  };
}

/** 美食打卡 */
function buildFoodItem(food, atmosphere) {
  return {
    category: 'food',
    prompt: `${food.en}, ${atmosphere.en}, ${PHOTO_QUALITY_SUFFIX}`,
    tags: [food.cn, atmosphere.cn, '美食'].filter(Boolean),
  };
}

/** 宣传海报（画面只留版位，文字由前端叠 —— 生图模型写字不可靠） */
function buildPosterItem(topic) {
  return {
    category: 'poster',
    prompt: `${topic.en}, ${PHOTO_QUALITY_SUFFIX}`,
    tags: [topic.cn, '海报', '宣传'].filter(Boolean),
  };
}

/** 按分类抽画幅（各题材的画幅倾向不同，见 photoScenes.PHOTO_ASPECTS） */
function pickPhotoAspect(category) {
  const pool = PHOTO_ASPECTS[category] || PHOTO_ASPECTS.cityscape;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 照片题材计划：生成 n 个题材（cityscape / selfie / food / poster），四类各约 1/4。
 *
 * 配比规则：城市风光权重最高（slot 0/1），自拍占 slot 2（不允许角色出镜时让给风光），
 * slot 3 在美食 / 海报间分配。生成后做一次**轻微打散**（见函数内注释），
 * 避免「前 n/4 全是风光」的机械感。**导出供测试**钉住配比与打散口径。
 */
export function buildPhotoCategoryPlan(n, allowSelfie) {
  const planIdx = [];
  for (let i = 0; i < n; i++) {
    const slot = i % 4;
    if (slot === 0 || slot === 1) planIdx.push('cityscape');       // 城市风光权重最高（题材最具特色）
    else if (slot === 2) planIdx.push(allowSelfie ? 'selfie' : 'cityscape');
    else planIdx.push(i % 8 === 3 ? 'food' : 'poster');
  }

  // 轻微打散：避免「前 n/4 全是风光」的机械感（2026-10-13 兑现原注释承诺——
  // 此前只算了 per 没使用，`void per` 消警告，打散实际从未发生）。
  // 仅当首段（per 个）清一色 cityscape 时，把段尾一个与**段后首个非风光题材**对调：
  // 只动 0~2 个位置、不引入随机（同一输入结果确定）、不改变四类配比。
  const per = Math.max(1, Math.round(n / 4));
  if (planIdx.slice(0, per).every(c => c === 'cityscape')) {
    const swapIn = planIdx.findIndex((c, i) => i >= per && c !== 'cityscape');
    if (swapIn !== -1) {
      const tail = per - 1;
      [planIdx[tail], planIdx[swapIn]] = [planIdx[swapIn], planIdx[tail]];
    }
  }
  return planIdx;
}

/**
 * 生成「哈托比亚」的一批条目。
 *
 * @param {object} outlet
 * @param {number} count
 * @param {boolean} withCharacters 是否允许角色出镜（自拍题材需要）
 */
async function generatePhotoBatch(outlet, count, withCharacters) {
  const n = Math.max(1, Math.min(MAX_BATCH_SIZE, count));
  const boards = listBoards(outlet.id);

  // ★ 题材配比：城市风光 + 自拍各约 1/4，美食 + 海报各约 1/4（保证四类都出现）。
  //   自拍需要角色；若不允许角色出镜，把自拍份额让给城市风光。
  const allowSelfie = withCharacters === true;
  const planIdx = buildPhotoCategoryPlan(n, allowSelfie);

  const mapScenes = listMapScenePrompts();
  // ★ 2026-10-18：先抽世界，再按**这些世界**的居民抽出镜角色（自拍出镜也是"媒体覆盖的地盘"）
  const sampled = sampleWorldSettings();
  const castPool = allowSelfie ? pickActiveCharacters(8, { worldIds: sampled.ids }) : [];
  const selfieCast = pickUnique(castPool, planIdx.filter(x => x === 'selfie').length);

  const frames = pickUnique(CITYSCAPE_FRAMES, planIdx.filter(x => x === 'cityscape').length);
  const atmos = pickUnique(PHOTO_ATMOSPHERE, n);
  const views = pickUnique(SELFIE_VIEWS, planIdx.filter(x => x === 'selfie').length);
  const foods = pickUnique(FOOD_ITEMS, planIdx.filter(x => x === 'food').length);
  const topics = pickUnique(POSTER_TOPICS, planIdx.filter(x => x === 'poster').length);
  const artists = pickRandomArtists(n);

  let ci = 0, si = 0, fi = 0, pi = 0;
  const plan = planIdx.map((cat, i) => {
    let item;
    if (cat === 'cityscape') item = buildCityscapeItem(frames[ci++], atmos[i], mapScenes);
    else if (cat === 'selfie') item = buildSelfieItem(views[si++], atmos[i], selfieCast[si - 1]);
    else if (cat === 'food') item = buildFoodItem(foods[fi++], atmos[i]);
    else item = buildPosterItem(topics[pi++]);
    const aspect = pickPhotoAspect(cat);
    return { ...item, aspect, artist: artists[i] || null, frame: null };
  });

  const msgs = [
    { role: 'system', content: [getSystemRules({ roleplay: false }), sampled.text].filter(Boolean).join('\n\n') },
    { role: 'system', content: outlet.prompt },
    { role: 'system', content: buildPhotoFormatPrompt(outlet, boards, plan) },
    {
      role: 'user',
      content: `请为上述 ${plan.length} 张图各写一个作品名与一句备注。${outlet.tagline ? `站点定位：${outlet.tagline}` : ''}`,
    },
  ];

  const raw = await chatSync(msgs, {
    temperature: 1.0,
    response_format: { type: 'json_object' },
    label: `media-photos:${outlet.name}`,
  });
  const jsonStr = extractFirstJson(raw);
  if (!jsonStr) throw new Error('LLM 未返回 JSON');
  // ★ 角色名清单用于出口兜底清洗（与规则34 同口径：图片站禁止出现任何角色名）
  const forbiddenNames = listCharacterDisplayNames();
  const drafts = normalizePhotoDraft(JSON.parse(repairJson(jsonStr)), boards, plan, { forbiddenNames });
  return insertDrafts(outlet, drafts, n);
}

/**
 * 生成一批图库条目。
 *
 * 分工（这是本形态的关键设计）：
 *   服务端 → 抽体位（不重复优先）· 抽角色（按体位需要的人数）· 选变体 · 抽画幅比例 · 抽画师串
 *   模型   → 只写作品名 / 备注 / 上传者 / 热度
 * 因此「画面」与「画风」都是**确定性随机**，不依赖模型自觉。
 */
async function generateGalleryBatch(outlet, count, withCharacters) {
  const n = Math.max(1, Math.min(MAX_BATCH_SIZE, count));
  const boards = listBoards(outlet.id);

  // 能出镜的角色池（排除归档）—— 图库里角色是"被画的对象"
  // ★ 2026-10-18：先抽世界，再按这些世界的居民抽出镜角色
  const sampled = sampleWorldSettings();
  const castPool = withCharacters ? pickActiveCharacters(8, { worldIds: sampled.ids }) : [];
  // 规则34 不许出现角色名：出口层按**全库名字**清洗作品名/备注/署名
  const forbiddenNames = listCharacterDisplayNames();
  const poses = pickRandomPoses(n);
  const artists = pickRandomArtists(n);
  const aspects = pickRandomAspects(n);

  const plan = poses.map((pose, i) => {
    // 该体位要几名女方（2 女体位需要两个不同角色）
    const need = girlsNeeded(pose);
    const picked = [];
    // 「女方须娇小」的体位（048/049/080）：优先从娇小档里挑（无则退回全池，不空手）
    const bag = [...preferPetitePool(castPool, pose)];
    for (let k = 0; k < need && bag.length; k++) {
      picked.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
    }
    // ★ 画面指代用**位置词**（不能塞中文角色名 —— 提示词是纯英文的）。
    //   2026-10-22（阶段 6）：原来用 `buildSubjectRef` 抠发型当指代，为的是区分同框的两名女方；
    //   现在区分改由**锚点的位置词**承担（`buildAnchorLines` 给第二个角色加
    //   `the girl on the left/right`），这里的指代只要与锚点同一套词即可 ——
    //   指代负责"说的是哪位"，锚点负责"她长什么样"，两件事不再混在一个 64 字符的串里。
    const refs = picked.map((_, i) => GIRL_POSITION_REFS[i] || `the girl ${i + 1}`);
    const subject = refs[0] || 'the girl';

    // 横躺类体位更可能配横幅：若抽到的比例方向与体位不合，就换一个同池的
    const isLying = LYING_RE.test(pose.name) || LYING_RE.test(pose.frozen);
    const wantWide = isLying;
    const gotWide = aspects[i].w > aspects[i].h;
    if (wantWide !== gotWide) {
      const alt = resolveGalleryAspects().filter(a => (a.w > a.h) === wantWide);
      if (alt.length) aspects[i] = alt[Math.floor(Math.random() * alt.length)];
    }

    // 环境层：场景/光影/视角/焦点/摄影效果/表情/状态/道具 —— 7 维各抽 1，带耦合约束。
    // ★ 同一条 `env` 同时喂给提示词（`sentence`）与标签（`tags`），
    //   所以"卡片上写的标签"与"画出来的画面"**同源**，不会漂移。
    const envelope = pickGalleryEnvelope(pose);

    const built = buildPoseImagePrompt(pose, { subject, girlRefs: refs, envelope });
    return {
      pose, artist: artists[i], aspect: aspects[i],
      imagePrompt: built.prompt, negative: built.negative, frame: built.frame,
      env: envelope.picks,
      girls: need,
      // 出镜角色的 id：**生图时要挂她们的 LoRA**，否则画面里的人根本不像那个角色。
      // 注意这不等于「作者」—— 本站条目的上传者仍是匿名网名（author_type 保持 anonymous）。
      castIds: picked.map(c => c.id),
      // 给模型看的是**角色名**（它要写中文作品名），进提示词的是**英文外观指代**
      girlNames: picked.map(c => c.display_name),
    };
  });

  const msgs = [
    { role: 'system', content: [getSystemRules({ roleplay: false }), sampled.text].filter(Boolean).join('\n\n') },
    { role: 'system', content: outlet.prompt },
    { role: 'system', content: buildGalleryFormatPrompt(outlet, boards, plan) },
    {
      role: 'user',
      content: `请为上述 ${plan.length} 张图各写一个作品名与一句备注。${outlet.tagline ? `站点定位：${outlet.tagline}` : ''}`,
    },
  ];

  const raw = await chatSync(msgs, {
    temperature: 1.0,
    response_format: { type: 'json_object' },
    label: `media-gallery:${outlet.name}`,
  });
  const jsonStr = extractFirstJson(raw);
  if (!jsonStr) throw new Error('LLM 未返回 JSON');
  const drafts = normalizeGalleryDraft(JSON.parse(repairJson(jsonStr)), boards, plan, { forbiddenNames });
  return insertDrafts(outlet, drafts, n);
}

/**
 * 把已规整的草稿落库（三个批量形态共用）。
 * @returns {Promise<{outletId:number, outletName:string, batchId:string, inserted:number}>}
 */
function insertDrafts(outlet, drafts, requested) {
  const db = getDb();
  const batchId = `mb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // ⚠ published_seq 必须**显式写 NULL**（待发布）。
  //   本列由 db/index.js 的 ALTER 加上，默认值是 0 —— 0 是「升级前已展示的旧帖」标记，
  //   不是「待发布」。漏写这一列会让新帖吃默认值 0，publishMediaPostIfReady 便把它当成
  //   「已发布」直接返回：不广播 media_new_posts、不写正式序号、不置 image_status='done'
  //   → 前端收不到 SSE 就「像没生成」。这是 2026-10-17 排查的 BUG-01 根因
  //   （本文件另 4 条 INSERT 都写了 NULL，只有这条批量形态漏了）。
  const ins = db.prepare(`
    INSERT INTO media_posts (outlet_id, board_id, batch_id, title, content, tags_json,
      author_type, character_id, author_name, author_avatar, likes, views, comments_json,
      image_prompt, payload_json, image_status, published_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const d of drafts) {
      ins.run(
        outlet.id, d.board_id, batchId, d.title, d.content, JSON.stringify(d.tags),
        d.author_type, d.character_id, d.author_name, d.author_avatar, d.likes, d.views,
        JSON.stringify(d.comments),
        d.image_prompt || null,
        d.payload ? JSON.stringify(d.payload) : null,
        // 图库必须有图 → 直接进 pending 排队；其余形态无图时不排队（避免白跑一趟生图）
        d.image_prompt ? 'pending' : 'none',
      );
      inserted++;
    }
  });
  tx();
  console.log(`[media] 「${outlet.name}」新增 ${inserted} 条（形态 ${outlet.layout}，请求 ${requested}）`);
  broadcast('media_new_posts', { outletId: outlet.id, count: inserted });
  // 只为刚生成的这一批补图（不 await：文字先上屏、图随后到）
  fillPendingImages(inserted).catch(err => console.error('[media] 本批补图失败:', err.message));
  return { outletId: outlet.id, outletName: outlet.name, batchId, inserted };
}

// ══════════════════════════════════════════
// 周刊形态（狸狸通讯社）
// ══════════════════════════════════════════

/** 周刊的输出格式约束（结构对齐游戏内《狸狸周刊》的实际版式） */
function buildWeeklyFormatPrompt() {
  const imageRules = String(getGlobalRule('image_prompt')?.rule_content || '').trim();
  return `请严格按照以下 JSON 格式输出这一期周刊，不要输出任何解释或 JSON 以外的文字：

{
  "volume": 数字（本期卷号，比上一期大 1；我会告诉你上一期是几卷）,
  "kind": "刊别（特急刊 / 增刊 / 号外 / 常规刊 三选一）",
  "headline": "大标题（把最劲爆的事写进去，≤40字）",
  "intro": "引言（一句话勾人，≤60字）",
  "preface": ["开场白第1段", "开场白第2段", "开场白第3段（可选）"],
  "columns": [
    {
      "name": "栏目名（**自己现想**，不许沿用往期用过的）",
      "items": [
        {
          "asker": "提问人的网名（不带@）",
          "q": "提问内容（口语、带情绪、接地气）",
          "answers": [
            { "speaker": "说话的角色名", "text": "这一句的内容（可以互相吐槽、接梗、歪楼）" }
          ]
        }
      ]
    }
  ],
  "tail": [
    {
      "kind": "rank",
      "title": "榜单标题（自己拟，贴合本期内容）",
      "notice": "榜单前的声明（可空字符串）",
      "rows": [
        { "rank": "第一名", "mask": "面具名", "change": "▲0 / NEW / ▼1 / ▼2", "bearer": "持有者" }
      ]
    },
    {
      "kind": "threads",
      "title": "跟帖区标题",
      "stat": "🤍 数字 💬 数字",
      "replies": [ { "author": "网名", "text": "跟帖内容" } ]
    }
  ],
  "credits": { "interview": "采访者名", "editor": "编辑名" },
  "image_prompt": "英文插画描述（本期头版大图）"
}

字段要求：
- "preface"：2~3 段，交代本期背景。**不要固定的开场白与收尾口号** —— 每期口气可以不一样。
- "columns"：**2~4 个栏目**，每个栏目 **3~5 组问答**，栏目主题彼此必须明显不同。
  ★ 栏目名**每期必须重新想**，不许沿用往期用过的名字或句式。
  每个 Q 的 "answers" 要有 **2~5 个嘉宾分段作答**，这是本刊的笑点所在（互相吐槽、接梗、歪楼、突然@别人）。
- "tail"：**可选**，不要每期都硬塞。需要时才从 rank / threads 里挑 **1~2 个**输出。
  rank 要 5~8 行，change 用 ▲▼NEW 表示名次变化，可以出现「？？」表示未公开。
  threads 的 "replies" 要 5~10 条，有队形刷屏、有人破坏队形、有官方号插入温馨提示、有歪楼。
- ★ **不得形成固定栏目与固定版式**：连续两期出现同一个小标题（哪怕换个说法）就算失败。
- "credits"：记者名/编辑名都要带「狸」字的刊物风格。
- 所有文字字段用中文；image_prompt 用英文。
- 内容必须符合 <world_setting>。

${buildAliasRuleBlock()}${imageRules ? `\n\n生图规则（image_prompt 必须遵守）：\n${imageRules}` : ''}`;
}

/**
 * 生成一期周刊（落库为 1 条 media_post，结构化数据存 payload_json）。
 * @param {object} outlet
 */
async function generateWeeklyIssue(outlet, manual = false) {
  const db = getDb();
  const worldSetting = getWorldSettingSample();

  // 上一期的卷号（本期 = 上期 + 1；首次出刊从 Vol.1 起）
  const prev = db.prepare(`
    SELECT payload_json FROM media_posts
    WHERE outlet_id = ? AND payload_json IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(outlet.id);
  const prevVolume = Number(safeParse(prev?.payload_json, null)?.volume) || 0;

  const msgs = [
    { role: 'system', content: [getSystemRules({ roleplay: false }), worldSetting].filter(Boolean).join('\n\n') },
    { role: 'system', content: outlet.prompt },
    { role: 'system', content: buildWeeklyFormatPrompt() },
    { role: 'user', content: `请出《狸狸周刊》新的一期。上一期是 Vol.${prevVolume || '（尚无，本期为 Vol.1）'}，本期卷号用 ${prevVolume + 1}。\n\n必须是全新一期，不得重复往期的头条与栏目内容。` },
  ];

  const raw = await chatWithPreset(msgs, {
    temperature: 0.9,
    response_format: { type: 'json_object' }, label: `media:${outlet.name}`,
  });
  const jsonStr = extractFirstJson(raw);
  if (!jsonStr) throw new Error('LLM 未返回 JSON');
  const draft = JSON.parse(repairJson(jsonStr));
  const p = normalizeWeeklyDraft(draft, prevVolume);

  // content 存一份纯文本（便于搜索与列表摘要），结构存 payload
  const plain = [
    `Vol.${p.volume}【${p.kind}】${p.headline}`,
    p.intro,
    ...p.preface,
    ...p.columns.flatMap(c => [c.name, ...c.items.flatMap(it => [`Q：${it.q}`, ...it.answers.map(a => `${a.speaker}：${a.text}`)])]),
  ].filter(Boolean).join('\n').slice(0, 4000);

  const batchId = `mw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const r = db.prepare(`
    INSERT INTO media_posts (outlet_id, board_id, batch_id, title, content, tags_json,
      author_type, author_name, likes, views, comments_json, image_prompt, payload_json, image_status, published_seq)
    VALUES (?, NULL, ?, ?, ?, ?, 'anonymous', ?, ?, ?, ?, ?, ?, 'pending', NULL)
  `).run(
    outlet.id, batchId,
    `Vol.${p.volume}【${p.kind}】${p.headline}`,
    plain,
    JSON.stringify([p.kind, '狸狸周刊']),
    `狸狸周刊编辑部`,
    p.views, p.views * randInt(8, 20), JSON.stringify([]),
    p.image_prompt, JSON.stringify(p),
  );
  console.log(`[media] 《狸狸周刊》Vol.${p.volume}【${p.kind}】出版（${p.columns.length} 栏目）`);
  publishMediaPostIfReady(Number(r.lastInsertRowid));
  fillBatchImages(1, [Number(r.lastInsertRowid)], manual).catch(err => console.error('[media] 本期刊头补图失败:', err.message));
  return { outletId: outlet.id, outletName: outlet.name, batchId, inserted: 1, postId: Number(r.lastInsertRowid) };
}

/**
 * 规整周刊草稿（纯函数，便于测试）。
 * @param {object} raw - LLM 输出
 * @param {number} prevVolume - 上一期卷号（用于兜底）
 */
export function normalizeWeeklyDraft(raw, prevVolume = 0) {
  if (!raw || typeof raw !== 'object') throw new Error('周刊草稿不是对象');

  const preface = (Array.isArray(raw.preface) ? raw.preface : [])
    .map(x => clampText(x, 800)).filter(Boolean).slice(0, 4);

  const columns = (Array.isArray(raw.columns) ? raw.columns : [])
    .map(c => ({
      name: clampText(c?.name, 60),
      items: (Array.isArray(c?.items) ? c.items : []).map(it => ({
        asker: clampText(it?.asker, 24),
        q: clampText(it?.q, 400),
        answers: (Array.isArray(it?.answers) ? it.answers : [])
          .map(a => ({ speaker: clampText(a?.speaker, 24) || '记者', text: clampText(a?.text, 500) }))
          .filter(a => a.text).slice(0, 8),
      })).filter(it => it.q && it.answers.length).slice(0, 6),
    }))
    .filter(c => c.name && c.items.length).slice(0, 5);
  if (!columns.length) throw new Error('周刊没有有效栏目');

  const tail = (Array.isArray(raw.tail) ? raw.tail : []).map(t => {
    const kind = t?.kind === 'rank' ? 'rank' : (t?.kind === 'threads' ? 'threads' : null);
    if (!kind) return null;
    if (kind === 'rank') {
      const rows = (Array.isArray(t.rows) ? t.rows : []).map(x => ({
        rank: clampText(x?.rank, 12), mask: clampText(x?.mask, 24),
        change: clampText(x?.change, 8), bearer: clampText(x?.bearer, 24),
      })).filter(x => x.rank || x.mask).slice(0, 10);
      if (!rows.length) return null;
      return { kind, title: clampText(t.title, 40) || '榜单', notice: clampText(t.notice, 200), rows };
    }
    const replies = (Array.isArray(t.replies) ? t.replies : []).map(x => ({
      author: clampText(x?.author, 30) || '网友', text: clampText(x?.text, 300),
    })).filter(x => x.text).slice(0, 14);
    if (!replies.length) return null;
    return { kind, title: clampText(t.title, 40) || '跟帖', stat: clampText(t.stat, 30), replies };
  }).filter(Boolean).slice(0, 3);

  const headline = clampText(raw.headline, 120);
  if (!headline) throw new Error('周刊缺少大标题');

  const volumeRaw = Number(raw.volume);
  const volume = Number.isFinite(volumeRaw) && volumeRaw > 0 ? Math.floor(volumeRaw) : (prevVolume + 1);

  return {
    volume,
    kind: clampText(raw.kind, 10) || '常规刊',
    headline,
    intro: clampText(raw.intro, 300),
    preface,
    columns,
    tail,
    credits: {
      interview: clampText(raw.credits?.interview, 24),
      editor: clampText(raw.credits?.editor, 24),
    },
    image_prompt: clampText(raw.image_prompt, 1200),
    views: randInt(8000, 60000),
  };
}

// ══════════════════════════════════════════
// 海报形态（狸狸八卦）
// ══════════════════════════════════════════

/** 海报的输出格式约束（结构对齐游戏内《狸狸八卦》的海报版式） */
function buildPosterFormatPrompt() {
  const imageRules = String(getGlobalRule('image_prompt')?.rule_content || '').trim();
  return `请严格按照以下 JSON 格式输出这一张海报，不要输出任何解释或 JSON 以外的文字：

{
  "issueNo": 数字（本期编号，接上一期 +1）,
  "hotline": "热点速报条（一行，把本期最大爆点喊出来）",
  "bigTitle": "大标题（4~6字，押韵或玩梗，是刊物的固定栏名风格）",
  "bubbles": ["爆点气泡1（4~8字，如「小鸟胃？大胃袋！」）", "爆点气泡2", "爆点气泡3（可选）"],
  "caption": ["旁白第1行", "旁白第2行", "旁白第3行"],
  "panels": [
    { "label": "小图标签（如「开拓者砂金抢拍杀红眼」）", "image_prompt": "英文：这张小图的画面描述" }
  ],
  "credits": { "reporter": "记者名", "editor": "编辑名" },
  "image_prompt": "英文：主图（本期主角被拍到的那个瞬间）"
}

字段要求：
- "hotline"：一行，感叹号拉满，把最大的瓜喊出来。
- "bigTitle"：4~6 字，要够夸张够梗（这是刊物固定栏名，每期风格一致）。
- "bubbles"：**2~3 个**，每个 4~8 字，是整张海报最抢眼的部分（会做成爆炸贴纸效果）。
- "caption"：**3~5 行**，每行一句、短促有力，交代事件来龙去脉（谁被拍到、在哪、发生了什么、什么反应）。
- "panels"：**2~3 个**小图，每个配一行图注式标签。
- "credits"：记者名要带「狸」字。
- 所有文字字段用中文；image_prompt 用英文。
- 内容必须符合 <world_setting>，但要用**化名或外号**称呼当事人（保持小报那种「不点名但大家都知道是谁」的调调）。
- 严禁重复往期的瓜；每期必须是新瓜。${imageRules ? `\n\n生图规则（image_prompt 必须遵守）：\n${imageRules}` : ''}`;
}

/** 生成一张海报（落库为 1 条 media_post；主图走 image，小图存在 payload 里） */
async function generatePosterIssue(outlet, manual = false) {
  const db = getDb();
  const worldSetting = getWorldSettingSample();

  // 上一期的编号
  const prev = db.prepare(`
    SELECT payload_json FROM media_posts
    WHERE outlet_id = ? AND payload_json IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(outlet.id);
  const prevNo = Number(safeParse(prev?.payload_json, null)?.issueNo) || 0;

  // ★ 2026-10-07：原先这里把刊名**写死**成《狸狸八卦》（下面 tags/author_name/日志同）。
  //   poster 是通用形态（`outlet.layout === 'poster'` 的任何刊都走这条分支），写死刊名
  //   等于对着别的刊喊「请出《狸狸八卦》」。既然默认那本已被用户删除，更没理由留死名，
  //   一律改用 `outlet.name`。
  const msgs = [
    { role: 'system', content: [getSystemRules({ roleplay: false }), worldSetting].filter(Boolean).join('\n\n') },
    { role: 'system', content: outlet.prompt },
    { role: 'system', content: buildPosterFormatPrompt() },
    { role: 'user', content: `请出《${outlet.name}》新的一期海报。上一期编号是 ${prevNo || '（尚无，本期为 01）'}，本期编号用 ${prevNo + 1}。\n\n必须是全新的瓜，不得重复往期。` },
  ];

  const raw = await chatWithPreset(msgs, {
    temperature: 0.95,
    response_format: { type: 'json_object' }, label: `media:${outlet.name}`,
  });
  const jsonStr = extractFirstJson(raw);
  if (!jsonStr) throw new Error('LLM 未返回 JSON');
  const p = normalizePosterDraft(JSON.parse(repairJson(jsonStr)), prevNo);

  const batchId = `mp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const r = db.prepare(`
    INSERT INTO media_posts (outlet_id, board_id, batch_id, title, content, tags_json,
      author_type, author_name, likes, views, comments_json, image_prompt, payload_json, image_status, published_seq)
    VALUES (?, NULL, ?, ?, ?, ?, 'anonymous', ?, ?, ?, ?, ?, ?, 'pending', NULL)
  `).run(
    outlet.id, batchId,
    `【${String(p.issueNo).padStart(2, '0')}】${p.bubbles[0] || p.bigTitle}`,
    [p.hotline, ...p.caption].filter(Boolean).join('\n').slice(0, 2000),
    JSON.stringify([outlet.name, '海报']),
    `${outlet.name}编辑部`,
    p.views, p.views * randInt(8, 20), JSON.stringify([]),
    p.image_prompt, JSON.stringify(p),
  );
  console.log(`[media] 《${outlet.name}》第 ${p.issueNo} 期海报发布（${p.bubbles.length} 气泡 / ${p.panels.length} 小图）`);
  publishMediaPostIfReady(Number(r.lastInsertRowid));
  // 先补主图；小图由 fillPendingImages 的 poster 分支继续补
  fillBatchImages(1 + p.panels.length, [Number(r.lastInsertRowid)], manual).catch(err => console.error('[media] 本期海报补图失败:', err.message));
  return { outletId: outlet.id, outletName: outlet.name, batchId, inserted: 1, postId: Number(r.lastInsertRowid) };
}

/** 规整海报草稿（纯函数） */
export function normalizePosterDraft(raw, prevNo = 0) {
  if (!raw || typeof raw !== 'object') throw new Error('海报草稿不是对象');

  const bubbles = (Array.isArray(raw.bubbles) ? raw.bubbles : [])
    .map(x => clampText(x, 24)).filter(Boolean).slice(0, 4);
  const caption = (Array.isArray(raw.caption) ? raw.caption : [])
    .map(x => clampText(x, 300)).filter(Boolean).slice(0, 6);
  const panels = (Array.isArray(raw.panels) ? raw.panels : [])
    .map(x => ({ label: clampText(x?.label, 40), image_prompt: clampText(x?.image_prompt, 1200), image: null }))
    .filter(x => x.label && x.image_prompt).slice(0, 3);

  const bigTitle = clampText(raw.bigTitle, 12);
  if (!bigTitle) throw new Error('海报缺少大标题');

  const noRaw = Number(raw.issueNo);
  const issueNo = Number.isFinite(noRaw) && noRaw > 0 ? Math.floor(noRaw) : (prevNo + 1);

  return {
    issueNo,
    hotline: clampText(raw.hotline, 200),
    bigTitle,
    bubbles: bubbles.length ? bubbles : [bigTitle],
    caption,
    panels,
    credits: {
      reporter: clampText(raw.credits?.reporter, 24),
      editor: clampText(raw.credits?.editor, 24),
    },
    image_prompt: clampText(raw.image_prompt, 1200),
    views: randInt(5000, 40000),
  };
}

// ═══════════════════════════════════════════════════════════
// 门户（portal）——数字报刊的「两层生成」
// ═══════════════════════════════════════════════════════════
/**
 * 为什么要分两层（设计动机，改之前先读）：
 *
 * 周刊/海报是「一次长 LLM + N 张图」全量产出 —— 周刊的 JSON 有 5600 字符，
 * 出刊要等十几秒到几十秒，配图还要再等；而且横版铺在 1920 屏上两侧各空 520px
 * （`.special-list` 是 max-width:880px 居中单列）。
 *
 * 门户把这个峰拆开：
 *   第 1 层  出刊：1 次**短** LLM，只产骨架（板块名 + 一句导语 + 每板块的生图提示词），
 *           文字先落库为草稿 → 全部栏目配图完成后发布。
 *   第 1.5 层 图：后台串行逐张保存，全部完成后整期发布。
 *           ★ 这批图同时就是板块详情的配图 —— 一图两用，不重复生成。
 *   第 2 层  阅读：点某个板块才开始生成它的正文，落库缓存，二次点开秒开。
 *
 * 「外壳统一、里子各自保持个性」：门户只是个壳，各刊的人设/语气仍由 outlet.prompt 决定；
 * 板块正文用**通用块数组**承载，周刊的 outlet.prompt 会自然产出 qa/rank/replies 块，
 * 狸狸八卦会产出 caption 块 —— 不用为每个刊物各写一套版式。
 */

/** 门户的门户层格式（骨架，故意写得短，产出控制在一千多字符） */
function buildPortalFormatPrompt() {
  const imageRules = String(getGlobalRule('image_prompt')?.rule_content || '').trim();
  return `本期请**只输出门户骨架**（不要写正文内容），严格按以下 JSON 格式，不要输出任何解释或 JSON 以外的文字：

{
  "issue": 数字（本期编号，比上一期大 1；我会告诉你上一期是几号）,
  "title": "本期总标题（震撼体，把本期最劲爆的那件事写进去，≤40字）",
  "lead": "一句话导语（勾人，≤60字）",
  "sections": [
    {
      "key": "板块的英文短标识（如 headline / gossip / column1 / ranking，全小写无空格）",
      "name": "板块名（4~12字，是这一块的小标题）",
      "lead": "这一块的导语（一句话剧透这块讲什么，≤45字）",
      "image_prompt": "英文：这一块的头图画什么（用于配图，也用作点开后的详情配图）"
    }
  ],
  "credits": { "reporter": "记者/撰稿名", "editor": "编辑名" }
}

字段要求：
- "sections"：**4~6 个**，彼此主题明显不同，合起来覆盖本期所有看点。
- 每块的 "lead" 要具体、有信息量，让人想点开看 —— 不要写「详见内文」这类空话。
- 每块的 "image_prompt" 必须独立可画：写清主体、动作、环境、光线；各块画面不要重复。
- 所有中文文字字段用中文；image_prompt 用英文。
- 内容必须符合 <world_setting>。
- **本期必须是全新的**，不得重复往期的标题与看点。${imageRules ? `\n\n生图规则（image_prompt 必须遵守）：\n${imageRules}` : ''}`;
}

/** 板块正文的块格式（第 2 层，点开某块时才生成） */
function buildSectionBodyPrompt(sectionName, sectionLead) {
  return `现在只写「${sectionName}」这**一个**板块的正文（前面已经给读者看过它的导语：${sectionLead || '（无）'}）。

请严格按以下 JSON 格式输出，不要输出任何解释或 JSON 以外的文字：

{
  "blocks": [
    { "type": "p", "text": "一个自然段" },
    { "type": "qa", "asker": "提问人的网名", "q": "问题", "answers": [ { "speaker": "说话人", "text": "这一句" } ] },
    { "type": "rank", "title": "榜单标题", "notice": "可空字符串", "rows": [ { "rank": "第一名", "mask": "面具名", "change": "▲0", "bearer": "持有者" } ] },
    { "type": "replies", "title": "跟帖区标题", "stat": "🤍 数字 💬 数字", "replies": [ { "author": "网名", "text": "跟帖内容" } ] },
    { "type": "caption", "lines": ["短促的一句", "短促的一句"] }
  ]
}

字段要求：
- 按这个板块的**性质**挑块类型用，不要五种全上：
  · 访谈/问答性质 → 多用 "qa"（asker/q/answers 必填，answers 2~5 个嘉宾分段作答，要互相吐槽、接梗、歪楼）
  · 榜单性质 → 用 "rank"（rows 5~8 行）
  · 需要网友反应 → 用 "replies"（replies 5~10 条，有队形刷屏、有人破坏队形、有官方号插话）
  · 八卦/事件叙述 → 用 "caption"（lines 3~5 行，每行短促有力）
  · 交代背景 / 承上启下 → 用 "p"
- **块数 3~8 个**，内容要扎实、具体、有梗，是「值得点开看」的量。
- 沿用你本刊一贯的人称、语气、口癖与署名风格。
- 所有文字用中文。至少含一个 "qa" 或 "caption" 块（保证有可读的对话感）。
- 内容必须符合 <world_setting>，且不得与本期其它板块重复。

${buildAliasRuleBlock()}`;
}

/**
 * 规范化门户骨架（纯函数，便于单测）。
 * 与 normalizeWeeklyDraft / normalizePosterDraft 同口径：容错 + 截断 + 兜底。
 */
export function normalizePortalDraft(raw, prevIssue = 0) {
  if (!raw || typeof raw !== 'object') throw new Error('门户草稿不是对象');

  const title = clampText(raw.title, 80);
  if (!title) throw new Error('门户缺少总标题');

  const seen = new Set();
  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map((s, i) => {
      const name = clampText(s?.name, 24);
      // key 只留字母数字下划线；缺失/重复就按序号兜底，保证前端 v-for 有稳定 key
      let key = String(s?.key || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
      if (!key || seen.has(key)) key = `s${i + 1}`;
      seen.add(key);
      return {
        key,
        name,
        lead: clampText(s?.lead, 120),
        image_prompt: clampText(s?.image_prompt, 1200),
        image: null,
        body: null,       // 第 2 层：点开时才填
        body_at: null,
      };
    })
    .filter(s => s.name)
    .slice(0, 8);

  if (!sections.length) throw new Error('门户一个板块都没有，模型返回异常');

  const noRaw = Number(raw.issue);
  const issue = Number.isFinite(noRaw) && noRaw > 0 ? Math.floor(noRaw) : (prevIssue + 1);

  return {
    portal: true,       // 前端据此认出这是门户（比按 layout 判断更可靠：老帖的 layout 取自 outlet）
    issue,
    title,
    lead: clampText(raw.lead, 160),
    sections,
    credits: {
      reporter: clampText(raw.credits?.reporter, 24),
      editor: clampText(raw.credits?.editor, 24),
    },
    views: randInt(5000, 40000),
  };
}

/** 该 post 的 payload 是否门户结构 */
function isPortalPayload(payload) {
  return Boolean(payload?.portal) && Array.isArray(payload.sections);
}

/**
 * 生成一期门户草稿（第 1 层）。后台串行补齐所有头图后发布。
 * 返回草稿标识；发布后才通知前端，栏目正文仍按需生成。
 */
async function generatePortalIssue(outlet, manual = false) {
  const db = getDb();
  const worldSetting = getWorldSettingSample();

  const prev = db.prepare(`
    SELECT payload_json FROM media_posts
    WHERE outlet_id = ? AND payload_json IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(outlet.id);
  const prevIssue = Number(safeParse(prev?.payload_json, null)?.issue) || 0;

  const msgs = [
    { role: 'system', content: [getSystemRules({ roleplay: false }), worldSetting].filter(Boolean).join('\n\n') },
    { role: 'system', content: outlet.prompt },
    { role: 'system', content: buildPortalFormatPrompt() },
    { role: 'user', content: `请出《${outlet.name}》新的一期。上一期是第 ${prevIssue || '（尚无，本期为第 1 期）'} 期，本期编号用 ${prevIssue + 1}。\n\n只出骨架，不要写正文。必须是全新一期。` },
  ];

  const raw = await chatWithPreset(msgs, {
    // 只产骨架 → max_tokens 压到海报同档，出刊速度是本设计的核心收益，别给大预算
    temperature: 0.9,
    response_format: { type: 'json_object' }, label: `media:${outlet.name}`,
  });
  const jsonStr = extractFirstJson(raw);
  if (!jsonStr) throw new Error('LLM 未返回 JSON');
  const p = normalizePortalDraft(JSON.parse(repairJson(jsonStr)), prevIssue);

  // content 存一份纯文本（列表摘要 / 搜索用），结构存 payload
  const plain = [
    `第${p.issue}期 ${p.title}`,
    p.lead,
    ...p.sections.map(s => `${s.name}｜${s.lead}`),
  ].filter(Boolean).join('\n').slice(0, 4000);

  const batchId = `mp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const r = db.prepare(`
    INSERT INTO media_posts (outlet_id, board_id, batch_id, title, content, tags_json,
      author_type, author_name, likes, views, comments_json, image_prompt, payload_json, image_status, published_seq)
    VALUES (?, NULL, ?, ?, ?, ?, 'anonymous', ?, ?, ?, ?, ?, ?, 'pending', NULL)
  `).run(
    outlet.id, batchId, p.title, plain, JSON.stringify(p.sections.map(s => s.name)),
    outlet.name, randInt(20, 600), p.views, '[]',
    p.sections[0]?.image_prompt || '',
    JSON.stringify(p),
  );
  const postId = Number(r.lastInsertRowid);
  console.log(`[media] ${outlet.name} 第${p.issue}期文字已生成（post #${postId}），等待 ${p.sections.length} 个板块配图后发布`);
  publishMediaPostIfReady(Number(r.lastInsertRowid));

  // 后台补图不阻塞请求；全部配图完成才对外发布。
  fillBatchImages(p.sections.length + 1, [postId], manual, true)
    .catch(err => console.error('[media] 门户补图失败:', err.message));

  return db.prepare('SELECT * FROM media_posts WHERE id = ?').get(postId);
}

/**
 * 给门户逐张补图（第 1.5 层）。
 *
 * 与 fillPosterPanelImages 的差别：**每补一张就写回一次库**，而不是攒到整期补完再写。
 * 每张图立即保存，失败后可从剩余图片继续；未发布的草稿不会逐图推送给前端。
 */
export function fillPortalImages(limit = 6, postIds = null) {
  const task = portalImageQueue.then(() => fillPortalImagesNow(limit, postIds));
  portalImageQueue = task.catch(() => {});
  return task;
}

async function fillPortalImagesNow(limit, postIds = null, priority = 'low') {
  const db = getDb();
  const scope = imagePostScope(postIds);
  const rows = db.prepare(`
    SELECT p.id, p.payload_json FROM media_posts p
    JOIN media_outlets o ON o.id = p.outlet_id
    WHERE o.layout = 'portal' AND p.payload_json IS NOT NULL
      AND (p.published_seq IS NULL OR p.image_status != 'done')
      ${scope.sql}
    ORDER BY (p.published_seq IS NULL) DESC, p.id DESC
    LIMIT 12
  `).all(scope.ids);

  let filled = 0;
  let attempted = 0;
  for (const row of rows) {
    if (attempted >= limit) break;
    const payload = safeParse(row.payload_json, null);
    if (!isPortalPayload(payload)) continue;

    for (const section of payload.sections) {
      if (attempted >= limit) break;
      if (section.image || !section.image_prompt) continue;
      attempted++;
      try {
        const result = await generateMediaImage(section.image_prompt, null, { priority, ragQuery: [section.name, section.lead].filter(Boolean).join('\n') });
        if (!result) continue;
        // 重新读一次 payload：生成期间可能有别的写入（如用户点了某块生成正文）
        const fresh = safeParse(db.prepare('SELECT payload_json FROM media_posts WHERE id = ?').get(row.id)?.payload_json, null);
        const target = isPortalPayload(fresh) ? fresh.sections.find(s => s.key === section.key) : null;
        if (!target || target.image) continue;   // 已被填过就跳过，避免覆盖
        target.image = result.url;
        db.prepare('UPDATE media_posts SET payload_json = ? WHERE id = ?').run(JSON.stringify(fresh), row.id);
        filled++;
        recordCompletedImageTask({
          conversationId: 'media_portal_section',
          promptOriginal: section.image_prompt,
          promptRefined: result.refinedPrompt,
          outputPaths: [result.url],
          style: result.artist,
          resolution: `${config.comfyui.momentsWidth}x${config.comfyui.momentsHeight}`,
          workflowTemplate: result.wfMode,
          db,
        });
        if (isMediaPostPublished(row.id)) broadcast('media_image_ready', { postId: row.id, image: result.url, sectionKey: section.key });
        console.log(`[media] 门户配图 #${row.id}/${section.key} 已补（${filled}/${limit}）`);
      } catch (err) {
        console.error(`[media] 门户配图失败 #${row.id}/${section.key}:`, err.message);
      }
    }

    // 全部板块都有图 → 整期标记 done，前端停止轮询
    const now = safeParse(db.prepare('SELECT payload_json FROM media_posts WHERE id = ?').get(row.id)?.payload_json, null);
    if (isPortalPayload(now) && now.sections.every(s => s.image || !s.image_prompt)) {
      const changed = db.prepare(`UPDATE media_posts SET image_status = 'done', image_error = NULL WHERE id = ? AND image_status != 'done'`).run(row.id).changes;
      // 门户的「封面」取第一块的头图，便于瀑布流/列表复用同一套渲染
      const cover = now.sections.find(s => s.image)?.image;
      if (cover) db.prepare('UPDATE media_posts SET image = ? WHERE id = ? AND (image IS NULL OR image = \'\')').run(cover, row.id);
      const published = publishMediaPostIfReady(row.id);
      if (changed || published) broadcast('media_portal_ready', { postId: row.id });
    }
  }
  return filled;
}

/**
 * 生成某个板块的正文（第 2 层）。按需触发、落库缓存 —— 生成过就直接返回缓存。
 * @returns {{ ok: boolean, cached?: boolean, section?: object, error?: string }}
 */
export async function generatePortalSection(postId, sectionKey) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM media_posts WHERE id = ?').get(postId);
  if (!row) return { ok: false, error: '内容不存在' };
  const payload = safeParse(row.payload_json, null);
  if (!isPortalPayload(payload)) return { ok: false, error: '这条内容不是门户结构' };

  const section = payload.sections.find(s => s.key === sectionKey);
  if (!section) return { ok: false, error: '找不到这个板块' };
  // 已生成过 → 直接给缓存（这就是「二次点开秒开」）
  if (section.body) return { ok: true, cached: true, section };

  const outlet = db.prepare('SELECT * FROM media_outlets WHERE id = ?').get(row.outlet_id);
  const worldSetting = getWorldSettingSample();

  const raw = await chatWithPreset([
    { role: 'system', content: [getSystemRules({ roleplay: false }), worldSetting].filter(Boolean).join('\n\n') },
    { role: 'system', content: outlet?.prompt || '' },
    { role: 'system', content: buildSectionBodyPrompt(section.name, section.lead) },
    { role: 'user', content: `本期的总标题是「${payload.title}」。现在请写「${section.name}」这一块的正文。` },
  ], {
    temperature: 0.9,
    response_format: { type: 'json_object' }, label: `media:${outlet?.name || '门户'}·板块`,
  });

  const jsonStr = extractFirstJson(raw);
  if (!jsonStr) throw new Error('LLM 未返回 JSON');
  const body = normalizeSectionBlocks(JSON.parse(repairJson(jsonStr)));

  // 重新读 payload 再写：生成期间可能刚补进了图，直接写旧对象会把图弄丢
  const fresh = safeParse(db.prepare('SELECT payload_json FROM media_posts WHERE id = ?').get(postId)?.payload_json, null);
  const target = isPortalPayload(fresh) ? fresh.sections.find(s => s.key === sectionKey) : null;
  if (!target) return { ok: false, error: '板块在生成期间被移除了，请刷新' };
  target.body = body;
  target.body_at = new Date().toISOString();
  db.prepare('UPDATE media_posts SET payload_json = ? WHERE id = ?').run(JSON.stringify(fresh), postId);

  console.log(`[media] 门户板块正文 #${postId}/${sectionKey} 已生成（${body.length} 块）`);
  return { ok: true, cached: false, section: target };
}

/** 板块正文的块数组规范化：只认已知块类型，其余丢弃（不做兜底猜测，避免前端拿到怪结构） */
export function normalizeSectionBlocks(raw) {
  const list = Array.isArray(raw?.blocks) ? raw.blocks : [];
  const out = [];
  for (const b of list) {
    const type = String(b?.type || '').toLowerCase();
    if (type === 'p') {
      const text = clampText(b.text, 2000);
      if (text) out.push({ type: 'p', text });
    } else if (type === 'qa') {
      const q = clampText(b.q, 300);
      const answers = (Array.isArray(b.answers) ? b.answers : [])
        .map(a => ({ speaker: clampText(a?.speaker, 30), text: clampText(a?.text, 600) }))
        .filter(a => a.text).slice(0, 6);
      if (q) out.push({ type: 'qa', asker: clampText(b.asker, 30), q, answers });
    } else if (type === 'rank') {
      const rows = (Array.isArray(b.rows) ? b.rows : [])
        .map(r => ({
          rank: clampText(r?.rank, 16), mask: clampText(r?.mask, 30),
          change: clampText(r?.change, 10), bearer: clampText(r?.bearer, 30),
        }))
        .filter(r => r.rank || r.bearer).slice(0, 12);
      if (rows.length) out.push({ type: 'rank', title: clampText(b.title, 40), notice: clampText(b.notice, 200), rows });
    } else if (type === 'replies') {
      const replies = (Array.isArray(b.replies) ? b.replies : [])
        .map(r => ({ author: clampText(r?.author, 30), text: clampText(r?.text, 600) }))
        .filter(r => r.text).slice(0, 14);
      if (replies.length) out.push({ type: 'replies', title: clampText(b.title, 40), stat: clampText(b.stat, 40), replies });
    } else if (type === 'caption') {
      const lines = (Array.isArray(b.lines) ? b.lines : []).map(l => clampText(l, 300)).filter(Boolean).slice(0, 8);
      if (lines.length) out.push({ type: 'caption', lines });
    }
  }
  if (!out.length) throw new Error('模型没产出可用的正文块，请重试');
  return out;
}

// ── 数字报刊的「出刊」：每日一刊 + 手动出刊 + 期号导航 ─────────────────

/**
 * 今天这个刊出过了吗（本地日期口径）。
 *
 * `media_posts.created_at` 由 SQLite 的 `CURRENT_TIMESTAMP` 写入（**UTC**），
 * 所以要比"本地今天"就必须两边都用 SQL 的 localtime 换算 —— 保持**同一套基准**。
 * （踩过：JS 的日期键与 SQL 的 `now` 是两套时间源，跨零点会不一致。）
 */
export function hasIssueToday(outletId) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM media_posts
    WHERE outlet_id = ? AND payload_json IS NOT NULL
      AND DATE(created_at, 'localtime') = DATE('now', 'localtime')
    LIMIT 1
  `).get(outletId));
}

/** 该刊最新一期的期号（没有则 0） */
function lastIssueNo(outletId) {
  const row = getDb().prepare(`
    SELECT payload_json FROM media_posts
    WHERE outlet_id = ? AND payload_json IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(outletId);
  return Number(safeParse(row?.payload_json, null)?.issue) || 0;
}

/**
 * 出一刊（数字报刊形态专用）。
 *
 * @param {number} outletId
 * @param {{ force?: boolean }} [opts]
 *   force=false（默认）：**当天已出过就返回那一期**，不重复出（省 token，与《邻舍日报》的 /generate 同口径）
 *   force=true：就算今天出过也再出一期（读者点「再出一期」加刊）
 * @returns {Promise<{existed: boolean, post: object, issue: number}>}
 */
/**
 * 从 payload 里读期号。
 * 三种形态各用各的字段名（门户 `issue` / 海报 `issueNo` / 旧周刊 `volume`）—— 这里统一。
 */
export function issueNoOf(payload) {
  const p = payload || {};
  const n = Number(p.issue ?? p.issueNo ?? p.volume);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 出一刊 —— 适用于**所有「按期出刊」的形态**：门户（数字报刊）/ 海报（官方传媒）/ 旧周刊。
 *
 * @param {number} outletId
 * @param {{ force?: boolean }} [opts]
 *   force=false（默认）：**当天已出过就返回那一期**，不重复出（省 token，与《邻舍日报》的 /generate 同口径）
 *   force=true：就算今天出过也再出一期（读者点「再出一期」加刊）
 * @returns {Promise<{existed: boolean, post: object, issue: number}>}
 */
export async function publishIssue(outletId, { force = false } = {}) {
  const outlet = getOutlet(outletId);
  if (!outlet) throw Object.assign(new Error('媒体不存在'), { statusCode: 404 });
  if (!isPeriodicalLayout(outlet.layout)) {
    throw Object.assign(new Error('这个媒体不是「按期出刊」的形态（数字报刊 / 海报），不能出刊'), { statusCode: 400 });
  }

  // 当天已出且不强制 → 直接把那一期还回去
  if (!force && hasIssueToday(outletId)) {
    const db = getDb();
    const post = db.prepare(`
      SELECT * FROM media_posts
      WHERE outlet_id = ? AND payload_json IS NOT NULL
        AND DATE(created_at, 'localtime') = DATE('now', 'localtime')
      ORDER BY id DESC LIMIT 1
    `).get(outletId);
    return { existed: true, post, issue: issueNoOf(safeParse(post?.payload_json, null)) };
  }

  // 按形态分派生成器。
  // ⚠ 三个生成器的返回值**不一致**：`generatePortalIssue` 返回 **DB 行**，
  //   而 `generatePosterIssue` / `generateWeeklyIssue` 返回 **summary 对象**（含 postId）。
  //   这里统一取"DB 行"再返回，免得每个调用方各写一套判断。
  //   （踩过：直接读 `res.payload_json` 对海报是 undefined → 期号读成 0、post 丢成 undefined。）
  const res = outlet.layout === 'poster' ? await generatePosterIssue(outlet)
    : outlet.layout === 'weekly' ? await generateWeeklyIssue(outlet)
      : await generatePortalIssue(outlet);
  const postId = res?.id ?? res?.postId ?? null;
  const post = postId ? getDb().prepare('SELECT * FROM media_posts WHERE id = ?').get(postId) : null;
  return { existed: false, post, issue: issueNoOf(safeParse(post?.payload_json, null)) };
}

/**
 * 期简目（往期导航用）：最新在前。只取渲染与切期需要的字段，不带正文。
 * 兼容三种形态（期号字段名不同，统一走 `issueNoOf`）。
 */
export function listIssues(outletId) {
  const rows = getDb().prepare(`
    SELECT id, title, created_at, payload_json FROM media_posts
    WHERE outlet_id = ? AND payload_json IS NOT NULL
    ORDER BY id DESC LIMIT 200
  `).all(outletId);
  return rows.map(r => {
    const p = safeParse(r.payload_json, null);
    // 门户有 sections（按块计正文进度）；海报没有块概念，用 1/1 表示"整张已出"
    const sections = Array.isArray(p?.sections) ? p.sections : [];
    const isPoster = !sections.length && Boolean(p?.bigTitle);
    return {
      post_id: r.id,
      issue: issueNoOf(p),
      title: r.title,
      created_at: r.created_at,
      section_count: isPoster ? 1 : sections.length,
      // 有多少块正文已经写过 —— 期号导航上标个进度，一眼看出哪期是完整的
      written: isPoster ? 1 : sections.filter(s => s?.body).length,
    };
  }).filter(x => x.issue > 0);
}

/** 每日出刊的在途守卫（避免同一分钟内被重复触发） */
let portalIssueInFlight = false;

/**
 * 每日一刊（挂在调度 tick 里，与《邻舍日报》同一套机制）。
 * 覆盖**所有按期出刊的形态**（数字报刊 + 官方传媒：海报/周刊）。
 *
 * 自带的克制设计：
 *  · **每个 tick 最多出一个刊** —— 有多个刊物时不会在同一分钟里并发几次 LLM；
 *    下一个 tick 自然轮到下一个还没出的刊。
 *  · 当天已出的刊会被跳过（`hasIssueToday`），所以它只是"每天补一次"，重复调用无副作用。
 *  · 全流程 try/catch —— 出刊失败不能影响调度。
 *
 * @returns {Promise<{published: string|null, reason: string}>}
 */
export async function maybeGenerateDailyIssues() {
  if (portalIssueInFlight) return { published: null, reason: 'in-flight' };
  try {
    const db = getDb();
    const candidates = db.prepare(`
      SELECT * FROM media_outlets WHERE enabled = 1 AND layout IN ('portal','poster','weekly')
      ORDER BY sort_order, id
    `).all();
    const outlet = candidates.find(o => !hasIssueToday(o.id)) || null;
    if (!outlet) return { published: null, reason: 'all-done' };

    portalIssueInFlight = true;
    const r = await publishIssue(outlet.id, { force: false });
    console.log(`[media] 每日出刊：${outlet.name} 第${r.issue}期`);
    return { published: outlet.name, reason: 'published' };
  } catch (err) {
    console.error('[media] 每日出刊失败:', err.message);
    return { published: null, reason: 'error' };
  } finally {
    portalIssueInFlight = false;
  }
}

/**
 * 抓一批内容（社交平台 = 一批帖子；门户/周刊/海报 = 出一期）。
 *
 * @param {object} opts
 * @param {string?} [opts.category] - `outletId` 缺省（前端在「全部」档点刷新）时，
 *   **只在当前分类内**随机抽一个媒体。不传 = 全库随机（老调用方语义）。
 */
export async function generateMediaBatch({ outletId = null, count = DEFAULT_BATCH_SIZE, withCharacters = true, category = null, manual = false } = {}) {
  if (generating) return generating;   // 同一时间只跑一批，避免并发刷爆 LLM
  generating = (async () => {
    const db = getDb();
    const n = Math.max(1, Math.min(MAX_BATCH_SIZE, Number(count) || DEFAULT_BATCH_SIZE));

    // 选媒体
    let outlet = outletId ? getOutlet(outletId) : null;
    // ★ 「全部」时随机抽一个 —— 必须**限定在当前分类内**。
    //   踩过的坑：老代码是全局 `ORDER BY RANDOM() LIMIT 1`，于是站在「数字报刊」点刷新
    //   可能抽到社交平台的媒体，生成出来的帖子根本不出现在当前分类里 ——
    //   用户看到的是"点了刷新毫无反应"，而 token 已经烧掉了。
    const cf = outlet ? null : categoryFilter(category, 'media_outlets');
    if (!outlet) {
      outlet = db.prepare(
        `SELECT * FROM media_outlets WHERE enabled = 1${cf ? ` AND ${cf.sql}` : ''} ORDER BY RANDOM() LIMIT 1`
      ).get(...(cf ? cf.params : [])) || null;
    }
    if (!outlet) {
      throw new Error(cf ? '这个分类下还没有可用的媒体（请先在媒体设置里添加）' : '没有可用的媒体（请先在媒体设置里添加）');
    }

    // 按形态分派：周刊/海报/门户一次出一期（刊），都不是「一批帖子」
    if (outlet.layout === 'portal') return await generatePortalIssue(outlet, manual);
    if (outlet.layout === 'weekly') return await generateWeeklyIssue(outlet, manual);
    if (outlet.layout === 'poster') return await generatePosterIssue(outlet, manual);
    // 论坛 / 图库是「一批帖子」的变体，但格式差异大到各走各的规整器
    if (outlet.layout === 'forum') return await generateForumBatch(outlet, n, withCharacters);
    if (outlet.layout === 'photos') return await generatePhotoBatch(outlet, n, withCharacters);
    if (outlet.layout === 'gallery') return await generateGalleryBatch(outlet, n, withCharacters);

    const boards = listBoards(outlet.id);
    // 角色数量受帖数限制：最多 3 个、且不超过总帖数的一半（否则整版都是角色帖，不像真实社区）
    const authorCount = !withCharacters ? 0 : Math.min(3, Math.max(1, Math.floor(n / 2)));
    // ★ 2026-10-18：先抽世界，再按世界的居民抽作者
    const sampled = sampleWorldSettings();
    const worldSetting = sampled.text;
    const authors = pickActiveCharacters(authorCount, { worldIds: sampled.ids });
    const msgs = [
      { role: 'system', content: [getSystemRules({ roleplay: false }), worldSetting].filter(Boolean).join('\n\n') },
      { role: 'system', content: outlet.prompt },
      { role: 'system', content: buildFormatPrompt(outlet, boards, authors, { usedAliases: recentUsedAliases(outlet.id) }) },
      { role: 'user', content: buildMaterialsPrompt(outlet, boards, authors, n) },
    ];

    const raw = await chatWithPreset(msgs, {
      temperature: 0.9,
      response_format: { type: 'json_object' },
      label: `media:${outlet.name}`,
    });
    let drafts;
    try {
      const jsonStr = extractFirstJson(raw);
      if (!jsonStr) throw new Error('LLM 未返回完整 JSON');
      // 合法 JSON 优先直接解析，避免修复逻辑改变原本正确的转义内容。
      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch { parsed = JSON.parse(repairJson(jsonStr)); }
      drafts = normalizeMediaDraft(parsed, boards, authors);
    } catch (err) {
      // 输出不完整直接报错，不重新请求模型，也不写入无图帖子。
      throw new Error(`社交平台图文输出不完整：${err.message}`);
    }

    const batchId = `mb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ins = db.prepare(`
      INSERT INTO media_posts (outlet_id, board_id, batch_id, title, content, tags_json,
        author_type, character_id, author_name, author_avatar, likes, views, comments_json,
        image_prompt, image_status, published_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
    `);
    let inserted = 0;
    const postIds = [];
    const tx = db.transaction(() => {
      for (const d of drafts) {
        const row = ins.run(
          outlet.id, d.board_id, batchId, d.title, d.content, JSON.stringify(d.tags),
          d.author_type, d.character_id, d.author_name, d.author_avatar, d.likes, d.views,
          JSON.stringify(d.comments), d.image_prompt || null,
        );
        postIds.push(Number(row.lastInsertRowid));
        inserted++;
      }
    });
    tx();
    console.log(`[media] 「${outlet.name}」新增 ${inserted} 条（角色参与 ${authors.map(a => a.display_name).join('、') || '无'}）`);

    // 所有新社交帖已校验配图提示词，等待图片齐全后发布。
    for (const id of postIds) publishMediaPostIfReady(id);

    // 按本批数量排队补图，不阻塞请求；忙碌时排队，不丢弃任务。
    fillBatchImages(inserted, postIds, manual).catch(err => console.error('[media] 本批补图失败:', err.message));

    return { outletId: outlet.id, outletName: outlet.name, batchId, inserted };
  })().finally(() => { generating = null; });
  return generating;
}

// ══════════════════════════════════════════
// 配图（草稿后台补齐后发布）
// ══════════════════════════════════════════

/**
 * 生成一张媒体配图。
 * @param {string} prompt
 * @param {object|null} character - 有角色时用其 `artist_override` / LoRA
 * @param {object} [opts]
 * @param {string|null} [opts.artist] - **本条专用画师串**，优先级高于一切。
 *        图库形态（规则34）靠它实现「每条画风都不一样」——
 *        该值由 generateGalleryBatch 从收藏夹随机抽、存进 payload.gallery.artist。
 * @param {number} [opts.width]  - 本条专用宽（图库随机比例）
 * @param {number} [opts.height] - 本条专用高
 * @param {string} [opts.negative] - 本条专用负向提示词（体位参考里的「负向」，
 *        用来压制该体位最常见的畸形，如同手同脚、多肢、男脸）
 * @param {Array<{characterId:number, slot?:string, side?:'left'|'right'}>} [opts.anchors]
 *        出镜角色的锚点（阶段 6，2026-10-22）。传了就用代码注入的整段外观；
 *        不传则这张图里没有本作角色（纯风景/静物/海报）。
 */
async function generateMediaImage(prompt, character = null, opts = {}) {
  // ★ 合并 v3.8.3 归一：补图通道按第三参传优先级字符串（'low'/'high'），
  //   图库/照片通道传 opts 对象（每条画师串、画幅比例、负向）。两种口径在此兼容。
  if (typeof opts === 'string') opts = { priority: opts };
  const charArtist = charArtistOverrideWithFallback(character);
  const ownArtist = typeof opts.artist === 'string' && opts.artist.trim() ? opts.artist.trim() : null;
  const loras = parseCharacterLoras(character?.loras);
  // 优先级：本条专用（图库随机画师串） > 角色单独画师串 > 全局
  const finalArtist = ownArtist !== null ? ownArtist : (charArtist !== null ? charArtist : config.comfyui.momentsArtist);
  const w = Number(opts.width) > 0 ? Number(opts.width) : config.comfyui.momentsWidth;
  const h = Number(opts.height) > 0 ? Number(opts.height) : config.comfyui.momentsHeight;
  const neg = typeof opts.negative === 'string' && opts.negative.trim() ? opts.negative.trim() : null;
  const result = await generateImageRaw(prompt, {
    ragQuery: (typeof opts.ragQuery === 'string' && opts.ragQuery.trim()) ? opts.ragQuery : prompt,
    artist: finalArtist,
    width: w,
    height: h,
    scene: 'moments',
    priority: opts.priority || 'low',
    /**
     * ★ 角色锚点（阶段 6，2026-10-22）：出镜角色的外观由代码整段注入。
     * 原来走 `buildSubjectRef`：从 `character_outfits.body` 抠发型、截到 64 字符 ——
     * 瞳色/体型/发饰全丢，还会切出 `...two high` 这种断尾。
     * 画面里没有本作角色时（风景/静物/海报）不传，不硬塞一段"她"。
     */
    ...(Array.isArray(opts.anchors) && opts.anchors.length ? { anchors: opts.anchors } : {}),
    ...(neg ? { negativePrompt: neg } : {}),
    ...(loras.length ? { customWorkflow: character?.custom_workflow || null, loras } : {}),
  });
  if (!result?.success || !result.images?.length) return null;
  const img = result.images[0];
  return {
    url: saveBase64Image('media', `media_${Date.now()}_${img.filename || 'comfy.png'}`, img.base64),
    refinedPrompt: result.promptRefined || prompt,
    wfMode: result.wfMode,
    artist: finalArtist,
  };
}

function parseCharacterLoras(loras) {
  if (!loras) return [];
  try {
    const parsed = typeof loras === 'string' ? JSON.parse(loras) : loras;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * 给缺图的帖子补封面（一次最多 limit 张，串行）。返回补上的张数。
 * 由生成批次或用户打开页面/补图时按需调用。
 */
export function fillPendingImages(limit = 6, postIds = null) {
  const task = imageQueue.then(() => fillPendingImagesNow(limit, postIds));
  imageQueue = task.catch(() => {});
  return task;
}

async function fillPendingImagesNow(limit, postIds = null, priority = 'low') {
  const db = getDb();
  let filled = 0;
  // 上游 v3.8.1：先把配图已齐的草稿发布掉（补图期间可能刚集齐），再补新一批
  for (const { id } of db.prepare('SELECT id FROM media_posts WHERE published_seq IS NULL').all()) publishMediaPostIfReady(id);
  // ⚠️ 这里**不要**调 resetStaleMediaGenerating —— 补图是"按需/高频"路径，
  // 把超时重置塞进来就会退化成「每次补图都扫一遍 generating」，重演 2026-10-04 的
  // 无限重生循环（详见该函数注释）。运行期自愈统一放在 replyQueueScheduler 的
  // 低频闸里（每 5 分钟最多一次 + 30 分钟才判超时），启动时全量重置一次。
  const pending = listPostsNeedingImage(limit, postIds);
  for (const p of pending) {
    // ★ 原子抢占（CAS）：只有仍是 pending 的才抢得到。
    //   这一句是防重复生图的关键 —— 原实现先无条件置 generating，
    //   若同一帖子被两条补图路径同时捞走，两边都会生成、后写的覆盖前写的，
    //   前一张文件就变成没人引用的孤儿（实测目录里 81 个文件只有 37 个被引用）。
    if (!claimPostForImage(p.id)) continue;
    try {
      // 图库形态：画师串 / 画幅比例 / 负向提示词**随条目走**（存 payload.gallery）
      // ——这是「每条画风与比例都不一样」的实现点，三者都是服务端确定性分配的。
      // ★ 哈托比亚（photos 形态）同口径，只是键名不同（payload.photos）；
      //   两者结构一致，这里合并读取，避免再复制一份补图逻辑。
      const payload = safeParse(p.payload_json, null);
      const gal = payload?.gallery || payload?.photos || null;
      // ★ 出镜角色（图库条目里 author_type 是 anonymous，但画面里是这些角色）：
      //   必须挂她们的 LoRA，否则画出来的人根本不像那个角色。
      const castId = p.character_id || gal?.castIds?.[0] || null;
      const character = castId
        ? db.prepare('SELECT id, loras, artist_override, custom_workflow FROM characters WHERE id = ?').get(castId)
        : null;
      /**
       * ★ 角色锚点（阶段 6，2026-10-22）：出镜的**每一个**角色都注入整段外观。
       * 来源是 payload 里本来就有的 `castIds`（图库 2 女体位会有两个）。
       * 第 1 个是 self（整段），第 2 个起 compact + 位置词 —— 与
       * `GIRL_POSITION_REFS` / 体位模板里的 `the girl 1|2` 用同一套词。
       */
      const castIds = [
        ...(p.character_id ? [p.character_id] : []),
        ...(Array.isArray(gal?.castIds) ? gal.castIds : []),
      ]
        .map(Number)
        .filter((id, i, arr) => Number.isInteger(id) && arr.indexOf(id) === i);
      const anchors = castIds.map((id, i) => ({
        characterId: id,
        slot: i === 0 ? 'self' : 'other',
        ...(i === 0 ? {} : { side: i % 2 === 0 ? 'right' : 'left' }),
      }));
      const result = await generateMediaImage(p.image_prompt, character, {
        artist: gal?.artist || null,
        width: gal?.width || null,
        height: gal?.height || null,
        negative: gal?.negative || null,
        priority,
        anchors,
      });
      if (!result) {
        updatePostImage(p.id, { status: 'failed', error: 'ComfyUI 未返回图片' });
        continue;
      }
      // ★ 条件写回：生成期间若有别的路径已经写入了图，就不覆盖它，
      //   并把自己刚存的这张删掉（否则又留一个孤儿）。
      const wrote = db.prepare(`
        UPDATE media_posts SET image = ?, image_status = 'done', image_error = NULL
        WHERE id = ? AND (image IS NULL OR image = '')
      `).run(result.url, p.id).changes;
      if (wrote !== 1) {
        console.warn(`[media] 帖子 #${p.id} 在生成期间已被填图，丢弃本次结果`);
        try { deleteImageFileByUrl(result.url); } catch { /* 文件可能已被清 */ }
        continue;
      }
      recordCompletedImageTask({
        conversationId: 'media_post',
        promptOriginal: p.image_prompt,
        promptRefined: result.refinedPrompt,
        outputPaths: [result.url],
        style: result.artist,
        resolution: `${gal?.width || config.comfyui.momentsWidth}x${gal?.height || config.comfyui.momentsHeight}`,
        workflowTemplate: result.wfMode,
        db,
      });
      // 上游 v3.8.1：图齐即发布，发布成功再广播（避免把未发布的草稿推给前端）
      publishMediaPostIfReady(p.id);
      if (isMediaPostPublished(p.id)) broadcast('media_image_ready', { postId: p.id, image: result.url });
      filled++;
    } catch (err) {
      console.error(`[media] 配图失败 #${p.id}:`, err.message);
      updatePostImage(p.id, { status: 'failed', error: String(err.message).slice(0, 200) });
    } finally {
      // 无论成功、失败还是中途 continue，这条都不再是「本进程正在生成」。
      imageClaims.delete(p.id);
    }
  }

  // ── 海报的小图（存在 payload.panels 里，一张海报最多 3 张）──
  // 单独一轮、放在主图之后：主图是海报的门面，优先保证。
  filled += await fillPosterPanelImages(Math.max(0, limit), postIds, priority);
  return filled;
}

/**
 * 补海报小图（payload.panels[].image 为空且已有 image_prompt 的）。
 * 用「先写回 payload 再生成」的顺序无法 CAS（payload 是一整块 JSON），
 * 后台由 fillPendingImages 串行处理；手动刷新只处理独占的新批次，后台扫描排除该批次。
 */
async function fillPosterPanelImages(limit = 3, postIds = null, priority = 'low') {
  const db = getDb();
  const scope = imagePostScope(postIds);
  const posts = db.prepare(`
    SELECT p.id, p.payload_json FROM media_posts p
    JOIN media_outlets o ON o.id = p.outlet_id
    WHERE o.layout = 'poster' AND p.payload_json IS NOT NULL
      AND (p.published_seq IS NULL OR p.image_status != 'done')
      ${scope.sql}
    ORDER BY (p.published_seq IS NULL) DESC, p.id DESC
    LIMIT 12
  `).all(scope.ids);

  let filled = 0;
  let attempted = 0;
  for (const row of posts) {
    if (attempted >= limit) break;
    const payload = safeParse(row.payload_json, null);
    const panels = Array.isArray(payload?.panels) ? payload.panels : [];
    let touched = false;

    // ★ F-07 配套（2026-10-12）：循环带索引 —— 广播里给出 panelIndex，
    //   前端才能把补好的面板图精确写进 payload.panels[i]（原先只带 panel:true，无法定位）。
    for (let pi = 0; pi < panels.length; pi++) {
      const panel = panels[pi];
      if (attempted >= limit) break;
      if (panel.image || !panel.image_prompt) continue;
      attempted++;
      try {
        const result = await generateMediaImage(panel.image_prompt, null, priority);
        if (!result) continue;
        panel.image = result.url;
        touched = true;
        filled++;
        recordCompletedImageTask({
          conversationId: 'media_poster_panel',
          promptOriginal: panel.image_prompt,
          promptRefined: result.refinedPrompt,
          outputPaths: [result.url],
          style: result.artist,
          resolution: `${config.comfyui.momentsWidth}x${config.comfyui.momentsHeight}`,
          workflowTemplate: result.wfMode,
          db,
        });
        publishMediaPostIfReady(row.id);
        if (isMediaPostPublished(row.id)) broadcast('media_image_ready', { postId: row.id, image: result.url, panel: true, panelIndex: pi });
      } catch (err) {
        console.error(`[media] 海报小图失败 #${row.id}:`, err.message);
      }
    }
    if (touched) {
      db.prepare('UPDATE media_posts SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), row.id);
    }
    publishMediaPostIfReady(row.id);
  }
  return filled;
}

// ══════════════════════════════════════════
// 自动补充（replyQueueScheduler tick 调用）
// ══════════════════════════════════════════

/**
 * 定时补内容：到点后随机挑一个启用的媒体补一小批，并顺带补几张缺图。
 * 不阻塞 tick（内部 fire-and-forget）。
 */
/** 这条内容是否有生图提示词（可重新生图） */
export function canRegenerateImage(post) {
  if (!post) return false;
  const payload = safeParse(post.payload_json, null);
  if (isPortalPayload(payload)) return payload.sections.some(s => String(s?.image_prompt || '').trim());
  if (String(post.image_prompt || '').trim()) return true;
  const panels = Array.isArray(payload?.panels) ? payload.panels : [];
  return panels.some(p => String(p?.image_prompt || '').trim());
}

/**
 * 为某条内容重新生成配图。
 *
 * 三种形态一视同仁：
 *   feed   → 清空主图，重新排队
 *   poster → 清空主图 **+ payload.panels[].image**（小图一并重出）
 *   weekly → 清空头图
 *
 * 旧图文件**不在这里删** —— 等新图写入成功后再处理，避免「图清了、新图又失败」
 * 导致这条内容永久没图。
 * @returns {{ok:boolean, error?:string, cleared?:number, post?:object}}
 */
export function regeneratePostImage(postId) {
  const db = getDb();
  const post = db.prepare('SELECT * FROM media_posts WHERE id = ?').get(postId);
  if (!post) return { ok: false, error: '内容不存在' };
  if (!canRegenerateImage(post)) return { ok: false, error: '这条内容没有生图提示词，无法重新生图' };

  let cleared = 0;
  const payload = safeParse(post.payload_json, null);
  const isPortal = isPortalPayload(payload);

  const tx = db.transaction(() => {
    // 主图清空并置回 pending —— CAS 抢占（claimPostForImage）只认 pending
    db.prepare(`UPDATE media_posts SET image = NULL, image_status = 'pending', image_error = NULL WHERE id = ?`).run(postId);
    cleared++;

    if (isPortal) {
      // 门户：清空**每个板块**的头图（正文 body 是文字、不动，重生成图片不该把已生成的正文丢掉）
      let touched = false;
      for (const s of payload.sections) {
        if (s?.image) { s.image = null; cleared++; touched = true; }
      }
      if (touched) {
        db.prepare('UPDATE media_posts SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), postId);
      }
    } else if (payload && Array.isArray(payload.panels)) {
      let touched = false;
      for (const panel of payload.panels) {
        if (panel?.image) { panel.image = null; cleared++; touched = true; }
      }
      if (touched) {
        db.prepare('UPDATE media_posts SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), postId);
      }
    }
  });
  tx();

  // 立刻排队（不 await：接口要快速返回；图会通过 SSE 到位）
  if (isPortal) {
    // 门户走自己的补图通道（主图通道已被 listPostsNeedingImage 排除）
    fillPortalImages(1 + payload.sections.length)
      .catch(err => console.error('[media] 门户重新生图失败:', err.message));
  } else {
    fillPendingImages(1 + (payload?.panels?.length || 0))
      .catch(err => console.error('[media] 重新生图失败:', err.message));
  }

  console.log(`[media] 帖子 #${postId} 重新生图：清空 ${cleared} 张`);
  const fresh = db.prepare('SELECT * FROM media_posts WHERE id = ?').get(postId);
  return { ok: true, cleared, post: mapPostRow(fresh) };
}

/**
 * 删除一条内容（含全部配图文件）。
 * 周刊/海报的小图存在 payload.panels、门户的头图存在 payload.sections —— **都要一并清理**，
 * 否则会留下没人引用的孤儿文件。
 * @param {number} postId
 * @param {{ silent?: boolean }} [opts] silent=true 时**不**失效相册缓存、**不**广播
 *   —— 批量删除用：逐条做这两件事会重复 N 次，由批量入口统一收尾。
 */
export function deletePost(postId, { silent = false } = {}) {
  const db = getDb();
  const post = db.prepare('SELECT * FROM media_posts WHERE id = ?').get(postId);
  if (!post) return { ok: false, error: '内容不存在' };

  // 先收集所有要删的图片 URL
  const urls = [];
  if (post.image) urls.push(post.image);
  const payload = safeParse(post.payload_json, null);
  if (Array.isArray(payload?.panels)) {
    for (const p of payload.panels) if (p?.image) urls.push(p.image);
  }
  // 门户的图存在 sections[].image（不是 panels），漏了会留下孤儿文件
  if (Array.isArray(payload?.sections)) {
    for (const s of payload.sections) if (s?.image) urls.push(s.image);
  }

  db.prepare('DELETE FROM media_posts WHERE id = ?').run(postId);

  // 删文件放在事务外：文件删失败不该导致记录删不掉
  let removed = 0;
  for (const u of urls) {
    try { if (deleteImageFileByUrl(u)) removed++; } catch { /* 可能已被清 */ }
  }
  if (!silent) {
    try { invalidateGalleryCache(); } catch { /* ignore */ }
    broadcast('media_post_deleted', { postId });
  }

  console.log(`[media] 删除内容 #${postId}（清理图片 ${removed}/${urls.length}）`);
  // T5：单条删除留痕（含标题快照；silent=true 是批量内部调用，由批量入口统一记一条）
  if (!silent) {
    recordMediaOp({
      opType: 'delete', targetType: 'post', targetId: postId,
      targetName: post.title || '',
      outletName: '',
      count: 1,
      detail: `删除内容「${String(post.title || '').slice(0, 40)}」（清理图片 ${removed} 张）`,
      snapshot: { title: post.title, outletId: post.outlet_id, boardId: post.board_id, author: post.author_name, image: !!post.image, removedImages: removed },
    });
  }
  return { ok: true, removedImages: removed };
}

// ── 批量操作（列表页「批量操作」用） ─────────────────────────

/** 一次最多处理多少条 —— 防止误点「全选」把整库送进来跑很久 */
export const MAX_BATCH_POSTS = 500;

function normalizePostIds(ids) {
  const arr = Array.isArray(ids) ? ids : [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * 批量删除。
 *
 * 逐条复用 `deletePost`（它已负责：收集主图 + payload.panels 小图、删记录、删文件、广播），
 * 但**撤掉它内部的缓存失效与广播**会重复 N 次 —— 这里由调用方统一收尾。
 * 返回每一张的结果，前端据此提示「成功 N 张，失败 M 张」而不是笼统报错。
 */
export function deletePosts(ids) {
  const list = normalizePostIds(ids);
  if (!list.length) return { ok: false, error: '没有选中任何内容' };
  if (list.length > MAX_BATCH_POSTS) return { ok: false, error: `一次最多处理 ${MAX_BATCH_POSTS} 条` };

  let deleted = 0;
  let removedImages = 0;
  const failedItems = [];
  for (const id of list) {
    // silent：逐条失效缓存/广播会重复 N 次，这里统一在下面收尾一次
    const r = deletePost(id, { silent: true });
    if (r.ok) { deleted++; removedImages += r.removedImages || 0; }
    else failedItems.push({ id, error: r.error });
  }
  if (deleted > 0) {
    try { invalidateGalleryCache(); } catch { /* ignore */ }
  }
  console.log(`[media] 批量删除：请求 ${list.length} 条，成功 ${deleted}，失败 ${failedItems.length}，清理图片 ${removedImages} 张`);
  // T5：批量删除记**一条汇总**（逐条记会刷屏，且批量入口才是用户看到的那次操作）
  if (deleted > 0) {
    recordMediaOp({
      opType: 'batch_delete', targetType: 'post', targetId: null,
      targetName: `批量删除 ${deleted} 条`,
      count: deleted,
      detail: `批量删除内容：成功 ${deleted} / 请求 ${list.length}，清理图片 ${removedImages} 张`,
      snapshot: { requested: list.length, deleted, failed: failedItems.length, removedImages, ids: list.slice(0, 50) },
    });
  }
  return { ok: true, requested: list.length, deleted, removedImages, failed: failedItems.length, failedItems: failedItems.slice(0, 20) };
}

/**
 * 批量重新生图。
 *
 * 逐条复用 `regeneratePostImage`（清空 image + payload.panels[].image 并置回 pending）。
 * 注意它内部每条都会调一次 `fillPendingImages` —— 批量时会排队 N 次，
 * 串行队列在执行时重新查询缺图，不会为已经完成的帖子重复生图。
 */
export function regeneratePostImages(ids) {
  const list = normalizePostIds(ids);
  if (!list.length) return { ok: false, error: '没有选中任何内容' };
  if (list.length > MAX_BATCH_POSTS) return { ok: false, error: `一次最多处理 ${MAX_BATCH_POSTS} 条` };

  let queued = 0;
  let clearedImages = 0;
  const failedItems = [];
  for (const id of list) {
    const r = regeneratePostImage(id);
    if (r.ok) { queued++; clearedImages += r.cleared || 0; }
    else failedItems.push({ id, error: r.error });
  }
  console.log(`[media] 批量重新生图：请求 ${list.length} 条，已排队 ${queued}，失败 ${failedItems.length}`);
  return { ok: true, requested: list.length, queued, clearedImages, failed: failedItems.length, failedItems: failedItems.slice(0, 20) };
}

/**
 * 「下次自动抓帖时刻」的持久化键。
 *
 * ★ 为什么必须落库：调度器是**每分钟 tick**，而 3099 由启动器以 `node --watch` 跑 ——
 *   改任何源码都会重启进程。若把下次时刻只放内存，每次重启都会重置，
 *   要么立刻抓一批、要么永远抓不到，错峰也就无从谈起。
 */
export const MEDIA_NEXT_AUTO_AT_KEY = 'media_next_auto_at';

function readNextAutoAt() {
  try {
    const raw = getSetting(MEDIA_NEXT_AUTO_AT_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}
function writeNextAutoAt(ts) {
  try { setSetting(MEDIA_NEXT_AUTO_AT_KEY, String(Math.round(ts))); } catch { /* 写不进去下轮再排 */ }
}

export function maybeAutoGenerate(now = Date.now()) {  // ⚠️ 这里**不再**每轮扫描补图。
  //
  // 原来每次 tick（1 分钟）都无条件调 `fillPendingImages(8)`，配合已被移除的橱窗预生成，
  // 会让 ComfyUI 持续满负载（实测 30 分钟被派单 46 次）。
  // 现在改为**纯按需**：只在①生成新批次后立即补那一批 ②前端打开传媒页时兜底补一次。
  // 没有任何"后台定时扫描出图"的路径。

  /*
   * 自动抓帖：**每晚 N 批 + 夜间窗口内错峰随机**（2026-10-05 改）。
   *
   * 与旧实现的区别：
   *   · 旧：`now - lastAutoAt >= 固定间隔` → 24 小时均匀铺开，白天也在产内容；
   *   · 新：把"下次时刻"落库（`media_next_auto_at`），到点且**落在夜间窗口内**才动手，
   *        动完立刻排下一次（在窗口内随机）。
   *
   * 「先排下一次、再生成」是刻意的：生成可能失败或进程中途重启，
   * 但排期已经推进，不会卡在同一个时刻上反复重试（那是"卡死重试"的典型成因）。
   */
  const perNight = autoPerNight();
  if (perNight === 0) return null;
  if (generating) return null;

  const nextAt = readNextAutoAt();
  if (nextAt == null) {
    // 还没排过（刚开启 / 老库没有这个键）→ 先排一次，本轮不生成
    writeNextAutoAt(nextAutoAt(now, perNight));
    console.log(`[media] 自动抓帖已排期：每晚 ${perNight} 批，下次 ${new Date(readNextAutoAt()).toLocaleString()}`);
    return null;
  }
  if (now < nextAt) return null;

  // 到点了，但可能已经天亮（进程夜间没开机）→ 不补跑，直接排到下一个窗口
  if (!isWithinNightWindow(now)) {
    writeNextAutoAt(nextAutoAt(now, perNight));
    return null;
  }

  const hasOutlet = getDb().prepare('SELECT 1 FROM media_outlets WHERE enabled = 1 LIMIT 1').get();
  if (!hasOutlet) return null;

  lastAutoAt = now;
  writeNextAutoAt(nextAutoAt(now, perNight));   // 先推进排期，再生成
  return generateMediaBatch({ count: AUTO_BATCH_SIZE })
    .then(r => console.log(`[media] 自动补充：「${r.outletName}」+${r.inserted} 条`))
    .catch(err => console.error('[media] 自动补充失败:', err.message));
}

/**
 * 把卡在 `generating` 的帖子放回 `pending`。两种模式，判据完全不同 —— 别混用：
 *
 * · **不带年龄（启动 / 手动清理）**：进程刚启动时不存在"正在生成"的帖子，
 *   所以 DB 里所有 generating 必然是上次中断的遗留，全量重置是安全的。
 * · **带 maxAgeMs（运行期定时自愈）**：只有「本进程记录的开跑时刻」已超过阈值才算卡死。
 *   记录在 `imageClaims`（claimPostForImage 时写入），**不是**帖子 `created_at`。
 *
 * ⚠️⚠️ 判据绝不能用 `created_at` —— 那是**帖子创建时间**，不是**生图开始时间**。
 * 曾经它被放在 `fillPendingImages()` 开头（等于每分钟跑一次）并这样判"卡了多久"：
 * 一个「创建于 10 分钟前、此刻正在生成中」的帖子被误判为卡死 → 重置 pending
 * → 下一轮又被捞去生成 → 再被重置……**形成无限重生循环，ComfyUI 被持续打满**。
 * （2026-10-04 实测：30 分钟内被反复派单 46 次、同一 prompt 重生 4 次。）
 * 运行期模式必须同时满足「每 5 分钟才扫一次」+「30 分钟才判超时」两道闸。
 *
 * @param {{maxAgeMs?: number|null}} [opts] 不传/传 null = 全量重置（仅限启动与手动清理）
 * @returns {number} 重置了几条
 */
export function resetStaleMediaGenerating({ maxAgeMs = null } = {}) {
  try {
    const db = getDb();
    if (!maxAgeMs) {
      const r = db.prepare(`
        UPDATE media_posts SET image_status = 'pending', image_error = '上次生成被中断，已重置'
        WHERE image_status = 'generating'
      `).run();
      if (r.changes > 0) console.log(`[media] 启动自愈：重置了 ${r.changes} 条中断的配图状态`);
      imageClaims.clear();
      return r.changes;
    }

    const now = Date.now();
    const rows = db.prepare("SELECT id FROM media_posts WHERE image_status = 'generating'").all();
    // 没有记录 = 不是本进程在跑（重启遗留由启动自愈清过；其余只可能是异常路径）→ 也按卡死处理。
    const stale = rows.filter(({ id }) => {
      const startedAt = imageClaims.get(id);
      return !startedAt || now - startedAt >= maxAgeMs;
    });
    if (!stale.length) return 0;
    const minutes = Math.max(1, Math.round(maxAgeMs / 60000));
    const update = db.prepare(`
      UPDATE media_posts SET image_status = 'pending', image_error = ?
      WHERE id = ? AND image_status = 'generating'
    `);
    let changed = 0;
    db.transaction(() => {
      for (const { id } of stale) {
        if (update.run(`配图生成超过 ${minutes} 分钟未完成，已重新排队`, id).changes === 1) {
          changed++;
          imageClaims.delete(id);
        }
      }
    })();
    if (changed > 0) console.log(`[media] 配图超时自愈：重置了 ${changed} 条卡在 generating 的帖子`);
    return changed;
  } catch (err) {
    console.error('[media] resetStaleMediaGenerating 失败:', err.message);
    return 0;
  }
}

/**
 * BUG-02：配图自愈闸 —— 调度器每分钟 tick 调一次，但**实际动作每 5 分钟最多一次**、
 * 每次最多补 `IMAGE_HEAL_LIMIT` 张。先释放超时的 generating（否则它抢不到补图机会），
 * 再走正常的补图队列（队列本身串行 + CAS 抢占，两条补图路径不会重复生同一张）。
 *
 * ⚠ 历史上「每分钟无条件补图」把 ComfyUI 打满过（30 分钟派单 46 次），
 * 所以间隔、批量、超时三个常数只能更保守，不许放宽。测试用 `force` 跳过节流。
 * @returns {Promise<{reset:number, filled:number}|null>} 被节流时返回 null
 */
export async function healStuckMediaImages({ now = Date.now(), force = false } = {}) {
  if (!force && now - lastImageHealAt < IMAGE_HEAL_INTERVAL_MS) return null;
  lastImageHealAt = now;
  const reset = resetStaleMediaGenerating({ maxAgeMs: IMAGE_HEAL_STALE_MS });
  let filled = 0;
  try {
    filled = await fillPendingImages(IMAGE_HEAL_LIMIT);
  } catch (err) {
    console.error('[media] 定时补图失败:', err.message);
  }
  if (reset > 0 || filled > 0) console.log(`[media] 配图自愈：重置 ${reset} 条 / 补上 ${filled} 张`);
  return { reset, filled };
}

/** 配图自愈节流状态（仅测试用：复位"上次补图时刻"） */
export function __resetMediaHealThrottleForTest() {
  lastImageHealAt = 0;
}

/** 生成中的内部时刻表（仅测试用：模拟「这条已经跑了 N 毫秒」；at=null 清除） */
export function __setImageClaimForTest(postId, at = Date.now()) {
  if (at == null) imageClaims.delete(postId);
  else imageClaims.set(postId, at);
}

/**
 * 清理未被任何帖子引用的孤儿配图文件。
 *
 * 重复生图的历史遗留：目录里的文件数远多于 DB 引用数（实测 81 vs 37）。
 * 现在虽然加了 CAS 防护不会再产生新的，但存量孤儿会白占磁盘，需要清一次。
 *
 * ⚠ 引用口径 = 主图 + payload.panels[].image + payload.sections[].image
 *   （与 deletePost 的清理清单完全一致，改一处必须同时改另一处）。
 * @param {number} [maxAgeMs] 只清理「这么久以前」的文件，避免误删正在写入的
 * @returns {{scanned:number, removed:number}}
 */
export function cleanupOrphanMediaImages(maxAgeMs = 60 * 60 * 1000) {
  try {
    const dir = getImageDir('media');
    if (!fs.existsSync(dir)) return { scanned: 0, removed: 0 };
    // ★ F-02 修复（2026-10-12）：引用口径必须与 deletePost（本文件上方「删除一条内容」）
    // 完全对齐 —— 除主图 `media_posts.image` 外，海报面板图 / 门户分节图**只存在 payload_json
    // 里**（payload.panels[].image / payload.sections[].image）。原实现只查 image 列，
    // 这两类图对清理器不可见 → 每次启动约 3 分钟后被当孤儿删除，而 DB 仍指向已删文件：
    // 海报小图 / 门户板块图永久空白（且 panel.image 为真值，自动补图会跳过重生成）。
    // 另：文件名提取与 deleteImageFileByUrl 同口径（去 query → 取末段 → decode），防编码文件名。
    const referenced = new Set();
    const addRef = (u) => {
      if (!u) return;
      let name = String(u).split('?')[0].split('/').pop() || '';
      try { name = decodeURIComponent(name); } catch { /* 非法编码：按原样 */ }
      if (name) referenced.add(name);
    };
    const refRows = getDb().prepare(
      `SELECT image, payload_json FROM media_posts
        WHERE (image IS NOT NULL AND image <> '') OR (payload_json IS NOT NULL AND payload_json <> '')`
    ).all();
    for (const r of refRows) {
      addRef(r.image);
      const payload = safeParse(r.payload_json, null);
      if (Array.isArray(payload?.panels)) {
        for (const p of payload.panels) addRef(p?.image);
      }
      if (Array.isArray(payload?.sections)) {
        for (const s of payload.sections) addRef(s?.image);
      }
    }
    let scanned = 0, removed = 0;
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('media_')) continue;      // 只看本模块产生的文件
      scanned++;
      if (referenced.has(f)) continue;
      const full = path.join(dir, f);
      try {
        if (now - fs.statSync(full).mtimeMs < maxAgeMs) continue;  // 太新，可能在写
        fs.unlinkSync(full);
        removed++;
      } catch { /* 单个失败不影响其余 */ }
    }
    if (removed > 0) {
      console.log(`[media] 清理孤儿配图 ${removed} 个（扫描 ${scanned}）`);
      // T5：清理也是破坏性操作，留一条痕（含扫描规模，便于日后核对"是不是误清"）
      recordMediaOp({
        opType: 'cleanup', targetType: 'post', targetId: null,
        targetName: `清理孤儿配图 ${removed} 个`,
        count: removed,
        detail: `清理孤儿配图：删除 ${removed} / 扫描 ${scanned} 个未被引用的文件`,
        snapshot: { scanned, removed, maxAgeMs },
      });
    }
    return { scanned, removed };
  } catch (err) {
    console.error('[media] cleanupOrphanMediaImages 失败:', err.message);
    return { scanned: 0, removed: 0 };
  }
}

/**
 * 距下次自动抓帖还有多久（前端「下次约 X 后」倒计时用）。
 * 关闭时返回 null。
 */
/**
 * 自动抓帖状态（供设置页显示「下次大概什么时候」）。
 *
 * `nextInMs` 现在来自**落库的排期**（`media_next_auto_at`），不是"上次 + 固定间隔" ——
 * 因为新模型是夜间窗口内错峰随机，没有固定间隔可言。
 */
export function getAutoState() {
  const perNight = autoPerNight();
  if (perNight === 0) {
    return { perNight: 0, nextInMs: null, nextAt: null, inNightWindow: isWithinNightWindow(Date.now()), generating: !!generating };
  }
  const nextAt = readNextAutoAt();
  return {
    perNight,
    nextAt: nextAt ? new Date(nextAt).toISOString() : null,
    nextInMs: nextAt ? Math.max(0, nextAt - Date.now()) : null,
    inNightWindow: isWithinNightWindow(Date.now()),
    generating: !!generating,
  };
}
