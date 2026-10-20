#!/usr/bin/env node
/**
 * 全库图片引用体检（只读）
 *
 * 用途：扫描 DB 里所有「图片路径」列，找出指向磁盘不存在文件的引用。
 *       合并/大批量清理/换头像之后跑一次，比人工点页面可靠。
 *
 * 用法：
 *   node scripts/audit/image-ref-audit.mjs            # 人类可读报告
 *   node scripts/audit/image-ref-audit.mjs --json     # JSON（供别的脚本消费）
 *
 * 口径：
 *   - `/xxx.png` → `agent-core/data/xxx.png`，再按 basename 兜底 `data/images/*` 与 `data/avatars`
 *   - 绝对盘路径按原样判断
 *   - `http(s):` / `data:` / `blob:` 视为外链，跳过
 *   - 空值不算断链
 *
 * 已知误报：`media_outlets.icon` 存的是 emoji，不在此列（本脚本已排除该列）。
 *
 * 首次建立：2026-10-20（D-01~D-03 数据修复后顺带做的全库体检）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const CORE = path.join(PROJECT_ROOT, 'agent-core');
const DATA = path.join(CORE, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA, 'agent.db');

const require = createRequire(path.join(CORE, 'package.json'));
const Database = require('better-sqlite3');

const asJson = process.argv.includes('--json');

// 表 → 需要检查的图片路径列。新增带图表的表时在这里补一行即可。
const TARGETS = [
  ['characters', ['avatar_path', 'standing_url', 'chat_bg_path', 'galgame_bg_path']],
  ['media_posts', ['author_avatar', 'image']],
  ['moment_posts', ['images']],
  ['messages', ['images']],
  ['character_standings', ['image_url']],
  ['character_expression_standings', ['image_url']],
  ['character_emojis', ['image_path']],
  ['user_emojis', ['image_path']],
  ['character_diaries', ['images']],
  ['character_dreams', ['image_path']],
  ['character_events', ['image']],
  ['event_history', ['final_image']],
  ['town_assets', ['image_path']],
  ['town_maps', ['image_path']],
  ['world_settings', ['cover_image']],
  ['media_avatars', ['image']],
  ['mailbox_letters', ['paper_path', 'portrait_path', 'illustration_path']],
  ['backpack_items', ['image_url']],
  ['item_templates', ['image_url']],
  ['loot_catalog', ['image_url']],
  ['town_npc_stock', ['image_url']],
  ['group_chats', ['avatar_path']],
  // image_tasks.output_paths 默认不查：它是历史任务日志，相册不读它，断链不影响展示。
  // 需要时加：['image_tasks', ['output_paths']],
];

const AVATAR_ROOTS = [path.join(DATA, 'avatars'), path.join(DATA, 'images', 'avatars')];

function fileExists(raw) {
  if (!raw || typeof raw !== 'string') return true;
  const s = raw.trim();
  if (!s) return true;
  if (/^(https?:|data:|blob:)/i.test(s)) return true;
  const clean = s.split('?')[0].split('#')[0];
  if (/^[a-zA-Z]:[\\/]/.test(clean)) return fs.existsSync(clean);
  const rel = clean.replace(/^\/+/, '');
  const cands = [
    path.join(DATA, rel),
    path.join(CORE, rel),
    path.join(DATA, 'images', path.basename(clean)),
    ...AVATAR_ROOTS.map((r) => path.join(r, path.basename(clean))),
  ];
  return cands.some((c) => fs.existsSync(c));
}

/** JSON 列可能是数组 / 对象 / 字符串，递归取所有像路径的字符串 */
function flatten(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return out;
    if (t.startsWith('[') || t.startsWith('{')) {
      try { return flatten(JSON.parse(t), out); } catch { /* 普通字符串，继续 */ }
    }
    out.push(t);
    return out;
  }
  if (Array.isArray(value)) { for (const v of value) flatten(v, out); return out; }
  if (typeof value === 'object') { for (const v of Object.values(value)) flatten(v, out); return out; }
  return out;
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`数据库不存在：${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const report = { db: DB_PATH, tables: [], total_missing: 0 };

for (const [table, cols] of TARGETS) {
  let rows;
  try {
    rows = db.prepare(`SELECT rowid AS _rid, * FROM ${table}`).all();
  } catch { continue; } // 表不存在（老库 / 精简库）跳过
  if (!rows.length) continue;

  const missing = [];
  for (const row of rows) {
    for (const col of cols) {
      for (const s of flatten(row[col])) {
        if (!fileExists(s)) missing.push({ id: row.id ?? row._rid, col, value: s });
      }
    }
  }
  if (missing.length) {
    report.tables.push({ table, rows: rows.length, missing });
    report.total_missing += missing.length;
  }
}
db.close();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.total_missing ? 1 : 0);
}

for (const t of report.tables) {
  console.log(`\n### ${t.table}  行数=${t.rows}  断链=${t.missing.length}`);
  for (const m of t.missing.slice(0, 15)) console.log(`   #${m.id} ${m.col}: ${m.value}`);
  if (t.missing.length > 15) console.log(`   … 另 ${t.missing.length - 15} 条`);
}
console.log(`\n=== 合计断链 ${report.total_missing} 处 ===`);
process.exit(report.total_missing ? 1 : 0);
