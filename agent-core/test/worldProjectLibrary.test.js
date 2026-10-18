/**
 * 世界观项目库 + 引擎反实例化 —— 回归测试。
 *
 * 背景（2026-10-07 用户裁定）：
 *   我把二相乐园的「幻造种不是每日仪式」写进了 `scheduleGenerator.js` 的公共提示词，
 *   而邻舍不是单一世界观项目。全量审计发现同类问题 244 处。
 *   用户裁定：**新建世界观时建立独立项目库**，引擎只读取、不内置。
 *
 * 本测试守三件事：
 *  ① 项目库机制本身（缺库回落中性、不抛错；读坏留痕；不用 slug 当身份）；
 *  ② **引擎不再内置具体世界观知识**（禁用词表护栏 —— 这是防复发的关键）；
 *  ③ 存量行为不变（没有项目库时，注入结果与"没有这套机制"一致）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`world project test forbids network: ${url}`); };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');
const AGENT_CORE = path.resolve(__dirname, '..');

const lib = await import('../src/services/worldProjectLibrary.js');
const {
  neutralProject, slugForWorld, readProject, writeProject, scaffoldProject,
  guessSlotsFromContent, projectDirFor, PROJECT_SLOTS,
} = lib;

// ─────────────────────────────────────────────────────────
// ① 项目库机制
// ─────────────────────────────────────────────────────────

test('★ 缺项目库 → 中性回落，且 exists=false（存量常态，不是异常）', () => {
  const p = readProject('__definitely_missing__');
  assert.equal(p.exists, false);
  assert.deepEqual(p.ambienceSections, []);
  assert.deepEqual(p.lexicons, []);
  assert.deepEqual(p.vocabHints, []);
});

test('★ slug 非空且不含路径分隔符（防目录穿越）', () => {
  for (const [name, id] of [['崩坏星穹铁道', 1], ['武装JK世界', 14], ['A/B:C', 9], ['', 3]]) {
    const s = slugForWorld(name, id);
    assert.ok(s.length > 0, `${name} 应能生成 slug`);
    assert.ok(!s.includes('/') && !s.includes('\\'), `slug 不得含路径分隔符: ${s}`);
    assert.match(s, /^[a-z0-9-]+$/i, `slug 只允许字母数字与连字符: ${s}`);
  }
});

test('★ slug 稳定：同 (id, name) 反复调用结果一致（重复建库不会散落目录）', () => {
  assert.equal(slugForWorld('崩坏星穹铁道', 1), slugForWorld('崩坏星穹铁道', 1));
});

test('★ 同名不同 id → slug 不同（改名/重建不撞车）', () => {
  assert.notEqual(slugForWorld('同名', 1), slugForWorld('同名', 2));
});

test('★★ 中性项目必须覆盖全部槽位（漏一个 = 存量世界观拿到 undefined）', () => {
  const n = neutralProject();
  for (const key of Object.keys(PROJECT_SLOTS)) {
    assert.ok(key in n, `neutralProject() 缺槽位 ${key} —— 存量世界观会拿到 undefined，行为分叉`);
  }
});

test('★ 写入后可回读；数组槽位被归一为数组（手工编辑写成别的类型不该炸）', () => {
  const slug = '__test_write__';
  try {
    writeProject(slug, { ambienceSections: ['A'], lexicons: [], vocabHints: [], notes: 'x' });
    assert.deepEqual(readProject(slug).ambienceSections, ['A']);

    // 人为写坏类型
    const f = path.join(projectDirFor(slug), 'project.json');
    fs.writeFileSync(f, JSON.stringify({ ambienceSections: '不是数组', lexicons: null }), 'utf8');
    const p = readProject(slug);
    assert.deepEqual(p.ambienceSections, [], '字符串应被归一为空数组');
    assert.deepEqual(p.lexicons, []);
  } finally {
    fs.rmSync(projectDirFor(slug), { recursive: true, force: true });
  }
});

test('★ project.json 解析失败 → 回落中性 + **warn 留痕**（不静默吞）', () => {
  const slug = '__test_broken__';
  try {
    fs.mkdirSync(projectDirFor(slug), { recursive: true });
    fs.writeFileSync(path.join(projectDirFor(slug), 'project.json'), '{ 这不是 json', 'utf8');
    const warns = [];
    const p = readProject(slug, { logger: { warn: (...a) => warns.push(a.join(' ')) } });
    assert.equal(p.exists, false, '坏文件应回落中性');
    assert.equal(warns.length, 1, '必须留痕，不能装看不见');
    assert.match(warns[0], /解析失败/);
  } finally {
    fs.rmSync(projectDirFor(slug), { recursive: true, force: true });
  }
});

test('★ scaffoldProject 幂等：已存在时不覆盖用户改动', () => {
  const slug = slugForWorld('__幂等测试__', 999);
  try {
    const { dir } = scaffoldProject({ name: '__幂等测试__', id: 999, content: 'v1' });
    writeProject(slug, { ...neutralProject(), ambienceSections: ['用户改过'] });
    scaffoldProject({ name: '__幂等测试__', id: 999, content: 'v2' });
    assert.deepEqual(readProject(slug).ambienceSections, ['用户改过'], '不该覆盖用户改过的槽位');
    assert.ok(fs.existsSync(path.join(dir, 'world.md')));
  } finally {
    fs.rmSync(projectDirFor(slug), { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────
// ② 猜测槽位：宁少勿多
// ─────────────────────────────────────────────────────────

test('★★ 猜测只认「人们的行为」，且必须真的存在于正文里', () => {
  const withSection = '## 世界背景\nx\n## 人们的行为\n- 例句\n## 日常规则\n- 规则\n';
  assert.deepEqual(guessSlotsFromContent(withSection).ambienceSections, ['人们的行为']);

  const without = '## 世界背景\nx\n## 日常规则\n- 规则\n';
  assert.deepEqual(guessSlotsFromContent(without).ambienceSections, [], '没有该节就不猜');
});

test('★★ 混合节（含规则/事实/画面指令）**不猜** —— 猜错的代价是静默丢内容', () => {
  // 「日常规则」实测含生图硬约束；「社会基调」实测含事实陈述
  const mixed = '## 日常规则\n- 男器整根画进画面\n## 社会基调\n- 愿宝是数字虚拟货币\n';
  assert.deepEqual(guessSlotsFromContent(mixed).ambienceSections, [],
    '混合节必须交给人裁定，引擎不得替它决定');
});

// ─────────────────────────────────────────────────────────
// ③ ★★ 引擎禁用词表 —— 防复发的核心护栏
// ─────────────────────────────────────────────────────────

/**
 * 引擎文件里**不允许出现**的世界观专有名词。
 *
 * 判据不是"出现了就是错"，而是"出现了 → 必须显式豁免并说明理由"。
 * 之所以要这条护栏：写提示词时"具体例子"比"抽象规则"好写得多，
 * 于是会顺手把某个世界的专名写进引擎 —— 换世界观后那段规则就是错的，
 * 而且**静态检查、构建、既有测试全都不报错**（这正是本次事故的成因）。
 */
const BANNED_TERMS = [
  // 崩坏星穹铁道 / 二相乐园
  '二相乐园', '二维市', '鸽川', '绘世学院', '幻造种', '愿宝', '花愿宝', '珠星', '海原电视塔',
  '幻月秘庭', '星际和平公司', '馋嘴胡同', '滨河道', '旧仓段', '娱乐广场', '世界尽头酒馆',
  '欢愉酒馆', '嬉步街', '喜悲街', '喜笑区', '悲泣区', '泊地站', '旧川里', '谒者', '假面愚者',
  // ★ 2026-10-07 补：做「派系与组织」时参考了《开局态势》，这些专名最容易顺手抄进引擎常量
  '幻月游戏', '欢愉假面', '欢愉愿力', '寰宇巨企', '共愿帮', '巡海游侠', '星核猎手', '仙舟联盟',
  // 少女与战车
  '战车道', '学园舰', '西住', '岛田', '黑森峰',
  // 武装JK世界
  '风纪委员',
];

/** 允许出现的地带：数据文件、种子、词库、以及本测试自身 */
const ALLOW_PATH = [
  /[\\/]data[\\/]/,            // 词库/数据（sexPositions、galleryEnvironment、yaml…）
  /seed[A-Z]/,                 // 种子数据（可编辑）
  /worldProjectLibrary\.js$/,  // 项目库机制自身会举例
  /\.test\.js$/,               // 测试文件
  /[\\/]public[\\/]/,          // 构建产物
];

/** 显式豁免：`// @world-agnostic-ok: 理由` —— 用于注释里的实测记录 */
const EXEMPT_MARK = '@world-agnostic-ok';

function walkJs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

test('★★★ 引擎文件不得内置任何世界观专有名词（除非显式豁免）', () => {
  const files = walkJs(path.join(AGENT_CORE, 'src'), [])
    .concat([path.join(AGENT_CORE, 'app.js')])
    .filter(f => !ALLOW_PATH.some(re => re.test(f)));

  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.includes(EXEMPT_MARK)) return;   // 本行已声明豁免

      // ★ 判据只盯「代码与提示词文本」，**不盯注释**：
      //   注释是文档（本项目有大量实测记录，写具体地名恰恰更有说服力），
      //   风险在会被拼进 prompt 或参与判断的**正文**里。
      //   纯注释行（// 或 JSDoc 的 * 开头）跳过 —— 否则真实信号会被淹没在记录里。
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;

      for (const t of BANNED_TERMS) {
        if (line.includes(t)) {
          offenders.push(`${path.relative(AGENT_CORE, file).replace(/\\/g, '/')}:${i + 1} 含「${t}」`);
        }
      }
    });
  }

  assert.deepEqual(
    offenders, [],
    `引擎正文里出现了世界观专有名词（换世界观后这些内容就是错的）：\n  ${offenders.join('\n  ')}\n` +
    `\n→ 修法：① 改为通用表述；② 从数据层/项目库读取；③ 确属必要的，行尾加「// ${EXEMPT_MARK}: 理由」`
  );
});

test('★★ 护栏本身有效：故意在一个非注释行塞入专名必须被抓到', () => {
  // 防"护栏写错导致永远绿"：直接验证判据函数
  const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
  assert.equal(isComment('        // 实测：鸽川区…'), true, '行注释应被跳过');
  assert.equal(isComment(' * 例如「幻造种」'), true, 'JSDoc 应被跳过');
  assert.equal(isComment("  const x = '鸽川区';"), false, '代码行不得跳过');
  assert.equal(isComment('  地点只能写：二维市、绘世学院等。'), false, '提示词正文不得跳过');
});

test('★★ 调度提示词（scheduleInst）不含任何世界观专名 —— 这是本次事故的现场', () => {
  const sg = fs.readFileSync(path.join(SRC, 'services/scheduleGenerator.js'), 'utf8');
  // 取 scheduleInst 常量原文
  const a = sg.indexOf('const scheduleInst = `');
  const b = sg.indexOf('`;', a + 30);
  assert.ok(a > 0 && b > a, '应能截出 scheduleInst');
  const inst = sg.slice(a, b);

  for (const t of ['幻造种', '愿宝', '鸽川', '二维市', '绘世学院', '人们的行为', '滨河道', '馋嘴胡同']) {
    assert.ok(!inst.includes(t), `scheduleInst 里仍含「${t}」——应改为通用表述`);
  }
});

test('★★ 世界观的"特色事物"规则仍在，但已通用化', () => {
  const sg = fs.readFileSync(path.join(SRC, 'services/scheduleGenerator.js'), 'utf8');
  assert.match(sg, /特色事物/, '通用化后的规则应保留');
  assert.match(sg, /不针对任何具体世界观/, '应显式声明它与世界观无关');
});

// ─────────────────────────────────────────────────────────
// ④ 注入层：单点收口 + 保守默认
// ─────────────────────────────────────────────────────────

test('★★ 裁剪只认"声明的氛围节"，不认具体标题', () => {
  const src = fs.readFileSync(path.join(SRC, 'db/worldRepository.js'), 'utf8');
  // 判据：不再**声明**硬编码章节名常量（注释里提到「人们的行为」作历史说明是允许的）
  assert.ok(!/^\s*const WORLD_BEHAVIOR_HEADING_RE/m.test(src), '旧的硬编码章节名正则必须已移除');
  const fn = src.slice(src.indexOf('export function adaptWorldText'), src.indexOf('export function adaptWorldText') + 2600);
  assert.match(fn, /slots\?\.ambienceSections/, '必须从槽位读声明');
  assert.match(fn, /declared\.length === 0\) return text/, '未声明时必须原样返回（保守默认）');
});

test('★★ adaptWorldText 行为：未声明不裁 / 声明才裁 / keep 恒不裁', async () => {
  const { adaptWorldText } = await import('../src/db/worldRepository.js');
  const world = '## 世界背景\n内容\n## 人们的行为\n- 例句一\n- 例句二\n## 日常规则\n- 规则\n';

  // ① 没声明 → 一字不改
  assert.equal(adaptWorldText(world, 'strip', null), world);
  assert.equal(adaptWorldText(world, 'strip', { ambienceSections: [] }), world);

  // ② 声明了 → 只裁该节，其余完整
  const cut = adaptWorldText(world, 'strip', { ambienceSections: ['人们的行为'] });
  assert.ok(!cut.includes('例句一'), '声明的节应被裁掉');
  assert.ok(cut.includes('## 世界背景') && cut.includes('## 日常规则'), '其他节必须完整保留');

  // ③ keep 模式恒不裁
  assert.equal(adaptWorldText(world, 'keep', { ambienceSections: ['人们的行为'] }), world);

  // ④ 声明的节在正文里不存在 → 不动
  assert.equal(adaptWorldText(world, 'strip', { ambienceSections: ['不存在的节'] }), world);
});

test('★ 世界观的裁剪改由项目库驱动，且不认「日常规则」这类混合节', async () => {
  const { adaptWorldText } = await import('../src/db/worldRepository.js');
  const world = '## 日常规则\n- 男器整根画进画面\n- 愿宝是虚拟货币\n';
  // 即使把「日常规则」声明为氛围节会丢内容，引擎也必须照声明执行（决定权在人）
  const cut = adaptWorldText(world, 'strip', { ambienceSections: ['日常规则'] });
  assert.equal(cut, '', '声明了就该裁（哪怕内容是混合的）—— 这是人的决定');
  // 默认（猜测结果）不声明它 → 完整保留
  assert.equal(adaptWorldText(world, 'strip', { ambienceSections: [] }), world);
});

test('★★ getWorldSetting 已单点收口（22 处裸调用一次性获得保护）', () => {
  const src = fs.readFileSync(path.join(SRC, 'db/worldRepository.js'), 'utf8');
  // ⚠ 别写死空括号签名：T07 起是 getWorldSetting(characterId = null)
  const start = src.indexOf('export function getWorldSetting(');
  const rawStart = src.indexOf('export function getWorldSettingRaw(');
  assert.ok(start > -1 && rawStart > start, '两个入口都必须存在且顺序不变');
  const fn = src.slice(start, rawStart);
  assert.match(fn, /adaptWorldText\(/, 'getWorldSetting 内部必须走裁剪');
  // T07 起槽位来源有两种：绑定世界（safeSlotsFor）或激活世界（safeActiveSlots）
  assert.match(fn, /safe(?:SlotsFor|ActiveSlots)\(/, '裁剪需按「取到的那个世界」的槽位');
  assert.match(src, /export function getWorldSettingRaw\(/, '必须保留原文逃生口');
});

test('★★ getWorldSetting 返回的内容必须已裁剪（行为级验证）', async () => {
  const db = await import('../src/db/index.js');
  db.getDb();   // ⚠ 必须先打开库：worldRepository 的句柄由它注入，否则 handle() 抛错
  const { createWorldSetting, updateWorldSetting, activateWorldSetting, getWorldSetting } = db;
  const name = '__注入收口测试__';
  const content = '## 世界背景\n内容保留\n## 人们的行为\n- 例句不该出现\n';
  let created;
  try {
    created = createWorldSetting({ name, content });
    // 声明该节为氛围节（直接写项目库，模拟用户配置）
    const slug = slugForWorld(name, created.id);
    writeProject(slug, { ...neutralProject(), ambienceSections: ['人们的行为'] });
    activateWorldSetting(created.id);

    const out = getWorldSetting();
    assert.ok(out.includes('内容保留'), '未被裁的节应保留');
    assert.ok(!out.includes('例句不该出现'), '声明的氛围节必须已被裁掉');
  } finally {
    if (created) {
      try { fs.rmSync(projectDirFor(slugForWorld(name, created.id)), { recursive: true, force: true }); } catch {}
    }
  }
});

// ─────────────────────────────────────────────────────────
// T07（2026-10-17 星图）：按角色解析世界 —— **覆盖，不拼接**
// ─────────────────────────────────────────────────────────
// 用户拍板的核心语义：一次调用只吃**一个**世界。角色在 A 世界，
// 激活世界 B 的文本一个字都不能进 prompt（否则多世界 = token 线性膨胀 + 设定互相污染）。

let _t07seq = 0;
function makeT07World(db, tag, content) {
  const name = `__T07_${tag}_${Date.now()}_${++_t07seq}__`;
  const w = db.createWorldSetting({ name, content });
  return { id: w.id, name };
}
function dropT07World(name, id) {
  try { fs.rmSync(projectDirFor(slugForWorld(name, id)), { recursive: true, force: true }); } catch {}
}
function makeT07Character(database, worldSettingId) {
  const name = `__t07_char_${Date.now()}_${++_t07seq}`;
  const info = database.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, world_setting_id) VALUES (?, ?, ?, ?)`
  ).run(name, name, '测试用', worldSettingId);
  return info.lastInsertRowid;
}

/**
 * ★★ 2026-10-18 世界分层：这条已经从「覆盖语义」改成「叠加语义」。
 *
 * 以前：角色绑定的世界会**完全顶掉**激活世界（一个字都不拼）。
 * 现在：主世界是**骨架层**，永远在前；角色绑定的具体世界在后，细节覆盖骨架。
 * 断言重点因此变成「两块都在 + framework 在前」。
 */
test('★★★ T07（分层）：主世界骨架 + 角色绑定世界同时注入，框架在前', async () => {
  const db = await import('../src/db/index.js');
  const database = db.getDb();
  const worldB = makeT07World(db, 'coreB', '# 世界框架\n框架通则BETA\n');
  const worldA = makeT07World(db, 'charA', '# A世界\nA世界独有标记ALPHA\n');
  try {
    db.activateWorldSetting(worldB.id);           // B = 主世界（骨架层）
    const chId = makeT07Character(database, worldA.id);

    const out = db.getWorldSetting(chId);
    assert.ok(out, '应该返回内容');
    assert.ok(out.includes('ALPHA'), '角色归属的具体世界必须在');
    assert.ok(out.includes('BETA'), '主世界骨架必须叠加（分层后的新语义）');
    assert.ok(out.indexOf('BETA') < out.indexOf('ALPHA'), 'framework 在前、current 在后');
    assert.match(out, /role="framework"/, '主世界要标成 framework');
    assert.match(out, /role="current"/, '具体世界要标成 current');

    // 同一个角色，逃生口也要跟随
    const raw = db.getWorldSettingRaw(chId);
    assert.ok(raw.includes('ALPHA') && raw.includes('BETA'), 'getWorldSettingRaw 也要叠加两块');
  } finally {
    dropT07World(worldA.name, worldA.id);
    dropT07World(worldB.name, worldB.id);
  }
});

test('★★★ T07：未绑定 / 不传参 → 回落激活世界（老调用零行为变化）', async () => {
  const db = await import('../src/db/index.js');
  const database = db.getDb();
  const worldB = makeT07World(db, 'fallbackB', '# B世界\n回落标记BETA\n');
  try {
    db.activateWorldSetting(worldB.id);
    const chId = makeT07Character(database, null);   // world_setting_id = NULL

    // 三条路必须同结果：不传参、传 null、传"未绑定的角色"
    const noArg = db.getWorldSetting();
    const nullArg = db.getWorldSetting(null);
    const unbound = db.getWorldSetting(chId);
    assert.equal(unbound, noArg, '未绑定角色必须与不传参逐字节一致');
    assert.equal(nullArg, noArg, '显式传 null 必须与不传参逐字节一致');
    assert.ok(noArg.includes('回落标记BETA'));
  } finally {
    dropT07World(worldB.name, worldB.id);
  }
});

test('★★ T07：角色指向已删世界 → 回落激活世界，不抛', async () => {
  const db = await import('../src/db/index.js');
  const database = db.getDb();
  const worldB = makeT07World(db, 'ghostB', '# B世界\n幽灵回落标记\n');
  try {
    db.activateWorldSetting(worldB.id);
    // 直接塞一个不存在的 world_setting_id（模拟世界被删但角色没改绑）
    const chId = makeT07Character(database, 999999);
    const out = db.getWorldSetting(chId);
    assert.ok(out?.includes('幽灵回落标记'), '指向已删世界时回落激活世界且不崩');
    assert.equal(db.getCharacterWorldSettingId(chId), null, '悬空绑定应视为未绑定');
  } finally {
    dropT07World(worldB.name, worldB.id);
  }
});

test('★★ T07（分层）：归属的世界正文为空 → 只剩主世界骨架，不产出 current 块', async () => {
  const db = await import('../src/db/index.js');
  const database = db.getDb();
  const worldB = makeT07World(db, 'emptyB', '# 世界框架\n骨架兜底BETA\n');
  const worldEmpty = makeT07World(db, 'emptyA', '');
  try {
    db.activateWorldSetting(worldB.id);
    const chId = makeT07Character(database, worldEmpty.id);
    const out = db.getWorldSetting(chId);
    // 分层后：具体世界为空 ≠ 没有世界观，骨架层仍然在
    assert.ok(out?.includes('骨架兜底BETA'), '主世界骨架不能被空的具体世界顶掉');
    assert.doesNotMatch(out || '', /role="current"/, '空的具体世界不该产出 current 块');
  } finally {
    dropT07World(worldEmpty.name, worldEmpty.id);
    dropT07World(worldB.name, worldB.id);
  }
});

test('★★★ T07（分层）：两块文本各按自己的槽位裁，不能拿主世界的声明去裁具体世界', async () => {
  const db = await import('../src/db/index.js');
  const database = db.getDb();
  // 两块都有同名章节「世界背景」，但只有主世界 B 把它声明为氛围节
  const worldA = makeT07World(db, 'slotA', '# A世界\n## 世界背景\nA的背景要留着\n');
  const worldB = makeT07World(db, 'slotB', '# 世界框架\n## 世界背景\nB的背景该被裁\n');
  try {
    db.activateWorldSetting(worldB.id);
    writeProject(slugForWorld(worldB.name, worldB.id), { ...neutralProject(), ambienceSections: ['世界背景'] });
    const chId = makeT07Character(database, worldA.id);

    const out = db.getSystemRulesWithWorld({ characterId: chId, roleplay: false });
    assert.ok(out.includes('A的背景要留着'),
      'A 没声明这个节 → 不能被主世界 B 的槽位连带裁掉（这正是 slotsForCharacter 返回中性的原因）');
    assert.ok(!out.includes('B的背景该被裁'), 'B 自己声明了 → 它自己那节要裁掉');
  } finally {
    dropT07World(worldA.name, worldA.id);
    dropT07World(worldB.name, worldB.id);
  }
});

// ─────────────────────────────────────────────────────────
// T12（2026-10-17 星图）：删世界的引用保护
// ─────────────────────────────────────────────────────────
// 前端已经拦了一道（有角色归属就不让删），但**绕开界面直接调接口**同样得挡住 ——
// 否则会删出悬空引用：角色指向不存在的世界（界面显示一个已删的世界名）、地图彻底悬空。

test('★★★ T12：有角色归属 → 拒绝删除世界', async () => {
  const db = await import('../src/db/index.js');
  const database = db.getDb();
  const wKeep = makeT07World(db, 'keepA', '# 留着的世界\n');
  const wDel = makeT07World(db, 'delA', '# 要删的世界\n');
  try {
    const chId = makeT07Character(database, wDel.id);
    const r = db.deleteWorldSetting(wDel.id);
    assert.equal(r.ok, false, '有角色归属时必须拒绝');
    assert.equal(r.code, 'WORLD_IN_USE');
    assert.ok(r.characterCount >= 1, '要回报有多少个角色');
    assert.match(r.error, /角色/, '错误信息要告诉用户怎么解');
    assert.ok(db.getWorldSettingById(wDel.id), '世界必须还在');
    void chId;
  } finally {
    dropT07World(wKeep.name, wKeep.id);
    dropT07World(wDel.name, wDel.id);
  }
});

test('★★★ T12：有地图归属 → 拒绝删除世界', async () => {
  const db = await import('../src/db/index.js');
  const database = db.getDb();
  const wKeep = makeT07World(db, 'keepB', '# 留着的世界\n');
  const wDel = makeT07World(db, 'delB', '# 要删的世界\n');
  try {
    database.prepare('INSERT INTO world_maps (name, world_setting_id, note) VALUES (?, ?, ?)')
      .run('__T12验收地图__', wDel.id, '');
    const r = db.deleteWorldSetting(wDel.id);
    assert.equal(r.ok, false, '有地图归属时必须拒绝');
    assert.ok(r.mapCount >= 1, '要回报有多少张地图');
    assert.match(r.error, /地图/);
    assert.ok(db.getWorldSettingById(wDel.id), '世界必须还在');
  } finally {
    database.prepare('DELETE FROM world_maps WHERE name = ?').run('__T12验收地图__');
    dropT07World(wKeep.name, wKeep.id);
    dropT07World(wDel.name, wDel.id);
  }
});

test('★★★ T12：没有任何引用 → 正常删除（守卫不能把正常删除也堵死）', async () => {
  const db = await import('../src/db/index.js');
  db.getDb();
  const wKeep = makeT07World(db, 'keepC', '# 留着的世界\n');
  const wDel = makeT07World(db, 'delC', '# 干净的待删世界\n');
  try {
    const r = db.deleteWorldSetting(wDel.id);
    assert.equal(r.ok, true, '无引用时应当删得掉');
    assert.ok(!db.getWorldSettingById(wDel.id), '确实删掉了（查无记录时 get 返回 undefined）');
    assert.ok(db.getWorldSettingById(wKeep.id), '别的世界不受影响');
  } finally {
    dropT07World(wKeep.name, wKeep.id);
    dropT07World(wDel.name, wDel.id);
  }
});

test('★★ T12：最后一套世界观仍然不可删（既有护栏不能被新守卫破坏）', async () => {
  const db = await import('../src/db/index.js');
  db.getDb();
  // 该测试文件里世界不止一套，所以这里验的是"判定顺序"：先报 last-one 还是先报 in-use。
  // 只要两套都在，删任意一套若无引用应成功；这条主要防"新增守卫把 count<=1 的判断挤掉"。
  const wA = makeT07World(db, 'lastA', '# A\n');
  const wB = makeT07World(db, 'lastB', '# B\n');
  try {
    assert.equal(db.deleteWorldSetting(wA.id).ok, true);
    const r2 = db.deleteWorldSetting(wB.id);
    // 此时库里仍会有默认世界（seed），所以 wB 通常仍可删；关键是不能抛异常
    assert.equal(typeof r2.ok, 'boolean');
  } finally {
    dropT07World(wA.name, wA.id);
    dropT07World(wB.name, wB.id);
  }
});


// T07 只装了能力；T08 要让它真的被用上。这里的护栏分两层：
//   ① 接线护栏（静态）：已接线的调用点必须把 id 传下去 —— 谁把它改回 getWorldSetting() 就红
//   ② 行为护栏（动态）：群聊整轮按「群主所在世界」解析，且只解析一次

// ─────────────────────────────────────────────────────────
// T08（2026-10-17 星图）：把 characterId 接到实际链路上
// ─────────────────────────────────────────────────────────
// T07 只装了能力；T08 要让它真的被用上。这里的护栏分两层：
//   ① 接线护栏（静态）：已接线的调用点必须把 id 传下去 —— 谁把它改回 getWorldSetting() 就红
//   ② 行为护栏（动态）：群聊整轮按「群主所在世界」解析，且只解析一次

test('★★★ T08：群聊整轮按「群主所在世界」解析，且不混入别的副世界', async () => {
  const db = await import('../src/db/index.js');
  db.getDb();
  const worldB = makeT07World(db, 'gcB', '# B世界\n群聊不该吃到的BETA\n');
  const worldA = makeT07World(db, 'gcA', '# A世界\n群主所在ALPHA\n');
  try {
    // ★ 分层后：B 只是"另一个没人归属的副世界"，不设为主世界（主世界是迁移建的空骨架）
    const ownerId = makeT07Character(db.getDb(), worldA.id);
    const { buildGroupContext } = await import('../src/services/groupChatEngine.js');

    // 不插群表：buildGroupContext 只读群 id 拼会话名，取不到历史摘要就当空
    const group = { id: 987654, creator_character_id: ownerId, members: [{ id: ownerId }] };
    const msgs = buildGroupContext(group, ['本轮：随便聊聊']);
    const stage = msgs[0]?.content || '';

    assert.ok(stage.includes('ALPHA'), '群聊舞台应吃群主所在的 A 世界');
    assert.ok(!stage.includes('BETA'), '别的副世界 B 的内容不得混进群聊');

    // 两次取到的舞台必须一致 —— 证明整轮只解析一次（不会上下半场换世界）
    const msgs2 = buildGroupContext(group, ['本轮：再聊一句']);
    assert.equal(msgs2[0].content, stage, '同一群同一轮的世界块必须稳定');
  } finally {
    dropT07World(worldA.name, worldA.id);
    dropT07World(worldB.name, worldB.id);
  }
});

test('★★★ T08 接线护栏：已接线的调用点必须把角色 id 传下去', () => {
  const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
  // [文件, 调用形态, 期望处数, 链路]
  // ⚠ 用「计数」而不是「有匹配」：同一文件常有多处（如 moments ×2、eventGenerator ×3），
  //   只改一处也能"有匹配"，计数才能防止漏改。
  const WIRED = [
    ['routes/chat.js', /getWorldSetting\(characterId\)/g, 1, '单聊舞台'],
    ['routes/chat.js', /getWorldSetting\(character\?\.id\)/g, 1, '对话预测'],
    ['routes/characters.js', /getWorldSetting\(characterId\)/g, 1, '服装外观'],
    ['routes/characters.js', /getWorldSetting\(char\?\.id\)/g, 1, '立绘'],
    ['routes/schedule.js', /getWorldSetting\(characterId\)/g, 1, '日程快照'],
    ['services/scheduleGenerator.js', /getWorldSetting\(character\?\.id\)/g, 1, '日程编排'],
    ['services/dialogueBackground.js', /getWorldSetting\(character\?\.id\)/g, 1, '对话背景'],
    ['services/groupChatEngine.js', /getWorldSetting\(groupWorldCharacterId\(group\)\)/g, 1, '群聊舞台'],
    ['services/scheduleLedger.js', /clichePropsNow\(characterId\)/g, 1, '日程台账词表'],
    ['routes/moments.js', /getWorldSetting\(character\.id\)/g, 2, '朋友圈生成 ×2'],
    ['services/momentInteractionService.js', /getWorldSetting\(posterChar\?\.id\)/g, 3, '朋友圈互动 ×3'],
    ['services/momentUserPostService.js', /getWorldSetting\(character\.id\)/g, 1, '用户动态评论'],
    ['services/momentCommentService.js', /getWorldSetting\(character\.id\)/g, 1, '朋友圈回复'],
    ['services/eventGenerator.js', /getWorldSetting\(character\.id\)/g, 3, '奇遇 ×3'],
    ['services/diaryGenerator.js', /getWorldSetting\(character\?\.id\)/g, 1, '日记'],
    ['services/dreamService.js', /getWorldSetting\(character\?\.id\)/g, 1, '梦境'],
    ['services/wakeService.js', /getWorldSetting\(char\?\.id\)/g, 1, '叫醒'],
    ['services/appointmentDetector.js', /getWorldSetting\(character\?\.id\)/g, 1, '约会检测'],
    ['services/itemGiftNarrative.js', /getWorldSetting\(character\?\.id\)/g, 1, '送礼叙事'],
    ['services/expressionStandingService.js', /getWorldSetting\(char\?\.id\)/g, 2, '表情立绘 ×2'],
    ['services/proactiveChatScheduler.js', /getWorldSetting\(character\.id\)/g, 1, '主动消息'],
    ['services/characterReactionService.js', /promptPrefixFingerprint\(character\?\.id\)/g, 1, '角色反应'],
    ['services/outfitScene.js', /getWorldSetting\(character\?\.id\)/g, 1, '换装'],
    ['services/replyQueueScheduler.js', /getWorldSetting\(characterId\)/g, 1, '延迟回复队列'],
    ['routes/relationships.js', /getWorldSetting\(characterId \|\| null\)/g, 1, '关系推演'],
    // ↓ 这批只调 getSystemRulesWithWorld（不经 getWorldSetting），首轮扫描漏掉了
    ['services/characterReactionPackService.js', /getSystemRulesWithWorld\(\{ roleplay: false, characterId: character\?\.id \}\)/g, 1, '角色反应包'],
    ['services/emotionEngine.js', /getSystemRulesWithWorld\(\{ characterId \}\)/g, 1, '送礼反应'],
    ['services/mailboxScheduler.js', /getSystemRulesWithWorld\(\{ characterId: charId \}\)/g, 1, '信箱回信'],
    ['services/proactiveChatScheduler.js', /getSystemRulesWithWorld\(\{ roleplay: false, characterId: character\?\.id \}\)/g, 1, '主动消息配图'],
    ['services/eventScheduler.js', /getSystemRulesWithWorld\(\{ roleplay: true, characterId: event\.character_id \}\)/g, 1, '奇遇紧急联络'],
  ];
  const problems = [];
  for (const [rel, re, want, note] of WIRED) {
    const got = (readSrc(rel).match(re) || []).length;
    if (got !== want) problems.push(`${rel} 期望 ${want} 处（${note}），实际 ${got} 处`);
  }
  assert.deepEqual(problems, [], `接线断了：\n  ${problems.join('\n  ')}`);
});

test('★★★ T08 第二轮：日常副线的消息构建器都吃「角色所在世界」', async () => {
  const db = await import('../src/db/index.js');
  const database = db.getDb();
  const worldA = makeT07World(db, 'r2A', '# A世界\n角色所在ALPHA2\n');
  const worldB = makeT07World(db, 'r2B', '# B世界\n别的副世界不该出现BETA2\n');
  try {
    // ★ 分层后：B 只是"另一个副世界"，不再设为主世界
    const row = database.prepare('SELECT * FROM characters WHERE id = ?').get(makeT07Character(database, worldA.id));

    // ① 送礼叙事：拼进 systemBase 的世界块
    const { buildGiftMessages } = await import('../src/services/itemGiftNarrative.js');
    const gift = JSON.stringify(buildGiftMessages({ item: { name: '小石头', description: '河边捡的' }, character: row }));
    assert.ok(gift.includes('ALPHA2'), '送礼叙事应吃角色所在世界');
    assert.ok(!gift.includes('BETA2'), '送礼叙事不得混入别的副世界');

    // ② 日记：system0（getSystemRulesWithWorld）应带角色世界
    const { buildDiaryMessages } = await import('../src/services/diaryGenerator.js');
    const diary = JSON.stringify(buildDiaryMessages({ character: row, dateKey: '2026-10-17', scheduleText: '' }));
    assert.ok(diary.includes('ALPHA2'), '日记应吃角色所在世界');
    assert.ok(!diary.includes('BETA2'), '日记不得混入别的副世界');

    // ③ 角色反应：前缀指纹里的 system1
    const { promptPrefixFingerprint } = await import('../src/services/characterReactionService.js');
    const fp = promptPrefixFingerprint(row.id);
    assert.ok(String(fp.system1).includes('ALPHA2'), '角色反应的 system1 应吃角色所在世界');
    assert.ok(!JSON.stringify(fp).includes('BETA2'), '角色反应不得混入别的副世界');

    // ④ 对照：不传参走**主世界**（迁移建的空骨架），既不是 A 也不是 B
    const bare = String(promptPrefixFingerprint().system1);
    assert.ok(!bare.includes('ALPHA2'), '不传参不该拿到某个角色的具体世界');
    assert.ok(!bare.includes('BETA2'), '不传参也不该拿到别的副世界');
  } finally {
    dropT07World(worldA.name, worldA.id);
    dropT07World(worldB.name, worldB.id);
  }
});

test('★★ T08：未绑定角色仍然回落激活世界（接线不能顺手改坏回落）', async () => {
  const db = await import('../src/db/index.js');
  const database = db.getDb();
  const worldB = makeT07World(db, 'unboundB', '# B世界\n回落标记DELTA\n');
  try {
    db.activateWorldSetting(worldB.id);
    const chId = makeT07Character(database, null);
    assert.ok(db.getWorldSetting(chId).includes('回落标记DELTA'), '未绑定角色必须仍吃激活世界');
    assert.equal(db.getWorldSetting(chId), db.getWorldSetting(), '与不传参完全一致');
  } finally {
    dropT07World(worldB.name, worldB.id);
  }
});

test('★★ 静默兜底必须能区分"数据层未就绪"与"真出错"（本次踩过的坑）', () => {
  // 实况：forumAlias 里写了空 catch 吞掉 ReferenceError（漏 import 导致 getActiveWorldSlots 未定义），
  // 表现成"专属取材维度神秘消失"，排查时才发现。空 catch 是红线 0 的同源陷阱。
  const fa = fs.readFileSync(path.join(SRC, 'services/forumAlias.js'), 'utf8');
  const fn = fa.slice(fa.indexOf('export function aliasSourcesNow'), fa.indexOf('export function aliasSourcesNow') + 1200);
  assert.match(fn, /catch\s*\(\w+\)/, '必须捕获变量，不能是空 catch');
  assert.match(fn, /console\.warn/, '真出错时必须留痕');
  assert.match(fn, /notReady|is not defined/, '要能区分"未就绪"（正常回落）与"真出错"（必须喊）');
  assert.match(fa, /^import \{ getActiveWorldSlots \}/m, '依赖必须真的 import（漏了会被 catch 吞成"没有项目库"）');
});

test('★ 同类兜底：scheduleLedger 也得真 import，不能靠 catch 兜', () => {
  const sl = fs.readFileSync(path.join(SRC, 'services/scheduleLedger.js'), 'utf8');
  // T08 起槽位入口由 getActiveWorldSlots 换成 getWorldSlotsFor(characterId)；
  // 这条护栏守的是"依赖真的被 import"（防 ReferenceError 被空 catch 吞掉），不是某个具体名字。
  assert.match(sl, /^import \{ get(?:ActiveWorldSlots|WorldSlotsFor) \}/m, 'scheduleLedger 依赖必须真的 import');
  assert.match(sl, /clichePropsNow\(characterId\)/, '词表必须按角色所在世界取（T08）');
});

// ─────────────────────────────────────────────────────────
// 前端护栏（2026-10-07 补）
// ─────────────────────────────────────────────────────────
// ⚠ 上面那条护栏只扫 `agent-core/src` 的 `.js` —— 于是**前端**成了缺口：
//   我在「派系与组织」的输入框里写了「如：幻月秘庭 / 共愿帮」（某世界观的专名），
//   构建、全部测试**都是绿的**，但那句话对任何别的世界观都是错的 —— 用户当场指出。
//   这里把**同一份词表**扩展到 `web-ui/src`（`.vue` + `.js`）。
//   存量违规列成**具名豁免**（文件 → 允许的词集合）：棘轮式，只许减少不许增加。

const WEB_UI_SRC = path.resolve(__dirname, '../../web-ui/src');

/**
 * 前端**存量**违规豁免：文件（相对 `web-ui/src`）→ 允许出现的词集合。
 * 只放"本次修复时已存在、且不宜顺手机械改"的；**新增违规一律不要补进这里**。
 */
const FRONTEND_LEGACY_ALLOW = {
  // 该地图功能的点位/坐标表：属"某个具体地图"的数据，待迁到数据层（同 transitSeed 的做法）
  'components/worldmap/MapPointView.vue': ['二相乐园', '二维市', '鸽川', '绘世学院', '珠星', '海原电视塔', '幻月秘庭', '世界尽头酒馆', '喜悲街', '喜笑区', '悲泣区', '泊地站'],
  // 报纸入口副标题写死了世界观名 —— 存量文案，宜改由数据/设置驱动
  'views/MediaView.vue': ['二相乐园'],
  // 媒体持牌人称谓（该世界观的词汇）—— 存量文案
  'components/media/MediaWeekly.vue': ['谒者'],
  // 故事页占位符举例 —— 另一个会话正在改该文件，暂不介入
  'views/StoryView.vue': ['鸽川', '嬉步街'],
};

function walkFrontend(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFrontend(p, acc);
    else if (/\.(vue|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

test('★★★ 前端（web-ui）也不得内置世界观专有名词（存量已在豁免表内，新增即失败）', () => {
  const offenders = [];
  for (const file of walkFrontend(WEB_UI_SRC, [])) {
    const rel = path.relative(WEB_UI_SRC, file).replace(/\\/g, '/');
    const allowed = new Set(FRONTEND_LEGACY_ALLOW[rel] || []);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes(EXEMPT_MARK)) return;
      // 模板注释 <!-- --> 与脚本注释同等对待
      if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return;
      for (const t of BANNED_TERMS) {
        if (!line.includes(t) || allowed.has(t)) continue;
        offenders.push(`web-ui/src/${rel}:${i + 1} 含「${t}」`);
      }
    });
  }
  assert.deepEqual(
    offenders, [],
    `前端出现了世界观专有名词（换世界观后这些文案就是错的）：\n  ${offenders.join('\n  ')}\n` +
    `\n→ 修法：① 改通用表述（占位符/示例尤其容易犯）；② 从数据层/项目库读取；③ 确属必要的，行尾加「${EXEMPT_MARK}: 理由」` +
    `（⚠ 存量豁免见本文件 FRONTEND_LEGACY_ALLOW，只许减少，不要往里加）`
  );
});

test('★★ 护栏本身有效：前端占位符里塞专名必须被抓到（防"豁免表写太宽导致永远绿"）', () => {
  // 直接验判据：造一行前端占位符，应命中；且豁免表里没有它
  const fakeLine = 'placeholder="如：幻月秘庭 / 共愿帮"';
  const hit = BANNED_TERMS.filter(t => fakeLine.includes(t));
  assert.ok(hit.includes('幻月秘庭'), '词表应能命中占位符里的专名');
  assert.ok(!Object.keys(FRONTEND_LEGACY_ALLOW).some(f => f.endsWith('FactionManagerModal.vue')),
    '我刚修好的组件不该在豁免表里');
});
