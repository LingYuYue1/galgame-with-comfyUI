/**
 * fill-sport-swim-assets.mjs — 补齐「运动装 / 泳装」的服装描述 + 立绘提示词
 *
 * 背景（2026-10-24）：用户「之前加了泳装那些，但是（立绘）还没有对应的生图链路，
 * 先把这些都加上后我再去跑吧」。
 *
 * 本脚本只管 sport / swim 两套：
 *   - 22 条服装描述（11 个角色 × 2 套）写进 `character_outfits`
 *   - 20 份立绘提示词（10 个角色 × 2 套）写进 `character_standings.prompt_text`
 *     （#1「默认助手」没有基础立绘，只补服装描述）
 *
 * ── 写法（与 fill-standing-prompts.mjs 同口径）──────────────────
 * 外观句沿用该角色 work 立绘 prompt 的外观段（发/眼/肤色/体型逐字不变），
 * 只替换服装与姿势 —— 六套立绘放在一起要像同一个人。
 * 服装句与写进 `character_outfits.description` 的文本**完全同一份**（下面共用常量），
 * 避免"描述一套、提示词另一套"这种漂移。
 *
 * ── 规范 ────────────────────────────────────────────────
 * - description 只存衣服，不含身体；`body` 沿用该角色现有值
 * - sport 必须含运动鞋；swim 不含鞋
 * - 立绘构图统一：纯白背景 / 单人 / 全身 / 1:2 竖幅（`STANDING_ROLE_PROMPTS` 硬性要求）
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
  31: 'Fu Xuan \\(Honkai: Star Rail\\) has long bright pink hair styled in a high ornate bun with a gold hairpin and headband, low twintails with ring braids below, asymmetric side locks framing her face, a brilliant third-eye gem embedded in her forehead, golden-pink eyes, fair skin, and a petite slender build.',
  47: 'Yaoguang \\(Honkai: Star Rail\\) is a slender young woman with long white hair fading into blue-purple gradient tips, loose strands framing her face, multicolored purple-blue eyes with upturned corners, and a peacock feather hair ornament.',
  112: 'Himeko \\(Honkai: Star Rail\\) has waist-length wavy bright red hair, the ends fading into a deeper red, golden rose hair ornaments, and golden eyes on fair skin. She has a tall slender mature figure with a tiny dark mole on her upper chest.',
  113: 'Stelle \\(Honkai: Star Rail\\) has medium-length tousled silvery grey hair reaching past her shoulders with loose strands framing her face, golden eyes, fair skin, and a tall slender athletic figure with a full bust.',
  171: '牢凌 (悲悼剧团) is a youthful delicate-featured girl with pink-purple gradient hair styled in twin buns with long twintails, black ribbon hair ornaments, heterochromia with a red left eye and a blue right eye, asymmetric eyelids, fair skin, a slender figure, narrow shoulders, slim waist and long legs.',
};

/* ══════════════════════════════════════════════════════════════
 * 服装描述（只含衣服）—— 同时供 character_outfits 与立绘 prompt 使用
 * ══════════════════════════════════════════════════════════════ */
const OUTFITS = {
  1: {
    sport: 'a fitted charcoal-grey long-sleeve athletic top with subtle gold piping, matching black running leggings with a side pocket, grey and white running shoes, a slim fitness watch, small black wireless earbuds',
    swim: 'a one-piece swimsuit in deep navy with thin gold trim along the neckline and straps, a light ivory sheer cover-up tied at the waist, a thin gold anklet',
  },
  4: {
    sport: 'a white and ice-blue cropped athletic jacket over a pale pink sports top, matching ice-blue running shorts, white ankle socks, white and light-blue running shoes, a slim fitness armband on her left arm, hair tied back with a pink scrunchie',
    swim: 'an ice-blue one-piece swimsuit with white piping and a small snowflake motif on the chest, a sheer white beach shirt tied loosely at her waist, a pink ribbon fastening at the back',
  },
  5: {
    sport: 'a fitted dark grey sleeveless training shirt, loose black training trousers, a red sash tied at the waist, black cloth training shoes, wrist wraps on both forearms',
    swim: 'dark navy knee-length swim trunks with a subtle golden cloud pattern along the hem, an open white linen shirt worn loose over his shoulders',
  },
  12: {
    sport: 'a loose mint-green hooded sweatshirt with the sleeves pushed up, black jogger shorts, white ankle socks, light green and white sneakers, a small towel draped around her neck',
    swim: 'a jade-green one-piece swimsuit with black side panels and a small bird pattern at the hip, a black mesh beach cover-up worn open',
  },
  14: {
    sport: 'a black cropped athletic tank top with neon violet trim, matching high-waist black running shorts, chunky neon-laced training shoes, a slim black fitness band on her left wrist',
    swim: 'a black one-piece swimsuit with neon violet piping and a pixel-grid print along the sides, a sheer black beach shirt worn loose',
  },
  15: {
    sport: 'a red cropped athletic top with black trim, matching black running shorts, red and white running shoes, a small black towel around her neck',
    swim: 'a red bikini with black crisscross straps and gold trim, a sheer black wrap skirt tied over her hips, a small golden bell anklet',
  },
  31: {
    sport: 'a fitted light purple athletic jacket over a white sports top, matching dark plum running leggings, white and purple running shoes, a thin gold hair tie',
    swim: 'a purple one-piece swimsuit with pale pink trim and subtle constellation patterns along the side, a sheer white beach cover-up tied at the waist',
  },
  47: {
    sport: 'a fog blue-grey fitted athletic long-sleeve top, dark charcoal running leggings, grey and white running shoes, a simple silver hair tie',
    swim: 'a deep blue-grey one-piece swimsuit with a subtle peacock-feather pattern along one side, a sheer ivory beach shirt worn open',
  },
  112: {
    sport: 'a fitted deep red athletic top with black side panels, matching black running leggings, black and gold running shoes, a black hair tie',
    swim: 'a deep wine-red one-piece swimsuit with gold ring details at the hips and thin straps, a sheer black beach wrap draped over one shoulder',
  },
  113: {
    sport: 'a loose black athletic tank top over a grey sports top, grey running shorts, black and white running shoes, black fingerless gloves',
    swim: 'a black one-piece swimsuit with grey side panels and a thin white stripe, an oversized white beach shirt worn open',
  },
  171: {
    sport: 'a black cropped athletic top with pink trim and a small ribbon at the chest, matching black running shorts with pink piping, chunky black and pink running shoes, a black ribbon hair tie',
    swim: 'a black bikini with pink ribbon ties at the shoulders and hips, a sheer black beach cover-up with lace trim',
  },
};

/* ══════════════════════════════════════════════════════════════
 * 立绘：姿势 + 构图（服装句直接取上面的 OUTFITS[角色][场景]）
 * ══════════════════════════════════════════════════════════════ */
const POSE = {
  '4:sport': 'She stands in a springy athletic ready stance, one hand on her hip and the other raised in a light stretch, chin lifted with a bright energetic grin, her weight on the balls of her feet.',
  '4:swim': 'She stands with one hand tucked behind her head and the other resting on her hip, head tilted with a bright playful grin, water droplets glinting on her shoulders.',
  '5:sport': 'He stands in a grounded martial stance, one arm extended loosely to the side and the other tucked behind his back, chin slightly lowered with a calm confident half-smile.',
  '5:swim': 'He stands with his weight on one leg, one hand pushing his damp white hair back and the other resting at his side, head tilted with an easy amused smile, water droplets on his shoulders.',
  '12:sport': 'She stands in a half-hearted stretch, one arm raised overhead and the other hanging limp, head tilted back with a lazy half-lidded look and a small sighing pout.',
  '12:swim': 'She stands with one hand holding the cover-up at her shoulder and the other planted on her hip, head tilted with a relaxed sleepy smile.',
  '14:sport': 'She stands in a slouched athletic stance, one hand on her hip and the other holding a water bottle loosely at her side, head tilted with a bored but cocky smirk, a light sheen of sweat at her temples.',
  '14:swim': 'She stands with her arms crossed loosely, her weight on one hip, head tilted with a half-lidded defiant look, water droplets glinting along her shoulders and her short silver-white hair slightly damp.',
  '15:sport': 'She stands in a light bouncing stance, one hand on her hip and the other raised in a teasing wave, head tilted with a sly playful grin.',
  '15:swim': 'She stands with one hip cocked, one hand lifting the wrap skirt and the other raised near her chin, head tilted with a mischievous knowing smile.',
  '31:sport': 'She stands in a composed upright stance, one hand resting at her waist and the other lightly raised, chin lifted with a restrained confident smile.',
  '31:swim': 'She stands with one hand holding the cover-up closed and the other at her side, head tilted with a calm composed smile.',
  '47:sport': 'She stands in a light jogging-ready stance, one hand adjusting the hair tie at her ponytail and the other resting at her side, head tilted with a quiet confident smile.',
  '47:swim': 'She stands with one hand resting on the shirt at her shoulder and the other at her side, head tilted with a calm reflective gaze.',
  '112:sport': 'She stands in a poised athletic stance, one hand on her hip and the other brushing her ponytail back over her shoulder, head tilted with a warm confident smile.',
  '112:swim': 'She stands with one hand holding the wrap at her shoulder and the other resting at her hip, head tilted with an unhurried elegant smile.',
  '113:sport': 'She stands in a loose athletic stance, one hand pushing her hair back from her face and the other hanging at her side, head tilted with a calm focused gaze.',
  '113:swim': 'She stands with both hands tucked into the pockets of the beach shirt, head tilted with a quiet neutral expression, water droplets running from her damp silvery hair down one shoulder.',
  '171:sport': 'She stands in a light springy stance, one hand on her hip and the other adjusting the ribbon in her hair, chin slightly lowered with a calm confident half-smile.',
  '171:swim': 'She stands with one hand holding the cover-up at her shoulder and the other resting at her hip, head tilted with a faint knowing smile.',
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
  // 泳装赤脚；运动装穿运动鞋（服装描述里已有），不能再说 barefoot
  const bare = scene === 'swim' ? ', barefoot' : '';
  return `${look} ${subj} wears ${outfit}${bare}. ${pose} `
    + 'Soft backlight and drifting particles, pure white background, simple background, solo, '
    + `${tag}, full body from head to feet, `
    + 'vertical 1:2 composition with generous negative space above and below.';
}

/* ══════════════════════════════════════════════════════════════
 * 执行
 * ══════════════════════════════════════════════════════════════ */
const SCENE_LABEL = { sport: '运动装', swim: '泳装' };
const ids = Object.keys(OUTFITS).map(Number);

console.log(`\n${DRY ? '【DRY-RUN · 不写库】' : '【写库】'} 运动装 / 泳装资产\n${'─'.repeat(66)}`);

console.log('\n## 服装描述（22 条）');
for (const id of ids) {
  for (const scene of ['sport', 'swim']) {
    const d = OUTFITS[id][scene];
    console.log(`  #${String(id).padEnd(4)} ${SCENE_LABEL[scene]}  ${String(d.length).padStart(3)} 字符`);
    if (DRY) console.log(`    ${d}`);
  }
}

const promptRows = [];
for (const id of ids) {
  for (const scene of ['sport', 'swim']) {
    const text = buildPrompt(id, scene);
    if (text) promptRows.push({ id, scene, text });
  }
}

console.log(`\n## 立绘提示词（${promptRows.length} 份）`);
let total = 0;
for (const p of promptRows) {
  total += p.text.length;
  // 立绘规则本身写的是 MAX 800；存量 28 张实际 824~1616，最短 770。
  // 所以 700~850 属正常区间，只有明显过短（<600）才提示。
  const flag = p.text.length > 1500 ? ' ⚠偏长' : (p.text.length < 600 ? ' ⚠偏短' : '');
  console.log(`  #${String(p.id).padEnd(4)} ${p.scene.padEnd(6)} ${String(p.text.length).padStart(4)} 字符${flag}`);
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
      for (const scene of ['sport', 'swim']) {
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
  （现在会把 6 套里所有缺图的槽一起跑；已出图的自动跳过）
`);
