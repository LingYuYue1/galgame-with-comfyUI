/**
 * loadGeneration.js — 异步加载的「世代号」守卫（F-22 竞态防护）
 *
 * ── 解决什么问题 ──────────────────────────────────────────────
 *
 * 详情弹窗一次打开会**并发**发起好几个异步请求（场景服装、场景立绘、外观列表、关系网）。
 * 若用户在请求飞行途中**切换到另一个角色**，先发出的那批响应会**迟到**回来，
 * 把新角色的界面数据覆盖成旧角色的 —— 更糟的是 `detail.dirty` 已是新角色的，
 * 于是「保存」有可能把 A 的外观**写进 B**（写库事故）。
 *
 * ── 怎么用 ────────────────────────────────────────────────────
 *
 *   const gen = createGeneration()
 *
 *   // 1) 每次发起一批新加载（例如切换角色）先取新世代：
 *   const g = gen.next()
 *
 *   // 2) 异步响应回来后判断是否仍属当前世代，不是就丢弃：
 *   const data = await api.something(id)
 *   if (!gen.isCurrent(g)) return   // 已被新的加载取代 → 不写界面状态
 *   state.value = data
 *
 * 世代号单调递增，旧世代的响应永远不可能再等于当前值，天然自废 ——
 * 无需记录「上一次是谁」，也无需手动取消请求。
 */
export function createGeneration() {
  let value = 0
  return {
    /** 进入下一个世代（作废此前所有未决请求），返回新世代号 */
    next() {
      return ++value
    },
    /** 当前世代号（从未调用 next 时为 0） */
    current() {
      return value
    },
    /** 给定的世代号是否仍是当前世代（旧的 → false，应当丢弃其响应） */
    isCurrent(gen) {
      return gen === value
    },
  }
}
