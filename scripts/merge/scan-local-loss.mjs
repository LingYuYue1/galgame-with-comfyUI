/**
 * scan-local-loss —— 本地成果丢失扫描（六扫描之⑥）
 *
 * 判据：**HEAD（合并前）有、而合并结果里不见了的「本地新增行」**。
 *   · 只看 BASE..OURS 区间里我们自己 + 进去的行（上游新增不算我们的成果）；
 *   · 行匹配用「归一化后整行相等」——宁可漏报，不要拿语义近似去猜；
 *   · 琐碎行（括号 / else / 注释）一律排除，否则噪声会淹没真信号。
 *
 * 用途：每合并完一批就跑一次。命中不是"一定错"，但**每一条都必须定性**
 * （恢复 / 论证接受），不允许留未解释项。
 *
 * 用法：
 *   node scripts/merge/scan-local-loss.mjs
 *   node scripts/merge/scan-local-loss.mjs --ours=backup/pre-v3.10-20261019 --base=115ddd6
 *   node scripts/merge/scan-local-loss.mjs --json
 */

import { DEFAULT_BASE, DEFAULT_TAG, workText, lines, norm, bulkLocalAdded, changedFiles, lsTreeNames, header } from './lib.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = arg('base', DEFAULT_BASE);
const TAG = arg('tag', DEFAULT_TAG);
const OURS = arg('ours', 'backup/pre-v3.10-20261019');
const JSON_OUT = process.argv.includes('--json');
const SAMPLE = 4;

/** 产物/依赖不参与判定 */
const SKIP = /^(agent-core\/public\/|node_modules\/|.*package-lock\.json$|docs\/|output\/|\.workbuddy\/)/;

const files = changedFiles(BASE, OURS).filter(f => !SKIP.test(f));
const existsAtOurs = lsTreeNames(OURS);
const addedByFile = bulkLocalAdded(BASE, OURS);
const hits = [];
const gone = [];

for (const f of files) {
  if (!existsAtOurs.has(f)) continue;
  const resultText = workText(f);
  if (resultText == null) { gone.push(f); continue; }

  const added = addedByFile.get(f) || [];
  if (!added.length) continue;
  const resultSet = new Set(lines(resultText).map(norm));
  const lost = added.filter(l => !resultSet.has(l));
  if (lost.length) hits.push({ file: f, total: added.length, lost });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ base: BASE, tag: TAG, ours: OURS, gone, hits }, null, 2));
  process.exit(0);
}

header(`scan-local-loss  ·  BASE=${BASE}  OURS=${OURS}`);
console.log(`本地改动文件 ${files.length} 个；有丢失 ${hits.length} 个；整文件消失 ${gone.length} 个`);

if (gone.length) {
  console.log('\n■ 整文件消失（本地有、结果没有）：');
  for (const f of gone) console.log('   ' + f);
}

let totalLost = 0;
for (const h of hits) {
  totalLost += h.lost.length;
  console.log(`\n■ ${h.file}  · 本地新增 ${h.total} 行，丢失 ${h.lost.length} 行`);
  for (const l of h.lost.slice(0, SAMPLE)) console.log('     - ' + l.trim().slice(0, 120));
  if (h.lost.length > SAMPLE) console.log(`     … 另有 ${h.lost.length - SAMPLE} 行`);
}

console.log(`\n合计丢失 ${totalLost} 行。每条都要定性：恢复 or 论证接受。`);
console.log('下一步：node scripts/merge/scan-silent-triage.mjs  ← 给每条做 A/B/C/D 归属');
