// 旅程到达调度器（星图 T15）—— 让「在途」这件事自己走完，不依赖有人打开页面。
//
// ── 为什么要它（而不是只靠"读的时候顺手结算"）──────────────────
// 读时结算（`getTripWorldContext` 里）只在有人取这个世界观时才触发；
// 角色半夜到站、没人开聊天 → 不结算 → 第二天早上日程仍按出发地排。
// 所以需要一个固定的心跳把到期旅程推进到「已到达 + 已改绑」。
//
// ── 为什么 60 秒 ─────────────────────────────────────────
// 旅程时长以小时计（默认 6），1 分钟的精度远够；再密就是空转。
// `unref()`：不让这个定时器拖住进程退出。

import { finalizeDueTrips } from '../db/index.js';

const TICK_MS = 60 * 1000;

let timer = null;
let running = false;

/** 扫一轮（导出让测试/接口能手动触发，不必等心跳） */
export function sweepTripsOnce() {
  if (running) return [];
  running = true;
  try {
    return finalizeDueTrips();
  } catch (err) {
    // 单轮失败不该让心跳停摆（下一次还会试）
    console.warn(`[tripScheduler] 扫描到期旅程失败: ${err.message}`);
    return [];
  } finally {
    running = false;
  }
}

export function startTripScheduler() {
  if (timer) return;
  // 启动时先扫一次：上次进程退出时可能留有"已到期但没结算"的旅程
  try {
    const boot = sweepTripsOnce();
    if (boot.length) console.log(`[tripScheduler] 启动补结算 ${boot.length} 段旅程`);
  } catch { /* sweepTripsOnce 内部已兜住 */ }

  timer = setInterval(() => { sweepTripsOnce(); }, TICK_MS);
  timer.unref?.();
  console.log(`[tripScheduler] 已启动（每 ${TICK_MS / 1000}s 检查到期旅程）`);
}

export function stopTripScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
