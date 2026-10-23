/**
 * 生图场景清单的覆盖率护栏（2026-10-23，方案 §19 全链路体检）
 *
 * 背景：`scenes` 白名单曾长期与实际使用脱节 ——
 *   · `items`（道具）和 `town`（小镇素材）从不在任何白名单里，**永远吃不到全局 LoRA**
 *   · 10 处链路根本没传 scene，靠"绕过白名单"意外生效
 *   · 前端弹窗只有 8 个选项，**没有"头像"**
 *
 * 本文件钉三件事：
 *   ① 清单自身干净（无重复、key 非空）
 *   ② 8 项旧配置能补全到当前全集，且补完是幂等的
 *   ③ **源码里所有 `scene: 'xxx'` 字面量都必须在清单内** —— 这条是防回归的主护栏
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { scanImageCalls } from '../scripts/lib/image-call-scan.mjs';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`lora scene test forbids network: ${url}`); };

const { IMAGE_SCENES, IMAGE_SCENE_KEYS, LEGACY_UI_SCENES_V1, isKnownScene, unknownScenes } =
  await import('../src/services/imageScenes.js');
const { migrateGlobalLoraScenes } = await import('../src/db/settings.js');
const { buildWorkflow, normalizeArtistString } = await import('../src/services/imageSkill.js');

test('清单：key 非空、无重复、有 label', () => {
  const seen = new Set();
  for (const s of IMAGE_SCENES) {
    assert.ok(s.key, `有场景缺 key：${JSON.stringify(s)}`);
    assert.ok(s.label, `场景 ${s.key} 缺 label`);
    assert.ok(!seen.has(s.key), `场景 key 重复：${s.key}`);
    seen.add(s.key);
  }
  assert.ok(IMAGE_SCENE_KEYS.length >= 15, `清单只有 ${IMAGE_SCENE_KEYS.length} 项，疑似漏登记`);
});

test('清单：体检时补的六项必须在册（否则补了 scene 也会失效）', () => {
  for (const k of ['avatar', 'item', 'media', 'paper', 'proactive', 'gift']) {
    assert.ok(isKnownScene(k), `${k} 不在场景清单里`);
  }
});

test('unknownScenes：识别复数/拼错的值', () => {
  assert.deepEqual(unknownScenes(['items']), ['items'], "'items' 是复数，不在清单里");
  assert.deepEqual(unknownScenes(['item']), [], "'item' 才是登记过的");
  assert.deepEqual(unknownScenes(['chat', 'nope']), ['nope']);
  assert.deepEqual(unknownScenes([]), []);
});

test('★ 旧 UI 八项（当时的"全选"）补全到当前全集', () => {
  const out = migrateGlobalLoraScenes([{ path: 'a.safetensors', weight: 0.9, scenes: [...LEGACY_UI_SCENES_V1] }]);
  assert.deepEqual(out[0].scenes, IMAGE_SCENE_KEYS, '八项应补全到全集');
  assert.equal(out[0].weight, 0.9, '其余字段不动');
  // 关键：补全后头像/道具/媒体/报纸/主动聊天/礼物都能命中
  for (const k of ['avatar', 'item', 'media', 'paper', 'proactive', 'gift']) {
    assert.ok(out[0].scenes.includes(k), `补全后应含 ${k}`);
  }
});

test('补全是幂等的：再跑一次不重复、不改变对象', () => {
  const once = migrateGlobalLoraScenes([{ path: 'a.safetensors', scenes: [...LEGACY_UI_SCENES_V1] }]);
  const twice = migrateGlobalLoraScenes(once);
  assert.deepEqual(twice[0].scenes, IMAGE_SCENE_KEYS);
  assert.equal(twice[0], once[0], '已是全集时保持原对象，不制造新引用');
});

test('七项（不含表情包，可能是故意排除）不补全', () => {
  const seven = LEGACY_UI_SCENES_V1.filter(s => s !== 'sticker');
  const out = migrateGlobalLoraScenes([{ path: 'a.safetensors', scenes: [...seven] }]);
  assert.equal(out[0].scenes.includes('avatar'), false, '七项属于"用户挑过的"，不该被补');
});

test('scenes 为空数组时不动（后端语义 = 全场景）', () => {
  const out = migrateGlobalLoraScenes([{ path: 'a.safetensors', scenes: [] }]);
  assert.deepEqual(out[0].scenes, []);
});

test('★ 源码护栏：每处生图调用的 scene 都必须在清单内', () => {
  // 用与 `scripts/audit-image-call-params.mjs` **同一套**提取逻辑 ——
  // 直接对全文跑 `scene:` 正则会把锚点的 scene:'work'、服装的 scene:'sleep'
  // 一起抓进来（那是另一套枚举），第一版就是这么误报的。
  const ROOT = path.resolve(import.meta.dirname, '..', 'src');
  const calls = scanImageCalls(ROOT);
  assert.ok(calls.length >= 25, `只扫到 ${calls.length} 处调用，扫描器可能坏了`);

  const bad = [];
  for (const c of calls) {
    // 三元 / 变量形式的 scene（如 `isEvent ? 'events' : mode`）静态判断不了，跳过
    const lit = /^'([^']+)'$/.exec(String(c.scene || '').trim());
    if (!lit) continue;
    if (!isKnownScene(lit[1])) bad.push(`${c.file}:${c.line} → scene: '${lit[1]}'`);
  }
  assert.deepEqual(bad, [], `以下 scene 值不在 IMAGE_SCENES 清单里，全局 LoRA 永远命不中：\n${bad.join('\n')}`);
});

test('★ 源码护栏：核心链路都必须显式传 scene（不许再靠"漏传"生效）', () => {
  const ROOT = path.resolve(import.meta.dirname, '..', 'src');
  const calls = scanImageCalls(ROOT);
  // 这些链路曾经因为没传 scene 而"绕过白名单生效"，体检后必须显式声明
  const mustDeclare = [
    'src/routes/characters.js',                 // 头像 / 立绘
    'src/services/proactiveChatScheduler.js',   // 主动聊天
    'src/services/itemService.js',              // 道具
    'src/services/lootService.js',              // 战利品
    'src/services/newspaperService.js',         // 报纸
    'src/services/mediaService.js',             // 媒体图
  ];
  const missing = [];
  for (const f of mustDeclare) {
    // `generateMediaImage` 是包装函数（内部默认 scene='media'，也可由调用方覆盖），
    // 不算"漏传"；真正落到 ComfyUI 的是 generateImageRaw / generateImage。
    const inFile = calls.filter(c => c.call !== 'generateMediaImage'
      && c.file.replace(/^src\//, '').replace(/\\/g, '/').endsWith(f.replace(/^src\//, '')));
    if (inFile.length === 0) { missing.push(`${f}（没扫到调用，检查扫描器）`); continue; }
    for (const c of inFile) {
      if (c.scene == null) missing.push(`${c.file}:${c.line}`);
    }
  }
  assert.deepEqual(missing, [], `这些调用没传 scene，会绕过 LoRA 白名单：\n${missing.join('\n')}`);
});

// ── 画师串与触发词（§19 里两个"看起来配了、实际没生效"的噪声源）──

test('normalizeArtistString：全角逗号/顿号/冒号都换成半角', () => {
  // 用户实机的真实串：`official art，@DOM` —— 那个 `，` 会让后半段黏成怪 token
  assert.equal(
    normalizeArtistString('Honkai: Star Rail, official art，@DOM'),
    'Honkai: Star Rail, official art, @DOM',
  );
  // 冒号只换字符不补空格：`@lora:1.2` 这类权重写法一旦被加空格就废了
  assert.equal(normalizeArtistString('a、b，c：d'), 'a, b, c:d');
  // 全角括号是画师原名的一部分，不能被改
  assert.equal(normalizeArtistString('画师（CV），@x'), '画师（CV）, @x');
  assert.equal(normalizeArtistString('  ,,a,,b,  '), 'a, b');
  assert.equal(normalizeArtistString(null), '');
});

test('★ buildWorkflow：画师串里已有的触发词不再重复注入', () => {
  const { wf } = buildWorkflow('1girl, solo', {
    loras: [{ path: 'x.safetensors', weight: 0.9, triggerWord: '@DOM' }],
    artist: 'Honkai: Star Rail, @DOM',      // 触发词已经写在画师串里
    scene: 'moments',
  });
  const triggerNode = (wf.nodes || []).find(n => n.title === 'lora触发词');
  const injected = triggerNode ? String(triggerNode.widgets_values?.[0] || '') : '';
  assert.equal(injected.includes('@DOM'), false,
    `触发词已在画师串里，不该再进 loraTrigger 节点：${injected}`);
});

test('buildWorkflow：画师串里没有的触发词照常注入', () => {
  const { wf } = buildWorkflow('1girl, solo', {
    loras: [{ path: 'y.safetensors', weight: 0.9, triggerWord: '@abc' }],
    artist: 'official art',
    scene: 'moments',
  });
  const triggerNode = (wf.nodes || []).find(n => n.title === 'lora触发词');
  const injected = triggerNode ? String(triggerNode.widgets_values?.[0] || '') : '';
  assert.equal(injected.includes('@abc'), true, `应注入 @abc，实际：${injected}`);
});
