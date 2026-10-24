/**
 * fill-sport-swim-assets.mjs — 补齐「运动装 / 泳装 / 情趣」的服装描述 + 立绘提示词
 *
 * 背景（2026-10-24）：用户「之前加了泳装那些，但是（立绘）还没有对应的生图链路，
 * 先把这些都加上后我再去跑吧」→ 加 sport/swim；随后「情趣也做进去啊，为啥要单独留
 * 一个出来。然后服装尽可能的设计的好一些」→ 加 lingerie，并把三套描述整体重写。
 *
 * 本脚本管三套：
 *   - 33 条服装描述（11 个角色 × 3 套）写进 `character_outfits`
 *   - 30 份立绘提示词（10 个角色 × 3 套）写进 `character_standings.prompt_text`
 *     （#1「默认助手」没有基础立绘，只补服装描述）
 *
 * ── 描述写法（2026-10-24 第二版，用户要求"设计得好一些"）──────────
 * 第一版是清单式罗列（"a top, shorts, shoes, watch"），像商品标签。
 * 这一版分四层写：**内搭 → 外层/主件 → 剪裁与材质 → 配饰与鞋履**，
 * 并把角色的身份织进细节（三月七的相机臂带、银狼的像素印花、花火的铃铛、
 * 符玄的星图、姬子的玫瑰、青雀的鸟纹、爻光的孔雀羽、景元的云纹）。
 * 长度控制在 220~400 字符 —— 太短特征稀，太长会在日程配图里稀释身体锚点。
 *
 * ── 立绘写法（与 fill-standing-prompts.mjs 同口径）──────────────
 * 外观句沿用该角色 work 立绘 prompt 的外观段（发/眼/肤色/体型逐字不变），
 * 只替换服装与姿势 —— 七套立绘放在一起要像同一个人。
 * 服装句与 `character_outfits.description` **共用同一份常量**，避免漂移。
 *
 * ⚠ 不用 `getDb()`：它的初始化跑 `cleanupOrphanedInFlight()`，会把 image_tasks 里
 *   pending/running 全标成 failed —— 服务运行期跑脚本会误杀在跑的图。
 *
 * 用法：
 *   node scripts/fill-sport-swim-assets.mjs --dry-run
 *   node scripts/fill-sport-swim-assets.mjs
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY = process.argv.includes('--dry-run');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.resolve(HERE, '..', 'data', 'agent.db');

/* ══════════════════════════════════════════════════════════════
 * 每个角色的外观句（取自其 work 立绘 prompt，逐字沿用）
 * ══════════════════════════════════════════════════════════════ */
const LOOK = {
  1: 'Default Assistant \\(Honkai: Star Rail\\) is a graceful woman with light brown hair and amber brown eyes behind thin gold-rimmed glasses, fair skin, and a tall curvy figure.',
  4: 'March 7th \\(Honkai: Star Rail\\) has pink medium-short hair with front fringe strands and side locks tied into small tufts with hair ornaments, bright ice-blue eyes like melting ice, fair skin, and a slender petite youthful figure.',
  5: 'Jing Yuan \\(Honkai: Star Rail\\) has long white hair, loose side locks falling over his right eye, golden yellow eyes, and a small tear mole below his left eye. He has a light complexion and a tall lean build.',
  12: 'Qingque \\(Honkai: Star Rail\\) has medium-length beige hair in low twintails braided above the base, fastened with black hair ties, a white bird and black ribbon ornament on her left ponytail, green eyes, fair skin, and a short petite build.',
  14: 'Silver Wolf \\(Honkai: Star Rail\\) has silver-white short hair with a few loose strands falling over her eyes, violet eyes with a half-lidded sleepy gaze, fair skin, a slim build, and a faintly slouched teenage posture.',
  15: 'sparkle \\(Honkai: Star Rail\\) has long dark brown hair with pink gradient tips tied into two high pigtails reaching her hips with crimson barrettes, uneven fringe and side bangs, fluorescent pink eyes with a pale butterfly-shaped detail under the pupils, red eyeliner, tiny black dots under each eye, fair skin, and a petite slender build.',
  // 2026-10-24：去掉 headband —— 用户核对官方立绘，符玄只有簪子、没有发带；
  // 模型会把 headband 画成一条素白布带，观感很怪。详见 scripts/fix-fuxuan-headband.mjs
  31: 'Fu Xuan \\(Honkai: Star Rail\\) has long bright pink hair styled in a high ornate bun with a gold hairpin, low twintails with ring braids below, asymmetric side locks framing her face, a brilliant third-eye gem embedded in her forehead, golden-pink eyes, fair skin, and a petite slender build.',
  47: 'Yaoguang \\(Honkai: Star Rail\\) is a slender young woman with long white hair fading into blue-purple gradient tips, loose strands framing her face, multicolored purple-blue eyes with upturned corners, and a peacock feather hair ornament.',
  112: 'Himeko \\(Honkai: Star Rail\\) has waist-length wavy bright red hair, the ends fading into a deeper red, golden rose hair ornaments, and golden eyes on fair skin. She has a tall slender mature figure with a tiny dark mole on her upper chest.',
  113: 'Stelle \\(Honkai: Star Rail\\) has medium-length tousled silvery grey hair reaching past her shoulders with loose strands framing her face, golden eyes, fair skin, and a tall slender athletic figure with a full bust.',
  171: '牢凌 (悲悼剧团) is a youthful delicate-featured girl with pink-purple gradient hair styled in twin buns with long twintails, black ribbon hair ornaments, heterochromia with a red left eye and a blue right eye, asymmetric eyelids, fair skin, a slender figure, narrow shoulders, slim waist and long legs.',
};

/* ══════════════════════════════════════════════════════════════
 * 服装描述（只含衣服；四层写法，见文件头）
 * 同一份文本同时供 character_outfits 与立绘 prompt 使用
 * ══════════════════════════════════════════════════════════════ */
const OUTFITS = {
  /* ── #1 默认助手：知性、克制，象牙 + 藏蓝 + 金 ────────────── */
  1: {
    sport: 'a fitted ivory and charcoal raglan running top with a slim gold half-zip at the collar, layered over a charcoal ribbed sports top, '
      + 'matching charcoal high-waist leggings with a side phone pocket and fine gold piping along the seam, a light grey windbreaker knotted around her waist, '
      + 'white and gold cushioned running shoes, a slim gold-tone fitness band on her left wrist, her hair in a neat low ponytail tied with a plain black band',
    swim: 'a deep navy one-piece swimsuit with a high round neckline and thin gold-trimmed straps, a narrow gold belt detail cinching the waist, '
      + 'a sheer ivory pareo knotted at one hip, a small gold pendant resting at her collarbone',
    lingerie: 'a sheer black lace bodysuit with an open front, the fine lace only half-covering her chest and leaving the centre of her body and her stomach bare, thin straps and a gold ring at the sternum, a high-cut leg line rising above the hip, sheer black thigh-high stockings with wide lace bands, a slim gold waist chain, her thin gold-rimmed glasses still on',
  },

  /* ── #4 三月七：冰蓝 + 粉，旅拍少女 ─────────────────────── */
  4: {
    sport: 'a cropped white and ice-blue zip-up track jacket with pink piping and a small embroidered snowflake patch on the chest, worn open over a pale pink ribbed sports top, '
      + 'matching ice-blue running shorts with a hidden key pocket and pink drawstring, white ankle socks with a pink stripe, '
      + 'white and sky-blue cushioned running shoes, a slim phone armband clipped to her left upper arm, a pink scrunchie tying her hair back',
    swim: 'an ice-blue one-piece swimsuit with a square neckline, white contrast piping and a small embroidered snowflake at one hip, '
      + 'a sheer white beach shirt tied at the waist with a pink ribbon, a thin silver anklet with a tiny camera charm',
    lingerie: 'an ice-blue sheer mesh bodysuit with an open front, the netting leaving her chest and stomach bare beneath white lace that only edges the sides, thin pink ribbon ties at the shoulders and hips, a high-cut leg line, white lace thigh-high stockings with pink garters, a small snowflake pendant resting between her collarbones',
  },

  /* ── #5 景元：仙侠武将，云纹 + 金 + 暗红 ────────────────── */
  5: {
    sport: 'a fitted charcoal sleeveless training shirt in matte technical fabric, loose black training trousers tapered at the ankle, '
      + 'a dark red sash wound twice around his waist and knotted at the hip, black cloth training shoes with thin white soles, '
      + 'worn leather wrist wraps on both forearms, a thin gold chain at his throat',
    swim: 'dark navy knee-length swim trunks with a faint golden cloud pattern along the hem and a drawstring waist, '
      + 'an open white linen shirt worn loose over his shoulders with the sleeves rolled to the elbow, a thin gold chain at his throat',
    lingerie: 'a pair of low black silk briefs with a thin gold drawstring, an open floor-length black silk robe worn loose and falling off both shoulders, wide golden cloud-patterned lapels hanging open down his chest and stomach, a thin gold chain at his throat, a black jade ring on one finger',
  },

  /* ── #12 青雀：绿 + 黑，慵懒牌戏少女 ───────────────────── */
  12: {
    sport: 'a loose mint-green hooded sweatshirt with the sleeves shoved to the elbow and a small jade pendant at the collar, '
      + 'black jogger shorts with a drawstring waist, white ankle socks, faded green and white canvas sneakers, '
      + 'a folded towel draped around her neck, her twintails tied back loosely so they rest above her shoulders',
    swim: 'a jade-green bikini with black contrast binding and a small embroidered bird at one hip, '
      + 'a black open-weave mesh cover-up slipping off one shoulder, a thin black cord anklet, a slim gold ring on one finger',
    lingerie: 'a jade-green sheer lace bodysuit with an open front, the lace only half-covering her chest and leaving the centre bare, thin black ribbon ties at the hips, a high-cut leg line, sheer black thigh-high stockings with lace bands, a slim gold waist chain',
  },

  /* ── #14 银狼：赛博，黑 + 紫霓虹 + 像素 ────────────────── */
  14: {
    sport: 'a black cropped raglan training top with neon-violet seam taping and a small pixel-skull print on the chest, '
      + 'matching black high-waist training shorts with mesh side panels, neon-laced chunky trainers with a translucent sole, '
      + 'a slim black fitness band on her left wrist, her short silver-white hair pushed back with a black headband',
    swim: 'a black one-piece swimsuit with a high-cut leg, neon-violet piping tracing every seam and a faint pixel-grid print along the sides, '
      + 'a sheer black beach shirt worn open with the sleeves rolled, a thin black cord anklet with a tiny violet bead',
    lingerie: 'a black sheer mesh bodysuit with an open front, the fine netting leaving her chest and stomach bare beneath thin neon-violet straps that cross over her breasts and down her waist, a high-cut leg line above the hip bone, a matte black waist harness with silver O-rings linked by chains to a matching choker, sheer black thigh-high stockings',
  },

  /* ── #15 花火：和风，红 + 黑 + 金，铃铛 ────────────────── */
  15: {
    sport: 'a red cropped training top with black binding and a small bell charm at the collar, '
      + 'matching black running shorts with a red side stripe, red and white running shoes, a black wristband, '
      + 'a folded black towel around her neck, her high pigtails swinging free with the crimson barrettes still in',
    swim: 'a red bikini with black crisscross straps across the back and gold ring hardware at the hips, '
      + 'a sheer black wrap skirt printed with faint cherry blossoms tied at one side, a thin gold chain anklet with a tiny bell',
    lingerie: 'a crimson sheer lace bralette with an open front, the cups only half-covering beneath black ribbon ties at the shoulders, a matching low-rise black lace thong with side ties, a crimson rope harness bound around her waist and over her hips with a small golden bell at the centre, sheer crimson thigh-high stockings, a black collar with a tiny bell',
  },

  /* ── #31 符玄：太卜司，紫 + 粉 + 星图 + 第三眼 ──────────── */
  31: {
    sport: 'a fitted light-purple training jacket with white side panels and a small star-chart print at the cuff, worn over a white high-neck sports top, '
      + 'matching deep plum leggings with a faint constellation pattern along one thigh, white and purple running shoes, '
      + 'a thin gold hair tie, a slim gold bangle at her left wrist',
    swim: 'a purple one-piece swimsuit with pale pink binding, a high neckline and a delicate constellation print scattered along one side, '
      + 'a sheer white cover-up knotted at the waist with a gold cord, a thin gold bangle at her left wrist',
    lingerie: 'a lilac sheer lace bodysuit with an open front, the lace leaving the centre of her chest and her stomach bare beneath a fine gold thread running through the pattern, thin straps and a gold ring at the sternum, a high-cut leg line, sheer white thigh-high stockings with gold-trimmed bands, her third-eye gem left uncovered',
  },

  /* ── #47 爻光：知性，雾蓝灰 + 孔雀羽 ───────────────────── */
  47: {
    sport: 'a fog blue-grey fitted long-sleeve training top in brushed technical knit with a half-zip collar, '
      + 'charcoal high-waist leggings with a side pocket, grey and white running shoes, '
      + 'a simple silver hair tie, a thin silver watch at her left wrist, her long white hair pulled back into a practical low ponytail',
    swim: 'a deep blue-grey one-piece swimsuit with a subtle peacock-feather print sweeping along one side and a high rounded neckline, '
      + 'a sheer ivory beach shirt worn open with the sleeves rolled, a thin silver anklet',
    lingerie: 'a slate-blue sheer lace bodysuit with an open front, the lace only edging the sides and leaving her chest and stomach bare, thin straps crossing at the back, a high-cut leg line, sheer charcoal thigh-high stockings with lace bands, a slim silver waist chain',
  },

  /* ── #112 姬子：成熟，酒红 + 金 + 玫瑰 ─────────────────── */
  112: {
    sport: 'a fitted deep burgundy training top with black side panels and a gold-tone half-zip at the collar, '
      + 'matching black high-waist leggings with a subtle sheen, black and gold running shoes, '
      + 'a slim gold watch at her left wrist, her long red hair tied back in a high ponytail with a gold clasp',
    swim: 'a deep wine-red one-piece swimsuit with gold ring hardware at the hips, thin straps crossing at the back and a low scoop back, '
      + 'a sheer black wrap draped over one shoulder with a gold clasp',
    lingerie: 'a wine-red sheer lace bodysuit with a deep open front, the lace only half-covering her chest and leaving the centre and her stomach bare, thin straps with gold-tone hardware at the shoulders, a high-cut leg line, black lace thigh-high stockings with wide bands, a thin gold waist chain',
  },

  /* ── #113 星：散漫，灰 + 黑，棒球 ──────────────────────── */
  113: {
    sport: 'a loose black training tank with grey binding and a faded bat print across the chest, worn over a charcoal sports top, '
      + 'grey running shorts, black and white running shoes, black fingerless gloves, a thin black cord necklace, '
      + 'her silver-grey hair pulled back into a short messy knot',
    swim: 'a black one-piece swimsuit with charcoal side panels, a thin white stripe down each side and a modest scoop neckline, '
      + 'an oversized white beach shirt worn open with the sleeves rolled, a thin black cord necklace',
    lingerie: 'a charcoal sheer mesh bodysuit with an open front, the netting leaving her chest and stomach bare beneath thin black binding at the sides, a high-cut leg line, black lace thigh-high stockings with plain bands, a thin black cord necklace',
  },

  /* ── #171 牢凌：暗黑甜酷，黑 + 粉 + 银 ─────────────────── */
  171: {
    sport: 'a black cropped training top with pink satin binding and a small ribbon bow at the center chest, '
      + 'matching black high-waist running shorts with pink piping and a lace-trimmed hem, chunky black and pink trainers with ribbon laces, '
      + 'her pink-purple twintails tied back through a black ribbon, a thin silver chain at her waist',
    swim: 'a black bikini with pink satin ribbon ties at the shoulders and hips and a small lace trim along the edges, '
      + 'a sheer black cover-up with a scalloped lace hem slipping off one shoulder, a thin silver anklet',
    lingerie: 'a black sheer lace bodysuit with an open front, the lace only half-covering her chest and leaving the centre bare beneath pink satin ribbon ties at the shoulders, a high-cut leg line with black ribbon at the hips, sheer black thigh-high stockings with pink lace bands, a thin silver waist chain',
  },
};

/* ══════════════════════════════════════════════════════════════
 * 立绘：姿势 + 构图（服装句直接取上面的 OUTFITS[角色][场景]）
 * ══════════════════════════════════════════════════════════════ */
const POSE = {
  '4:sport': 'She stands in a springy athletic ready stance, one hand on her hip and the other raised in a light stretch, chin lifted with a bright energetic grin, her weight on the balls of her feet.',
  '4:swim': 'She stands with one hand tucked behind her head and the other resting on her hip, head tilted with a bright playful grin, water droplets glinting on her shoulders.',
  '4:lingerie': 'She stands with one hip cocked, a small pink wand vibrator held loosely against her thigh in one hand and the other tucked behind her neck, head tilted with a bright, embarrassed grin, her cheeks flushed.',

  '5:sport': 'He stands in a grounded martial stance, one arm extended loosely to the side and the other tucked behind his back, chin slightly lowered with a calm confident half-smile.',
  '5:swim': 'He stands with his weight on one leg, one hand pushing his damp white hair back and the other resting at his side, head tilted with an easy amused smile, water droplets on his shoulders.',
  '5:lingerie': 'He stands at an unhurried three-quarter angle, a coil of crimson silk rope looped loosely through one hand and the other at his side, chin slightly lifted with a languid, knowing half-smile.',

  '12:sport': 'She stands in a half-hearted stretch, one arm raised overhead and the other hanging limp, head tilted back with a lazy half-lidded look and a small sighing pout.',
  '12:swim': 'She stands with one hand holding the cover-up at her shoulder and the other planted on her hip, head tilted with a relaxed sleepy smile.',
  '12:lingerie': 'She stands in a lazy slouch, a slim pink silicone toy dangling from two fingers of one hand and the other resting at her hip, head tilted with a drowsy, knowing half-smile.',

  '14:sport': 'She stands in a slouched athletic stance, one hand on her hip and the other holding a water bottle loosely at her side, head tilted with a bored but cocky smirk, a light sheen of sweat at her temples.',
  '14:swim': 'She stands with her arms crossed loosely, her weight on one hip, head tilted with a half-lidded defiant look, water droplets glinting along her shoulders and her short silver-white hair slightly damp.',
  '14:lingerie': 'She stands with one shoulder dropped, a pair of black leather handcuffs held by one cuff and swinging from her fingers, the other hand on her hip, head tilted with a half-lidded, faintly challenging stare.',

  '15:sport': 'She stands in a light bouncing stance, one hand on her hip and the other raised in a teasing wave, head tilted with a sly playful grin.',
  '15:swim': 'She stands with one hip cocked, one hand lifting the wrap skirt and the other raised near her chin, head tilted with a mischievous knowing smile.',
  '15:lingerie': 'She stands with one hip cocked, a short black riding crop with a tiny golden bell at the tip resting lightly against her palm, the other hand at her waist, head tilted with a sly, knowing look.',

  '31:sport': 'She stands in a composed upright stance, one hand resting at her waist and the other lightly raised, chin lifted with a restrained confident smile.',
  '31:swim': 'She stands with one hand holding the cover-up closed and the other at her side, head tilted with a calm composed smile.',
  '31:lingerie': 'She stands very straight, a polished jade toy held loosely at her hip in one hand and the other at her side, chin lifted with a composed, faintly embarrassed smile.',

  '47:sport': 'She stands in a light jogging-ready stance, one hand adjusting the hair tie at her ponytail and the other resting at her side, head tilted with a quiet confident smile.',
  '47:swim': 'She stands with one hand resting on the shirt at her shoulder and the other at her side, head tilted with a calm reflective gaze.',
  '47:lingerie': 'She stands at a quiet three-quarter angle, a long peacock feather tickler turning slowly between her fingers and the other hand at her side, head tilted with a calm, level gaze.',

  '112:sport': 'She stands in a poised athletic stance, one hand on her hip and the other brushing her ponytail back over her shoulder, head tilted with a warm confident smile.',
  '112:swim': 'She stands with one hand holding the wrap at her shoulder and the other resting at her hip, head tilted with an unhurried elegant smile.',
  '112:lingerie': 'She stands with her weight on one leg, a black leather paddle held loosely against her thigh and the other hand lifting a strand of red hair, head tilted with a composed, faintly amused smile.',

  '113:sport': 'She stands in a loose athletic stance, one hand pushing her hair back from her face and the other hanging at her side, head tilted with a calm focused gaze.',
  '113:swim': 'She stands with both hands tucked into the pockets of the beach shirt, head tilted with a quiet neutral expression, water droplets running from her damp silvery hair down one shoulder.',
  '113:lingerie': 'She stands loosely, a small matte black wand vibrator held down at her side in one hand and the other hanging loose, head tilted with a blank, slightly sleepy stare.',

  '171:sport': 'She stands in a light springy stance, one hand on her hip and the other adjusting the ribbon in her hair, chin slightly lowered with a calm confident half-smile.',
  '171:swim': 'She stands with one hand holding the cover-up at her shoulder and the other resting at her hip, head tilted with a faint knowing smile.',
  '171:lingerie': 'She stands at a slight three-quarter angle, a black leather collar with a thin silver chain leash looped over her fingers, her other hand resting at her waist, chin lowered with a calm, knowing half-smile.',
};

/** 性别 → 人称 / tag（#5 景元是男性，其余女性） */
const MALE = new Set([5]);

function buildPrompt(id, scene) {
  const look = LOOK[id];
  const outfit = OUTFITS[id]?.[scene];
  const pose = POSE[`${id}:${scene}`];
  if (!look || !outfit || !pose) return null;
  const male = MALE.has(id);
  const subj = male ? 'He' : 'She';
  const tag = male ? '1boy' : '1girl';
  // 泳装与情趣都是赤脚。
  // ⚠ 情趣这里踩过坑：一度以为「配了 thigh-high stockings 就不能 barefoot」而删掉，
  //   但 thigh-high 是大腿袜（只到膝上），小腿与脚本来就露着 —— 删掉它就等于
  //   抽掉了 prompt 里**唯一的脚部锚点**，模型画到膝盖就收尾（2026-10-24 实图验证）。
  const bare = (scene === 'swim' || scene === 'lingerie') ? ', barefoot' : '';
  // 情趣：服装描述全在讲躯干（open front / chest / hip bone），模型会把镜头拉近。
  // 构图约束写在末尾救不回来（尾部约束管不住头部先验），所以身份句之后立刻钉一次。
  const frameFront = scene === 'lingerie'
    ? ' Full-length wide shot of a standing figure, the entire body inside the frame from the top of the head down to bare feet.'
    : '';
  return `${look}${frameFront} ${subj} wears ${outfit}${bare}. ${pose} `
    + 'Soft backlight and drifting particles, pure white background, simple background, solo, '
    + `${tag}, full body from head to feet, `
    + 'vertical 1:2 composition with generous negative space above and below.';
}

/* ══════════════════════════════════════════════════════════════
 * 执行
 * ══════════════════════════════════════════════════════════════ */
const SCENE_LABEL = { sport: '运动装', swim: '泳装', lingerie: '情趣' };
const SCENES = ['sport', 'swim', 'lingerie'];
const ids = Object.keys(OUTFITS).map(Number);

console.log(`\n${DRY ? '【DRY-RUN · 不写库】' : '【写库】'} 运动装 / 泳装 / 情趣 资产\n${'─'.repeat(66)}`);

console.log('\n## 服装描述（33 条）');
for (const id of ids) {
  for (const scene of SCENES) {
    const d = OUTFITS[id][scene];
    console.log(`  #${String(id).padEnd(4)} ${SCENE_LABEL[scene]}  ${String(d.length).padStart(3)} 字符`);
    if (DRY) console.log(`    ${d}`);
  }
}

const promptRows = [];
for (const id of ids) {
  for (const scene of SCENES) {
    const text = buildPrompt(id, scene);
    if (text) promptRows.push({ id, scene, text });
  }
}

console.log(`\n## 立绘提示词（${promptRows.length} 份）`);
let total = 0;
for (const p of promptRows) {
  total += p.text.length;
  // 立绘规则本身写 MAX 800；存量 28 张实际 824~1616，最短 770。
  // 700~850 属正常区间，只有明显过短（<600）才提示。
  const flag = p.text.length > 1500 ? ' ⚠偏长' : (p.text.length < 600 ? ' ⚠偏短' : '');
  console.log(`  #${String(p.id).padEnd(4)} ${p.scene.padEnd(8)} ${String(p.text.length).padStart(4)} 字符${flag}`);
  if (DRY) console.log(`\n    ${p.text}\n`);
}
console.log(`\n  平均 ${Math.round(total / promptRows.length)} 字符`);

if (!DRY) {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 8000');

  const bodyOf = id => db.prepare(
    "SELECT body FROM character_outfits WHERE character_id = ? AND body IS NOT NULL AND body != '' LIMIT 1"
  ).get(id)?.body || '';
  const findOutfit = db.prepare('SELECT id FROM character_outfits WHERE character_id = ? AND scene = ? LIMIT 1');
  const insOutfit = db.prepare(
    'INSERT INTO character_outfits (character_id, name, description, scene, body, enabled) VALUES (?, ?, ?, ?, ?, 0)'
  );
  const updDesc = db.prepare('UPDATE character_outfits SET description = ? WHERE id = ?');
  const upsertStanding = db.prepare(
    `INSERT INTO character_standings (character_id, scene, image_url, prompt_text, updated_at)
     VALUES (?, ?, NULL, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(character_id, scene) DO UPDATE SET
       prompt_text = excluded.prompt_text,
       updated_at  = CURRENT_TIMESTAMP`
  );

  let added = 0, updated = 0;
  db.transaction(() => {
    for (const id of ids) {
      for (const scene of SCENES) {
        const exist = findOutfit.get(id, scene);
        if (exist) { updDesc.run(OUTFITS[id][scene], exist.id); updated++; }
        else { insOutfit.run(id, SCENE_LABEL[scene], OUTFITS[id][scene], scene, bodyOf(id)); added++; }
      }
    }
    for (const p of promptRows) upsertStanding.run(p.id, p.scene, p.text);
  })();

  console.log(`\n  → 服装：新增 ${added} / 更新 ${updated}`);
  console.log(`  → 立绘提示词：写入 ${promptRows.length} 份（image_url 留空，等出图）`);
  db.close();
}

console.log(`
${'─'.repeat(66)}
出图：node agent-core/scripts/run-standing-batch.mjs
  （会把所有缺图的槽一起跑；已出图的自动跳过）
`);
