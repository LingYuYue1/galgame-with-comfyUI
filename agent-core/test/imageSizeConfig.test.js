/**
 * 回归：生图尺寸配置（2026-10-21 设置页整改 · 阶段 2）
 *
 * 改造前，六条链路的尺寸是**写死在代码里**的：
 *   报纸   → 偷用 config.comfyui.momentsWidth/Height（改朋友圈会连带改报纸）
 *   立绘   → expressionStandingService 写死 768×1536
 *   道具   → itemService / lootService 写死 512×512
 *   信箱   → mailboxScheduler 写死 1200×900（肖像 900×1200）
 *   聊天背景 → dialogueBackground 写死 1280×720
 *   媒体   → GALLERY_ASPECTS 七选一随机，池与上限都不可控
 *
 * 这批断言兜两件事：
 *   1. 新增的配置键**全部登记**进 SETTING_TO_CONFIG，且默认值 = 改造前的硬编码值
 *      ——「默认不改行为」是红线，不能因为"开放配置"顺手把默认值也调了
 *   2. 媒体画幅池的**过滤与长边上限，在默认状态下不改变任何结果**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SETTING_TO_CONFIG, loadSystemSettings } from '../src/db/settings.js';
import { config, GALLERY_ASPECT_KEYS } from '../src/config.js';
// 从纯数据/纯计算模块引入，不经过 mediaService —— 否则模块加载时 comfyClient 会真去连 ComfyUI
import { GALLERY_ASPECTS } from '../src/data/galleryAspects.js';
import { resolveGalleryAspects } from '../src/services/galleryAspectResolver.js';

/** 键 → [config 字段, 改造前的硬编码值] */
const SIZE_KEYS = {
  comfy_paper_width:      ['paperWidth',     1600],
  comfy_paper_height:     ['paperHeight',    1200],
  comfy_standing_width:   ['standingWidth',   768],
  comfy_standing_height:  ['standingHeight', 1536],
  comfy_item_width:       ['itemWidth',       512],
  comfy_item_height:      ['itemHeight',      512],
  comfy_mail_width:       ['mailWidth',      1200],
  comfy_mail_height:      ['mailHeight',      900],
  comfy_chatbg_width:     ['chatBgWidth',    1280],
  comfy_chatbg_height:    ['chatBgHeight',    720],
};

function createDb(entries) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE system_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const ins = db.prepare('INSERT INTO system_settings(setting_key, setting_value) VALUES (?, ?)');
  for (const [k, v] of entries) ins.run(k, v);
  return db;
}

function withComfy(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = config.comfyui[k];
  Object.assign(config.comfyui, patch);
  try { return fn(); } finally { Object.assign(config.comfyui, saved); }
}

test('所有新增尺寸键都登记进 SETTING_TO_CONFIG（obj=comfyui, type=int）', () => {
  for (const key of Object.keys(SIZE_KEYS)) {
    assert.ok(key in SETTING_TO_CONFIG, `${key} 未登记 —— setSetting 会警告且重启后丢失`);
    assert.equal(SETTING_TO_CONFIG[key].obj, 'comfyui', `${key} 的 obj 不对`);
    assert.equal(SETTING_TO_CONFIG[key].type, 'int', `${key} 的 type 不对`);
  }
});

test('默认值必须等于改造前的硬编码值（红线：默认不改行为）', () => {
  for (const [key, [field, expected]] of Object.entries(SIZE_KEYS)) {
    assert.equal(
      config.comfyui[field], expected,
      `${key} 的默认值变成了 ${config.comfyui[field]}，改造前是 ${expected}`,
    );
  }
});

test('写库后 loadSystemSettings 能把尺寸读回 config（等价于重启不丢）', () => {
  const db = createDb([
    ['comfy_standing_width', '512'],
    ['comfy_standing_height', '768'],
    ['comfy_paper_width', '1200'],
  ]);
  const before = {
    standingWidth: config.comfyui.standingWidth,
    standingHeight: config.comfyui.standingHeight,
    paperWidth: config.comfyui.paperWidth,
  };
  try {
    // 先反着设，证明值真来自库、不是默认值碰巧相等
    config.comfyui.standingWidth = 1;
    config.comfyui.standingHeight = 1;
    config.comfyui.paperWidth = 1;

    loadSystemSettings(db);

    assert.equal(config.comfyui.standingWidth, 512);
    assert.equal(config.comfyui.standingHeight, 768);
    assert.equal(config.comfyui.paperWidth, 1200);
  } finally {
    Object.assign(config.comfyui, before);
    db.close();
  }
});

test('媒体画幅池：默认返回原表，逐项一致（改了等于没改）', () => {
  withComfy({ galleryPool: null, galleryMaxEdge: 0 }, () => {
    assert.deepEqual(resolveGalleryAspects(), GALLERY_ASPECTS);
  });
});

test('媒体画幅池：只勾选的画幅才参与随机', () => {
  withComfy({ galleryPool: ['4:3', '16:9'] }, () => {
    const keys = resolveGalleryAspects().map(a => a.key);
    assert.deepEqual(keys, ['4:3', '16:9']);
  });
});

test('媒体画幅池：全部取消时退回全表，不产出空池（宁可出图也不崩）', () => {
  withComfy({ galleryPool: [] }, () => {
    assert.equal(resolveGalleryAspects().length, GALLERY_ASPECTS.length);
  });
});

test('媒体长边上限：超标的等比缩到上限，且宽高都是 8 的倍数', () => {
  withComfy({ galleryPool: null, galleryMaxEdge: 1280 }, () => {
    for (const a of resolveGalleryAspects()) {
      const longEdge = Math.max(a.w, a.h);
      assert.ok(longEdge <= 1280, `${a.key} 长边 ${longEdge} 超过 1280`);
      assert.equal(a.w % 8, 0, `${a.key} 的宽 ${a.w} 不是 8 的倍数`);
      assert.equal(a.h % 8, 0, `${a.key} 的高 ${a.h} 不是 8 的倍数`);
    }
  });
});

test('媒体长边上限：0 表示不限，尺寸原样不动', () => {
  withComfy({ galleryPool: null, galleryMaxEdge: 0 }, () => {
    for (const a of resolveGalleryAspects()) {
      const src = GALLERY_ASPECTS.find(x => x.key === a.key);
      assert.equal(a.w, src.w);
      assert.equal(a.h, src.h);
    }
  });
});

test('config 里的画幅白名单与 GALLERY_ASPECTS 一致（两处各写一份，必须同步）', () => {
  assert.deepEqual(GALLERY_ASPECT_KEYS, GALLERY_ASPECTS.map(a => a.key));
});

// ── 各链路独立画师串（2026-10-22）──
const ARTIST_KEYS = {
  comfy_paper_artist:    'paperArtist',
  comfy_standing_artist: 'standingArtist',
  comfy_mail_artist:     'mailArtist',
  comfy_chatbg_artist:   'chatBgArtist',
  comfy_item_artist:     'itemArtist',
};

test('五条链路的独立画师串都登记进 SETTING_TO_CONFIG（type=string）', () => {
  for (const key of Object.keys(ARTIST_KEYS)) {
    assert.ok(key in SETTING_TO_CONFIG, `${key} 未登记 —— 重启后会丢`);
    assert.equal(SETTING_TO_CONFIG[key].obj, 'comfyui');
    assert.equal(SETTING_TO_CONFIG[key].type, 'string');
  }
});

test('独立画师串默认是空/null —— 空表示「跟随原来源」，升级后零变化', () => {
  for (const field of Object.values(ARTIST_KEYS)) {
    const v = config.comfyui[field];
    assert.ok(v === null || v === '' || v === undefined, `${field} 默认应为空，实际是 ${v}`);
  }
});

test('写库后 loadSystemSettings 能把独立画师串读回（等价于重启不丢）', () => {
  const db = createDb([
    ['comfy_standing_artist', '@ebora'],
    ['comfy_item_artist', '崩铁立绘风'],
  ]);
  const before = { standingArtist: config.comfyui.standingArtist, itemArtist: config.comfyui.itemArtist };
  try {
    config.comfyui.standingArtist = '';
    config.comfyui.itemArtist = '';
    loadSystemSettings(db);
    assert.equal(config.comfyui.standingArtist, '@ebora');
    assert.equal(config.comfyui.itemArtist, '崩铁立绘风');
  } finally {
    Object.assign(config.comfyui, before);
    db.close();
  }
});
