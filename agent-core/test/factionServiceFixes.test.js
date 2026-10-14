/**
 * F-51 / F-52 / F-54 / F-55 回归测试（factionService 同批四项修复）
 *
 * · F-51：createFaction / updateFaction 的 parentId 缺「存在性 + 同世界」校验
 *         （update 只有防环——且 assertNoCycle 对不存在的 id 静默通过）→ 可建悬空/跨世界层级；
 * · F-52：mirrorToProject(slug) 的数据源 listFactions() 恒为「激活世界」——
 *         写非激活世界镜像时交叉污染；
 * · F-54：势力关系有向单边存储 + 对称型语义（同盟/敌对/中立/竞争）→ 对方侧看不到 → 读时对称镜像；
 * · F-55：memberCount 按行计数——同角色多职务（UNIQUE 允许）会重复计数 → 按角色去重。
 *
 * ⚠ 本地临时库 + 临时项目库目录，不碰真库、不调 LLM（与 factions.test.js 同款骨架）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-factionfixes-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');
globalThis.fetch = async url => { throw new Error(`faction fixes test forbids network: ${url}`); };

// 迁移必须显式执行（只 load 不加列；与 factions.test.js 同因）
const { loadFeatureMigrations } = await import('../src/db/migrations/index.js');
const { runRegisteredMigrations } = await import('../src/db/migrationRegistry.js');
const { getDb, createWorldSetting, activateWorldSetting } = await import('../src/db/index.js');
await loadFeatureMigrations();
runRegisteredMigrations(getDb());

const svc = await import('../src/services/factionService.js');
const { slugForWorld } = await import('../src/services/worldProjectLibrary.js');

const db = getDb();
const world = createWorldSetting({ name: '主测试世界', content: '## 世界背景\n一个用于测试的世界。' });
activateWorldSetting(world.id);

function newCharacter(name, archived = 0) {
  const r = db.prepare(`INSERT INTO characters (name, display_name, base_prompt, archived) VALUES (?, ?, '你是测试角色。', ?)`)
    .run(name, name, archived);
  return Number(r.lastInsertRowid);
}

// ─────────────────────────────────────────────────────────
// F-51：parentId 校验（存在性 + 同世界；防范悬空层级）
// ─────────────────────────────────────────────────────────

test('F-51 主断言：createFaction 拒绝不存在的 parentId（不得静默建悬空层级）', () => {
  assert.throws(() => svc.createFaction({ name: '悬空子测', parentId: 999999 }), /不存在/);
});

test('F-51 主断言：createFaction 拒绝跨世界的 parentId', () => {
  db.prepare(`INSERT INTO factions (slug, name, type, world_slug) VALUES ('x-world-f', '别界派', '军事', 'x-world-slug')`).run();
  const other = db.prepare(`SELECT id FROM factions WHERE slug = 'x-world-f'`).get();
  assert.throws(() => svc.createFaction({ name: '跨界子测', parentId: other.id }), /跨世界/);
});

test('F-51 主断言：updateFaction 同样拒绝不存在 / 跨世界的 parentId', () => {
  const f = svc.createFaction({ name: '改挂测' });
  assert.throws(() => svc.updateFaction(f.id, { parentId: 999999 }), /不存在/);
  const other = db.prepare(`SELECT id FROM factions WHERE slug = 'x-world-f'`).get();
  assert.throws(() => svc.updateFaction(f.id, { parentId: other.id }), /跨世界/);
});

test('F-51 守卫：合法的父子关系照常（存在 + 同世界 + 无环；含清空与重挂）', () => {
  const a = svc.createFaction({ name: '合法父测' });
  const b = svc.createFaction({ name: '合法子测', parentId: a.id });
  assert.equal(b.parentId, a.id);
  assert.equal(svc.updateFaction(b.id, { parentId: null }).parentId, null, '清空上级合法');
  assert.equal(svc.updateFaction(b.id, { parentId: a.id }).parentId, a.id, '重新挂回合法的父级');
});

// ─────────────────────────────────────────────────────────
// F-55：memberCount 按角色去重（行数仍是行数）
// ─────────────────────────────────────────────────────────

test('F-55 主断言：同角色多职务只计一个成员（memberCount 去重，列表行数不变）', () => {
  const f = svc.createFaction({ name: '计数测' });
  const cid = newCharacter('双职务者');
  svc.addMember(f.id, { characterId: cid, role: '首领' });
  svc.addMember(f.id, { characterId: cid, role: '顾问' });
  const dto = svc.getFaction(f.id);
  assert.equal(dto.members.length, 2, '两条职务记录都保留（行数=2）');
  assert.equal(dto.memberCount, 1, '同一角色只算 1 名成员（修复前=2）');
});

test('F-55 主断言：多行 + 归档混合时按角色数统计（活跃 2 / 归档 1）', () => {
  const f = svc.createFaction({ name: '混合计数测' });
  const c1 = newCharacter('双行活跃');
  const c2 = newCharacter('单行活跃');
  const c3 = newCharacter('归档者', 1);
  svc.addMember(f.id, { characterId: c1, role: '干部' });
  svc.addMember(f.id, { characterId: c1, role: '线人' });
  svc.addMember(f.id, { characterId: c2, role: '成员' });
  svc.addMember(f.id, { characterId: c3, role: '挂名' });
  const dto = svc.getFaction(f.id);
  assert.equal(dto.memberCount, 2, '活跃按角色数去重（修复前=3）');
  assert.equal(dto.archivedMemberCount, 1, '归档按角色数（两版一致，守卫）');
});

// ─────────────────────────────────────────────────────────
// F-54：势力关系——对称型关系读时镜像（对方侧可见）
// ─────────────────────────────────────────────────────────

test('F-54 主断言：A→B 敌对后，B 侧也能看到与 A 的关系（对称镜像）', () => {
  const a = svc.createFaction({ name: '镜像甲', type: '其他' });
  const b = svc.createFaction({ name: '镜像乙', type: '其他' });
  svc.upsertRelation({ fromId: a.id, toId: b.id, relation: '敌对' });
  const bView = svc.getFaction(b.id);
  const hit = bView.relations.find(r => r.toId === a.id);
  assert.ok(hit, 'B 的关系列表应含 A（修复前对方侧看不到）');
  assert.equal(hit.relation, '敌对');
  assert.equal(hit.toName, '镜像甲');
});

test('F-54 守卫：从属不镜像（语义单向）；双侧登记同一对方不重复展示；出边不受影响', () => {
  const a = svc.createFaction({ name: '单向甲', type: '其他' });
  const b = svc.createFaction({ name: '单向乙', type: '其他' });
  svc.upsertRelation({ fromId: a.id, toId: b.id, relation: '从属' });
  assert.equal(svc.getFaction(b.id).relations.length, 0, '「B 从属 A」不得镜像成「A 从属 B」');

  const c = svc.createFaction({ name: '双向甲', type: '其他' });
  const d = svc.createFaction({ name: '双向乙', type: '其他' });
  svc.upsertRelation({ fromId: c.id, toId: d.id, relation: '同盟' });
  svc.upsertRelation({ fromId: d.id, toId: c.id, relation: '同盟' });
  assert.equal(svc.getFaction(c.id).relations.length, 1, '同一对方双侧都登记时只展示一条（出边优先）');
  assert.equal(svc.getFaction(d.id).relations.length, 1);
  assert.equal(svc.getFaction(c.id).relations[0].toName, '双向乙', '出边优先展示本侧登记的记录');
});

// ─────────────────────────────────────────────────────────
// F-52：mirrorToProject 按 slug 取数（数据源与写目标同世界）
// ─────────────────────────────────────────────────────────

test('F-52 主断言：镜像非激活世界时，写入的是该世界自己的派系（而非激活世界的）', () => {
  // 二号世界（创建但不激活）
  const wB = createWorldSetting({ name: '二号世界', content: '## 世界背景\n二号世界。' });
  const slugB = slugForWorld('二号世界', wB.id);
  assert.ok(slugB && slugB !== svc.activeWorldSlug(), '二号世界应为非激活状态');
  // 两个世界各自的派系
  db.prepare(`INSERT INTO factions (slug, name, type, world_slug) VALUES ('wb-f1', '乙世界帮', '军事', ?)`).run(slugB);
  svc.createFaction({ name: '甲世界帮' }); // 激活世界（主测试世界）的派系

  const r = svc.mirrorToProject(slugB);
  assert.equal(r.ok, true, JSON.stringify(r));
  const file = path.join(process.env.LINSHE_WORLD_PROJECTS_DIR, slugB, 'project.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = (json.factions || []).map(f => f.name);
  assert.ok(names.includes('乙世界帮'), '镜像应含二号世界自己的派系');
  assert.ok(!names.includes('甲世界帮'), '不得把激活世界的派系写进别的世界（修复前正是如此）');
});

test('F-52 守卫：默认（激活世界）镜像照常工作', () => {
  const r = svc.mirrorToProject();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.count >= 1, '激活世界镜像应有内容');
});
