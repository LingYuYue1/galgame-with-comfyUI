/**
 * 阶段 7 验收 / 试穿图：只出「用户本人」，可选与某个角色同框。
 *
 * 用法：
 *   node scripts/probe-user-anchor-image.mjs                              # 库内锚点，单人
 *   node scripts/probe-user-anchor-image.mjs --preset=unfinished          # 试穿（不写库）
 *   node scripts/probe-user-anchor-image.mjs --preset=unfinished --with=171   # 与牢凌同框
 *   node scripts/probe-user-anchor-image.mjs --preset=gambler --pose=half
 *
 * 方案库见 `scripts/user-outfit-presets.mjs`。
 * ⚠ 本脚本**只读**配置：试穿不落库，采纳要另外跑 `set-user-anchor.mjs --preset=xx`。
 */
import { getDb } from '../src/db/index.js';
import path from 'path';
import { PRESETS } from './user-outfit-presets.mjs';

getDb();
const { generateImageRaw } = await import('../src/services/imageSkill.js');
const { config } = await import('../src/config.js');
const { saveBase64Image } = await import('../src/services/imagePaths.js');

const argv = process.argv.slice(2);
const pickArg = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const presetKey = pickArg('preset');
const pose = pickArg('pose') || 'full';       // full=全身立绘  half=半身
const withId = pickArg('with');               // 与某个角色 id 同框

const preset = presetKey ? PRESETS[presetKey] : null;
if (presetKey && !preset) {
  console.error(`✗ 没有这个方案：${presetKey}。可选：${Object.keys(PRESETS).join(' / ')}`);
  process.exit(1);
}

// 试穿时把方案临时挂到内存里的 config（**不写库**），
// 这样双人模式也能走正常的 applyAnchors（含 1boy/1girl 的人数与位置词）
if (preset) config.user.anchor = { body: preset.body, outfits: preset.outfits };

console.log('======== 用户形象 ========');
console.log(' 昵称:', config.user?.nickname || '(空)', '| 性别:', config.user?.gender || '(空)');
console.log(preset ? ` 试穿方案: ${preset.name}（${presetKey}）—— 不写库` : ' 使用库内锚点');
if (withId) console.log(` 同框角色 id: ${withId}`);

/** 意气风发的姿态要写进提示词 —— 老气有一半来自"站着不动" */
const POSE_FULL = [
  'dynamic confident posture', 'standing with weight on one leg', 'shoulders relaxed',
  'slight smirk', 'looking at viewer', 'wind moving the hair',
].join(', ');
const POSE_HALF = [
  'half body', 'confident posture', 'slight smirk', 'looking at viewer',
].join(', ');

const BG = 'simple white background, flat lighting, even lighting, no shadows';

let prompt;
if (withId) {
  prompt = `two people standing side by side, ${POSE_FULL}, ${BG}`;
} else {
  prompt = `solo, ${pose === 'half' ? POSE_HALF : POSE_FULL}, ${BG}`;
}

const anchors = withId
  ? [{ kind: 'user' }, { characterId: Number(withId) }]
  : [{ kind: 'user' }];

console.log('\n======== 提交生图 ========');
console.log(' 描述:', prompt);

const result = await generateImageRaw(prompt, {
  promptScene: 'avatar',        // 借用头像场景：不跑 RAG，快
  priority: 'high',
  disableRAG: true,
  skipOptimization: true,       // 试穿图不要被 LLM 改写锚点
  artist: config.comfyui.momentsArtist,
  width: withId ? 1280 : (pose === 'half' ? 640 : 576),
  height: withId ? 1024 : 864,   // 用户要求：试穿图不用生太大，够看清就够
  anchors,
});

if (!result?.success || !result.images?.length) {
  console.error('✗ 出图失败:', result?.error || '(无返回)');
  process.exit(1);
}

const img = result.images[0];
const tag = presetKey || 'current';
const filename = `user_outfit_${tag}${withId ? `_with${withId}` : ''}_${Date.now()}.png`;
const url = saveBase64Image('avatargen', filename, img.base64);
const abs = path.resolve('data/images', url.replace(/^\/images\//, ''));

console.log('\n======== 结果 ========');
console.log(' 落盘:', abs);
console.log(' 最终提示词（前 600 字符）:\n', String(result.promptRefined || '').slice(0, 600));
