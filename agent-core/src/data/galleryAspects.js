/**
 * 媒体画幅常量（纯数据，**不依赖任何模块**）。
 *
 * 单独放这里的理由：`config.js` 保存画幅池时需要这份 key 白名单做校验，
 * 而 config 是底层模块 —— 如果常量文件和 config 互相 import 就会成环。
 * 所以常量只留数据，算「当前生效池」的逻辑放在 services/galleryAspectResolver.js。
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

/** 合法画幅 key（配置校验用） */
export const GALLERY_ASPECT_KEYS = GALLERY_ASPECTS.map(a => a.key);
