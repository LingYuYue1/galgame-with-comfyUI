/**
 * 阶段 7 验收图：只出「用户本人」一张，给用户认脸。
 *
 * 方案 §9 原话：「先出一张「生图测试」给用户认，点头才接链路」
 * —— 所以这个脚本**不接任何业务链路**，只验证"锚点能不能把这个人画出来"。
 *
 * 用法：node scripts/probe-user-anchor-image.mjs
 * 产物：data/images/avatargen/user_anchor_probe_<时间戳>.png
 */
import { getDb } from '../src/db/index.js';
import fs from 'fs';
import path from 'path';

getDb();
const { generateImageRaw } = await import('../src/services/imageSkill.js');
const { config } = await import('../src/config.js');
const { saveBase64Image } = await import('../src/services/imagePaths.js');

console.log('======== 用户形象（config.user）========');
console.log(' 昵称:', config.user?.nickname || '(空)');
console.log(' 性别:', config.user?.gender || '(空)');
console.log(' 外观:', String(config.user?.appearance || '(空)').slice(0, 300));
if (!config.user?.appearance) {
  console.error('\n✗ user_appearance 为空，先填外观再来');
  process.exit(1);
}

// 立绘式全身，方便一次看清脸 + 衣服 + 身形
const PROMPT = 'solo, full body, standing, looking at viewer, hands relaxed at sides, '
  + 'straight-on view, simple white background, flat lighting, even lighting, no shadows';

console.log('\n======== 提交生图 ========');
console.log(' 原始描述:', PROMPT);
const result = await generateImageRaw(PROMPT, {
  promptScene: 'avatar',       // 借用头像场景：不跑 RAG，快
  priority: 'high',
  disableRAG: true,
  artist: config.comfyui.momentsArtist,
  width: 768,
  height: 1152,                // 全身需要竖图
  anchors: [{ kind: 'user' }], // ← 阶段 7 的全部意义就在这一行
});

if (!result?.success || !result.images?.length) {
  console.error('✗ 出图失败:', result?.error || '(无返回)');
  process.exit(1);
}

const img = result.images[0];
const filename = `user_anchor_probe_${Date.now()}.png`;
const url = saveBase64Image('avatargen', filename, img.base64);
const abs = path.resolve('data/images', url.replace(/^\/images\//, ''));

console.log('\n======== 结果 ========');
console.log(' 落盘:', abs);
console.log(' 最终提示词（前 400 字符）:\n', String(result.promptRefined || '').slice(0, 400));
console.log(' 锚点文本:\n', String(result.anchorUsed || '(无)').slice(0, 400));
