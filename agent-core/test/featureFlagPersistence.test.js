/**
 * 功能开关的「重启不丢」守卫（2026-10-22）
 *
 * 用户报的 bug：「角色自主旅游打开后，刷新网页或重启后端就变回没打开的」。
 *
 * 根因类型（已在 `be6a157` 修过一次）：`PUT /api/config/features` 会把值写进
 * `system_settings` 的 `feature_<key>`，但**启动时只按 `SETTING_TO_CONFIG` 的白名单回读**。
 * 新增一个 feature 忘了登记 → 写是写进去了，重启却读不回来 → 表现就是「拨了复位」。
 *
 * 这个坑已经踩过两次（autoTravel / storyOutline / storyLines），所以这里做成守卫：
 * 以后 `config.features` 里加字段，忘了登记会直接红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { SETTING_TO_CONFIG, loadSystemSettings } from '../src/db/settings.js';

/**
 * 允许不登记的例外。加之前先想清楚「重启后回到默认值」是不是真的可接受。
 * - townBuildingFeatures：小镇建筑开关组（对象，非布尔），用户明确不用小镇，暂不接持久化
 */
const ALLOW_UNPERSISTED = new Set(['townBuildingFeatures']);

function createDb(entries) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE system_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const ins = db.prepare('INSERT INTO system_settings(setting_key, setting_value) VALUES (?, ?)');
  for (const [k, v] of entries) ins.run(k, v);
  return db;
}

test('★ config.features 里每个开关都必须登记进 SETTING_TO_CONFIG（否则重启必复位）', () => {
  const mapped = new Set(
    Object.keys(SETTING_TO_CONFIG)
      .filter(k => k.startsWith('feature_'))
      .map(k => k.slice('feature_'.length)),
  );
  const missing = Object.keys(config.features)
    .filter(k => !mapped.has(k))
    .filter(k => !ALLOW_UNPERSISTED.has(k));
  assert.deepEqual(
    missing,
    [],
    `这些开关没登记，拨了重启就没了：${missing.join(', ')}\n` +
    `修法：在 src/db/settings.js 的 SETTING_TO_CONFIG 里加 feature_<key>（bool 或 json）`,
  );
});

test('★ 写库后 loadSystemSettings 真的把布尔开关读回 config（等价于重启）', () => {
  const db = createDb([
    ['feature_autoTravel', 'true'],
    ['feature_storyOutline', 'true'],
    ['feature_storyLines', 'false'],
  ]);
  const before = {
    autoTravel: config.features.autoTravel,
    storyOutline: config.features.storyOutline,
    storyLines: config.features.storyLines,
  };
  try {
    config.features.autoTravel = false;
    config.features.storyOutline = false;
    config.features.storyLines = true;
    loadSystemSettings(db);
    assert.equal(config.features.autoTravel, true, 'autoTravel 没读回来 —— 重启会复位');
    assert.equal(config.features.storyOutline, true, 'storyOutline 没读回来');
    assert.equal(config.features.storyLines, false, 'storyLines 没按库里的 false 读回');
  } finally {
    Object.assign(config.features, before);
    db.close();
  }
});

test('三条踩过坑的开关，登记的存储类型是 bool', () => {
  for (const k of ['autoTravel', 'storyOutline', 'storyLines']) {
    const def = SETTING_TO_CONFIG[`feature_${k}`];
    assert.ok(def, `feature_${k} 未登记`);
    assert.equal(def.obj, 'features');
    assert.equal(def.type, 'bool');
  }
});
