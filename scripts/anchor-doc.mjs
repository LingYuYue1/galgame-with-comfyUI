/**
 * 角色锚点对照表生成器
 *
 * 从库里（`characters` + `character_outfits`）直接生成《锚点对照-角色外观总表.md`，
 * 保证文档与真实数据一致（不手抄）。待确认草稿从 payload 文件读入，标注「尚未落库」。
 *
 * 用法：node scripts/anchor-doc.mjs [--out=<路径>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = 'E:/桌面文件/邻舍Ling(二创)';
// 依赖装在 agent-core/node_modules —— 用 createRequire 锚到那边的 package.json 解析
const requireFromCore = createRequire(path.join(ROOT, 'agent-core', 'package.json'));
const Database = requireFromCore('better-sqlite3');

const DB = path.join(ROOT, 'agent-core', 'data', 'agent.db');
const outArg = process.argv.find(a => a.startsWith('--out='));
const OUT = outArg ? outArg.slice(6) : path.join(ROOT, 'docs', '锚点对照-角色外观总表.md');
const DRAFT_FILE = path.join(ROOT, 'output', 'anchor-backup', 'payload-p0-weak5.json');

const SCENE_ORDER = ['work', 'casual', 'home', 'sleep', 'nude'];
const SCENE_LABEL = { work: '常服', casual: '私服', home: '居家', sleep: '睡衣', nude: '全身（私密场景）' };

const db = new Database(DB, { readonly: true });
const chars = db.prepare('SELECT id, display_name, base_prompt FROM characters ORDER BY id').all();

const draftAll = fs.existsSync(DRAFT_FILE)
  ? (JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8')).characters || [])
  : [];

const rows = [];
for (const c of chars) {
  const outfits = db.prepare('SELECT scene, name, description, body FROM character_outfits WHERE character_id=?').all(c.id);
  const byScene = Object.fromEntries(outfits.map(o => [o.scene, o]));
  const body = outfits.find(o => o.body && o.body.trim())?.body || '';
  const bp = c.base_prompt || '';
  const firstLine = (bp.split('\n')[0] || '').trim();
  const m = bp.match(/##\s*你的外观([\s\S]*?)(?=\n##\s|$)/);
  const sec = m ? m[1].trim() : '';
  const ascii = (sec.match(/[A-Za-z]/g) || []).length;
  const cjk = (sec.match(/[\u4e00-\u9fff]/g) || []).length;
  const lang = !sec ? '无外观段' : (ascii > cjk * 2 ? '英文' : (cjk > ascii * 2 ? '中文' : '混合'));
  const draft = draftAll.find(d => Number(d.characterId) === c.id);
  rows.push({ c, byScene, body, firstLine, sec, lang, draft, hasOutfits: outfits.length > 0 });
}

const hasIdentity = (body) => /\([A-Za-z][^)]*\)/.test(body.split(',')[0] || '');

let md = `# 邻舍二创 · 角色锚点对照表

> **本文件由脚本生成**（\`scripts/anchor-doc.mjs\`，从 agent-core 库直读），请勿手改 —— 改动请改库里数据后重跑脚本。
> 生成时间：${new Date().toISOString().replace('T', ' ').slice(0, 16)}
> 规范依据：\`docs/角色锚点-规范与提升规划.md\`（v0.2：**锚点 = 服装库 body 层**；注入文本 = body + 该场景服装）

## 一览

| # | 角色 | 服装库 | body（锚点） | 身份行 | 外观段 | 备注 |
|---|------|--------|--------------|--------|--------|------|
`;

for (const r of rows) {
  const n = Object.keys(r.byScene).length;
  const status = n === 0
    ? (r.draft ? '⚠ 未落库（草稿待确认）' : '❌ 缺锚点')
    : '✅ 已落库';
  md += `| ${r.c.id} | ${r.c.display_name} | ${n ? n + ' 套' : '—'} | ${r.body ? r.body.length + ' 字符' : '—'} | ${r.body ? (hasIdentity(r.body) ? '✅' : '❌') : '—'} | ${r.lang} | ${status} |\n`;
}
md += `
---

## 逐个明细

`;
for (const r of rows) {
  md += `### #${r.c.id} ${r.c.display_name}\n\n`;
  md += `- 角色卡首行：${r.firstLine.slice(0, 120)}\n`;
  if (r.body) {
    md += `\n**① body（恒定锚点）**\n\n\`\`\`\n${r.body}\n\`\`\`\n`;
  } else {
    md += `\n**① body（恒定锚点）**：❌ 尚无。\n`;
  }
  if (Object.keys(r.byScene).length) {
    md += `\n**② 各场景服装（变量）**\n\n| 场景 | 名称 | 服装文本 |\n|------|------|----------|\n`;
    for (const k of SCENE_ORDER) {
      const o = r.byScene[k];
      if (!o) continue;
      md += `| ${SCENE_LABEL[k] || k} | ${o.name} | ${o.description} |\n`;
    }
    md += '\n';
  }
  if (r.sec) md += `**③ 角色卡「## 你的外观」段**（${r.lang}，${r.sec.length} 字符）\n\n\`\`\`\n${r.sec}\n\`\`\`\n\n`;
  md += '---\n\n';
}

const pending = rows.filter(r => !r.hasOutfits && r.draft);
if (pending.length) {
  md += `## 待确认草稿（**尚未落库**，等你点头即写入）\n\n`;
  for (const r of pending) {
    md += `### #${r.c.id} ${r.c.display_name}\n\n**① body（锚点）**\n\n\`\`\`\n${r.draft.body}\n\`\`\`\n\n`;
    md += `**② 各场景服装**\n\n| 场景 | 名称 | 服装文本 |\n|------|------|----------|\n`;
    for (const o of r.draft.outfits) md += `| ${SCENE_LABEL[o.scene] || o.scene} | ${o.name} | ${o.description} |\n`;
    md += '\n';
  }
}

fs.writeFileSync(OUT, md, 'utf8');
console.log(`已生成 → ${OUT}（${md.length} 字符）`);
console.log('表内角色数：', rows.length, '| 已落库：', rows.filter(r => r.hasOutfits).length, '| 草稿待确认：', pending.length);
db.close();
