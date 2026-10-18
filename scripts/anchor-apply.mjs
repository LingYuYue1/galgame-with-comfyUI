/**
 * 角色锚点写入工具（F-63 配套）——带自动备份 + 回读校验
 *
 * 为什么用接口而不是直接改库：`PUT /api/characters/:id/outfits/scene` 是**人工编辑通道**
 * （`humanEdited: true` 绕过睡衣脚部护栏），走它与界面「保存」完全同一条链路，
 * 校验/同步（body 写进全部行）都由后端负责。
 *
 * 用法：
 *   node scripts/anchor-apply.mjs <payload.json>          # 写入（自动备份原值）
 *   node scripts/anchor-apply.mjs <payload.json> --dry    # 只打印差异，不写
 *
 * payload.json 形状：
 *   {
 *     "characterId": 4,
 *     "label": "三月七",
 *     "body": "<新身体锚点>",
 *     "outfits": [{ "scene": "work", "name": "常服", "description": "..." }, ...]
 *   }
 * 备份落点：output/anchor-backup/<日期>-char<id>-<label>.json（写入前抓取的全量快照）
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3099';
const ROOT = 'E:/桌面文件/邻舍Ling(二创)';
const BACKUP_DIR = path.join(ROOT, 'output', 'anchor-backup');

const payloadPath = process.argv[2];
const DRY = process.argv.includes('--dry');
const onlyArg = process.argv.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').map(s => s.trim()).filter(Boolean) : null;
if (!payloadPath) { console.error('用法: node scripts/anchor-apply.mjs <payload.json> [--dry] [--only=景元,银狼]'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const jobs = Array.isArray(raw.characters) ? raw.characters : [raw];
const selected = ONLY ? jobs.filter(j => ONLY.includes(j.label)) : jobs;

if (!selected.length) { console.error('没有匹配的角色（--only 过滤后为空）'); process.exit(1); }
if (ONLY) console.log(`[--only] 本次处理 ${selected.length}/${jobs.length}：${selected.map(j => j.label).join('、')}\n`);

for (const payload of selected) {
await applyOne(payload);
}

async function applyOne(payload) {
const id = Number(payload.characterId);
if (!id) { console.error('payload 缺 characterId'); process.exit(1); }

async function getState() {
  const r = await fetch(`${BASE}/api/characters/${id}/outfits/scene`);
  if (!r.ok) throw new Error(`GET outfits 失败 http=${r.status}`);
  const j = await r.json();
  return j; // { scenes, outfits: [{scene,name,description,body,text}] }
}

const before = await getState();
const beforeBody = before.outfits.find(o => o.body && o.body.trim())?.body || '';

console.log(`=== 角色 #${id}（${payload.label || ''}）当前状态 ===`);
for (const o of before.outfits) console.log(`  [${o.scene}] ${o.name}`);
console.log(`\n【原 body】\n${beforeBody}`);

// ── 备份 ──
// ⚠ 干跑不写快照：`--dry` 语义是"只看不改"，落一份文件会污染 output/anchor-backup/
//   （那里每份都是"某次真实写入前的原值"，混进干跑快照后就没法按时间倒推真正的还原点）。
if (DRY) {
  console.log('\n[备份] 干跑模式，不写快照');
} else {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const backupFile = path.join(BACKUP_DIR, `${stamp}-char${id}-${payload.label || 'x'}-before.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ capturedAt: new Date().toISOString(), characterId: id, body: beforeBody, outfits: before.outfits }, null, 2), 'utf8');
  console.log(`\n[备份] 原值已存 → ${backupFile}`);
}

// ── 差异预览 ──
console.log('\n=== 变更预览 ===');
console.log(`【新 body】\n${payload.body}`);
for (const o of payload.outfits || []) {
  const old = before.outfits.find(x => x.scene === o.scene);
  const changed = !old || old.description !== o.description || old.name !== o.name;
  console.log(`  [${o.scene}] ${o.name} ${changed ? '★变更' : '（未变）'}`);
  if (changed && old) console.log(`      旧: ${old.description}\n      新: ${o.description}`);
}

if (DRY) { console.log('\n[dry] 未写入。\n'); return; }

// ── 写入 ──
const r = await fetch(`${BASE}/api/characters/${id}/outfits/scene`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ body: payload.body, outfits: payload.outfits }),
});
const out = await r.json();
if (!r.ok || out.error) { console.error('\n[写入失败]', r.status, JSON.stringify(out).slice(0, 400)); process.exit(1); }
console.log(`\n[写入成功] saved=`, JSON.stringify(out.saved));

// ── 回读校验 ──
const after = await getState();
const afterBody = after.outfits.find(o => o.body && o.body.trim())?.body || '';
const allSame = after.outfits.every(o => o.body === afterBody);
console.log('\n=== 回读校验 ===');
console.log('body 已同步到全部行:', allSame ? '✅' : '❌');
console.log('body 与目标一致:', afterBody === payload.body ? '✅' : `❌\n${afterBody}`);
for (const o of after.outfits) {
  const want = (payload.outfits || []).find(x => x.scene === o.scene);
  if (want) console.log(`  [${o.scene}] ${o.description === want.description ? '✅' : '❌'} ${o.name}`);
}
console.log('');
}
