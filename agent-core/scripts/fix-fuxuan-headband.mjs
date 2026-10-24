/**
 * fix-fuxuan-headband.mjs — 去掉符玄（#31）锚点里的 headband
 *
 * 背景（2026-10-24）：用户核对官方立绘后指出「她头上没有类似发带的东西，只有簪子」，
 * 而模型把锚点里的 `headband` 画成了一条素白布带，七套立绘上都出现，观感很怪。
 *
 * 改三处（三处是同一句话的三份拷贝）：
 *   1. character_outfits.body          身体锚点，各套共用 —— 所有生图链路的唯一真源
 *   2. characters.base_prompt          「## 你的外观」老写法 —— 聊天仍在用
 *   3. character_standings.prompt_text 已定稿的立绘提示词 —— 点「再次 Roll 图」会复现
 *
 * ⚠ 不用 `getDb()`：初始化会跑 cleanupOrphanedInFlight()，把 image_tasks 里
 *   pending/running 全标成 failed —— 服务运行期跑脚本会误杀在跑的图。
 *
 * 用法：
 *   node scripts/fix-fuxuan-headband.mjs --dry-run
 *   node scripts/fix-fuxuan-headband.mjs
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY = process.argv.includes('--dry-run');
const CID = 31;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.resolve(HERE, '..', 'data', 'agent.db');

// 只匹配核心短语，不绑定前面的介词 —— #31 的 casual 用的是 `held by ...`，
// 而其余套是 `with ...`。绑介词会让 casual 漏掉（2026-10-24 实际发生过）。
const FROM = 'gold hairpin and headband';
const TO = 'gold hairpin';

const db = new Database(DB_PATH, DRY ? { readonly: true } : {});
if (!DRY) {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 8000');
}

/**
 * ⚠ **未命中必须返回原值，不能返回 null。**
 * 初版写成「命中就替换、否则返回 null」，结果 casual（句式不同）被写成了 NULL，
 * 一条提示词被静默清空。批量替换里，"没找到"的正确语义是"不动"。
 */
const sub = s => String(s || '').split(FROM).join(TO);

console.log(`\n${DRY ? '【DRY-RUN】' : '【写库】'} #${CID} 去掉 headband\n${'─'.repeat(60)}`);

/* ① body（每套一行，可能有多行同值） */
const bodyRows = db.prepare(
  "SELECT id, scene, body FROM character_outfits WHERE character_id = ? AND body LIKE '%headband%'"
).all(CID);
console.log(`\n① character_outfits.body：${bodyRows.length} 行命中`);
for (const r of bodyRows) {
  console.log(`   ${r.scene}: ...${sub(r.body)?.match(/high ornate bun[^,]*/)?.[0] || '(替换失败)'}...`);
}
if (!DRY && bodyRows.length) {
  const upd = db.prepare('UPDATE character_outfits SET body = ? WHERE id = ?');
  db.transaction(() => { for (const r of bodyRows) upd.run(sub(r.body), r.id); })();
  console.log('   → 已更新');
}

/* ② base_prompt */
const ch = db.prepare('SELECT id, base_prompt FROM characters WHERE id = ?').get(CID);
const hasBase = String(ch?.base_prompt || '').includes(FROM);
console.log(`\n② characters.base_prompt：${hasBase ? '命中 1 处' : '未命中'}`);
if (!DRY && hasBase) {
  db.prepare('UPDATE characters SET base_prompt = ? WHERE id = ?').run(sub(ch.base_prompt), CID);
  console.log('   → 已更新');
}

/* ③ 立绘提示词 */
const prompts = db.prepare(
  "SELECT scene, prompt_text FROM character_standings WHERE character_id = ? AND prompt_text LIKE '%headband%'"
).all(CID);
console.log(`\n③ character_standings.prompt_text：${prompts.length} 份命中 → ${prompts.map(p => p.scene).join(' / ')}`);
if (!DRY && prompts.length) {
  const upd = db.prepare('UPDATE character_standings SET prompt_text = ? WHERE character_id = ? AND scene = ?');
  db.transaction(() => { for (const p of prompts) upd.run(sub(p.prompt_text), CID, p.scene); })();
  console.log('   → 已更新');
}

/* 复核 */
if (!DRY) {
  const leftBody = db.prepare("SELECT COUNT(*) n FROM character_outfits WHERE character_id = ? AND body LIKE '%headband%'").get(CID).n;
  const leftPrompt = db.prepare("SELECT COUNT(*) n FROM character_standings WHERE character_id = ? AND prompt_text LIKE '%headband%'").get(CID).n;
  const leftBase = String(db.prepare('SELECT base_prompt FROM characters WHERE id = ?').get(CID)?.base_prompt || '').includes('headband');
  console.log(`\n复核：body 残留 ${leftBody} / prompt 残留 ${leftPrompt} / base_prompt 残留 ${leftBase ? '有' : '无'}`);
}

db.close();
console.log(`
${'─'.repeat(60)}
下一步：已出的 4 张符玄立绘（work/casual/home/sleep）仍是带发带的旧图，
要一致就重跑：
  node scripts/run-standing-batch.mjs   # 只跑缺图的；已有图的需先在界面里删掉该槽
`);
