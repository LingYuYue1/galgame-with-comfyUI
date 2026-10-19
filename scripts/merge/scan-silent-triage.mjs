/**
 * scan-silent-triage —— 丢失行的三方归属分类（六扫描的收口工具）
 *
 * 对 scan-local-loss 捞出来的每一行，做 base / 上游新版 / 本地 的归属判定：
 *
 *   A ｜ 上游**也有**这行，但合并结果里没有  → 大概率是我们解冲突时丢了，**应恢复**
 *   B ｜ 本地独有（上游没有），结果里没有    → 本地成果被覆盖，**逐条判断是否仍有意义**
 *   C ｜ base 有、上游新版已删、结果也没有   → 上游自删，跟随是预期（信息性，不用处理）
 *   D ｜ base 有、上游新版有、结果没有       → 冲突时取了别人的值，**要确认是有意的**
 *
 * 输出按 A/B/C/D 分组，A 与 D 是必须逐条定性的部分。
 *
 * 用法：
 *   node scripts/merge/scan-silent-triage.mjs
 *   node scripts/merge/scan-silent-triage.mjs --ours=backup/pre-v3.10-20261019 --json
 */

import { DEFAULT_BASE, DEFAULT_TAG, gitText, workText, lines, norm, isTrivial, bulkLocalAdded, changedFiles, lsTreeNames, header } from './lib.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = arg('base', DEFAULT_BASE);
const TAG = arg('tag', DEFAULT_TAG);
const OURS = arg('ours', 'backup/pre-v3.10-20261019');
const JSON_OUT = process.argv.includes('--json');
const SAMPLE = 5;

const SKIP = /^(agent-core\/public\/|node_modules\/|.*package-lock\.json$|docs\/|output\/|\.workbuddy\/)/;

const files = changedFiles(BASE, OURS).filter(f => !SKIP.test(f));
const existsAtOurs = lsTreeNames(OURS);
const addedByFile = bulkLocalAdded(BASE, OURS);
const buckets = { A: [], B: [], C: [], D: [] };

for (const f of files) {
  if (!existsAtOurs.has(f)) continue;
  const added = addedByFile.get(f) || [];
  if (!added.length) continue;                 // 本地没加过东西，谈不上"本地成果丢失"
  const resultText = workText(f);
  if (resultText == null) continue;

  const resultSet = new Set(lines(resultText).map(norm));
  const maybeLost = added.filter(l => !resultSet.has(l));
  if (!maybeLost.length) continue;             // 没有丢失就不去读上游内容（省掉几百次 git 调用）

  const oursSet = new Set(lines(gitText(OURS, f) || '').map(norm));
  const tagSet = new Set(lines(gitText(TAG, f) || '').map(norm));
  const baseSet = new Set(lines(gitText(BASE, f) || '').map(norm));

  // ① 本地新增行里丢掉的 → A / B
  for (const l of maybeLost) {
    buckets[tagSet.has(l) ? 'A' : 'B'].push({ file: f, line: l });
  }

  // ② 这个文件里 base 有、结果没有的行 → C / D
  for (const l of oursSet) {
    if (isTrivial(l) || resultSet.has(l) || !baseSet.has(l)) continue;
    buckets[tagSet.has(l) ? 'D' : 'C'].push({ file: f, line: l });
  }
}

const count = k => buckets[k].length;

if (JSON_OUT) {
  console.log(JSON.stringify({ base: BASE, tag: TAG, ours: OURS, counts: { A: count('A'), B: count('B'), C: count('C'), D: count('D') }, buckets }, null, 2));
  process.exit(0);
}

header(`scan-silent-triage  ·  BASE=${BASE}  TAG=${TAG}  OURS=${OURS}`);
console.log(`A 上游也有但产物缺 ${count('A')} ｜ B 本地成果被覆盖 ${count('B')} ｜ C 上游自删 ${count('C')} ｜ D 冲突取值 ${count('D')}`);

const show = (key, title, note) => {
  const arr = buckets[key];
  console.log(`\n■ ${key} · ${title} —— ${arr.length} 条${note ? '　' + note : ''}`);
  const byFile = new Map();
  for (const it of arr) {
    if (!byFile.has(it.file)) byFile.set(it.file, []);
    byFile.get(it.file).push(it.line);
  }
  for (const [f, ls] of [...byFile].slice(0, 12)) {
    console.log(`   ${f}  (${ls.length})`);
    for (const l of ls.slice(0, SAMPLE)) console.log('      - ' + l.trim().slice(0, 110));
  }
  if (byFile.size > 12) console.log(`   … 另有 ${byFile.size - 12} 个文件`);
};

show('A', '上游保留但产物缺', '← 优先处理，通常是解冲突时丢的');
show('B', '本地成果被覆盖', '← 逐条判断是否仍有意义');
show('D', '冲突时取了别人的值', '← 确认是有意的');
show('C', '上游自删（信息性）', '← 不用处理');

console.log('\n处置要求：A 必须恢复或写出不接受的理由；B/D 每条一句结论，登记到台账。');
