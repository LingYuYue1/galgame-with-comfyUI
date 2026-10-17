// 世界缓存失效信号（星图 T13）—— 一个只装计数器的极小模块。
//
// ── 为什么要单独一个文件（循环依赖）─────────────────────────
// `worldRepository` 缓存了「某角色此刻的世界文本」，而会改变这个结果的写入方有三个：
//   ① `worldRepository` 自己（建/改/删/激活世界）—— 同模块，直接失效没问题；
//   ② `routes/characters.js`（改绑 `characters.world_setting_id`）；
//   ③ `tripRepository`（发起/取消旅程、到达结算时改绑）。
// ②③ 都不能反向 import `worldRepository`（会成环：tripRepository ← worldRepository）。
// 所以把「代数」这种没有任何依赖的小东西单独放这里，谁都能 import。
//
// ── 语义 ────────────────────────────────────────────────
// `bump()` 把代数 +1 → 所有用旧代数建的缓存条目在下次读取时自动作废（惰性）。
// 不做主动清理：条目数上限就是角色数，没必要为它维护一套失效回调。
//
// ── 调试 ────────────────────────────────────────────────
// 每次 bump 记一笔「谁、为什么」，`GET /api/config/world-cache-stats` 能看到最近几次，
// 排查「改了世界但 prompt 没变」时第一眼就能看出是没失效还是别的问题。

let _epoch = 0;
const _log = [];          // 最近 N 次失效原因（只留痕，不阻断）
const LOG_LIMIT = 20;

/**
 * 让所有世界缓存失效。
 * @param {string} [reason] 人话原因，例如 'world.update#3' / 'character.rebind#12' / 'trip.create#7'
 */
export function bumpWorldCache(reason = 'unknown') {
  _epoch++;
  _log.push({ epoch: _epoch, reason, at: Date.now() });
  if (_log.length > LOG_LIMIT) _log.shift();
  return _epoch;
}

/** 当前代数（缓存条目必须带着它，读时比对） */
export function worldCacheEpoch() {
  return _epoch;
}

/** 最近失效记录（调试用；倒序，最新的在前） */
export function worldCacheLog() {
  return _log.slice().reverse();
}

/** 仅供测试：重置代数与日志（生产路径永远不清 —— 与迁移 registry 同口径） */
export function __resetWorldCacheSignalForTest() {
  _epoch = 0;
  _log.length = 0;
}
