/**
 * scan-revert-loss —— 删除类动作扫描（六扫描之⑤）
 *
 * 判据：**合并把文件/大段代码删掉了，而这不是我们主动要删的**。
 * 上游的「撤回 / 重构 / 优化型删除」在自动合并里是静默生效的 ——
 * v3.8.2 那次就是靠这个扫描才发现本地被整段抹掉。
 *
 * 本脚本只做两件事：
 *   ① 整文件消失（合并前有、合并结果里没有）；
 *   ② 单文件净删除超过阈值（默认 ≥ 30 行且 ≥ 30%），列出被删的代表行。
 *
 * ⚠ 性能：先用**一次** `git diff --numstat` 拿到全部增减行数，只对超过阈值的少数文件
 *   读内容算比例。不要退回逐文件 `git show` —— Windows 上单次约 1.2 秒，几百个文件会跑成分钟级。
 *
 * 用法：
 *   node scripts/merge/scan-revert-loss.mjs
 *   node scripts/merge/scan-revert-loss.mjs --ours=backup/pre-v3.10-20261019 --min=40
 */

import { DEFAULT_TAG, sh, workText, lines, norm, isTrivial, header } from './lib.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const OURS = arg('ours', 'backup/pre-v3.10-20261019');
const TAG = arg('tag', DEFAULT_TAG);
const MIN_LINES = Number(arg('min', '30'));
const MIN_RATIO = 0.3;
const JSON_OUT = process.argv.includes('--json');

const SKIP = /^(agent-core\/public\/|node_modules\/|.*package-lock\.json$|docs\/|output\/|\.workbuddy\/)/;

/** 一次拿全部（OURS → 工作区）的增减统计 */
const statRows = sh(`git diff --numstat ${OURS}`)
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  .map(row => {
    const [add, del, file] = row.split('\t');
    return { file, add: Number(add), del: Number(del) };
  })
  .filter(r => r.file && !SKIP.test(r.file) && Number.isFinite(r.del));

/** 整文件消失 */
const deleted = sh(`git diff --diff-filter=D --name-only ${OURS}`)
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  .filter(f => !SKIP.test(f));

/** 只看净删除量够大的，再逐个算比例（这一步文件数很少） */
const shrunk = [];
for (const r of statRows.filter(r => r.del >= MIN_LINES && r.add === 0)) {
  const after = workText(r.file);
  if (after == null) continue;                 // 整删的已在 deleted 里
  const afterN = lines(after).length;
  const beforeN = afterN + r.del;              // 近似：删除行数 + 现存行数
  if (r.del / Math.max(beforeN, 1) < MIN_RATIO) continue;

  const beforeText = sh(`git show ${OURS}:${r.file}`, { stdio: ['pipe', 'pipe', 'ignore'] });
  const afterSet = new Set(lines(after).map(norm));
  const sample = lines(beforeText).map(norm).filter(l => !isTrivial(l) && !afterSet.has(l)).slice(0, 5);
  shrunk.push({ file: r.file, before: beforeN, after: afterN, removed: r.del, sample });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ours: OURS, tag: TAG, deleted, shrunk }, null, 2));
  process.exit(0);
}

header(`scan-revert-loss  ·  OURS=${OURS}  TAG=${TAG}`);
console.log(`对照文件 ${statRows.length} 个（OURS → 工作区）`);

console.log(`\n■ 整文件消失：${deleted.length} 个`);
for (const f of deleted) console.log('   ' + f);

console.log(`\n■ 净删除 ≥ ${MIN_LINES} 行且 ≥ ${Math.round(MIN_RATIO * 100)}%：${shrunk.length} 个`);
for (const s of shrunk) {
  console.log(`\n   ${s.file}  ${s.before} → ${s.after} 行（-${s.removed}）`);
  for (const l of s.sample) console.log('      - ' + l.trim().slice(0, 110));
}

console.log('\n提示：产物（agent-core/public）与 docs 已排除；删除是否接受，逐条写进台账。');
