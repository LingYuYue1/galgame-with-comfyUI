/**
 * 回归：前端有开关的 feature_* 必须在 SETTING_TO_CONFIG 里登记。
 *
 * 2026-10-21 实测到的真 bug：`feature_autoTravel` / `feature_storyOutline` / `feature_storyLines`
 * 三个开关前端能拨、DB 里也有值，但一直没进映射表 —— 结果是
 * 「拨动 → 写进 system_settings → 重启时 loadSystemSettings 不认这个键 → config 用回 env 默认值」，
 * 表现为"开关静默复位"。用户以为开了角色自主旅游，重启后其实是关的。
 *
 * setSetting() 本来会打 "[config] ... will NOT survive restart" 警告，但淹没在启动日志里没人看。
 * 所以这里用测试兜住：**凡是本次登记的键，都要能真正从库读回 config**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SETTING_TO_CONFIG, loadSystemSettings } from '../src/db/settings.js';
import { config } from '../src/config.js';

const KEYS = ['feature_autoTravel', 'feature_storyOutline', 'feature_storyLines'];

const FIELDS = {
  feature_autoTravel: 'autoTravel',
  feature_storyOutline: 'storyOutline',
  feature_storyLines: 'storyLines',
};

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

test('三个 feature 键必须登记进 SETTING_TO_CONFIG', () => {
  for (const key of KEYS) {
    assert.ok(key in SETTING_TO_CONFIG, `${key} 未登记 —— setSetting 会警告且重启后丢失`);
    assert.equal(SETTING_TO_CONFIG[key].obj, 'features');
    assert.equal(SETTING_TO_CONFIG[key].type, 'bool');
  }
});

test('写库后 loadSystemSettings 能把它们读回 config（等价于"重启不丢"）', () => {
  const db = createDb(KEYS.map((k) => [k, 'true']));
  const before = {};
  for (const key of KEYS) before[FIELDS[key]] = config.features[FIELDS[key]];

  try {
    // 先反着设一遍，才能证明后面真的是从库里读回来的，而不是默认值碰巧相等
    for (const key of KEYS) config.features[FIELDS[key]] = false;

    loadSystemSettings(db);

    for (const key of KEYS) {
      assert.equal(config.features[FIELDS[key]], true, `${key} 没有被应用回 config`);
    }
  } finally {
    Object.assign(config.features, before);
    db.close();
  }
});

test('库里写 false 也能覆盖掉 env 的 true', () => {
  const db = createDb(KEYS.map((k) => [k, 'false']));
  const before = {};
  for (const key of KEYS) before[FIELDS[key]] = config.features[FIELDS[key]];

  try {
    for (const key of KEYS) config.features[FIELDS[key]] = true;
    loadSystemSettings(db);
    for (const key of KEYS) {
      assert.equal(config.features[FIELDS[key]], false, `${key} 的 false 没有覆盖成功`);
    }
  } finally {
    Object.assign(config.features, before);
    db.close();
  }
});
