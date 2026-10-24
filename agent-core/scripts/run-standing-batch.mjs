/**
 * run-standing-batch.mjs — 批量跑场景立绘（用库里已定稿的提示词，不请求 LLM）
 *
 * 配合 fill-standing-prompts.mjs：那个脚本把 12 份提示词写进
 * `character_standings.prompt_text`，这个脚本负责把它们变成图。
 *
 * 为什么走 HTTP 而不是 import：
 *   出图链路（renderSceneStandingImage）在 routes/characters.js 内部，没有导出；
 *   而脚本直连 `getDb()` 会触发启动清理，把 pending/running 的 image_tasks 标成失败。
 *   走 HTTP 用的是**正在运行的服务的**同一条链路，口径与 UI 完全一致。
 *
 * 已出图的槽会自动跳过 —— 中途 Ctrl+C 之后可以原样重跑，不会重复烧 GPU。
 *
 * 用法：
 *   node scripts/run-standing-batch.mjs                 # 跑全部缺图的
 *   node scripts/run-standing-batch.mjs --dry-run       # 只列清单
 *   node scripts/run-standing-batch.mjs --only=5,14     # 只跑指定角色
 *   node scripts/run-standing-batch.mjs --base=http://127.0.0.1:3099
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const onlyArg = args.find(a => a.startsWith('--only='));
const baseArg = args.find(a => a.startsWith('--base='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').map(Number).filter(Boolean) : null;
const BASE = baseArg ? baseArg.slice(7) : 'http://127.0.0.1:3099';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.resolve(HERE, '..', 'data', 'agent.db');

const SCENE_LABEL = { work: '常服', casual: '私服', home: '居家', sleep: '睡衣' };

/* ── 1. 读清单 ─────────────────────────────────────────────── */
const db = new Database(DB_PATH, { readonly: true });
let rows = db.prepare(
  `SELECT s.character_id, s.scene, s.prompt_text, c.display_name
   FROM character_standings s JOIN characters c ON c.id = s.character_id
   WHERE (s.image_url IS NULL OR s.image_url = '')
     AND s.prompt_text IS NOT NULL AND length(trim(s.prompt_text)) > 10
   ORDER BY s.character_id, CASE s.scene
     WHEN 'work' THEN 1 WHEN 'casual' THEN 2 WHEN 'home' THEN 3 WHEN 'sleep' THEN 4 ELSE 9 END`
).all();
db.close();

if (ONLY) rows = rows.filter(r => ONLY.includes(r.character_id));

if (!rows.length) {
  console.log('没有待出图的场景立绘（全部已有图，或没有定稿 prompt）。');
  process.exit(0);
}

console.log(`\n待出图 ${rows.length} 张 · 目标服务 ${BASE}`);
console.log('─'.repeat(64));
for (const r of rows) {
  console.log(`  #${String(r.character_id).padEnd(4)} ${r.display_name.padEnd(8)} ${(SCENE_LABEL[r.scene] || r.scene).padEnd(4)} prompt ${String(r.prompt_text.length).padStart(4)} 字符`);
}
if (DRY) {
  console.log('\n（dry-run，未发起任何生成）');
  process.exit(0);
}

/* ── 2. 探活 ──────────────────────────────────────────────── */
try {
  const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.log('\n服务在线，开始串行出图（单张 int8 约 30~60 秒）\n');
} catch (e) {
  console.error(`✗ 连不上 ${BASE} —— ${e.message}\n  先把后端（3099）拉起来再跑。`);
  process.exit(1);
}

/* ── 3. 逐张出图 ──────────────────────────────────────────── */
const t0 = Date.now();
let ok = 0, fail = 0;
for (const [i, r] of rows.entries()) {
  const label = `[${i + 1}/${rows.length}] #${r.character_id} ${r.display_name} ${SCENE_LABEL[r.scene] || r.scene}`;
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/characters/${r.character_id}/standings/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 传 prompt = 跳过 LLM，直接用定稿那份
      body: JSON.stringify({ scene: r.scene, prompt: r.prompt_text }),
      signal: AbortSignal.timeout(300000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    ok++;
    console.log(`${label} ✓ ${((Date.now() - started) / 1000).toFixed(1)}s → ${body.image_url || '(已落库)'}`);
  } catch (e) {
    fail++;
    console.log(`${label} ✗ ${e.message}`);
    // 单张失败不中断：可能是显存/工作流临时问题，跑完再一起看
  }
}
console.log('\n' + '─'.repeat(64));
console.log(`完成：成功 ${ok} / 失败 ${fail} / 总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (fail) console.log('失败的可以原样重跑 —— 已出图的槽会自动跳过。');
