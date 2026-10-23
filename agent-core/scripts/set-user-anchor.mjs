/**
 * 写入用户形象的**生图锚点**（阶段 7，2026-10-23）。
 *
 * 为什么需要脚本而不是直接改中文那段：
 *   实测 `config.user.appearance` 那段中文长描述在本模型上约束力接近零 ——
 *   出图是个银发蓝西装的少年，与文字毫无关系（角色锚点用英文 tag 就一直很稳）。
 *   所以拆成两份：appearance 继续管文案，anchor 管画面。
 *
 * 用法：node scripts/set-user-anchor.mjs [--dry]
 *   --dry 只打印，不写库
 */
import { getDb } from '../src/db/index.js';

getDb();
const { setSetting } = await import('../src/db/settings.js');
const { config } = await import('../src/config.js');

/**
 * 由 `config.user.appearance` 那段中文逐句对译而来，**不写 1boy**：
 * 人数由 applyAnchors 统一写（施工方案 §18.2：tag 串开头会切进立绘模式）。
 * `young man / male focus` 必须留 —— 只有中性外观词时模型会把人画成女性。
 */
const ANCHOR = {
  body: [
    'young man', 'male focus',
    // 发型：及肩、自然垂落、不束起
    'long black hair', 'shoulder-length black hair', 'loose hair', 'hair down', 'untied hair',
    // 异色瞳 + 一单一双
    'heterochromia', 'red left eye', 'blue right eye', 'asymmetrical eyelids', 'sharp eyes',
    // 180cm 无法用 tag 表达，只取"修长/偏瘦/线条干净"
    'tall', 'slender', 'lean build', 'fair skin',
  ].join(', '),
  outfits: [
    // 黑黄长风衣：阴阳图 / 四象纹 / 飘带 / 袖口卦象
    'long black and yellow coat', 'open coat over black shirt',
    // ⚠ 必须点名内搭。只写 `open coat` 时模型会把风衣画成敞开露胸（第一版实测），
    //   用户原描述里没有露出，"衣衫下的线条"是穿着衣的状况
    'black shirt', 'black high-collar shirt', 'buttoned shirt',
    'yin-yang emblem on lapel', 'four symbols pattern on hem',
    'ribbons trailing from coat', 'hexagram patterns on cuffs',
    // 下装
    'black trousers', 'thigh strap', 'ring pockets', 'black low-top boots',
    // 配饰：右腕朱砂绳、腰间五帝钱 + 腰牌
    // ⚠ `hanging at waist` 会被画成一条金色圆片腰带，改成 from belt 限定为"挂在腰带上"
    'red cinnabar cord wrapped around right wrist',
    'five chinese coins hanging from waist belt', 'waist plaque',
  ].join(', '),
};

const dry = process.argv.includes('--dry');
console.log('body   :', ANCHOR.body);
console.log('outfits:', ANCHOR.outfits);
console.log('总长度 :', (ANCHOR.body + ', ' + ANCHOR.outfits).length, '字符');

if (dry) {
  console.log('\n(--dry) 未写库');
} else {
  config.user.anchor = ANCHOR;
  setSetting('user_anchor', JSON.stringify(ANCHOR));
  console.log('\n✓ 已写入 system_settings.user_anchor（重启后仍生效）');
}
