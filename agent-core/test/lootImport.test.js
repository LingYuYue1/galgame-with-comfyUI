/**
 * F-28 回归测试（2026-10-13）：橱窗「导入工具」随仓化。
 *
 * 首轮筛查 P2：`lootService.js` 的 `importCatalog` / `savePages` 是「导入工具用」的两个入口
 * （注释与前端空态都指向它），但那个工具**从未随仓库提供**（全仓无调用方）→
 * 全新部署 `loot_catalog` 恒空、橱窗永久显示「还没有商品清单」。
 *
 * 修复：新增 `scripts/import-loot.mjs`（读 JSON 清单 → 校验 → `importCatalog`）
 *   + `scripts/loot-catalog.example.json` 格式样例。本测试钉住：
 *   ①`parseCatalogPayload` 校验语义（合法对象形/简形、缺字段、非法 cat、重复 tag、孤儿 page）；
 *   ②CLI 端到端：导入落库、分页配置写入、重跑幂等（增删改计数 + image_url 不丢）；
 *   ③非法清单退出码非 0 且不落库；④接线护栏（脚本存在且调用 importCatalog）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-lootimport-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.IMAGES_DIR = path.join(TMP_DIR, 'images');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

const AGENT_CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(AGENT_CORE, 'scripts', 'import-loot.mjs');

const { getDb, closeDb } = await import('../src/db/index.js');
const { getPages, getPageStats } = await import('../src/services/lootService.js');

const db = getDb();

function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: AGENT_CORE,
    env: { ...process.env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function writeJson(name, payload) {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
  return p;
}

const PAGES = [
  { key: 'clothes', label: '服装' },
  { key: 'accessory', label: '配饰' },
  { key: 'hairstyle', label: '发型' },
];
const ITEM = (tag, name, cat, slot, page, meaning = '') => ({ tag, name, meaning, cat, slot, page });

// 清单 A：4 条（clothes 2 / accessory 1 / hairstyle 1）
const CATALOG_A = {
  pages: PAGES,
  items: [
    ITEM('maid_dress', '女仆装', 'clothes', 'full', 'clothes', '黑白女仆连衣裙'),
    ITEM('serafuku', '水手服', 'clothes', 'full', 'clothes', '蓝白水手服'),
    ITEM('headband', '发箍', 'accessory', 'head', 'accessory', '缎带发箍'),
    ITEM('twintails', '双马尾', 'hairstyle', 'hair', 'hairstyle', '经典双马尾'),
  ],
};
// 清单 B：maid_dress 改名 / serafuku、twintails 不动 / headband 删 / glasses 加
const CATALOG_B = {
  pages: PAGES,
  items: [
    ITEM('maid_dress', '女仆连衣裙', 'clothes', 'full', 'clothes', '黑白女仆连衣裙'),
    ITEM('serafuku', '水手服', 'clothes', 'full', 'clothes', '蓝白水手服'),
    ITEM('glasses', '眼镜', 'accessory', 'head', 'accessory', '圆框眼镜'),
    ITEM('twintails', '双马尾', 'hairstyle', 'hair', 'hairstyle', '经典双马尾'),
  ],
};

// ── ① parseCatalogPayload 校验语义 ──────────────────────────
test('① parseCatalogPayload：合法对象形规范化（meaning 缺省补空、page 原样）', async () => {
  const { parseCatalogPayload } = await import(pathToFileURL(SCRIPT).href);
  const out = parseCatalogPayload({
    pages: PAGES,
    items: [ITEM('a1', '甲', 'clothes', 'full', 'clothes')],
  });
  assert.equal(out.pages.length, 3);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].meaning, '');
  assert.equal(out.items[0].page, 'clothes');
});

test('① parseCatalogPayload：简形（顶层数组 = 只更新 items，不动分页）', async () => {
  const { parseCatalogPayload } = await import(pathToFileURL(SCRIPT).href);
  const out = parseCatalogPayload([ITEM('a1', '甲', 'clothes', 'full', 'clothes')]);
  assert.equal(out.pages, null);
  assert.equal(out.items.length, 1);
});

test('① parseCatalogPayload：缺 name → 报错指到具体条目', async () => {
  const { parseCatalogPayload } = await import(pathToFileURL(SCRIPT).href);
  assert.throws(() => parseCatalogPayload({
    pages: PAGES,
    items: [ITEM('a1', '甲', 'clothes', 'full', 'clothes'), { tag: 'a2', cat: 'clothes', slot: 'full' }],
  }), /items\[1\]\.name/);
});

test('① parseCatalogPayload：cat 非法 → 报错并列出可用值', async () => {
  const { parseCatalogPayload } = await import(pathToFileURL(SCRIPT).href);
  assert.throws(() => parseCatalogPayload({
    pages: PAGES,
    items: [ITEM('a1', '甲', 'unknown_cat', 'full', 'clothes')],
  }), /可用/);
});

test('① parseCatalogPayload：tag 重复 / page 不在 pages 内 → 报错', async () => {
  const { parseCatalogPayload } = await import(pathToFileURL(SCRIPT).href);
  assert.throws(() => parseCatalogPayload({
    pages: PAGES,
    items: [ITEM('a1', '甲', 'clothes', 'full', 'clothes'), ITEM('a1', '乙', 'clothes', 'full', 'clothes')],
  }), /重复/);
  assert.throws(() => parseCatalogPayload({
    pages: PAGES,
    items: [ITEM('a1', '甲', 'clothes', 'full', 'toys')],
  }), /不在 pages/);
});

// ── ② CLI 端到端 ────────────────────────────────────────────
test('② CLI：导入清单 A → 落库 4 行 + 分页 3 页 + 计数正确', () => {
  const fileA = writeJson('catalog-a.json', CATALOG_A);
  const r = runCli([fileA]);
  assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /\+4 ~0 -0 = 4/, '统计应为 +4 ~0 -0 = 4');

  const n = db.prepare('SELECT COUNT(*) AS n FROM loot_catalog').get().n;
  assert.equal(n, 4);

  assert.deepEqual(getPages(), PAGES);
  const stats = getPageStats().map(s => [s.key, s.count, s.withImage]);
  assert.deepEqual(stats, [['clothes', 2, 0], ['accessory', 1, 0], ['hairstyle', 1, 0]]);
});

test('② CLI：重跑清单 B → +1 ~3 -1；已生成图的 image_url 不丢；删除条目连带清理', () => {
  // 先给 maid_dress 塞一个「已生成」的图，模拟真实使用过的库
  db.prepare(`UPDATE loot_catalog SET image_url = '/images/loot/maid.png' WHERE tag = 'maid_dress'`).run();

  const fileB = writeJson('catalog-b.json', CATALOG_B);
  const r = runCli([fileB]);
  assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /\+1 ~3 -1 = 4/, '统计应为 +1 ~3 -1 = 4');

  const maid = db.prepare(`SELECT name, image_url FROM loot_catalog WHERE tag = 'maid_dress'`).get();
  assert.equal(maid.name, '女仆连衣裙', '改名应生效');
  assert.equal(maid.image_url, '/images/loot/maid.png', '重跑不得清掉已生成图');
  assert.equal(db.prepare(`SELECT id FROM loot_catalog WHERE tag = 'headband'`).get(), undefined, '清单外条目应被删');
  assert.ok(db.prepare(`SELECT id FROM loot_catalog WHERE tag = 'glasses'`).get(), '新条目应入库');
  assert.equal(getPageStats().find(s => s.key === 'clothes').withImage, 1);
});

test('③ CLI：破损 JSON → 退出码非 0、有明确报错、不落库', () => {
  const broken = path.join(TMP_DIR, 'broken.json');
  fs.writeFileSync(broken, '{ oops', 'utf8');
  const before = db.prepare('SELECT COUNT(*) AS n FROM loot_catalog').get().n;
  const r = runCli([broken]);
  assert.notEqual(r.code, 0, '非法清单必须失败退出');
  assert.match(r.stdout + r.stderr, /\[import-loot\]/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loot_catalog').get().n, before, '失败不得改库');
});

// ── ④ 接线护栏 ──────────────────────────────────────────────
test('④ 护栏：scripts/import-loot.mjs 存在、调用 importCatalog、无参数时打印用法', () => {
  assert.ok(fs.existsSync(SCRIPT), '导入脚本必须随仓');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /importCatalog\(/, '脚本必须调用 importCatalog');
  const r = runCli([]);
  assert.notEqual(r.code, 0, '无参数应报错退出');
  assert.match(r.stdout + r.stderr, /用法|usage/i);
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
