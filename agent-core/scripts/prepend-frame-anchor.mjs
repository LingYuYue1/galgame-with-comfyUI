/**
 * prepend-frame-anchor.mjs — 给所有立绘提示词加「前置构图锚」
 *
 * 为什么（2026-10-24，同日第二次踩）：
 *   立绘提示词的构图句一直写在**末尾**（`full body from head to feet, vertical 1:2...`），
 *   但尾部约束管不住头部先验。现实例：
 *     · 情趣套 → 画到膝盖就收尾（脚没了）
 *     · #14 银狼 casual（删掉中间的粒子句之后）→ 直接画成胸像
 *   凡是「服装描述/躯体细节」占比高的 prompt，镜头都会往近拉。
 *   唯一有效的办法是在**身份句之前**就钉死画幅。
 *
 * 幂等：已含 `the entire body inside the frame` 的跳过，可反复跑。
 *
 * 用法：
 *   node scripts/prepend-frame-anchor.mjs --dry-run
 *   node scripts/prepend-frame-anchor.mjs
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY = process.argv.includes('--dry-run');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.resolve(HERE, '..', 'data', 'agent.db');

// 不带性别代词，男女通用
const ANCHOR = 'Full-length wide shot of a standing figure, the entire body inside the frame from head to feet. ';
const MARK = 'the entire body inside the frame';

const db = new Database(DB_PATH, DRY ? { readonly: true } : {});
if (!DRY) {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 8000');
}

const rows = db.prepare('SELECT character_id, scene, prompt_text FROM character_standings ORDER BY character_id, scene').all();
const todo = rows.filter(r => r.prompt_text && !String(r.prompt_text).includes(MARK));

console.log(`\n${DRY ? '【DRY-RUN】' : '【写库】'} 前置构图锚\n${'─'.repeat(60)}`);
console.log(`  总 prompt: ${rows.length}｜已有锚: ${rows.length - todo.length}｜待加: ${todo.length}\n`);

for (const r of todo) console.log(`  + #${String(r.character_id).padEnd(4)} ${r.scene.padEnd(9)} ${r.prompt_text.length} → ${r.prompt_text.length + ANCHOR.length}`);

if (!DRY && todo.length) {
  const upd = db.prepare('UPDATE character_standings SET prompt_text = ?, updated_at = CURRENT_TIMESTAMP WHERE character_id = ? AND scene = ?');
  db.transaction(() => { for (const r of todo) upd.run(ANCHOR + r.prompt_text, r.character_id, r.scene); })();
  const after = db.prepare('SELECT COUNT(*) n FROM character_standings WHERE prompt_text LIKE ?').get('%' + MARK + '%').n;
  console.log(`\n  → 已加 ${todo.length} 份；全库含锚 ${after} / ${rows.length}`);
}

db.close();
