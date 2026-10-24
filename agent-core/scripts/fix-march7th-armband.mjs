/**
 * fix-march7th-armband.mjs — 去掉「armband holding her phone」这种会被读成动作的表述
 *
 * 背景（2026-10-24）：用户报「三月七出现三只手的情况多一点」。
 * 全库扫描：服装描述里出现 `holding` 的**只有 #4 sport 一处** ——
 *   `a slim armband holding her phone on her left arm`
 * 语法上是"臂带托着手机"，但模型很容易把 holding 读成动作，而姿势句里
 * 两只手都已经占用（one hand on her hip and the other raised），于是补出第三只手。
 *
 * 改成 `a slim phone armband clipped to her left upper arm` —— 明确是臂带夹着，不涉及手。
 *
 * 覆盖三处：character_outfits.description / character_standings.prompt_text / 脚本源头。
 *
 * 用法：
 *   node scripts/fix-march7th-armband.mjs --dry-run
 *   node scripts/fix-march7th-armband.mjs
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY = process.argv.includes('--dry-run');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.resolve(HERE, '..', 'data', 'agent.db');

const FROM = 'a slim armband holding her phone on her left arm';
const TO = 'a slim phone armband clipped to her left upper arm';

const db = new Database(DB_PATH, DRY ? { readonly: true } : {});
if (!DRY) {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 8000');
}

// 未命中必须返回原值 —— 不能返回 null（2026-10-24 前一次批量替换踩过这个坑）
const sub = s => String(s || '').split(FROM).join(TO);

console.log(`\n${DRY ? '【DRY-RUN】' : '【写库】'} #4 sport 的 armband 表述\n${'─'.repeat(60)}`);

const outfit = db.prepare("SELECT id, description FROM character_outfits WHERE character_id = 4 AND scene = 'sport'").get();
console.log('\n① description:', outfit ? (outfit.description.includes(FROM) ? '命中' : '未命中') : '无该行');
if (!DRY && outfit && outfit.description.includes(FROM)) {
  db.prepare('UPDATE character_outfits SET description = ? WHERE id = ?').run(sub(outfit.description), outfit.id);
}

const st = db.prepare("SELECT prompt_text, image_url FROM character_standings WHERE character_id = 4 AND scene = 'sport'").get();
console.log('② prompt:', st ? (String(st.prompt_text || '').includes(FROM) ? '命中' : '未命中') : '无该行');
console.log('   该槽是否已有图:', st?.image_url ? '有（需重置重跑）' : '无');
if (!DRY && st && String(st.prompt_text || '').includes(FROM)) {
  db.prepare("UPDATE character_standings SET prompt_text = ?, updated_at = CURRENT_TIMESTAMP WHERE character_id = 4 AND scene = 'sport'")
    .run(sub(st.prompt_text));
}

if (!DRY) {
  const left = db.prepare("SELECT COUNT(*) n FROM character_outfits WHERE description LIKE '%holding%'").get().n;
  console.log(`\n复核：全库 outfit description 仍含 holding 的行 = ${left}`);
  const after = db.prepare("SELECT description FROM character_outfits WHERE character_id = 4 AND scene = 'sport'").get()?.description || '';
  const m = after.match(/[^,]*armband[^,]*/i);
  console.log('新表述:', m ? m[0].trim() : '(未找到)');
}

db.close();
