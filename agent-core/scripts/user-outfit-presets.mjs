/**
 * 用户形象的外观方案库（2026-10-23 第四版：日常单品路线）
 *
 * ── 用户第五次反馈 ──
 * 「嗯，还有有些怪。（附图 gambler）这套稍微好一点，现在不用出合照。
 *   多搞几套方案吧要不。图不用生分辨率太大的。」
 *
 * ⇒ 用户认可的方向是 **gambler 这一路**：日常可见的单品 + 一点科幻点缀 + 年轻。
 *   不是"角色设计感"，是"街上真有人这么穿"。
 * ⇒ 所以本版不再碰长风衣/长袍/礼装，全部改短款日常单品，只保留：
 *   黑色及肩长发 / 左红右蓝异色瞳 / 一单一双 / 一点青绿发光 / 高帮或厚底鞋。
 *
 * ── 一条被反复验证的规律 ──
 * 老气 = 长（长风衣、长袍、及膝靴）+ 满（层层叠叠）+ 暗（全身深色）+ 直（站得笔直）。
 * 年轻 = 短 + 松 + 亮 + 动。五套方案全部按这个来。
 */

const BODY = [
  'young man', 'male focus', 'youthful',
  'long black hair', 'shoulder-length black hair', 'loose hair', 'hair down',
  'heterochromia', 'red left eye', 'blue right eye', 'asymmetrical eyelids',
  'bright eyes', 'handsome face',
  'tall', 'slender', 'lean build', 'fair skin',
].join(', ');

/**
 * ①「棒球少年」—— gambler 的兄弟，但更冷更利落
 * 用户认可的就是这一路，所以留一个更干净的版本做基准：
 * 黑夹克 + 米白袖子（对撞），去掉印花，靠剪裁和配件说话。
 */
const VARSITY = {
  name: '棒球少年',
  body: BODY,
  outfits: [
    'black varsity jacket', 'cream white sleeves', 'striped ribbed cuffs and collar',
    'jacket open', 'cropped fit',
    'white t-shirt', 'light blue denim jeans',
    'white high top sneakers',
    'silver chain hanging from belt', 'silver earring', 'silver rings',
    'black fingerless glove on right hand',
    'teal glowing stripe along the sleeve',
  ].join(', '),
};

/**
 * ②「连帽卫衣」—— 最松弛的一套
 * 没有硬质结构，全靠 oversized 与垂坠感；卫衣抽绳做青绿微光。
 */
const HOODIE = {
  name: '连帽卫衣',
  body: BODY,
  outfits: [
    'oversized beige hoodie', 'hood down', 'kangaroo pocket', 'sleeves pushed up',
    'white t-shirt showing at hem',
    'light grey jogger pants', 'cropped above ankle',
    'white high top sneakers',
    'silver necklace', 'single silver earring',
    'teal glowing drawstrings on the hood',
  ].join(', '),
};

/**
 * ③「皮夹克」—— 最硬的一套
 * 亮面皮质 + 银拉链，把"游侠"的锐气放在材质上而不是纹样上。
 */
const BIKER = {
  name: '皮夹克',
  body: BODY,
  outfits: [
    'black leather biker jacket', 'cropped', 'silver zippers',
    'asymmetric zipper collar', 'jacket open',
    'black t-shirt',
    'black slim jeans',
    'black ankle boots', 'silver buckles',
    'silver chain', 'silver rings', 'black fingerless gloves',
    'teal glowing line along the collar',
  ].join(', '),
};

/**
 * ④「机能风」—— 最崩铁的一套
 * 短款机能外套 + 多口袋 + 束带，配色取白与黑，青绿微光走缝线。
 */
const TECHWEAR = {
  name: '机能风',
  body: BODY,
  outfits: [
    'white technical jacket', 'cropped', 'multiple pockets', 'black straps across the chest',
    'black undershirt',
    'black cargo pants', 'straps around thighs',
    'black tactical boots',
    'silver buckles', 'silver carabiner at waist',
    'teal glowing seams along the jacket',
  ].join(', '),
};

/**
 * ⑤「赛车夹克」—— 最热烈的一套
 * 深蓝白橙三色拼接，速度感；这是唯一一套把三个颜色都用满的。
 */
const RACER = {
  name: '赛车夹克',
  body: BODY,
  outfits: [
    'navy blue racing jacket', 'white and orange stripes on the chest',
    'cropped', 'jacket open', 'ribbed cuffs',
    'black t-shirt',
    'dark blue jeans',
    'red high top sneakers', 'white soles',
    'silver chain', 'silver earring',
    'teal glowing line on the sleeve',
  ].join(', '),
};

/**
 * ⑥「赌桌少年」—— 用户附图认可的那套（保留作基准，别再改它）
 * 米白飞行夹克 + 酒红内衬 + 黑T + 深牛仔 + 银腰链 + 红帆布鞋。
 */
const GAMBLER = {
  name: '赌桌少年',
  body: BODY,
  outfits: [
    'cream colored bomber jacket', 'jacket open', 'ribbed cuffs',
    'dark red inner lining', 'red trim',
    'black fitted t-shirt',
    'dark denim jeans', 'belt with silver chain',
    'red high top sneakers', 'white soles',
    'single black fingerless glove on left hand',
    'silver rings', 'silver earring',
    'teal glowing line on the jacket sleeve',
  ].join(', '),
};

export const PRESETS = {
  varsity: VARSITY,
  gambler: GAMBLER,
  hoodie: HOODIE,
  biker: BIKER,
  techwear: TECHWEAR,
  racer: RACER,
};

export const DEFAULT_PRESET = 'varsity';
