/**
 * reset-standing-slots.mjs — 把指定立绘槽"重置为待生成"，图文件保留在磁盘
 *
 * 用途：提示词改过之后，旧图不该再挂在槽位上。这个脚本只把
 * `character_standings.image_url` 置空（prompt_text 原样保留），
 * **不删任何图片文件** —— 旧图留在 data/images/standing/ 里，随时能翻回来比。
 *
 * 为什么需要它：`run-standing-batch.mjs` 只跑 `image_url IS NULL` 的槽，
 * 不重置的话，改完提示词也没法重跑。
 *
 * 用法：
 *   node scripts/reset-standing-slots.mjs --scene=lingerie --dry-run
 *   node scripts/reset-standing-slots.mjs --scene=lingerie
 *   node scripts/reset-standing-slots.mjs --only=31 --scene=work,casual,home,sleep
 *   node scripts/reset-standing-slots.mjs --only=31 --scene=all
 *
 * ⚠ 不用 getDb()：初始化会跑 cleanupOrphanedInFlight()，把 image_tasks 里
 *   pending/running 全标成 failed —— 服务运行期跑脚本会误杀在跑的图。
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const onlyArg = args.find(a => a.startsWith('--only='));
const sceneArg = args.find(a => a.startsWith('--scene='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').map(Number).filter(Boolean) : null;
const SCENES = sceneArg ? sceneArg.slice(8).split(',').map(s => s.trim()).filter(Boolean) : null;

if (!SCENES) {
  console.error('必须指定 --scene=（逗号分隔，或 all）');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.resolve(HERE, '..', 'data', 'agent.db');

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 8000');

let sql = `SELECT s.character_id, s.scene, s.image_url, c.display_name
           FROM character_standings s JOIN characters c ON c.id = s.character_id
           WHERE s.image_url IS NOT NULL AND s.image_url != ''`;
const params = [];
if (ONLY) {
  sql += ` AND s.character_id IN (${ONLY.map(() => '?').join(',')})`;
  params.push(...ONLY);
}
if (!SCENES.includes('all')) {
  sql += ` AND s.scene IN (${SCENES.map(() => '?').join(',')})`;
  params.push(...SCENES);
}
sql += ' ORDER BY s.character_id, s.scene';

const rows = db.prepare(sql).all(...params);
if (!rows.length) {
  console.log('没有匹配的已出图槽位。');
  db.close();
  process.exit(0);
}

console.log(`\n${DRY ? '【DRY-RUN · 不写库】' : '【重置】'} 将清空 ${rows.length} 个槽的 image_url`);
console.log('─'.repeat(64));
for (const r of rows) console.log(`  #${String(r.character_id).padEnd(4)} ${r.display_name.padEnd(8)} ${r.scene.padEnd(9)} ${r.image_url}`);

if (DRY) {
  console.log('\n（图文件不会被删除；prompt_text 也保留）');
  db.close();
  process.exit(0);
}

const upd = db.prepare(
  "UPDATE character_standings SET image_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE character_id = ? AND scene = ?"
);
db.transaction(() => { for (const r of rows) upd.run(r.character_id, r.scene); })();

console.log(`\n→ 已重置 ${rows.length} 个槽。图片文件仍在 data/images/standing/，未删除。`);
console.log('→ 现在可以跑：node scripts/run-standing-batch.mjs');
db.close();
