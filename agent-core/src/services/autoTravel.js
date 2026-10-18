/**
 * 角色自主旅游（2026-10-18）
 *
 * 「角色会自己出门」是本项目的原始设计意图，但 T15 当时只做了**手动**发起
 * （前端「前往…」按钮）。这里补上"她自己会走"的那一半：到点自动刷日程时
 * 掷一次骰子，命中就真的发起一段跨世界旅程。
 *
 * 为什么挂在「刷日程」而不是独立定时器：
 *   ① 日程生成时 `buildTripDayBlock` 会读在途状态 —— 先发起、再生成，
 *      当天日程自动变成"在路上"，不需要事后再去改一份已经排好的日程；
 *   ② 刷日程本来就是"按角色逐个、频率受控"的调度器，天然不会一口气把所有人放出门；
 *   ③ 独立定时器要自己处理节流、并发、和刷日程抢顺序 —— 多一套状态就多一处会错的地方。
 *
 * 四道闸（缺一不可）：
 *   ① 开关关 → 永不掷（默认关，红线 4）
 *   ② 她已经在路上 → 不掷（一段没走完不能再起一段）
 *   ③ 全局在途人数达上限 → 不掷（"所有人都在旅游"正是用户明确不要的）
 *   ④ 她没有归属世界 → 不掷（没有"家"的人不参与，免得替用户做归属决定）
 */
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { createTrip, getActiveTrip } from '../db/tripRepository.js';

/** 同时在路上的人数上限。1 = 一次只有一个人在外面（"偶尔有人出门"的观感） */
const MAX_CONCURRENT_TRAVELLERS = 1;

/**
 * 掷一次骰子，命中就发起旅程。
 *
 * **同步**（better-sqlite3 全同步），调用方不必 await。
 * 不抛错：旅游是锦上添花，任何一步不成立都安静地返回 null，
 * 绝不能让"她今天没出门"把日程刷新整条链路带崩。
 *
 * @param {{id:number, display_name?:string}} character
 * @returns {{ok:true, item:object}|null} 发起成功时返回 createTrip 的结果，否则 null
 */
export function maybeAutoTravel(character) {
  try {
    if (!config.features?.autoTravel) return null;
    const cid = Number(character?.id);
    if (!Number.isSafeInteger(cid) || cid <= 0) return null;

    const db = getDb();

    // 闸①：已经在路上
    if (getActiveTrip(cid)) return null;

    // 闸②：全局在途上限
    const inTransit = Number(
      db.prepare(`SELECT COUNT(*) AS n FROM character_trips WHERE status = 'transit'`).get()?.n || 0
    );
    if (inTransit >= MAX_CONCURRENT_TRAVELLERS) return null;

    // 闸③：她得有个"家"（归属一个副世界）。未归属角色吃主世界骨架，没有出发地。
    const home = Number(
      db.prepare(`SELECT world_setting_id AS wid FROM characters WHERE id = ?`).get(cid)?.wid
    );
    if (!Number.isSafeInteger(home) || home <= 0) return null;

    // 掷骰
    const chance = Number(config.trip?.autoTravelChance);
    if (!(chance > 0) || Math.random() >= chance) return null;

    // 目的地：启用中的副世界，排除她当前所在的那个。
    // 只有一个副世界 = 无处可去，安静放弃（不是错误）。
    const dest = db.prepare(`
      SELECT id, name FROM world_settings
      WHERE is_enabled = 1 AND is_core = 0 AND id <> ?
      ORDER BY RANDOM()
      LIMIT 1
    `).get(home);
    if (!dest) return null;

    // 交通方式：跨世界步行少见一些，但保留 —— "她一个人走了很远的路过来"也是一种叙事
    const transport = Math.random() < 0.18 ? 'walk' : (Math.random() < 0.55 ? 'train' : 'ship');

    const r = createTrip({ characterId: cid, toWorldId: dest.id, transport });
    if (!r?.ok) {
      // ALREADY_IN_TRANSIT / ALREADY_THERE 都是正常情况（并发下可能刚被人先发起），不吵
      return null;
    }
    console.log(
      `[autoTravel] ${character?.display_name || `#${cid}`} 自己出门了 → 「${dest.name}」（${transport}）`
    );
    return r;
  } catch (err) {
    console.warn('[autoTravel] 跳过：', err?.message || err);
    return null;
  }
}

/** 供测试与诊断：当前在途人数 */
export function countTravellers() {
  try {
    return Number(getDb().prepare(`SELECT COUNT(*) AS n FROM character_trips WHERE status = 'transit'`).get()?.n || 0);
  } catch {
    return 0;
  }
}

export const AUTO_TRAVEL_MAX_CONCURRENT = MAX_CONCURRENT_TRAVELLERS;
