import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const { saveMap, getMapPayload } = await import('../src/services/town/townMapService.js');
const { reconcileTownResponsibilities } = await import('../src/services/town/townResponsibilityRuntime.js');
const { normalizeTownCapabilities, townCapabilities, setCharacterCapabilities } = await import('../src/services/town/townCapabilities.js');
const { createNpc, updateNpc } = await import('../src/services/town/townNpcService.js');

function setup(t) {
  closeDb();
  config.dbPath = ':memory:';
  const db = getDb();
  t.after(closeDb);
  const { mapId } = saveMap({ create: true, name: '地图保存回归', cols: 16, rows: 16,
    layers: { ground: Array.from({ length: 16 }, () => Array(16).fill(null)), objects: [] },
    locations: [{ key: 'stock', name: '补给摊', businessKind: 'supplier', x: 2, y: 2 }],
    assignResponsibilities: false });
  return { db, mapId };
}

function addBuilding(db, map, capabilities = ['service']) {
  const assetId = Number(db.prepare(`INSERT INTO town_assets(kind,key,name,image_path,meta_json,status)
    VALUES('building','new_house','新生成的小屋','',?,'ready')`)
    .run(JSON.stringify({ footprint: { w: 2, h: 2 }, businessKind: 'none', capabilities })).lastInsertRowid);
  // 与编辑器一致：从素材库放入的新对象尚无 id，保存时才分配。
  map.layers.objects.push({ assetId, x: 8, y: 8, flip: false });
  return assetId;
}

test('旧地点的空权限经过读取、新建筑摆放、保存和再次保存后保持不变', t => {
  const { db, mapId } = setup(t);
  // 旧镇补给地点走 defaultTownLocationCapabilities 后会持久化空数组。
  db.prepare('UPDATE town_locations SET capabilities_json=NULL WHERE map_id=?').run(mapId);
  reconcileTownResponsibilities({ db, mapId });
  assert.equal(db.prepare('SELECT capabilities_json FROM town_locations WHERE map_id=?').get(mapId).capabilities_json, '[]');
  const map = getMapPayload(mapId);
  const originalLocationId = map.locations[0].id;
  assert.deepEqual(map.locations[0].capabilities, []);
  const assetId = addBuilding(db, map);
  assert.equal(saveMap({ ...map, mapId }).ok, true);
  const saved = getMapPayload(mapId);
  assert.equal(saved.layers.objects[0].assetId, assetId);
  assert.ok(Number.isInteger(saved.layers.objects[0].id));
  assert.equal(saved.locations.find(l => l.key === 'stock').id, originalLocationId);
  assert.deepEqual(saved.locations.find(l => l.key === 'stock').capabilities, []);
  assert.equal(saved.locations.find(l => l.key === 'new_house').objectId, saved.layers.objects[0].id);
  assert.equal(saveMap({ ...saved, mapId }).ok, true);
  assert.deepEqual(getMapPayload(mapId).locations, saved.locations);
});

test('无职能的建筑素材可摆放并自动生成可保存的地点', t => {
  const { db, mapId } = setup(t);
  const map = getMapPayload(mapId);
  addBuilding(db, map, []);
  saveMap({ ...map, mapId });
  const saved = getMapPayload(mapId);
  assert.deepEqual(saved.locations.find(l => l.key === 'new_house').capabilities, []);
  saveMap({ ...saved, mapId });
  assert.deepEqual(getMapPayload(mapId).locations.find(l => l.key === 'new_house').capabilities, []);
});

test('损坏的历史权限读取为空后仍可保存地图，且不会自动授予职能', t => {
  const { db, mapId } = setup(t);
  db.prepare('UPDATE town_locations SET capabilities_json=? WHERE map_id=?').run('{bad', mapId);
  const map = getMapPayload(mapId);
  assert.deepEqual(map.locations[0].capabilities, []);
  saveMap({ ...map, mapId });
  assert.deepEqual(getMapPayload(mapId).locations[0].capabilities, []);
});

test('地点仍拒绝非法权限且整次地图保存回滚；省略字段保留原权限', t => {
  const { db, mapId } = setup(t);
  const original = getMapPayload(mapId);
  for (const capabilities of ['service', {}, ['invented'], ['service', 'invented']]) {
    const map = structuredClone(original);
    map.name = '不应保存';
    map.locations[0].capabilities = capabilities;
    assert.throws(() => saveMap({ ...map, mapId }), { code: 'INVALID_TOWN_CAPABILITIES' });
    assert.deepEqual(getMapPayload(mapId), original);
  }
  const map = structuredClone(original);
  delete map.locations[0].capabilities;
  saveMap({ ...map, mapId });
  assert.deepEqual(getMapPayload(mapId).locations[0].capabilities, original.locations[0].capabilities);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM town_locations WHERE map_id=?').get(mapId).n, 1);
});

test('NPC 和入住角色仍要求至少一项职能', t => {
  const { db, mapId } = setup(t);
  assert.throws(() => normalizeTownCapabilities([]), { code: 'INVALID_TOWN_CAPABILITIES' });
  assert.throws(() => townCapabilities({ capabilities: [] }), { code: 'INVALID_TOWN_CAPABILITIES' });
  assert.throws(() => setCharacterCapabilities(db, 1, []), { code: 'INVALID_TOWN_CAPABILITIES' });
  const npc = createNpc({ mapId, displayName: '店员', job: '店员', capabilities: ['service'], assignResponsibilities: false });
  assert.throws(() => updateNpc(npc.id, { capabilities: [] }), { code: 'INVALID_TOWN_CAPABILITIES' });
  assert.equal(db.prepare('SELECT capabilities_json FROM town_npcs WHERE id=?').get(npc.id).capabilities_json, '["service"]');
});
