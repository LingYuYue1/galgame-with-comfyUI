/**
 * 写入用户形象的**生图锚点**（阶段 7，2026-10-23）。
 *
 * 用法：
 *   node scripts/set-user-anchor.mjs                    # 写入默认方案（comet）
 *   node scripts/set-user-anchor.mjs --preset=drifter    # 写入指定方案
 *   node scripts/set-user-anchor.mjs --dry               # 只打印，不写库
 *   node scripts/set-user-anchor.mjs --list              # 看有哪些方案
 *
 * 方案库见 `scripts/user-outfit-presets.mjs`（含设计依据与官方设定来源）。
 *
 * 为什么用户形象要单独一个字段、不能复用中文那段 appearance：
 *   实测中文长段在本模型上约束力接近零 —— 出图是个银发蓝西装的少年，与文字无关；
 *   同一内容换成英文 tag 就画对了。所以 appearance 管文案、anchor 管画面，各司其职。
 */
import { getDb } from '../src/db/index.js';

getDb();
const { setSetting } = await import('../src/db/settings.js');
const { config } = await import('../src/config.js');
const { PRESETS, DEFAULT_PRESET } = await import('./user-outfit-presets.mjs');

const argv = process.argv.slice(2);
const pickArg = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

if (argv.includes('--list')) {
  for (const [k, p] of Object.entries(PRESETS)) {
    console.log(`${k.padEnd(10)} ${p.name}  (${(p.body + ', ' + p.outfits).length} 字符)`);
  }
  process.exit(0);
}

const key = pickArg('preset') || DEFAULT_PRESET;
const preset = PRESETS[key];
if (!preset) {
  console.error(`✗ 没有这个方案：${key}。可选：${Object.keys(PRESETS).join(' / ')}`);
  process.exit(1);
}

const ANCHOR = { body: preset.body, outfits: preset.outfits };
const total = `${ANCHOR.body}, ${ANCHOR.outfits}`;

console.log('方案   :', preset.name, `(${key})`);
console.log('body   :', ANCHOR.body);
console.log('outfits:', ANCHOR.outfits);
console.log('总长度 :', total.length, '字符');

if (argv.includes('--dry')) {
  console.log('\n(--dry) 未写库');
} else {
  config.user.anchor = ANCHOR;
  setSetting('user_anchor', JSON.stringify(ANCHOR));
  console.log('\n✓ 已写入 system_settings.user_anchor（重启后仍生效）');
}
