/**
 * 星图 T13 —— 世界文本缓存（memo）回归测试。
 *
 * 要守住的不是"有没有缓存"，而是**缓存不许让用户改的东西看不见**：
 *  ① 命中真的发生（否则等于没做）；
 *  ② 建/改/删/激活世界后立刻看到新结果；
 *  ③ 角色改绑、发起/取消旅程后立刻切换世界语境（T15 的在途语境也在这条链上）；
 *  ④ 项目库（project.json）被 UI 写、被手改，都要立刻反映到注入文本（含氛围节裁剪）；
 *  ⑤ 没人 bump 的外部修改，靠 TTL 兜底（本测试把 TTL 调到 80ms 来验）。
 *
 * 为什么单独一个文件：这些断言全是"第一次拿到 A、改完必须拿到 B"的时序题，
 * 和 worldProjectLibrary.test.js 的静态护栏不是一类东西。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
const TMP_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-world-cache-'));
process.env.LINSHE_WORLD_PROJECTS_DIR = TMP_PROJECTS;
// 短 TTL：让「没人 bump 的外部修改」这一条能在测试里几毫秒内验证
process.env.WORLD_MEMO_TTL_MS = '80';
globalThis.fetch = async (url) => { throw new Error(`world cache test forbids network: ${url}`); };

const db = await import('../src/db/index.js');
const { loadFeatureMigrations } = await import('../src/db/migrations/index.js');
const { runRegisteredMigrations } = await import('../src/db/migrationRegistry.js');
await loadFeatureMigrations();
runRegisteredMigrations(db.getDb());   // character_trips 由 009 建（T15 的旅程链路要验）
const lib = await import('../src/services/worldProjectLibrary.js');
const { bumpWorldCache, __resetWorldCacheSignalForTest } = await import('../src/db/worldCacheSignal.js');

const database = db.getDb();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeChar(name) {
  return Number(database.prepare(
    `INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '测试人格')`
  ).run(name, name).lastInsertRowid);
}

// ── ① 命中确实发生 ───────────────────────────────────────
test('★★ T13：同一角色连续取世界 → 第二次起命中缓存（不再重建）', () => {
  db.__resetWorldCacheForTest();
  const w = db.createWorldSetting({ name: '缓存A', content: '# A\n缓存测试正文A\n' });
  db.activateWorldSetting(w.id);
  const cid = makeChar('缓存角色1');

  const first = db.getWorldSetting(cid);
  const buildsAfterFirst = db.getWorldCacheStats().world.builds;
  const second = db.getWorldSetting(cid);
  const stats = db.getWorldCacheStats();

  assert.equal(first, second, '两次结果必须一致');
  assert.ok(first.includes('缓存测试正文A'), '内容正确');
  assert.equal(stats.world.misses, 1, '第一次应未命中');
  assert.ok(stats.world.hits >= 1, '第二次应命中');
  assert.equal(stats.world.builds, buildsAfterFirst, '命中时不应再重建');
});

// ── ② 世界写入口立刻失效 ──────────────────────────────────
test('★★★ T13：改世界正文 / 改名字 / 激活切换后，下一次立刻是新结果（不许读到旧值）', () => {
  db.__resetWorldCacheForTest();
  const a = db.createWorldSetting({ name: '失效A', content: '# A\n旧正文AAA\n' });
  const b = db.createWorldSetting({ name: '失效B', content: '# B\n另一个世界BBB\n' });
  db.activateWorldSetting(a.id);
  const cid = makeChar('缓存角色2');

  assert.ok(db.getWorldSetting(cid).includes('旧正文AAA'), '初始吃 A');

  db.updateWorldSetting(a.id, { content: '# A\n新正文AAA\n' });
  assert.ok(db.getWorldSetting(cid).includes('新正文AAA'), '改正文后必须立刻生效');
  assert.ok(!db.getWorldSetting(cid).includes('旧正文AAA'), '不许残留旧正文');

  db.activateWorldSetting(b.id);
  assert.ok(db.getWorldSetting(cid).includes('另一个世界BBB'), '激活切换后未绑定角色应跟着换');

  // 删世界的缓存风险 = 「世界都删了，prompt 里还在念它」
  //   绑定过的世界删不掉（T12 引用保护），所以先绑 → 解绑 → 再删
  const doomed = db.createWorldSetting({ name: '待删世界', content: '# 待删\n这个世界的正文不该残留\n' });
  database.prepare('UPDATE characters SET world_setting_id = ? WHERE id = ?').run(doomed.id, cid);
  db.invalidateWorldCache('test.bind');
  assert.ok(db.getWorldSetting(cid).includes('这个世界的正文不该残留'));
  database.prepare('UPDATE characters SET world_setting_id = NULL WHERE id = ?').run(cid);
  db.invalidateWorldCache('test.unbind');
  assert.equal(db.deleteWorldSetting(doomed.id).ok, true, '没有引用时应能删除');

  const afterDelete = db.getWorldSetting(cid);
  assert.ok(!String(afterDelete).includes('这个世界的正文不该残留'), '删掉的世界一个字都不许再出现在 prompt 里');
  assert.ok(String(afterDelete).includes('另一个世界BBB'), '应立刻按仍存在的激活世界解析');
});

// ── ③ 角色改绑 / 旅程 ─────────────────────────────────────
test('★★★ T13：角色改绑世界后立刻换语境；发起/取消旅程也立刻切换', () => {
  db.__resetWorldCacheForTest();
  const w1 = db.createWorldSetting({ name: '改绑一', content: '# 一\n改绑世界一号\n' });
  const w2 = db.createWorldSetting({ name: '改绑二', content: '# 二\n改绑世界二号\n' });
  // ★ 2026-10-18 世界分层：这里**不能**把 w1 设为主世界 —— 主世界是骨架，
  //   不是可去的地方（createTrip 会以 CORE_WORLD 拒绝）。本用例只需要 w1 是"一个副世界"。
  //   原先的 activateWorldSetting 调用是分层前的语义（"默认具体世界"），已无必要。
  const cid = makeChar('缓存角色3');
  database.prepare('UPDATE characters SET world_setting_id = ? WHERE id = ?').run(w1.id, cid);

  assert.ok(db.getWorldSetting(cid).includes('改绑世界一号'));

  // 直接改库不会 bump（这是"绕过 API 的写"），所以先用 API 那条路：invalidateWorldCache
  database.prepare('UPDATE characters SET world_setting_id = ? WHERE id = ?').run(w2.id, cid);
  db.invalidateWorldCache('test.rebind');
  assert.ok(db.getWorldSetting(cid).includes('改绑世界二号'), '改绑后必须换世界');

  // 旅程：发起 → 旅途语境；取消 → 回到出发世界
  const trip = db.createTrip({ characterId: cid, toWorldId: w1.id, transport: 'train', durationHours: 4 });
  assert.equal(trip.ok, true, trip.error);
  const during = db.getWorldSetting(cid);
  assert.match(during, /旅途/, '发起旅程后应立刻是旅途语境');
  assert.ok(!during.includes('改绑世界二号'), '在途时出发地正文不许出现');

  db.cancelTrip(trip.item.id);
  assert.ok(db.getWorldSetting(cid).includes('改绑世界二号'), '取消后应立刻回到原世界');
});

// ── ④ 项目库：UI 写、手改，都要立刻生效（含氛围节裁剪）──
test('★★★ T13：project.json 声明/撤销氛围节后，注入文本立刻跟着变（项目库缓存 + 世界缓存都要失效）', () => {
  db.__resetWorldCacheForTest();
  const content = '# 世界\n## 人们的行为\n这里的人下班后都去河边坐着。\n## 硬规则\n不得出现现代武器。\n';
  const w = db.createWorldSetting({ name: '项目库世界', content });
  db.activateWorldSetting(w.id);
  const cid = makeChar('缓存角色4');
  const slug = lib.slugForWorld('项目库世界', w.id);
  // ⚠ createWorldSetting 会 scaffoldProject 并**猜**氛围节（`## 人们的行为` 正好是唯一被猜的标题）
  //   → 先把声明归零，才能验证"未声明 = 全留"
  lib.writeProject(slug, { ...lib.neutralProject(), ambienceSections: [] });

  // 默认不声明 → 原样全留
  const before = db.getWorldSetting(cid);
  assert.ok(before.includes('这里的人下班后都去河边坐着'), '未声明氛围节应保留');
  assert.ok(before.includes('不得出现现代武器'), '规则也要保留');

  // 声明「人们的行为」为氛围节 → 该节被裁
  lib.writeProject(slug, { ...lib.neutralProject(), ambienceSections: ['人们的行为'] });
  const after = db.getWorldSetting(cid);
  assert.ok(!after.includes('这里的人下班后都去河边坐着'), '声明后该节应被裁掉');
  assert.ok(after.includes('不得出现现代武器'), '未声明的规则必须留着');

  // 撤销声明 → 恢复
  lib.writeProject(slug, { ...lib.neutralProject(), ambienceSections: [] });
  const restored = db.getWorldSetting(cid);
  assert.ok(restored.includes('这里的人下班后都去河边坐着'), '撤销声明后应恢复');
});

test('★★ T13：手改 project.json（不经 writeProject）也要被 mtime 检出', async () => {
  const slug = lib.slugForWorld('手改世界', 999001);
  lib.writeProject(slug, { ...lib.neutralProject(), ambienceSections: [] });
  const first = lib.readProject(slug);
  assert.deepEqual(first.ambienceSections, []);

  const file = path.join(lib.projectDirFor(slug), 'project.json');
  await sleep(12); // 让 mtime 明确变化
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, slug, ambienceSections: ['手改节'], vocabHints: ['手改提示'] }), 'utf8');

  const second = lib.readProject(slug);
  assert.deepEqual(second.ambienceSections, ['手改节'], '手改后应读到新声明');
  assert.deepEqual(second.vocabHints, ['手改提示']);
});

// ── ⑤ TTL 兜底 + 统计形状 ────────────────────────────────
test('★★ T13：没人 bump 的外部改动，靠 TTL 兜底（短 TTL 下生效）', async () => {
  db.__resetWorldCacheForTest();
  const w = db.createWorldSetting({ name: 'TTL世界', content: '# TTL\nTTL正文甲\n' });
  db.activateWorldSetting(w.id);
  const cid = makeChar('缓存角色5');

  assert.ok(db.getWorldSetting(cid).includes('TTL正文甲'));
  // 直接改库（模拟"绕过所有入口"的写入）→ 没有 bump
  database.prepare('UPDATE world_settings SET content = ? WHERE id = ?').run('# TTL\nTTL正文乙\n', w.id);
  assert.ok(db.getWorldSetting(cid).includes('TTL正文甲'), '未过期前读到的仍是缓存（预期行为）');

  await sleep(120); // 超过 80ms TTL
  assert.ok(db.getWorldSetting(cid).includes('TTL正文乙'), 'TTL 到期后应自动重建');
});

test('★ T13：统计接口形状稳定（前端/排查脚本依赖）', () => {
  const s = db.getWorldCacheStats();
  assert.equal(typeof s.epoch, 'number');
  assert.equal(typeof s.world.hits, 'number');
  assert.equal(typeof s.world.misses, 'number');
  assert.equal(typeof s.world.builds, 'number');
  assert.equal(typeof s.world.ttlMs, 'number');
  assert.ok(Array.isArray(s.recentInvalidations), '失效留痕应是数组');
  assert.ok(s.project && typeof s.project.hits === 'number', '项目库统计应合并进来');
  assert.ok(Array.isArray(s.topChars), '用量度量：应给出各角色世界块体积排行');
  if (s.topChars.length) assert.equal(typeof s.topChars[0].chars, 'number');
});

test.after(() => {
  try { fs.rmSync(TMP_PROJECTS, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
  try { __resetWorldCacheSignalForTest(); } catch { /* 只影响后续测试的代数起点 */ }
});
