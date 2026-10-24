/**
 * prepend-frame-anchor.mjs — 给立绘提示词加「前置构图锚」（仅在有裁切问题时用）
 *
 * ⚠ 2026-10-24 的教训：这个脚本被**误用过一次**，全量加到 70 份后撤回 59 份。
 *   起因是我把用户「裁剪过的截图」当成原图，误判"胸像 = 构图崩了"。
 *   实际原图构图正常，而 `wide shot` 会把镜头拉远、角色变小 —— 与立绘「角色尽量大」相悖。
 *
 * 什么时候才该用：
 *   - 有**原图**证明画面被裁（例如情趣套画到膝盖、脚没进画面）
 *   - 且确认不是画幅/分辨率问题（见 MEMORY 5.4 的诊断顺序：先查脚部锚点）
 *
 * 什么时候不该用：
 *   - 只是觉得「角色有点近」——立绘本来就该近
 *   - 拿的是裁剪截图、看不清原构图
 *
 * 幂等：已含 `the entire body inside the frame` 的跳过。
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
