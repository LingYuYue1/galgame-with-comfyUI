/**
 * fill-standing-prompts.mjs — 补立绘提示词（第二阶段 A 阶段）
 *
 * 背景（2026-10-24）：用户「先把立绘的提示词填充好，我去跑即可」。
 *
 * ── 为什么手写，不调 LLM ──────────────────────────────────────
 * 同一角色的四套立绘必须**看起来是同一个人**。UI 里点「生成」会重新走 LLM，
 * 每次重写外观段 —— 实测存量 28 张 prompt 长度 824~1616、句式各不相同，
 * 四套放一起就能看出脸在漂。本脚本以**该角色已有的那张立绘 prompt 的外观句为骨架，
 * 逐字沿用**，只替换「服装段」与「姿势段」，把漂移压到最小。
 *
 * ── 写入什么 ─────────────────────────────────────────────
 * 1) #171 牢凌补 casual / home / sleep 三套服装描述（原来只有 work，出图永远常服）
 * 2) #14 银狼 home 描述纠错（原文 "long ponytail let down" 与「银白短发」矛盾）
 * 3) 12 处缺图的场景立绘写 prompt_text（image_url 留空，等出图）
 *
 * 出图方式：角色详情页切到该场景 → 点「再次 Roll 图」（会复用这里存的 prompt，
 * 不再请求 LLM）。点「生成」则会重新让 LLM 写一份，覆盖掉这里的。
 *
 * 用法：
 *   node scripts/fill-standing-prompts.mjs --dry-run   # 只打印，不写库
 *   node scripts/fill-standing-prompts.mjs             # 写库
 *
 * ⚠ 为什么直连 SQL 而不是调 outfitScene.upsertSceneOutfits / characterStanding.upsertSceneStanding：
 *   那两个函数走 `getDb()`，而 `getDb()` 的初始化里有 `cleanupOrphanedInFlight()` ——
 *   它会把 image_tasks 里所有 pending/running 的任务标成 failed。
 *   脚本在服务运行期间执行，一跑就会误杀正在排队/生成的图。所以这里自建只读-写入连接，
 *   只碰 character_outfits / character_standings 两张表，不触发任何启动清理。
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NUDE_NAME, NUDE_DESCRIPTION } from '../src/services/outfitScene.js';

const DRY = process.argv.includes('--dry-run');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.resolve(HERE, '..', 'data', 'agent.db');

/* ══════════════════════════════════════════════════════════════
 * 一、#171 牢凌缺的三套服装（work 已有：白挂脖 + 粉蝴蝶结 + 黑 oversized 外套
 *     + 黑百褶短裙 + 大腿绑带 + 厚底靴）。风格延续「暗黑甜酷」，不另起一套审美。
 *     规范：description 只写衣服不含身体；home 必须有室内拖鞋，sleep 必须赤脚。
 * ══════════════════════════════════════════════════════════════ */
const NEW_OUTFITS = [
  {
    characterId: 171,
    scene: 'casual',
    name: '私服',
    description:
      'black lace-trimmed camisole dress with a pink ribbon at the waist, layered over a sheer white blouse with puffed sleeves, ' +
      'a cropped black denim jacket with pink stitched seams, black knee-high socks with lace cuffs, ' +
      'chunky black platform sneakers with pink laces, a small heart-shaped crossbody bag, thin silver rings',
  },
  {
    characterId: 171,
    scene: 'home',
    name: '居家',
    description:
      'oversized off-white knit cardigan worn open over a black slip dress with a lace hem, ' +
      'soft black cotton lounge shorts, fluffy pink indoor slippers, a thin silver anklet at one ankle',
  },
  {
    characterId: 171,
    scene: 'sleep',
    name: '睡衣',
    description:
      'black satin sleep camisole with delicate pink lace trim along the neckline and thin straps, ' +
      'matching short satin shorts, a loose sheer black robe slipping off one shoulder, barefoot',
  },
];

/** #14 银狼 home：描述里的 "long ponytail let down over one shoulder" 与银白短发矛盾 */
const FIX_OUTFITS = [
  {
    characterId: 14,
    scene: 'home',
    name: '居家',
    description:
      'loose black graphic tee with a glowing pixel logo, soft grey joggers, fuzzy slippers, ' +
      'a hooded blanket draped over her shoulders, her short silver-white hair loosely tied back, ' +
      'a handheld console set aside',
  },
];

/* ══════════════════════════════════════════════════════════════
 * 二、12 份立绘 prompt
 *     每份 = 身份标签 + 外观句（照抄该角色已有 prompt）+ 服装段 + 姿势段 + 构图段
 *     构图段统一：pure white background / solo / full body / vertical 1:2
 * ══════════════════════════════════════════════════════════════ */

/** 景元：work 是铠甲常服（含 high ponytail）。casual/home/sleep 三套发型要松散，
 *  所以外观句去掉 "in a high ponytail"，但发色/瞳色/泪痣/体型逐字保留。 */
const JY_LOOK =
  'Jing Yuan \\(Honkai: Star Rail\\) has long white hair, loose side locks falling over his right eye, ' +
  'golden yellow eyes, and a small tear mole below his left eye. He has a light complexion and a tall lean build.';
const JY_FRAME =
  'Soft backlight rims his white hair and shoulders with a faint golden glow and drifting motes, ' +
  'pure white background, simple background, solo, 1boy, full body from head to boots, ' +
  'vertical 1:2 composition with generous negative space above and below.';

/** 银狼：work 的 prompt 把 jacket / scarf 写进了外观括号里（换装会串），这里只留真外观 */
const SW_LOOK =
  'Silver Wolf \\(Honkai: Star Rail\\) has silver-white short hair, violet eyes with a half-lidded sleepy gaze, ' +
  'black headset headphones resting around her neck, fair skin, and a slim build.';
/** 睡觉那套要把耳机摘掉 —— 戴耳机入睡既不合理，也会与「set aside」自相矛盾 */
const SW_LOOK_SLEEP =
  'Silver Wolf \\(Honkai: Star Rail\\) has silver-white short hair, violet eyes with a half-lidded sleepy gaze, ' +
  'fair skin, and a slim build.';
const SW_FRAME =
  'A few glowing pixel squares and drifting light particles scatter around her, ' +
  'pure white background, simple background, solo, 1girl, full body from head to sneakers, ' +
  'vertical 1:2 composition with generous negative space above and below, soft rim light.';

/** 牢凌：原创角色，沿用现有 work prompt 的身份前缀与外观句（已验证可出图） */
const LL_LOOK =
  '牢凌 (悲悼剧团) is a youthful delicate-featured girl with pink-purple gradient hair styled in twin buns with long twintails, ' +
  'black ribbon hair ornaments, heterochromia with a red left eye and a blue right eye, asymmetric eyelids, fair skin, ' +
  'a slender figure, narrow shoulders, slim waist and long legs.';
const LL_FRAME =
  'Soft backlight and drifting particles frame her silhouette, pure white background, simple background, solo, 1girl, ' +
  'full body from head to boots, vertical 1:2 composition with generous negative space above and below.';

/** 姬子 */
const HM_LOOK =
  'Himeko \\(Honkai: Star Rail\\) has waist-length wavy bright red hair partially tied into a rose-shaped bun, ' +
  'the ends fading into a deeper red, with golden rose hair ornaments and golden eyes on fair skin. ' +
  'She has a tall slender mature figure with a tiny dark mole on her upper chest and deep red nail polish.';
const HM_FRAME =
  'She is framed full-length against a pure white background with soft backlight and drifting gold particles, ' +
  'simple background, solo, 1girl, full body from head to feet, ' +
  'vertical 1:2 composition with generous negative space above and below.';

/** 星 */
const ST_LOOK =
  'Stelle \\(Honkai: Star Rail\\) has medium-length tousled silvery grey hair reaching past her shoulders ' +
  'with loose strands framing her face, golden eyes, fair skin, and a tall slender athletic figure with a full bust.';

/** 统一构图尾巴（女）—— 与各角色原有句式并存，不覆盖 */
const FRAME_TAIL =
  'pure white background, simple background, solo, 1girl, full body, ' +
  'vertical 1:2 composition with generous negative space above and below, soft backlight and drifting particles.';

const PROMPTS = [
  /* ── #5 景元 ───────────────────────────────────────────── */
  {
    characterId: 5, scene: 'casual',
    text: `${JY_LOOK} He wears a flowing dark grey silk changshan with subtle gold cloud embroidery, `
      + 'black fitted trousers, soft leather shoes, a jade pendant at the collar, a folding fan tucked at his waist, '
      + 'and a light coat draped over one shoulder. '
      + 'He stands at the center of a vertical full-body composition in an unhurried strolling posture, '
      + 'one hand loosely holding a closed folding fan at his side and the other tucked into his trouser pocket, '
      + 'chin slightly lifted with a calm, faintly amused half-smile, weight shifted onto one leg so the draped coat '
      + `hangs in a long diagonal fold. ${JY_FRAME}`,
  },
  {
    characterId: 5, scene: 'home',
    text: `${JY_LOOK} He wears a loose indigo silk robe worn open over a plain white undershirt, `
      + 'wide grey lounge trousers, and dark cloth slippers, his sleeves casually rolled to the forearm, '
      + 'his long white hair spilling over one shoulder with the red ribbon loosely wound around his wrist. '
      + 'He stands in a relaxed at-ease posture with one hand loosely holding a small teacup at his waist and the other '
      + 'hanging at his side, head tilted slightly with drowsy half-lidded golden eyes and a soft contented smile. '
      + JY_FRAME,
  },
  {
    characterId: 5, scene: 'sleep',
    text: `${JY_LOOK} He wears a charcoal silk pajama shirt unbuttoned at the collar and matching wide pajama trousers, `
      + 'and he is barefoot, his long white hair loose and tousled with the red ribbon untied and held loosely in one hand. '
      + 'He stands in a languid just-risen posture, one hand pushing his loose hair back from his forehead and the other '
      + 'hanging at his side, head tilted with heavy half-lidded golden eyes and a faint sleepy half-smile, weight settled onto one leg. '
      + JY_FRAME,
  },

  /* ── #14 银狼 ──────────────────────────────────────────── */
  {
    characterId: 14, scene: 'casual',
    text: `${SW_LOOK} She wears an oversized holographic-print hoodie with the sleeves pushed up, `
      + 'a black pleated mini skirt over ripped fishnet tights, chunky platform sneakers with neon laces, '
      + 'a black shoulder bag covered in arcade stickers, and purple-tinted goggles pushed up on her head. '
      + 'She stands in a slouched, weight-on-one-hip posture, one hand tucked into her hoodie pocket and the other '
      + 'holding a handheld console loosely at her side, head tilted toward the viewer with a bored, faintly smug smirk, '
      + 'eyes barely open as if she would rather be gaming. ' + SW_FRAME,
  },
  {
    characterId: 14, scene: 'home',
    text: `${SW_LOOK} She wears a loose black graphic tee with a glowing pixel logo, soft grey joggers, `
      + 'fuzzy slippers, and a hooded blanket draped over her shoulders, her short silver-white hair loosely tied back '
      + 'with a few strands falling free. '
      + 'She stands in a slouchy at-home posture, one hand holding a handheld console against her chest and the other '
      + 'tugging the hooded blanket around her shoulders, chin tucked with a drowsy half-lidded look and a small pout. '
      + SW_FRAME,
  },
  {
    characterId: 14, scene: 'sleep',
    text: `${SW_LOOK_SLEEP} She wears a black satin camisole with thin neon-piped straps and matching shorts, `
      + 'with a loose oversized tee thrown on top, barefoot, her short silver-white hair loose and tousled, '
      + 'her headset, goggles and hair clip set aside on a nearby surface. '
      + 'She stands in a sleepy just-woken posture, one hand rubbing her eye and the other hanging loosely at her side, '
      + 'shoulders slightly hunched, head tilted down with heavy half-lidded violet eyes and a faintly annoyed sleepy frown. '
      + SW_FRAME,
  },

  /* ── #171 牢凌 ─────────────────────────────────────────── */
  {
    characterId: 171, scene: 'casual',
    text: `${LL_LOOK} She wears a black lace-trimmed camisole dress with a pink ribbon at the waist, layered over a sheer `
      + 'white blouse with puffed sleeves, a cropped black denim jacket with pink stitched seams, black knee-high socks '
      + 'with lace cuffs, chunky black platform sneakers with pink laces, and a small heart-shaped crossbody bag. '
      + 'She stands at a slight three-quarter angle in a light springy posture, one hand lifting a twintail tip between '
      + 'her fingers and the other tucked into her jacket pocket, chin slightly lowered with a calm faintly knowing '
      + 'half-smile, weight shifted onto one leg. ' + LL_FRAME,
  },
  {
    characterId: 171, scene: 'home',
    text: `${LL_LOOK} She wears an oversized off-white knit cardigan thrown open over a black slip dress with a lace hem, `
      + 'soft black cotton lounge shorts, and fluffy pink indoor slippers, her twintails left loose and slightly '
      + 'disheveled with the black ribbon ornaments sitting askew. '
      + 'She stands in a relaxed indoor posture with one hand tugging a cardigan sleeve down over her knuckles and the '
      + 'other resting at her hip, head tilted with a soft drowsy gaze and a small quiet smile, weight settled onto one leg. '
      + LL_FRAME,
  },
  {
    characterId: 171, scene: 'sleep',
    text: `${LL_LOOK} She wears a black satin sleep camisole with delicate pink lace trim along the neckline and thin `
      + 'straps, matching short satin shorts, and a loose sheer black robe slipping off one shoulder, barefoot, '
      + 'her pink-purple gradient hair loosened from its buns and spilling over her shoulders, '
      + 'the black ribbon ornaments set aside. '
      + 'She stands in a languid just-before-sleep posture, one hand holding the slipping robe at her shoulder and the '
      + 'other hanging loosely, head tilted with heavy half-lidded mismatched eyes and a faint tired half-smile. '
      + LL_FRAME,
  },

  /* ── #112 姬子 ─────────────────────────────────────────── */
  {
    characterId: 112, scene: 'home',
    text: `${HM_LOOK} She wears a loose deep red silk robe with wide sleeves, its tie belt loosely knotted at the waist, `
      + 'black lace trim along the hem and cuffs, over a plain white soft cotton camisole and dark grey wide-leg lounge '
      + 'trousers, with soft black indoor slippers, her hair let down from the rose bun into long flowing red waves, '
      + 'a simple gold bracelet on one wrist and a black choker with a golden rose. '
      + 'She stands in a relaxed at-home posture, one hand holding a coffee cup against her chest and the other resting '
      + 'loosely at her side, head tilted with a warm unhurried smile. ' + HM_FRAME,
  },
  {
    characterId: 112, scene: 'sleep',
    text: `${HM_LOOK} She wears a deep wine-red silk slip nightgown with thin straps, delicate black lace trim along the `
      + 'neckline and hem, and a matching short silk robe draped loosely over her shoulders, bare legs and barefoot, '
      + 'her hair let down from the rose bun into long flowing red waves, wearing no jewelry except a thin gold bracelet. '
      + 'She stands in a languid late-evening posture, one hand resting on the robe at her shoulder and the other hanging '
      + 'at her side, head tilted with soft half-lidded golden eyes and a faint unhurried smile. ' + HM_FRAME,
  },

  /* ── #113 星 ───────────────────────────────────────────── */
  {
    characterId: 113, scene: 'sleep',
    text: `${ST_LOOK} She wears a loose white cotton sleep shirt with thin straps, slightly oversized and falling to `
      + 'mid-thigh, bare legs and barefoot, her silvery grey hair loose and tousled, with no accessories. '
      + 'She stands in a sleepy just-woken posture, one hand pushing her tousled hair back from her face and the other '
      + 'hanging loosely at her side, shoulders relaxed, head tilted with heavy half-lidded golden eyes and a blank '
      + 'drowsy expression. ' + FRAME_TAIL,
  },
];

/* ══════════════════════════════════════════════════════════════
 * 执行
 * ══════════════════════════════════════════════════════════════ */
const SCENE_LABEL = { work: '常服', casual: '私服', home: '居家', sleep: '睡衣' };

console.log(`\n${DRY ? '【DRY-RUN · 不写库】' : '【写库】'} 立绘提示词填充\n${'─'.repeat(64)}`);

/** 只在真正写库时才开连接 —— dry-run 全程不碰数据库 */
let db = null;
if (!DRY) {
  db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  // 服务在跑时库被持有，等锁而不是直接 SQLITE_BUSY
  db.pragma('busy_timeout = 8000');
  if (!db.prepare('SELECT 1 FROM characters WHERE id = 171').get()) {
    console.error('✗ 库里没有 id=171 的角色，DB_PATH 可能指错了：' + DB_PATH);
    process.exit(1);
  }
}

/** 某角色的身体锚点（新插入的服装行必须带上，否则 composeOutfitText 只有衣服没有身体） */
function bodyOf(characterId) {
  const row = db.prepare(
    `SELECT body FROM character_outfits WHERE character_id = ? AND body IS NOT NULL AND body != '' LIMIT 1`
  ).get(characterId);
  return row?.body || '';
}

/* 1. 服装描述 */
console.log('\n## 服装描述');
for (const o of [...NEW_OUTFITS, ...FIX_OUTFITS]) {
  const tag = o.characterId === 14 ? '更正' : '新增';
  console.log(`  ${tag} #${o.characterId} ${o.scene}(${o.name}) ${o.description.length} 字符`);
  if (DRY) console.log(`    ${o.description}`);
}
if (!DRY) {
  const findOutfit = db.prepare('SELECT id FROM character_outfits WHERE character_id = ? AND scene = ? LIMIT 1');
  const insOutfit = db.prepare(
    'INSERT INTO character_outfits (character_id, name, description, scene, body, enabled) VALUES (?, ?, ?, ?, ?, 0)'
  );
  const updDesc = db.prepare('UPDATE character_outfits SET description = ? WHERE id = ?');
  db.transaction(() => {
    for (const o of [...NEW_OUTFITS, ...FIX_OUTFITS]) {
      const exist = findOutfit.get(o.characterId, o.scene);
      if (exist) {
        updDesc.run(o.description, exist.id);
        console.log(`  → #${o.characterId} ${o.scene} 已存在，更新描述`);
      } else {
        insOutfit.run(o.characterId, o.name, o.description, o.scene, bodyOf(o.characterId));
        console.log(`  → #${o.characterId} ${o.scene} 新增`);
      }
    }
    // 「全身」那行缺则补 —— getSceneOutfitForNow 按**名字**匹配日程标注，没有这行就匹配不上
    if (!findOutfit.get(171, 'nude')) {
      insOutfit.run(171, NUDE_NAME, NUDE_DESCRIPTION, 'nude', bodyOf(171));
      console.log('  → #171 nude(全身) 补建（原缺，日程标「全身」会匹配不上）');
    }
  })();
}

/* 2. 立绘提示词 */
console.log('\n## 立绘提示词（12 份）');
let total = 0;
for (const p of PROMPTS) {
  total += p.text.length;
  const flag = p.text.length > 1500 ? ' ⚠偏长' : (p.text.length < 700 ? ' ⚠偏短' : '');
  console.log(`  #${String(p.characterId).padEnd(3)} ${p.scene.padEnd(6)} ${String(p.text.length).padStart(4)} 字符${flag}`);
  if (DRY) console.log(`\n    ${p.text}\n`);
}
console.log(`\n  合计 ${PROMPTS.length} 份 / 平均 ${Math.round(total / PROMPTS.length)} 字符`);

if (!DRY) {
  // image_url 不动：已有图的槽保留原图，只换 prompt；缺图的槽插 NULL 等出图
  const upsert = db.prepare(
    `INSERT INTO character_standings (character_id, scene, image_url, prompt_text, updated_at)
     VALUES (?, ?, NULL, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(character_id, scene) DO UPDATE SET
       prompt_text = excluded.prompt_text,
       updated_at  = CURRENT_TIMESTAMP`
  );
  db.transaction(() => { for (const p of PROMPTS) upsert.run(p.characterId, p.scene, p.text); })();
  console.log('  → 12 份 prompt 已写入 character_standings.prompt_text');
  db.close();
}

console.log(`
${'─'.repeat(64)}
下一步（出图）：角色详情页 → 切到对应场景 → 点「再次 Roll 图」
  · 「再次 Roll 图」= 用上面这份 prompt 直接出图（不请求 LLM）
  · 「生成」        = 让 LLM 重写一份，会覆盖掉这里的 prompt
`);
