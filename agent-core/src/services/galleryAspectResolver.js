/**
 * 媒体画幅池的「当前生效值」计算。
 *
 * 从 mediaService 拆出来的直接原因：mediaService 的依赖链会拉起 comfyClient，
 * 模块一加载就去连 ComfyUI 读 object_info（实测测试白跑 7 秒，ComfyUI 没开时更糟）。
 * 这段是纯计算，不该被拖进那条链里。
 *
 * 对外接口不变：调用方仍从 mediaService 拿这两个名字。
 */
import { config } from '../config.js';
import { GALLERY_ASPECTS } from '../data/galleryAspects.js';

/**
 * 按设置过滤勾选的画幅 + 按长边上限等比缩。
 *
 * **默认返回的就是 `GALLERY_ASPECTS` 原表**（`galleryPool` 未设、`galleryMaxEdge` = 0），
 * 与改造前「7 种全用、原尺寸抽」逐项一致。
 *
 * 每次调用现算、不缓存：用户在设置页改完立刻生效，不需要重启后端。
 * 全部取消勾选时退回全表 —— 宁可出图，也不要在这里抛错或产出 undefined 尺寸。
 */
export function resolveGalleryAspects() {
  const pool = Array.isArray(config.comfyui.galleryPool) ? config.comfyui.galleryPool : null;
  const keys = pool && pool.length ? new Set(pool) : null;
  const cap = Number(config.comfyui.galleryMaxEdge) || 0;

  const picked = keys ? GALLERY_ASPECTS.filter(a => keys.has(a.key)) : GALLERY_ASPECTS;
  const list = picked.length ? picked : GALLERY_ASPECTS;
  if (!cap) return list;

  return list.map(a => {
    const longEdge = Math.max(a.w, a.h);
    if (longEdge <= cap) return a;
    // 取 8 的倍数，和 latent 对齐；下限 64 防呆
    const scale = v => Math.max(64, Math.round((v * cap) / longEdge / 8) * 8);
    return { ...a, w: scale(a.w), h: scale(a.h) };
  });
}
