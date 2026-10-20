/**
 * 图片 URL 版本化 —— 让「覆盖同一路径」的图片也能被客户端重新拉取。
 *
 * 背景（BUG-04，2026-10-20 用户实测复现）：
 *   图片编辑任务（重新生成 / 放大）是**覆盖同一个 URL** 指向的文件，文件名不变。
 *   虽然 `/images` 挂着 `Cache-Control: no-cache`，但客户端在切页/刷新时并不总会重新验证，
 *   于是「覆盖后能看到新图 → 切窗口又变回旧的」。给 URL 拼一个随文件 mtime 变化的版本号，
 *   任何缓存都绕不过去。
 *
 * 安全性：
 *   - 后端所有接 URL 的入口（routes/images.js）都会先 `replace(/\?.*$/, '')` 剥掉 query，
 *     所以把带版本号的 URL 传回后端不会污染磁盘路径，也不会写进 DB。
 *   - 外链 / data: / blob: 原样返回，不碰。
 *
 * 缓存：
 *   stat 结果在进程内缓存 5 秒，避免每次列表请求都做上千次 stat。
 *   图片被覆盖后由 `invalidateImageVersionCache()` 主动清空（applyEditTask 里调用），
 *   所以覆盖立即可见，不必等 TTL 到期。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');           // agent-core
const DATA = path.join(ROOT, 'data');
// 与 imagePaths / 测试隔离口径一致：设了 IMAGES_DIR 就以它为准（测试用临时目录）
const IMAGES_DIR = process.env.IMAGES_DIR ? path.resolve(process.env.IMAGES_DIR) : path.join(DATA, 'images');

/** URL 前缀 → 磁盘目录。顺序重要：更长的前缀要先匹配（/.pending 在 /images 之前）。 */
const PREFIXES = [
  ['/images/.pending/', path.join(IMAGES_DIR, '.pending')],
  ['/images/', IMAGES_DIR],
  ['/avatars/', path.join(DATA, 'avatars')],
  ['/world-covers/', path.join(DATA, 'world-covers')],
  ['/town-assets/', path.join(ROOT, 'data', 'town', 'assets')],
];

const TTL_MS = 5000;
const MAX_ENTRIES = 5000;
const cache = new Map(); // url(不含 query) → { v: number, at: number }

/** 把站内图片 URL 映射到磁盘绝对路径；不是站内图片则返回 null */
export function toDiskPath(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  for (const [prefix, dir] of PREFIXES) {
    if (!clean.startsWith(prefix)) continue;
    let rest = clean.slice(prefix.length);
    try { rest = decodeURIComponent(rest); } catch { /* 保持原样 */ }
    const abs = path.resolve(dir, rest);
    // 目录穿越防护：解析结果必须落在该目录内
    if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
    return abs;
  }
  return null;
}

function statVersion(cleanUrl) {
  const hit = cache.get(cleanUrl);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.v;

  const disk = toDiskPath(cleanUrl);
  if (!disk) return null;

  let v = null;
  try {
    v = Math.round(fs.statSync(disk).mtimeMs);
  } catch {
    // PNG 已被 AVIF 压缩替换时原路径不存在 —— 用同名 .avif 的 mtime 兜底，
    // 与 app.js 的 imageAvifFallback 行为保持一致。
    if (/\.png$/i.test(disk)) {
      try { v = Math.round(fs.statSync(disk.replace(/\.png$/i, '.avif')).mtimeMs); } catch { v = null; }
    }
  }
  if (v == null) return null;

  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(cleanUrl, { v, at: now });
  return v;
}

/**
 * 给单个图片 URL 拼版本号。
 * @param {string} url
 * @param {number} [knownMtimeMs] 已知文件 mtime（相册扫描时已经有，省一次 stat）
 */
export function withImageVersion(url, knownMtimeMs) {
  if (!url || typeof url !== 'string') return url;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  const clean = url.split('?')[0].split('#')[0];
  const v = knownMtimeMs != null ? Math.round(knownMtimeMs) : statVersion(clean);
  if (v == null) return url; // 文件不存在：原样返回，让上层的 404 / 占位逻辑照常工作
  return `${clean}?v=${v}`;
}

/** 批量版本化（保持顺序、保持非字符串元素原样） */
export function withImageVersions(urls) {
  if (!Array.isArray(urls)) return urls;
  return urls.map((u) => (typeof u === 'string' ? withImageVersion(u) : u));
}

/** 图片被覆盖/删除后调用，让下一次版本计算重新 stat */
export function invalidateImageVersionCache() {
  cache.clear();
}
