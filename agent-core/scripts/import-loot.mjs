/**
 * 橱窗商品清单导入工具（F-28）。
 *
 * 全新部署时 `loot_catalog` 为空 → 橱窗显示「还没有商品清单」。本脚本把外部 JSON 清单
 * 校验后写进库；幂等：以 tag 为键 更新/新增/删除，重跑不会清掉已生成的图。
 *
 * 用法：
 *   node scripts/import-loot.mjs <清单文件.json>
 *   node scripts/import-loot.mjs -h        # 查看格式说明
 *
 * 清单格式（可直接复制 scripts/loot-catalog.example.json 起手）：
 *   {
 *     "pages": [ { "key": "clothes", "label": "服装" } ],
 *     "items": [
 *       { "tag": "maid_dress", "name": "女仆装", "meaning": "黑白女仆连衣裙",
 *         "cat": "clothes", "slot": "full", "page": "clothes" }
 *     ]
 *   }
 *   · cat：落地效果类别（可选值见 KNOWN_CATS）；page：归到哪个标签页，省略时回落 cat
 *   · 顶层也可直接给数组（= 只更新 items，不改标签页）
 *
 * 退出码：0 成功；1 参数/文件/校验错误（错误以 [import-loot] 前缀输出，失败不改库）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from '../src/db/index.js';
import { importCatalog, KIND_BY_CAT } from '../src/services/lootService.js';

/** cat 的合法取值（与落地效果映射保持单一真源：lootService.KIND_BY_CAT） */
export const KNOWN_CATS = Object.keys(KIND_BY_CAT);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 校验并规范化清单内容。
 * @param {unknown} raw 已 JSON.parse 的清单内容
 * @returns {{ pages: Array<object>|null, items: Array<object> }} pages=null 表示「不动分页配置」
 * @throws {Error} 任何违规都抛带位置的错误（导入前拦下，保证不写库）
 */
export function parseCatalogPayload(raw) {
  if (raw === null || raw === undefined) throw new Error('清单内容为空');

  let pages = null;
  let items;
  if (Array.isArray(raw)) {
    // 简形：顶层数组 = 只更新商品
    items = raw;
  } else if (typeof raw === 'object') {
    items = raw.items;
    if (raw.pages !== undefined && raw.pages !== null) {
      if (!Array.isArray(raw.pages) || raw.pages.length === 0) {
        throw new Error('pages 应为非空数组（没有标签页的商品在橱窗里看不见）');
      }
      const seen = new Set();
      pages = raw.pages.map((p, i) => {
        if (!p || typeof p !== 'object') throw new Error(`pages[${i}] 不是对象`);
        if (!isNonEmptyString(p.key)) throw new Error(`pages[${i}].key 应为非空字符串`);
        if (!isNonEmptyString(p.label)) throw new Error(`pages[${i}].label 应为非空字符串`);
        if (seen.has(p.key)) throw new Error(`pages[${i}].key "${p.key}" 重复`);
        seen.add(p.key);
        return { ...p };
      });
    }
  } else {
    throw new Error('清单顶层应为对象（{ pages, items }）或数组（items）');
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('清单里没有 items（应为非空数组）');
  }

  const pageKeys = pages ? new Set(pages.map((p) => p.key)) : null;
  const seenTags = new Map();
  const normalized = items.map((it, i) => {
    if (!it || typeof it !== 'object') throw new Error(`items[${i}] 不是对象`);
    if (!isNonEmptyString(it.tag)) throw new Error(`items[${i}].tag 应为非空字符串`);
    const tag = it.tag.trim();
    if (seenTags.has(tag)) throw new Error(`items[${i}].tag "${tag}" 与 items[${seenTags.get(tag)}] 重复`);
    seenTags.set(tag, i);
    if (!isNonEmptyString(it.name)) throw new Error(`items[${i}].name 应为非空字符串（tag="${tag}"）`);
    if (!KNOWN_CATS.includes(it.cat)) {
      throw new Error(`items[${i}].cat "${it.cat}" 未知（可用：${KNOWN_CATS.join(' / ')}；tag="${tag}"）`);
    }
    if (!isNonEmptyString(it.slot)) throw new Error(`items[${i}].slot 应为非空字符串（tag="${tag}"）`);
    if (it.meaning !== undefined && typeof it.meaning !== 'string') {
      throw new Error(`items[${i}].meaning 应为字符串（tag="${tag}"）`);
    }
    let page = it.page ?? null;
    if (page !== null) {
      if (!isNonEmptyString(page)) throw new Error(`items[${i}].page 应为非空字符串（tag="${tag}"）`);
      page = page.trim();
      if (pageKeys && !pageKeys.has(page)) {
        throw new Error(`items[${i}].page "${page}" 不在 pages 的 key 列表（${[...pageKeys].join(' / ')}）里（tag="${tag}"）`);
      }
    }
    return { tag, name: it.name.trim(), meaning: it.meaning ?? '', cat: it.cat, slot: it.slot, page };
  });

  return { pages, items: normalized };
}

function usage() {
  return `用法：node scripts/import-loot.mjs <清单文件.json>（-h 查看本说明）

清单格式（可复制 scripts/loot-catalog.example.json 起手）：
  {
    "pages": [ { "key": "clothes", "label": "服装" } ],
    "items": [
      { "tag": "maid_dress", "name": "女仆装", "meaning": "黑白女仆连衣裙",
        "cat": "clothes", "slot": "full", "page": "clothes" }
    ]
  }
  · cat  可选：${KNOWN_CATS.join(' / ')}
  · slot 细分类：如 clothes/full、accessory/head、hairstyle/hair（adult_toy/play 不出图）
  · page 省略时回落 cat；顶层给数组（不带 pages）则只更新商品、不动标签页
  · 幂等导入：以 tag 为键 更新/新增/删除，重跑不会清掉已生成的图`;
}

async function main() {
  const file = process.argv[2];
  if (!file || file === '-h' || file === '--help') {
    console.log(usage());
    process.exitCode = file ? 0 : 1;
    return;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`读取清单失败（${file}）：${err.message}`);
  }

  const { pages, items } = parseCatalogPayload(raw);

  getDb();
  const r = importCatalog(items, pages);
  console.log(`[import-loot] 完成：新增 ${r.added}、更新 ${r.updated}、删除 ${r.removed}，共 ${r.total} 条商品；`
    + (pages ? `标签页 ${pages.length} 个` : '标签页未改动'));
  console.log('[import-loot] 重跑本命令即可随清单增量更新。');
  closeDb();
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(`[import-loot] ${err.message}`);
    process.exitCode = 1;
    try { closeDb(); } catch { /* ignore */ }
  });
}
