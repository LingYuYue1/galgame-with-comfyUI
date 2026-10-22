/**
 * 媒体画幅常量（纯数据，**不依赖任何模块**）。
 *
 * 单独放这里的理由：`config.js` 保存画幅池时需要这份 key 白名单做校验，
 * 而 config 是底层模块 —— 如果常量文件和 config 互相 import 就会成环。
 * 所以常量只留数据，算「当前生效池」的逻辑放在 services/galleryAspectResolver.js。
 */

/**
 * 标准档：长边 1600~1728、约 1.6~1.9MP。**就是改造前的 7 种**，默认全选。
 * `galleryPool` 为空时只从这里取，所以加小尺寸档不会改变任何既有行为。
 */
export const GALLERY_ASPECTS = [
  { key: '2:3', w: 1088, h: 1632 },
  { key: '3:4', w: 1200, h: 1600 },
  { key: '9:16', w: 972, h: 1728 },
  { key: '1:1', w: 1440, h: 1440 },
  { key: '4:3', w: 1600, h: 1200 },
  { key: '3:2', w: 1632, h: 1088 },
  { key: '16:9', w: 1728, h: 972 },
];

/**
 * 小尺寸档（2026-10-22 加）：与标准档**比例一一对应**，长边 ≤1280、像素 ≤1.05MP，
 * 全部 8 对齐（latent 对齐）。给显存紧的机器用，默认**不进池**。
 *
 * key 用「宽x高」而不是比例：标准档已经占了 `'2:3'` 这类 key，
 * 两档会一起写进 `media_items.aspect`，用尺寸当 key 才不会撞名、也一眼能看出实际多大。
 * （`galleryCustom` 用的是同一套口径，所以自定义再填 512×768 会被挡重复。）
 */
export const GALLERY_SMALL_ASPECTS = [
  { key: '512x768',   w: 512,  h: 768,  ratio: '2:3'  },
  { key: '768x1024',  w: 768,  h: 1024, ratio: '3:4'  },
  { key: '576x1024',  w: 576,  h: 1024, ratio: '9:16' },
  { key: '1024x1024', w: 1024, h: 1024, ratio: '1:1'  },
  { key: '1024x768',  w: 1024, h: 768,  ratio: '4:3'  },
  { key: '768x512',   w: 768,  h: 512,  ratio: '3:2'  },
  { key: '1280x720',  w: 1280, h: 720,  ratio: '16:9' },
];

/** 两档合起来 = 所有能进池的画幅 */
export const GALLERY_ALL_ASPECTS = [...GALLERY_ASPECTS, ...GALLERY_SMALL_ASPECTS];

/** 合法画幅 key（配置校验用，含小尺寸档） */
export const GALLERY_ASPECT_KEYS = GALLERY_ALL_ASPECTS.map(a => a.key);
