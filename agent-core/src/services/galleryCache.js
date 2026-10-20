// 相册缓存（独立服务，避免每次请求都 readdir + stat 阻塞事件循环）。
// 生图/删图等操作通过 invalidateGalleryCache() 失效缓存；
// 服务层与路由层都从这里导入，不再出现 service → route 的反向依赖。
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { getAllImageDirs } from './imagePaths.js';
import { getDb } from '../db/index.js';
import { buildImageSourceIndex, attachSource } from './imageSourceResolver.js';

export const galleryCache = {
  data: null,       // { images: [...], total: number }
  mtime: 0,         // 缓存创建时间
  ttl: 30_000,      // 30 秒 TTL（生图不频繁，短缓存已足够）
};

/** 扫描单个目录，返回带 folder 标记的图片列表 */
async function scanDirectory(dirPath, category, urlPrefix) {
  try {
    const files = await readdir(dirPath);
    const imageFiles = files.filter(f => /\.(png|jpg|jpeg|webp|gif|avif)$/i.test(f));
    if (imageFiles.length === 0) return [];

    const BATCH_SIZE = 64;
    const results = [];
    for (let i = 0; i < imageFiles.length; i += BATCH_SIZE) {
      const batch = imageFiles.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (name) => {
          const s = await stat(join(dirPath, name));
          return { name, size: s.size, mtime: s.mtimeMs, folder: category, url: `${urlPrefix}/${name}` };
        })
      );
      results.push(...batchResults);
    }
    // ★ 2026-10-20：跳过「空壳图」。实测 chat/ 下有 50 个 3 字节（NUL×3）的
    //   user_*.png —— 客户端 POST 了 `base64,AAAA` 留下的垃圾。它们打不开、
    //   也没有任何任务记录，进相册只能变成「未知来源」，不如不显示。
    //   上传接口已同步加了 <100 字节拒收，这里是对历史文件与其它写入口的兜底。
    return results.filter(r => r.size >= 100);
  } catch {
    return [];
  }
}

/** 刷新相册缓存：扫描所有子目录 + 历史平铺目录，批量 stat */
// 相册里不出现的目录：道具是背包图标等游戏素材，不是「留影」。
// 注意只在相册层排除：图片压缩等其它调用方仍然要处理它们。
const GALLERY_EXCLUDED_CATEGORIES = new Set(['items']);

export async function refreshGalleryCache() {
  const dirs = getAllImageDirs();
  const allResults = [];

  for (const { category, dir, urlPrefix } of dirs) {
    if (GALLERY_EXCLUDED_CATEGORIES.has(category)) continue;
    const results = await scanDirectory(dir, category, urlPrefix);
    allResults.push(...results);
  }

  allResults.sort((a, b) => b.mtime - a.mtime);

  // BUG-03：按 URL 反查 image_tasks，补上「来源 / 角色 / 出口」。
  // 相册本来是纯磁盘扫描，来源数据一直躺在 DB 里没被读出来。
  // 索引构建失败不能让相册整体挂掉 —— 降级为「全部未知来源」。
  let sourceIndex = null;
  let names = new Map();
  try {
    const db = getDb();
    sourceIndex = buildImageSourceIndex(db);
    names = new Map(db.prepare('SELECT id, display_name FROM characters').all().map((r) => [r.id, r.display_name]));
  } catch (err) {
    console.error('[gallery] 来源索引构建失败（相册仍可用）:', err.message);
  }
  // ★ 2026-10-20：即使索引为空也要走 attachSource —— 它现在带「按目录/文件名」兜底，
  //   立绘（22 张有 21 张没任务记录）、用户上传图（53 张）都能落到具体来源，
  //   不再一律显示「未知来源」。
  const images = allResults.map(img => attachSource(img, sourceIndex || new Map(), names));

  galleryCache.data = { images, total: images.length };
  galleryCache.mtime = Date.now();
}

/** 当新图片生成/删除后调用，使缓存失效 */
export function invalidateGalleryCache() {
  galleryCache.data = null;
  galleryCache.mtime = 0;
}
