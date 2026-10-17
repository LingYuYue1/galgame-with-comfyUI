// 跨世界旅程仓储（星图 T15）—— 在途时间代价的唯一真源。
//
// ── 为什么单独一个模块 ─────────────────────────────────────
// 「在途」这件事会被三处消费：
//   ① 世界解析（`worldRepository.resolveBoundWorld` 要先问一句"她在路上吗"）；
//   ② 日程生成（在途日排「赶路」）；
//   ③ 星图「旅程」页签（列表 / 倒计时 / 取消）。
// 三处若各写一份 SQL，"谁算在途"迟早各说各话 —— 所以口径全部收口在这里。
//
// ── 时间口径（全库统一，别在 JS 里比）──────────────────────
// SQLite 的 `datetime('now')` 是 **UTC 文本** `YYYY-MM-DD HH:MM:SS`，定长 → 文本比较
// 等价于时间比较。所以：
//   · 到期判据一律写成 SQL 条件 `arrive_at <= datetime('now')`；
//   · 时间相加用 `datetime('now', '+N hours')`，不要 `new Date(Date.now()+N*3600e3)` 再
//     `toISOString()` 混进来（格式不同，文本比较立刻失效）。
// 这是本项目踩过的坑：把 UTC 当本地看，整段结论会差 8 小时。
//
// ── 依赖方向（单向，红线）──────────────────────────────────
// 本模块**不得** import `worldRepository.js` / `db/index.js`（会成环）。
// 需要世界名、角色名时直接查表；查不到就降级成「未知世界」，绝不让旅程功能瘫痪。
import { config } from '../config.js';

let _db = null;

/** db/index.js 打开数据库后注入句柄 */
export function initTripRepository(db) {
  _db = db;
}

function handle() {
  if (!_db) throw new Error('tripRepository: db handle not initialized (initTripRepository)');
  return _db;
}

/** 旅程状态 */
export const TRIP_STATUS = {
  TRANSIT: 'transit',     // 在途
  ARRIVED: 'arrived',     // 已到达（已改绑）
  CANCELLED: 'cancelled', // 已取消（原路不动）
};

/** 交通方式 → 中文名 + 语境提示（场景模板用） */
export const TRIP_TRANSPORTS = {
  train: { label: '列车', setting: '车厢里：座椅、车窗、过道与餐车，铁轨的节律声，报站' },
  ship: { label: '星舰', setting: '船舱里：舷窗外的深空、恒温循环风、引擎的低鸣，舱内广播' },
  walk: { label: '步行', setting: '路上：脚程、天光与风向的变化，路边的坡与树影，歇脚处' },
};

export function transportLabel(key) {
  return TRIP_TRANSPORTS[key]?.label || TRIP_TRANSPORTS.train.label;
}

// ─────────────────────────────────────────────────────────
// 时长
// ─────────────────────────────────────────────────────────

const MIN_HOURS = 1;
const MAX_HOURS = 168; // 一周封顶：再长就不是"旅程"而是"搬家"了

/** 全局统一时长（小时）—— 用户可在设置里改，这里只负责夹紧到合理区间 */
export function getTripDurationHours() {
  let v;
  try {
    v = Number(config.trip?.durationHours);
  } catch { v = NaN; }
  if (!Number.isFinite(v)) v = 6;
  return clampHours(v);
}

function clampHours(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 6;
  return Math.max(MIN_HOURS, Math.min(MAX_HOURS, n));
}

// ─────────────────────────────────────────────────────────
// 旅途语境文本
// ─────────────────────────────────────────────────────────

/**
 * 默认旅途语境（用户没自己写 scene 时用）。
 *
 * 写作纪律：
 *   · 只描述**在途**这一段，不写目的地风物 —— 世界观块在在途期间被本段**整体覆盖**，
 *     一旦掺进目的地设定，就等于把「覆盖不拼接」变成了拼接。
 *   · 明确告诉模型「还没到」，防它提前演到达。
 *   · 剩余时间按分钟给，短途不会是"还需 0 小时"这种怪句子。
 */
export function buildTripSceneText({ fromName, toName, transport, remainingMinutes, note } = {}) {
  const t = TRIP_TRANSPORTS[transport] || TRIP_TRANSPORTS.train;
  const remain = formatRemain(remainingMinutes);
  const from = fromName ? `「${fromName}」` : '原来待的地方';
  const to = toName ? `「${toName}」` : '目的地';
  const lines = [
    `【旅途 · 尚未抵达】此刻正在从${from}前往${to}的路上（${t.label}），预计还需 ${remain}。`,
    t.setting ? `场景是旅途本身 —— ${t.setting}。` : '',
    '这一段的空气、光线、气味都来自「在路上」：同行的人、行李、停靠与等待、还没落地的悬着感。',
    '**还没有到达**：不要描写目的地的街景、机构、行话与熟人，也不要把出发地的日常照搬过来。',
    note ? `旅伴/缘由：${note}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function formatRemain(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${Math.max(1, m)} 分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r >= 5 ? `${h} 小时 ${r} 分钟` : `${h} 小时`;
}

// ─────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────

/** 剩余分钟（SQL 里算，避免 JS 与 UTC 文本混算）；负数归零 */
const REMAIN_SQL = `CAST((julianday(arrive_at) - julianday('now')) * 24 * 60 AS INTEGER) AS remaining_minutes`;
/**
 * 是否已到期 —— 精确到秒，用 SQL 判，不要拿 `remaining_minutes <= 0` 代劳：
 * 分钟是向下取整，剩余 30 秒也会算成 0，那样会把"差 1 分钟到达"误判成"已到"，
 * 于是旅途语境提前消失、角色短暂回到出发地世界。这个坑留给注释，别再踩。
 */
const DUE_SQL = `(arrive_at <= datetime('now')) AS is_due`;

function shape(row) {
  if (!row) return null;
  return {
    ...row,
    transport_label: transportLabel(row.transport),
    remaining_minutes: Math.max(0, Number(row.remaining_minutes) || 0),
    is_due: Number(row.is_due) === 1,
    in_transit: row.status === TRIP_STATUS.TRANSIT,
  };
}

/** 某角色此刻在途的那一段（没有 → null） */
export function getActiveTrip(characterId) {
  const id = Number(characterId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  try {
    const row = handle().prepare(
      `SELECT *, ${REMAIN_SQL}, ${DUE_SQL} FROM character_trips WHERE character_id = ? AND status = ? ORDER BY id DESC LIMIT 1`
    ).get(id, TRIP_STATUS.TRANSIT);
    return shape(row);
  } catch {
    // 表还没建（老库迁移未跑 / 测试库）→ 当"不在途"，绝不阻断世界观解析
    return null;
  }
}

export function getTripById(id) {
  const tid = Number(id);
  if (!Number.isSafeInteger(tid) || tid <= 0) return null;
  try {
    const row = handle().prepare(`SELECT *, ${REMAIN_SQL}, ${DUE_SQL} FROM character_trips WHERE id = ?`).get(tid);
    return shape(row);
  } catch { return null; }
}

/**
 * 旅程列表。
 * @param {object} [opts]
 * @param {number} [opts.characterId] 只看某角色
 * @param {number} [opts.worldId]     出发地或目的地命中这个世界的都算（星图世界页签用）
 * @param {string} [opts.status]      只看某状态
 * @param {number} [opts.limit]       默认 50，上限 200
 */
export function listTrips(opts = {}) {
  const where = [];
  const params = [];
  if (opts.characterId != null && opts.characterId !== '') {
    where.push('character_id = ?');
    params.push(Number(opts.characterId));
  }
  if (opts.worldId != null && opts.worldId !== '') {
    where.push('(from_world_id = ? OR to_world_id = ?)');
    params.push(Number(opts.worldId), Number(opts.worldId));
  }
  if (opts.status) {
    where.push('status = ?');
    params.push(String(opts.status));
  }
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  try {
    const rows = handle().prepare(
      `SELECT *, ${REMAIN_SQL}, ${DUE_SQL} FROM character_trips
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT ${limit}`
    ).all(...params);
    return rows.map(shape);
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────
// 创建 / 取消
// ─────────────────────────────────────────────────────────

function nameOfWorld(id) {
  if (id == null) return '';
  try {
    return handle().prepare('SELECT name FROM world_settings WHERE id = ?').get(Number(id))?.name || '';
  } catch { return ''; }
}

function nameOfCharacter(id) {
  try {
    const r = handle().prepare('SELECT display_name, name FROM characters WHERE id = ?').get(Number(id));
    return r?.display_name || r?.name || '';
  } catch { return ''; }
}

/**
 * 发起一段旅程。
 *
 * 校验顺序（每一步都返回结构化原因，路由层直接转 400）：
 *   ① 角色存在且未归档；② 目的地世界存在；③ 不在同一个世界（去了等于没去）；
 *   ④ 当前没有在途段（多段行程留到以后，先不给"排队"这种会出错的自由）。
 *
 * @returns {{ok:true, item:object}|{ok:false, code:string, error:string}}
 */
export function createTrip({ characterId, toWorldId, transport = 'train', scene = '', note = '', durationHours } = {}) {
  const db = handle();
  const cid = Number(characterId);
  const tw = Number(toWorldId);
  if (!Number.isSafeInteger(cid) || cid <= 0) return { ok: false, code: 'BAD_CHARACTER', error: '角色无效' };
  if (!Number.isSafeInteger(tw) || tw <= 0) return { ok: false, code: 'BAD_WORLD', error: '目的地世界无效' };

  const ch = (() => {
    try { return db.prepare('SELECT id, display_name, name, world_setting_id, archived FROM characters WHERE id = ?').get(cid); }
    catch { return null; }
  })();
  if (!ch) return { ok: false, code: 'NO_CHARACTER', error: '角色不存在' };
  if (Number(ch.archived) === 1) return { ok: false, code: 'ARCHIVED', error: '归档角色不能出行' };

  const target = (() => {
    try { return db.prepare('SELECT id, name FROM world_settings WHERE id = ?').get(tw); }
    catch { return null; }
  })();
  if (!target) return { ok: false, code: 'NO_WORLD', error: '目的地世界不存在' };

  // ③ 「已经在那儿」判定：绑定世界优先；未绑定则看激活世界（= 此刻实际吃的那套设定）
  const effective = ch.world_setting_id != null
    ? Number(ch.world_setting_id)
    : (() => { try { return Number(db.prepare('SELECT id FROM world_settings WHERE is_active = 1 LIMIT 1').get()?.id) || null; } catch { return null; } })();
  if (effective === tw) {
    return { ok: false, code: 'ALREADY_THERE', error: `她已经在这个世界了（${target.name}）` };
  }

  // ④ 已有在途 → 拒绝（提示剩余时间，用户自己决定等还是取消）
  const active = getActiveTrip(cid);
  if (active) {
    return {
      ok: false,
      code: 'ALREADY_IN_TRANSIT',
      error: `她正在前往「${nameOfWorld(active.to_world_id) || '目的地'}」的路上，还需 ${formatRemain(active.remaining_minutes)}；要改主意先取消这一段`,
      activeTripId: active.id,
    };
  }

  const hours = clampHours(durationHours == null ? getTripDurationHours() : durationHours);
  const tp = TRIP_TRANSPORTS[transport] ? transport : 'train';
  const sceneText = String(scene || '').trim();
  const noteText = String(note || '').trim();

  try {
    const info = db.prepare(
      `INSERT INTO character_trips
         (character_id, from_world_id, to_world_id, status, transport, scene, note, started_at, arrive_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', ?))`
    ).run(cid, ch.world_setting_id ?? null, tw, TRIP_STATUS.TRANSIT, tp, sceneText, noteText, `+${hours} hours`);
    return { ok: true, item: getTripById(Number(info.lastInsertRowid)) };
  } catch (err) {
    return { ok: false, code: 'DB_ERROR', error: `发起旅程失败：${err.message}` };
  }
}

/** 取消在途旅程（原地不动，绑定保持出发前的样子） */
export function cancelTrip(id) {
  const db = handle();
  const tid = Number(id);
  if (!Number.isSafeInteger(tid) || tid <= 0) return { ok: false, code: 'BAD_ID', error: '旅程 id 无效' };
  const trip = getTripById(tid);
  if (!trip) return { ok: false, code: 'NO_TRIP', error: '旅程不存在' };
  if (trip.status !== TRIP_STATUS.TRANSIT) {
    return { ok: false, code: 'NOT_IN_TRANSIT', error: trip.status === TRIP_STATUS.ARRIVED ? '这段旅程已经结束了' : '这段旅程已经取消过了' };
  }
  try {
    db.prepare(
      `UPDATE character_trips SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?`
    ).run(TRIP_STATUS.CANCELLED, tid, TRIP_STATUS.TRANSIT);
    return { ok: true, item: getTripById(tid) };
  } catch (err) {
    return { ok: false, code: 'DB_ERROR', error: `取消失败：${err.message}` };
  }
}

// ─────────────────────────────────────────────────────────
// 到达结算
// ─────────────────────────────────────────────────────────

/**
 * 把到期旅程结算掉：**标记到达 + 改绑角色世界**。
 *
 * 幂等：更新语句带 `AND status='transit'` 且检查 `changes`；重复调用（调度器 + 读时兜底并发）
 * 只有一个能把状态推移，另一个 changes=0 直接跳过 —— 不会重复改绑、不会重复清日程。
 *
 * 为什么要清当日日程方案：日程是按「日子类型」缓存的（`schedule_day_plans`），
 * 不清的话角色已经落在目的地世界，明天却还在排出发地的职业与地点。
 * 只清方案、**不动今天已经快照过的日程** —— 她今天确实在路上，那份日程是真的。
 *
 * @param {object} [opts]
 * @param {number} [opts.characterId] 只结算这个角色（读时兜底用，避免全表扫）
 * @returns {Array<object>} 本次真正结算掉的旅程
 */
export function finalizeDueTrips(opts = {}) {
  const db = handle();
  const only = opts.characterId != null && opts.characterId !== '' ? Number(opts.characterId) : null;
  let due;
  try {
    due = only
      ? db.prepare(`SELECT * FROM character_trips WHERE status = ? AND character_id = ? AND arrive_at <= datetime('now')`).all(TRIP_STATUS.TRANSIT, only)
      : db.prepare(`SELECT * FROM character_trips WHERE status = ? AND arrive_at <= datetime('now')`).all(TRIP_STATUS.TRANSIT);
  } catch {
    return []; // 表未建（老库/测试库）
  }
  if (!due.length) return [];

  const done = [];
  const tx = db.transaction((rows) => {
    for (const t of rows) {
      const moved = db.prepare(
        `UPDATE character_trips SET status = ?, arrived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = ?`
      ).run(TRIP_STATUS.ARRIVED, t.id, TRIP_STATUS.TRANSIT);
      if (moved.changes === 0) continue; // 另一个调用者已经推过了

      const target = (() => {
        try { return db.prepare('SELECT id, name FROM world_settings WHERE id = ?').get(t.to_world_id); }
        catch { return null; }
      })();
      let rebound = false;
      if (!target) {
        // 目的地被删了（T12 的引用保护只看"角色当前绑定"，管不到"旅程目的地"）
        console.warn(`[trip] 旅程 #${t.id} 到期，但目的地世界 #${t.to_world_id} 已不存在 → 角色 #${t.character_id} 保持原绑定`);
      } else {
        db.prepare(`UPDATE characters SET world_setting_id = ? WHERE id = ?`).run(t.to_world_id, t.character_id);
        rebound = true;
      }

      // 日程方案失效（让下一次生成按新世界重排）；**只在实际改绑后**才清 ——
      // 目的地已删、人根本没换世界，却把人家的日程方案 wipe 了，那是纯损失。
      // 表可能不存在 → 静默；清了就记账，不静默删东西（用户可据此判断要不要重生成）。
      if (rebound) {
        try {
          const cleared = db.prepare('DELETE FROM schedule_day_plans WHERE character_id = ?').run(t.character_id);
          if (cleared.changes > 0) {
            console.log(`[trip] 角色 #${t.character_id} 换了世界 → 清空 ${cleared.changes} 份按日型日程方案（下次生成按新世界重排）`);
          }
        } catch { /* 老库没有这张表 */ }
      }

      done.push({ ...t, status: TRIP_STATUS.ARRIVED, to_world_name: target?.name || '' });
    }
  });
  try { tx(due); } catch (err) {
    console.warn(`[trip] 到期结算失败: ${err.message}`);
    return [];
  }

  for (const t of done) {
    console.log(`[trip] #${t.id} 到达：角色 #${t.character_id}（${nameOfCharacter(t.character_id) || '?'}）→ 世界「${t.to_world_name || t.to_world_id}」`);
  }
  return done;
}

/**
 * 给世界解析层用：某角色若在途，返回**旅途语境伪世界**；否则 null。
 *
 * 伪世界刻意长得像 `world_settings` 的行（id / name / content / tagline / visual_tone），
 * 这样 `getWorldSetting` 不用为旅程写第二条分支 —— 它照常包 `<world_setting>` 与裁剪。
 * `id: null` 是关键：它让 `slugForWorld(name, null)` 算出一个不存在的项目库 slug，
 * 于是**不走任何世界的氛围节裁剪**（旅途文本是自己写的，按别人的规则剪会剪坏）。
 */
export function getTripWorldContext(characterId) {
  const trip = getActiveTrip(characterId);
  if (!trip) return null;
  // 到期但调度器还没扫到 → 就地结算（幂等）。结算完她就不是"在途"，交回正常世界解析。
  if (trip.is_due) {
    finalizeDueTrips({ characterId });
    return null;
  }

  const fromName = nameOfWorld(trip.from_world_id);
  const toName = nameOfWorld(trip.to_world_id);
  const content = trip.scene?.trim()
    ? trip.scene.trim()
    : buildTripSceneText({
      fromName, toName, transport: trip.transport,
      remainingMinutes: trip.remaining_minutes, note: trip.note,
    });
  return {
    id: null,
    name: `前往「${toName || '目的地'}」的途中`,
    content,
    tagline: '',
    visual_tone: '',
    is_active: 0,
    is_enabled: 1,
    // ── 旅程专属标记（调用方若要区分"在途"与"某个世界"，认这个 ──
    __trip: true,
    trip_id: trip.id,
    from_world_id: trip.from_world_id,
    to_world_id: trip.to_world_id,
    arrive_at: trip.arrive_at,
    remaining_minutes: trip.remaining_minutes,
  };
}

/** 给 UI 用：某角色此刻的状态摘要（不在途 → null） */
export function getTripStatusFor(characterId) {
  const trip = getActiveTrip(characterId);
  if (!trip) return null;
  // 已到期但调度器还没扫到 → 就地结算再返回 null（与 getTripWorldContext 同口径：
  // 到点了就不该再对外说"还在途"，否则日程会照赶路日排）
  if (trip.is_due) {
    finalizeDueTrips({ characterId });
    return null;
  }
  return {
    id: trip.id,
    character_id: trip.character_id,
    from_world_id: trip.from_world_id,
    from_world_name: nameOfWorld(trip.from_world_id),
    to_world_id: trip.to_world_id,
    to_world_name: nameOfWorld(trip.to_world_id),
    transport: trip.transport,
    transport_label: trip.transport_label,
    remaining_minutes: trip.remaining_minutes,
    started_at: trip.started_at,
    arrive_at: trip.arrive_at,
    note: trip.note,
  };
}

export { formatRemain };
