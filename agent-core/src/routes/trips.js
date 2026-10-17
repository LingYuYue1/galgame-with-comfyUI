// 跨世界旅程接口（星图 T15）—— 自动挂载在 `/api/trips`（见 routes/_autoMount.js 约定式）。
//
// 口径全部在 `db/tripRepository.js`，本文件只负责：参数收窄 → 调仓储 → 转 HTTP 状态。
// 校验失败一律 400 且带 `code`，前端据此给具体提示（不吞成笼统的"操作失败"）。

import { Router } from 'express';
import {
  TRIP_STATUS,
  TRIP_TRANSPORTS,
  getTripDurationHours,
  getTripById,
  listTrips,
  createTrip,
  cancelTrip,
  finalizeDueTrips,
  getTripStatusFor,
} from '../db/index.js';

const router = Router();

/** 前端需要知道的静态信息：时长默认值 + 可选交通方式 */
router.get('/config', (req, res) => {
  res.json({
    duration_hours: getTripDurationHours(),
    transports: Object.entries(TRIP_TRANSPORTS).map(([value, v]) => ({ value, label: v.label })),
    statuses: TRIP_STATUS,
  });
});

/**
 * GET /api/trips?character_id=&world_id=&status=&limit=
 * 星图「旅程」页签：某个世界的全部旅程（出发地或目的地命中都算）。
 */
router.get('/', (req, res) => {
  const items = listTrips({
    characterId: req.query.character_id,
    worldId: req.query.world_id,
    status: req.query.status,
    limit: req.query.limit,
  });
  res.json({ ok: true, items, total: items.length });
});

/** GET /api/trips/active/:characterId —— 某角色此刻在途的那一段（没有 → item:null） */
router.get('/active/:characterId', (req, res) => {
  const item = getTripStatusFor(req.params.characterId);
  res.json({ ok: true, item });
});

/** GET /api/trips/character/:characterId —— 某角色的旅程历史（含在途/取消） */
router.get('/character/:characterId', (req, res) => {
  const items = listTrips({ characterId: req.params.characterId, limit: req.query.limit });
  res.json({ ok: true, items });
});

/** GET /api/trips/:id —— 单段 */
router.get('/:id', (req, res) => {
  const item = getTripById(req.params.id);
  if (!item) return res.status(404).json({ ok: false, code: 'NO_TRIP', error: '旅程不存在' });
  res.json({ ok: true, item });
});

/**
 * POST /api/trips —— 发起旅程
 * body: { character_id, to_world_id, transport?, scene?, note?, duration_hours? }
 *
 * ⚠ `duration_hours` 是**调试/临时**通道（默认取全局配置）。正常使用不传。
 */
router.post('/', (req, res) => {
  const {
    character_id: characterId,
    to_world_id: toWorldId,
    transport,
    scene,
    note,
    duration_hours: durationHours,
  } = req.body || {};

  const result = createTrip({ characterId, toWorldId, transport, scene, note, durationHours });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

/** POST /api/trips/:id/cancel —— 取消（原地不动） */
router.post('/:id/cancel', (req, res) => {
  const result = cancelTrip(req.params.id);
  if (!result.ok) {
    const status = result.code === 'NO_TRIP' ? 404 : 400;
    return res.status(status).json(result);
  }
  res.json(result);
});

/** POST /api/trips/settle —— 手动结算到期旅程（调试/兜底用） */
router.post('/settle', (req, res) => {
  const settled = finalizeDueTrips();
  res.json({ ok: true, settled, count: settled.length });
});

export default router;
