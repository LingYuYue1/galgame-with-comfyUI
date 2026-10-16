/**
 * 探针：peek（瞄一眼）链路 LLM 空返回归因
 *
 * 背景：schedule.js `POST /:characterId/peek` 的 chatSync 未显式传 thinking，
 *       在用户 .env `LLM_THINKING_MODE=enabled` 下会带思考请求；F-58 注释已证
 *       「本机通道推理 token 计入 max_tokens」。本脚本用真实装配复现并对照。
 *
 * 用法（cwd 必须是 agent-core，dotenv 才能读到 .env）：
 *   cd agent-core && node ../scripts/probe-peek-llm.mjs [characterId] [--pick=活动名关键词] [--repeat=N] [--no-run=c]
 *
 *   --pick    从该角色今日日程里挑选含此关键词的活动（复刻真实失败场景）
 *   --repeat  对 A 组（现状）重复 N 次，测间歇率
 *   --no-run  跳过某组（a/b/c，可逗号分隔）
 *
 * 安全：只读 DB 副本（DB_PATH 指向副本），只发 LLM 请求，不落盘不建任务。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AC = path.join(ROOT, 'agent-core');

const characterId = Number(process.argv[2] || 4);
const argOf = (name) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const pickKeyword = argOf('pick');
const repeatA = Number(argOf('repeat') || 1);
const skipSet = new Set(String(argOf('no-run') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

// ── 指向 DB 副本（绝不碰真库）──
const dbCopy = path.join(ROOT, 'output', '.dbcheck', 'agent.db');
process.env.DB_PATH = dbCopy;

const imp = (rel) => import(pathToFileURL(path.join(AC, rel)).href);

// ── 捕获 console 输出里的 usage 行 ──
const captured = [];
for (const k of ['log', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { captured.push(a.join(' ')); orig(...a); };
}
const drainUsage = () => {
  const lines = captured.splice(0, captured.length).filter(l => l.includes('[usage]') || l.includes('[cache]'));
  return lines.join(' | ').replace(/\s+/g, ' ').trim();
};

const { getDb, getSystemRules, getWorldSetting, getGlobalRule } = await imp('src/db/index.js');
const { getWorldIntegrationRule } = await imp('src/builtinRules.js');
const { buildCharacterPersona } = await imp('src/services/characterPersona.js');
const { getSceneOutfitForActivity, asPersonaOutfits } = await imp('src/services/outfitScene.js');
const { getCurrentActivity, isTempWoken } = await imp('src/services/scheduleManager.js');
const { appendOathRing } = await imp('src/services/oathUtils.js');
const { getTimeLightInline } = await imp('src/services/timeLight.js');
const { config } = await imp('src/config.js');
const { chatSync } = await imp('src/llm/llm-client.js');

const db = getDb();
const character = db.prepare('SELECT id, display_name, base_prompt, custom_workflow, loras, artist_override FROM characters WHERE id = ?').get(characterId);
if (!character) { console.error('character not found:', characterId); process.exit(1); }

let activity = getCurrentActivity(characterId);
if (pickKeyword) {
  // 从今日日程里挑一条含关键词的活动（复刻真实失败场景，数据原样取自 schedule_json）
  const row = db.prepare('SELECT schedule_date, schedule_json FROM daily_schedules WHERE character_id = ? ORDER BY schedule_date DESC LIMIT 1').get(characterId);
  const arr = JSON.parse(row?.schedule_json || '[]');
  const hit = arr.find(a => (a.activity || '').includes(pickKeyword));
  if (!hit) { console.error(`今日日程中未找到含「${pickKeyword}」的活动。可选：`, arr.map(a => a.activity).join(' / ')); process.exit(1); }
  activity = hit;
  console.log(`\n[--pick] 命中活动：${hit.startTime}-${hit.endTime} ${hit.activity} @ ${hit.location}`);
}
if (!activity) { console.error('no current activity for', character.display_name); process.exit(1); }

console.log(`\n=== 受试角色: #${character.id} ${character.display_name} ===`);
console.log(`当前活动: ${activity.activity} @ ${activity.location} (${activity.startTime || '?'})`);
console.log(`活动描述: ${(activity.description || '').slice(0, 120)}`);

// ── 完全复刻 peek 路由的消息装配（schedule.js:840-940）──
const charName = character.display_name;
const systemRules = getSystemRules({ roleplay: false });
const worldSetting = getWorldSetting();
const system0 = [systemRules, worldSetting].filter(Boolean).join('\n\n');

let system1 = '';
if (worldSetting) system1 = `${getWorldIntegrationRule('photo')}\n\n`;

const tempWoken = isTempWoken(characterId);
const isSleeping = !tempWoken && activity.replyDelay === -1;

let lightTime = new Date();
if (activity.startTime) {
  const [h, m] = activity.startTime.split(':').map(Number);
  if (!isNaN(h)) { lightTime = new Date(); lightTime.setHours(h, m || 0, 0, 0); }
}
// ★ 与生产同源：F-61 修复后 timeLightInline 会进入 system1，这里必须一起复刻
const timeLightInline = getTimeLightInline(lightTime);
const sleepNote = isSleeping
  ? `\n\n【极其重要】角色正在睡觉，双眼必须紧闭，**房间里没有灯光，睡觉时候不开灯**，不能睁眼。表情安详放松，呈现深度睡眠的自然状态，盖被子。睡姿、床、被子、**睡衣（睡觉时候绝对不会穿本来的衣服）**等细节贴合角色性格。`
  : '';

let effectiveActivity = activity.activity;
let effectiveDescription = activity.description;
let wakeNote = '';
if (tempWoken) {
  const wakeMode = db.prepare('SELECT wake_mode FROM characters WHERE id = ?').get(characterId)?.wake_mode;
  const userName = config.user.nickname || '用户';
  if (wakeMode === 'phone') {
    effectiveActivity = '被电话吵醒';
    effectiveDescription = '半睁着眼看着手机，睡眼惺忪，正在打哈欠';
    wakeNote = `\n\n【注意】角色刚被${userName}的电话吵醒，处于半睡半醒的迷糊状态。双眼半睁半合，睡眼惺忪，头发凌乱，**穿着睡衣（睡觉时候绝对不会穿本来的衣服）**，正在打哈欠。手机屏幕的亮光照在角色脸上，角色靠在床上或枕头上看着手机屏幕。表情困倦慵懒，展现出被吵醒后的迷蒙感。`;
  } else if (wakeMode === 'door' || wakeMode === 'shake') {
    const userAppearance = config.user.appearance ? `（${config.user.appearance}）` : '';
    effectiveActivity = '被各种方式叫醒/晃醒/摇醒/拖拽等姿势';
    effectiveDescription = `被${userName}${userAppearance}从床上被各种方式叫醒/晃醒/摇醒/拖拽等姿势弄醒的瞬间`;
    wakeNote = `\n\n【注意】画面中是${userName}${userAppearance}上门把角色从床上摇醒的场景。角色半坐在床上，睡眼惺忪地睁开眼，表情懵懂迷糊。${userName}${userAppearance}正俯身或弯腰，${userName}的手搭在角色任意部位，把角色晃醒或者摇醒或者拖拉拽弄醒。角色穿着**穿着睡衣（睡觉时候绝对不会穿本来的衣服）**，被子半掀开，展现了刚被强行弄醒的瞬间动态。`;
  }
}

system1 += `你是一个专业的人像摄影师，你现在需要给角色拍一张人像照，任意角度（俯拍，仰拍，正脸，侧脸，背面，低角度全都不限制），角色也不看着镜头，表现角色当前正在做的事情。角色表情、动作神态根据角色人格和正在做的事来生成，要贴合角色气质。画面输出用英文prompt`;
system1 += `\n\n${timeLightInline}${sleepNote}${wakeNote}`;

const sceneOutfits = asPersonaOutfits(getSceneOutfitForActivity(characterId, activity));
let personaText = buildCharacterPersona(character, { variant: 'full', person: charName, outfits: sceneOutfits || undefined });
if (!personaText) personaText = `角色名：${charName}`;
const ringUserName = config.user?.nickname || 'user';
personaText = appendOathRing(personaText, characterId, ringUserName, { isFirstPerson: false, charName });

const imageRulesText = getGlobalRule('image_prompt')?.rule_content || '';
const system3 = `${imageRulesText ? imageRulesText : ''}`;

const userMsg = `牢记<world_setting>世界观里的环境描述和人物行为和着装，然后给「${charName}」拍一张当前正在${activity.location}进行${effectiveActivity}的照片，具体照片表现是${effectiveDescription}直接输出为英文prompt`;

const llmMsgs = [
  { role: 'system', content: system0 },
  { role: 'system', content: system1 },
  { role: 'system', content: system3 },
  { role: 'system', content: personaText },
  { role: 'user', content: userMsg },
];

const approxChars = llmMsgs.reduce((s, m) => s + m.content.length, 0);
console.log(`\n消息体: ${llmMsgs.length} 条 | 总字符 ${approxChars}（粗估 ${Math.round(approxChars / 3)} tokens）`);
console.log(`thinkingMode(全局) = ${config.llm.thinkingMode} | model = ${config.llm.model}`);

// ── 对照分组 ──
const runs = [];
for (let i = 0; i < repeatA; i++) {
  runs.push({ id: 'a', name: `A 现状（不传 thinking → 全局 enabled）${repeatA > 1 ? ` #${i + 1}` : ''}`, opts: {}, maxTokens: 1024 });
}
if (!skipSet.has('b')) runs.push({ id: 'b', name: 'B 禁思考（thinking:disabled）', opts: { thinking: { type: 'disabled' } }, maxTokens: 1024 });
if (!skipSet.has('c')) runs.push({ id: 'c', name: 'C 开思考 + 抬高预算 4096', opts: {}, maxTokens: 4096 });

const results = [];
for (const run of runs) {
  process.stdout.write(`\n──────── ${run.name} ────────\n`);
  const t0 = Date.now();
  let content = '', finishReason = null, err = null;
  try {
    const r = await chatSync(llmMsgs, {
      temperature: 0.7,
      max_tokens: run.maxTokens,
      label: `probe-peek:${run.id}`,
      returnMeta: true,
      retries: 0,
      timeout: 120000,
      ...run.opts,
    });
    content = r.content ?? '';
    finishReason = r.finishReason;
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - t0;
  const usage = drainUsage();
  results.push({ name: run.name, len: content.length, finishReason, ms, err: err?.message || null, usage, content });
  console.log(`→ 耗时 ${(ms / 1000).toFixed(1)}s | 正文长度 ${content.length} | finish_reason=${finishReason} ${err ? '| 错误: ' + err.message : ''}`);
  console.log(`→ ${usage}`);
  if (content) console.log(`→ 正文预览: ${JSON.stringify(content.slice(0, 200))}`);
  else console.log('→ ⚠ 正文为空');
}

// ── 汇总 ──
console.log('\n\n═══════════════ 汇总 ═══════════════');
for (const r of results) {
  const verdict = r.err ? 'ERR ❌' : (r.len >= 5 ? '有正文 ✅' : '空正文 ❌');
  const anchored = /\(honkai|honkai:\s*star rail\)|march 7th/i.test(r.content || '') ? '含角色锚点' : '无角色锚点';
  console.log(`${verdict} | ${anchored} | ${r.name}\n        ${(r.ms / 1000).toFixed(1)}s | 正文 ${r.len} 字符 | finish=${r.finishReason} | ${r.usage}`);
}
const empties = results.filter(r => r.len < 5).length;
console.log(`\n空正文/失败：${empties}/${results.length}`);
process.exit(0);
