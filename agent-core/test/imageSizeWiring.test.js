/**
 * 生图尺寸「接线」验证（2026-10-22）
 *
 * 用户的担心原话：「确保刚刚改的尺寸什么的都能被生图拿到，别设置里面改了，还按照之前的尺寸生图」。
 *
 * 这个担心非常具体，因为链路是**按节点 title 注入**的：
 *   配置 → 各 service 传 overrides.width/height → buildWorkflow 找 title=`图片的宽/图片的长` 的节点写值
 * 任何一环脱节（字段没传、title 对不上、工作流换了个没有这俩节点的版本），
 * 尺寸都会**静默不变**——不报错、不打日志，只有出图出来才发现。
 *
 * 所以这里不验"配置存下来了"，而是验「装配出来的工作流里，宽高真的被改写了」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { buildWorkflow } from '../src/services/imageSkill.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORKFLOW_DIR = path.resolve(ROOT, '..', 'workflow');

/** 取装配后工作流里某个 title 节点被写入的值 */
function nodeValue(wf, title) {
  const node = (wf.nodes || []).find(n => n.title === title);
  return node ? node.widgets_values?.[0] : undefined;
}

function withWorkflowConfig(patch, fn) {
  const saved = { mode: config.workflow?.mode, customTemplate: config.workflow?.customTemplate };
  if (!config.workflow) config.workflow = {};
  config.workflow.mode = 'custom';
  config.workflow.customTemplate = patch;
  try { return fn(); } finally {
    if (!config.workflow) config.workflow = {};
    config.workflow.mode = saved.mode;
    config.workflow.customTemplate = saved.customTemplate;
  }
}

test('★ 传进去的宽高必须真的写进工作流（这是「设置改了不出图」的唯一防线）', () => {
  const wf = buildWorkflow('a test prompt', { width: 640, height: 896, customWorkflow: null });
  assert.equal(nodeValue(wf.wf, '图片的宽'), 640);
  assert.equal(nodeValue(wf.wf, '图片的长'), 896);
});

test('★ 每次装配都重新套用本次宽高 —— 不会残留上一次的尺寸', () => {
  const a = buildWorkflow('p', { width: 512, height: 768, customWorkflow: null });
  const b = buildWorkflow('p', { width: 1280, height: 720, customWorkflow: null });
  assert.equal(nodeValue(a.wf, '图片的宽'), 512);
  assert.equal(nodeValue(b.wf, '图片的宽'), 1280);
  assert.equal(nodeValue(b.wf, '图片的长'), 720);
});

test('★ 没有生成工作流缺「图片的宽/图片的长」节点（换工作流就静默失效）', () => {
  const files = fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.json'));
  assert.ok(files.length > 0, 'workflow 目录里没有工作流文件？');
  const broken = [];
  for (const f of files) {
    // 放大细化工作流吃的是原图尺寸，不该有宽高节点
    if (/放大细化/.test(f)) continue;
    let wf;
    try { wf = JSON.parse(fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8')); } catch { broken.push(`${f}（JSON 解析失败）`); continue; }
    const titles = new Set((wf.nodes || []).map(n => n.title).filter(Boolean));
    const miss = ['图片的宽', '图片的长'].filter(t => !titles.has(t));
    if (miss.length) broken.push(`${f}（缺 ${miss.join('/')}）`);
  }
  assert.deepEqual(broken, [], `这些工作流拿不到尺寸设置：\n${broken.join('\n')}`);
});

test('当前实际在用的自定义工作流也带宽高节点（用户切模板时会忘）', () => {
  const tpl = config.workflow?.customTemplate;
  if (!tpl) return;   // 不是 custom 模式就无所谓
  const p = path.join(WORKFLOW_DIR, tpl);
  assert.ok(fs.existsSync(p), `配置里的工作流不存在：${tpl}`);
  const wf = JSON.parse(fs.readFileSync(p, 'utf8'));
  const titles = new Set((wf.nodes || []).map(n => n.title).filter(Boolean));
  assert.ok(titles.has('图片的宽') && titles.has('图片的长'), `${tpl} 缺宽高节点，改尺寸不会生效`);
});

test('画师串同样是按 title 注入 —— 顺手一起验', () => {
  const wf = buildWorkflow('p', { artist: '@verify_artist', width: 512, height: 512, customWorkflow: null });
  assert.equal(nodeValue(wf.wf, '画师串'), '@verify_artist');
});

/**
 * 静态兜底：每条链路都必须把自己的配置字段传给生图调用。
 * 只看「文件里有没有这个引用」——够了，能抓住「重构时把 width 删了」这类回归。
 */
test('★ 九条链路各自的尺寸字段都有被引用（删一处就红）', () => {
  const expect = {
    'routes/images.js': ['config.comfyui.width', 'config.comfyui.height', 'config.comfyui.eventWidth', 'config.comfyui.momentsWidth'],
    'routes/moments.js': ['config.comfyui.momentsWidth', 'config.comfyui.momentsHeight'],
    'services/eventGenerator.js': ['config.comfyui.eventWidth', 'config.comfyui.eventHeight'],
    'services/newspaperService.js': ['config.comfyui.paperWidth', 'config.comfyui.paperHeight'],
    'services/expressionStandingService.js': ['config.comfyui.standingWidth', 'config.comfyui.standingHeight'],
    'services/mailboxScheduler.js': ['config.comfyui.mailWidth', 'config.comfyui.mailHeight'],
    'services/dialogueBackground.js': ['config.comfyui.chatBgWidth', 'config.comfyui.chatBgHeight'],
    'services/itemService.js': ['config.comfyui.itemWidth', 'config.comfyui.itemHeight'],
    'services/lootService.js': ['config.comfyui.itemWidth', 'config.comfyui.itemHeight'],
  };
  const missing = [];
  for (const [rel, keys] of Object.entries(expect)) {
    const src = fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
    for (const k of keys) if (!src.includes(k)) missing.push(`${rel} 没引用 ${k}`);
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('媒体画幅走 resolver（不是写死的表），自定义与小尺寸档都能进池', async () => {
  const { resolveGalleryAspects } = await import('../src/services/galleryAspectResolver.js');
  const saved = {
    pool: config.comfyui.galleryPool,
    custom: config.comfyui.galleryCustom,
    cap: config.comfyui.galleryMaxEdge,
  };
  try {
    config.comfyui.galleryPool = ['512x768', '1024x1024'];
    config.comfyui.galleryCustom = [{ w: 704, h: 704 }];
    config.comfyui.galleryMaxEdge = 0;
    const got = resolveGalleryAspects();
    assert.deepEqual(got.map(a => [a.w, a.h]), [[512, 768], [1024, 1024], [704, 704]]);
  } finally {
    config.comfyui.galleryPool = saved.pool;
    config.comfyui.galleryCustom = saved.custom;
    config.comfyui.galleryMaxEdge = saved.cap;
  }
});
