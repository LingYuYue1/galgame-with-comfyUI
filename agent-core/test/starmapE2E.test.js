/**
 * 星图端到端回归（**路由层**）—— 2026-10-19
 *
 * ── 为什么要有这一条 ────────────────────────────────────────
 * 本仓 1800+ 条测试几乎全部**在服务层直调**（`import` service / repo 再调用函数）。
 * 好处是快、稳；代价是「URL → 路由 → 业务」这一层接线完全没有护栏：
 * 路由忘记把 `characterId` 传下去、参数名改了、挂载点写错，服务层测试全都是绿的。
 * 这不是假想 —— 星图 T08 的「36 处调用点」就是这么漏的（其中一处漏了 characterId，
 * 角色会读到别人的世界）。单点测试抓不到，只能靠真实使用撞出来。
 *
 * ── 怎么做的 ────────────────────────────────────────────────
 * 不引 `app.js`（它是启动脚本：建库、跑迁移、拉起十几个调度器、立刻 listen，不可导入），
 * 而是复用**生产同一套挂载表** `autoMountRoutes()` 在测试里拼一个真 express，
 * 监听到随机端口，用 fetch 走完整链路。于是挂载点 / 参数名 / 路由器中间件都是真的。
 *
 * ── 锁的链路 ────────────────────────────────────────────────
 *   建世界（POST）→ 世界列表（GET，含主世界标记）→ 地图按世界过滤（GET）
 *   → 角色归属 A → 发起旅程去 B（POST）→ 在途（GET）
 *   → 模拟到点 → 结算（POST /settle）→ 角色已改绑 B → 缓存统计接口仍自洽
 *
 * 不覆盖：LLM 生成类接口（要打桩，属于另一类测试）、前端。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-e2e-starmap-'));
process.env.DB_PATH = path.join(TMP, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP, 'images');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP, 'world-projects');
// 星图链路不该联网；真联网说明有用例漏打桩，宁可红
globalThis.fetch = () => { throw new Error('starmap e2e forbids outbound network'); };

const dbmod = await import('../src/db/index.js');
const { loadFeatureMigrations } = await import('../src/db/migrations/index.js');
const { runRegisteredMigrations } = await import('../src/db/migrationRegistry.js');
const express = (await import('express')).default;
const { autoMountRoutes } = await import('../src/routes/_autoMount.js');
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');

await loadFeatureMigrations();
runRegisteredMigrations(dbmod.getDb());
const db = dbmod.getDb();

// 起真服务（挂载表 = 生产那一套）
const app = express();
app.use(express.json({ limit: '20mb' }));
// ⚠ 并发跑全量时 `routeAutoMount.test.js` 会在 src/routes 里临时建 `zzprobe_route.js`
//   再删掉 —— 我们这条恰好要扫同一个目录。撞上就给一次重试，仍失败才算真失败。
for (let attempt = 1; ; attempt++) {
  try {
    await autoMountRoutes(app, { wrapRouterAsync });
    break;
  } catch (err) {
    if (attempt >= 2) throw err;
    await new Promise(r => setTimeout(r, 200));
  }
}
const server = app.listen(0);
let base = '';
await new Promise((resolve) => {
  if (server.listening) return resolve();
  server.once('listening', resolve);
});
base = `http://127.0.0.1:${server.address().port}`;

// 本地回环要走真 fetch —— 上面禁的是出站，这里换成本地实现
const realFetch = (await import('node:http')).default;
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = realFetch.request(`${base}${url}`, {
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 就留原文 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

after(() => {
  server.close();
  try { db.close(); } catch { /* 已关 */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('★★★ 星图全链路：建世界 → 角色归属 → 旅程在途 → 到达改绑（走真实路由表）', async () => {
  // ── ① 建两个副世界（走 POST，验 body 解析与响应形状）──
  const wA = await request('POST', '/api/config/world-settings', { name: '甲世界', content: '甲世界：浮在云海上的环形城。' });
  assert.equal(wA.status, 200, `建世界失败：${wA.text}`);
  const idA = wA.json.item.id;
  assert.ok(idA > 0);

  const wB = await request('POST', '/api/config/world-settings', { name: '乙世界', content: '乙世界：终年落雨的旧商店街。' });
  assert.equal(wB.status, 200);
  const idB = wB.json.item.id;

  // ── ② 世界列表：主世界（骨架）必须存在且被标记 ──
  const list = await request('GET', '/api/config/world-settings');
  assert.equal(list.status, 200);
  const core = list.json.list.find(w => Number(w.is_core) === 1);
  assert.ok(core, '世界列表里没有主世界（is_core=1）—— 分层骨架丢了');
  assert.ok(list.json.list.some(w => w.id === idA) && list.json.list.some(w => w.id === idB));

  // ── ③ 地图列表必须带出「归属世界」──
  //   前端不传 worldSettingId（`getWorldMaps()` 取全量后自己按世界分组），
  //   所以契约不是"按世界过滤"，而是**每一张图都要能说出自己属于谁**。
  //   这个字段丢了，星图里所有地图会挤进同一个世界。
  db.prepare('INSERT INTO world_maps (name, world_setting_id, note) VALUES (?, ?, ?)').run('甲图', idA, '');
  db.prepare('INSERT INTO world_maps (name, world_setting_id, note) VALUES (?, ?, ?)').run('乙图', idB, '');
  const maps = await request('GET', '/api/worldmap/maps');
  assert.equal(maps.status, 200);
  const byName = Object.fromEntries((maps.json.maps || []).map(m => [m.name, m]));
  assert.ok(byName['甲图'] && byName['乙图'], '地图列表少了刚建的图');
  assert.equal(Number(byName['甲图'].world_setting_id), idA, '甲图的世界归属错了');
  assert.equal(Number(byName['乙图'].world_setting_id), idB, '乙图的世界归属错了');

  // ── ④ 角色归属甲世界（直接插行：角色创建会触发生成，属于另一类测试）──
  const info = db.prepare(
    'INSERT INTO characters (name, display_name, base_prompt, world_setting_id) VALUES (?, ?, ?, ?)'
  ).run('e2e-char', '端到端角色', '性格安静，说话简短。', idA);
  const charId = Number(info.lastInsertRowid);

  // ── ⑤ 发起旅程：甲 → 乙 ──
  const trip = await request('POST', '/api/trips', { character_id: charId, to_world_id: idB, duration_hours: 2 });
  assert.equal(trip.status, 200, `发起旅程失败：${trip.text}`);
  assert.equal(trip.json.ok, true);

  // 在途状态：世界语境换成旅途（T15 的核心不变量）
  const active = await request('GET', `/api/trips/active/${charId}`);
  assert.equal(active.status, 200);
  assert.ok(active.json.item, '在途查询拿不到旅程');
  assert.equal(Number(active.json.item.to_world_id), idB, '在途摘要的目的地不对');
  assert.ok(active.json.item.remaining_minutes > 0, '在途剩余时间应大于 0');
  assert.equal(Number(active.json.item.from_world_id), idA, '在途摘要的出发地不对');

  // 在途时不能重复出发（四道闸之一，走路由看错误码有没有被吞）
  // 注意目的地仍填乙：她的**归属**还在甲，所以不会先撞 ALREADY_THERE，能真正测到"在途"这道闸。
  const dup = await request('POST', '/api/trips', { character_id: charId, to_world_id: idB, duration_hours: 2 });
  assert.equal(dup.status, 400);
  assert.equal(dup.json.code, 'ALREADY_IN_TRANSIT');

  // ── ⑥ 模拟到点 → 手动结算 ──
  db.prepare("UPDATE character_trips SET arrive_at = datetime('now', '-1 hour') WHERE character_id = ?").run(charId);
  const settled = await request('POST', '/api/trips/settle');
  assert.equal(settled.status, 200);
  assert.equal(settled.json.count, 1, `应结算 1 条，实际 ${settled.json.count}`);

  // ── ⑦ 到达即改绑：角色现在属于乙世界 ──
  const chars = await request('GET', '/api/characters');
  assert.equal(chars.status, 200);
  const all = chars.json.list || chars.json.characters || chars.json;
  const me = (Array.isArray(all) ? all : []).find(c => Number(c.id) === charId);
  assert.ok(me, '角色列表里找不到刚建的测试角色');
  assert.equal(Number(me.world_setting_id), idB, '到达后没有改绑到目的地世界');

  // ── ⑧ 世界缓存统计接口仍然自洽（T13 的观察面）──
  const stats = await request('GET', '/api/config/world-cache-stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.json && typeof stats.json === 'object');

  // ── ⑨ 收尾：删世界要挡住"还有角色住着"的那个（T12 引用保护走路由）──
  const delB = await request('DELETE', `/api/config/world-settings/${idB}`);
  assert.equal(delB.status, 400, '角色还住在乙世界，删除必须被拦');
  assert.equal(delB.json.code, 'WORLD_IN_USE', '拦是拦了，但错误码不对（前端按 code 分支提示）');
});
