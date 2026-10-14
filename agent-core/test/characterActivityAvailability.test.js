import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const { pickActiveCharacters } = await import('../src/services/mediaService.js');
const { pickFeaturedCharacter } = await import('../src/services/newspaperService.js');
const { getAllOverview } = await import('../src/services/scheduleManager.js');
const scheduler = await import('../src/services/momentScheduler.js');
const router = (await import('../src/routes/characters.js')).default;

// 本地二创**保留** `characters.archived`（归档 = 不参与任何主动行为）与
// 人设润色 / 单个·批量归档接口；上游 v3.8.0 把这些删掉属「上游删除动作」，本地不采纳。
// 本测试改为钉住「本地保留行为」：归档仍屏蔽主动行为，独立活动开关仍生效。
test('角色归档标记仍屏蔽主动行为，独立活动开关仍生效', async t => {
  const db = getDb();
  t.after(closeDb);
  // 测试库里 feature_momentFreq 种子值是 '0'（= 关闭自动发帖）；本测试要验证调度器选人，
  // 故显式打开频率闸门，让 runSchedulerTick 真正进入选人逻辑。
  config.features.momentFreq = 1;
  // 本地库**有** archived 列（上游 v3.8.0 已删除该列）
  assert.equal(db.prepare('PRAGMA table_info(characters)').all().some(c => c.name === 'archived'), true,
    '本地保留 characters.archived 列');
  db.prepare('UPDATE characters SET moments_disabled = 1, events_disabled = 1').run();
  db.prepare('UPDATE town_npcs SET moments_disabled = 1').run();
  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO characters (name, display_name, base_prompt, archived, moments_disabled, events_disabled, next_moment_at)
    VALUES ('archived_one', '归档角色', '测试人设', 1, 0, 0, datetime('now', '-1 hour'))
  `).run();
  // 独立最小库保证随机抽样只存在这一个（归档）候选。
  db.prepare('DELETE FROM characters WHERE id != ?').run(id);

  // 归档 = 不参与任何主动行为：日报主角 / 图库活跃角色 / 自动发帖 全部排除
  assert.equal(pickFeaturedCharacter(db), null, '归档角色不被日报抽为主角');
  assert.deepEqual(pickActiveCharacters(1).map(c => c.id), [], '归档角色不被图库抽为活跃角色');
  assert.ok(getAllOverview().some(c => c.id === id), '概览仍列出归档角色（只屏蔽主动行为，不隐藏卡片）');

  const calls = [];
  scheduler.setMomentPostGenerator(async character => { calls.push(character.id); });
  await scheduler.runSchedulerTick();
  assert.deepEqual(calls, [], '归档角色不参与自动发帖');

  // 取消归档后，独立活动开关（moments_disabled = 0）放开即可参与
  db.prepare('UPDATE characters SET archived = 0 WHERE id = ?').run(id);
  assert.equal(pickFeaturedCharacter(db)?.id, id, '取消归档后日报可抽到它');
  assert.deepEqual(pickActiveCharacters(1).map(c => c.id), [id], '取消归档后图库可抽到它');
  await scheduler.runSchedulerTick();
  assert.deepEqual(calls, [id], '取消归档后参与自动发帖');

  // 不看朋友圈的独立设置仍应拦截自动发帖（与归档无关的原行为）
  db.prepare("UPDATE characters SET moments_disabled = 1, next_moment_at = datetime('now', '-1 hour') WHERE id = ?").run(id);
  await scheduler.runSchedulerTick();
  assert.equal(calls.length, 1, '不看朋友圈的独立设置仍应拦截自动发帖');
});

// 本地有意**保留**人设润色（refine-persona-draft）与单个/批量归档（:id/archived、archived-all）接口；
// 上游 v3.8.0 移除属上游删除动作，不采纳。这里改为断言这些接口「本地仍可用」。
test('人设润色与单个/批量归档接口在本地仍可用', async () => {
  for (const [method, url] of [['POST', '/refine-persona-draft'], ['POST', '/archived-all'], ['PUT', '/1/archived']]) {
    const result = await new Promise((resolve, reject) => {
      const req = { method, url, body: {}, params: {} };
      const res = {
        status() { return this; },
        json() { resolve('handled'); },
      };
      router.handle(req, res, err => err ? reject(err) : resolve('not-found'));
    });
    assert.equal(result, 'handled', `${method} ${url} 本地保留可用`);
  }
});
