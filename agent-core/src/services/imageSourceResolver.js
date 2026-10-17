// 相册来源解析（BUG-03）—— 把 `image_tasks.conversation_id` 读出来变成人话。
//
// ── 背景 ────────────────────────────────────────────────────
// 相册本体是**纯磁盘扫描**（galleryCache），从不碰数据库，所以每张图都不知道是谁要的。
// 来源数据其实一直在：`image_tasks.conversation_id` 存的是来源标签
// （`char_4_moments` / `media_post` / `town_newspaper` …），`output_paths` 存图片 URL。
// 这里按 URL 反查，补上 `source` / `character_id` / `character_name` / `outlet_name`
// 与可直接展示的 `source_label`（如「朋友圈 · 三月七」「传媒 · 规则34」）。
//
// ── 口径 ───────────────────────────────────────────────────
// · URL 归一：去 query / decode / 只留**末两段**（`moments/x.png`），与相册扫描结果对齐。
// · PNG 被压缩成 AVIF 时文件名主体不变、扩展名变了 → 两种扩展名都登记。
// · 查不到 → 由调用方显示「未知来源」，这里返回 undefined，不猜。
// · 传媒帖的出口名从 `media_posts` 反查（封面 image / payload.panels[].image /
//   payload.sections[].image 三处引用口径，与清理器一致）。

const ROLE_LABELS = [
  [/^moments$/, '朋友圈'],
  [/^(events?|event_.*)$/, '奇遇'],
  [/^standing$/, '立绘'],
  [/^avatar$/, '头像'],
  [/^schedule_peek/, '日程一瞥'],
];

const MEDIA_LABELS = {
  media_post: '传媒',
  media_portal_section: '传媒 · 门户',
  media_poster_panel: '传媒 · 海报',
  town_newspaper: '小镇 · 日报',
};

/** URL → 稳定键（末两段、小写、无 query）。相册扫描与任务记录都用它对齐。 */
export function normalizeImageKey(url) {
  let s = String(url || '').split('?')[0].split('#')[0].replace(/\\/g, '/');
  try { s = decodeURIComponent(s); } catch { /* 非法编码：按原样 */ }
  const parts = s.split('/').filter(Boolean);
  return parts.slice(-2).join('/').toLowerCase();
}

function withExtensionVariants(key) {
  const out = [key];
  if (/\.png$/.test(key)) out.push(key.replace(/\.png$/, '.avif'));
  else if (/\.avif$/.test(key)) out.push(key.replace(/\.avif$/, '.png'));
  return out;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

/** 把来源标签翻译成「来源 + 角色/出口」。不认识的标签返回 null（= 未知来源）。 */
export function describeConversationId(conversationId, names = new Map()) {
  const raw = String(conversationId || '').trim();
  if (!raw) return null;

  const charMatch = /^char_(\d+)(?:_(.+))?$/.exec(raw);
  if (charMatch) {
    const characterId = Number(charMatch[1]);
    const suffix = charMatch[2] || '';
    const characterName = names.get(characterId) || null;
    if (!suffix) return { source: '聊天', source_label: '聊天', character_id: characterId, character_name: characterName };
    const rule = ROLE_LABELS.find(([re]) => re.test(suffix));
    const source = rule ? rule[1] : '角色图';
    return {
      source,
      source_label: characterName ? `${source} · ${characterName}` : source,
      character_id: characterId,
      character_name: characterName,
    };
  }

  const mediaLabel = MEDIA_LABELS[raw];
  if (mediaLabel) return { source: mediaLabel, source_label: mediaLabel, character_id: null, character_name: null };
  return null;
}

/** 传媒帖的图片 URL → 出口名（封面 / 海报小图 / 门户板块图三处都算）。 */
function buildOutletIndex(db) {
  const index = new Map();
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT p.image, p.payload_json, o.name
      FROM media_posts p LEFT JOIN media_outlets o ON o.id = p.outlet_id
      WHERE o.name IS NOT NULL
    `).all();
  } catch { return index; }

  const add = (url, name) => {
    const key = normalizeImageKey(url);
    if (!key) return;
    for (const k of withExtensionVariants(key)) if (!index.has(k)) index.set(k, name);
  };
  for (const row of rows) {
    add(row.image, row.name);
    const payload = parseJson(row.payload_json, null);
    if (Array.isArray(payload?.panels)) for (const panel of payload.panels) add(panel?.image, row.name);
    if (Array.isArray(payload?.sections)) for (const section of payload.sections) add(section?.image, row.name);
  }
  return index;
}

/**
 * 构建「图片 URL 键 → 来源信息」索引。
 * @param {import('better-sqlite3').Database} [db]
 * @returns {Map<string, {source:string, source_label:string, character_id:number|null, character_name:string|null, outlet_name:string|null}>}
 */
export function buildImageSourceIndex(db) {
  const index = new Map();
  if (!db) return index;
  let names = new Map();
  try {
    names = new Map(db.prepare('SELECT id, display_name FROM characters').all().map(r => [r.id, r.display_name]));
  } catch { /* 角色表缺失（空库）→ 只显示来源，不显示名字 */ }

  const outlets = buildOutletIndex(db);

  let tasks = [];
  try {
    tasks = db.prepare(
      "SELECT conversation_id, output_paths FROM image_tasks WHERE output_paths IS NOT NULL AND output_paths <> '' ORDER BY id"
    ).all();
  } catch { return index; }

  for (const task of tasks) {
    const meta = describeConversationId(task.conversation_id, names);
    if (!meta) continue;
    const paths = parseJson(task.output_paths, []);
    if (!Array.isArray(paths)) continue;
    for (const path of paths) {
      const key = normalizeImageKey(path);
      if (!key) continue;
      const outletName = outlets.get(key) || null;
      const label = meta.character_name || outletName
        ? `${meta.source} · ${meta.character_name || outletName}`
        : meta.source;
      const info = { ...meta, source_label: label, outlet_name: outletName };
      for (const k of withExtensionVariants(key)) if (!index.has(k)) index.set(k, info);
    }
  }
  return index;
}

/** 相册卡片要附带的来源字段（查不到给「未知来源」）。 */
export function attachSource(image, index) {
  const info = index?.get(normalizeImageKey(image?.url));
  if (!info) {
    return { ...image, source: null, source_label: '未知来源', character_id: null, character_name: null };
  }
  return {
    ...image,
    source: info.source,
    source_label: info.source_label,
    character_id: info.character_id,
    character_name: info.character_name,
  };
}
