/**
 * imageScenes.js — 生图场景的**唯一权威清单**（2026-10-23，方案 §19 全链路体检）
 *
 * ── 为什么要有这个文件 ──
 * `filterGlobalLoras(loras, scene)` 用 `scenes` 白名单决定「这条全局 LoRA 在哪个场景生效」。
 * 但场景值散落在 26 处调用点，从来没人列全过：
 *
 *   · 后端 `imageSkill.js` 的注释只写了 8 个：chat/group/portrait/moments/events/schedule/mailbox/sticker
 *   · 实际代码里还用了 `items`（道具）、`town`（小镇素材）—— **这两个值不在任何白名单里**
 *   · 前端 `GlobalLoraModal.vue` 的勾选项也只有 8 个，**没有"头像"**
 *   · 更麻烦的是有 10 处链路**根本没传 scene** → `filterGlobalLoras` 走
 *     `if (!currentScene) return true` 直接全放行
 *
 * 于是形成一个很别扭的状态：
 * **头像之所以吃得到 LoRA，是因为它"没传 scene"，而不是因为"头像这一项被打开了"。**
 * 谁要是好心把 scene 补对，头像会**当场失去 LoRA** —— 这是个埋着的雷。
 *
 * ── 本文件要解决的问题 ──
 * 让每个链路都有明确的、在清单里的 scene；让用户在设置页能逐项开关。
 * 这样"设置"与"链路"才真正对应得上，而不是靠"漏传参数"意外生效。
 *
 * ⚠ 新增链路时**必须**先在这里登记 key，再去调用点传 `scene`。
 *   `scripts/audit-image-call-params.mjs` 会检查有没有出现清单外的值。
 */

/**
 * 全部生图场景。`label` 给前端用，`hint` 说明这条链路具体指什么图。
 */
export const IMAGE_SCENES = [
  { key: 'chat',      label: '聊天配图', hint: '聊天里发来的照片' },
  { key: 'group',     label: '群聊',     hint: '群聊里发的图' },
  { key: 'portrait',  label: '立绘',     hint: '角色立绘（含场景立绘）' },
  { key: 'avatar',    label: '头像',     hint: '角色头像' },
  { key: 'moments',   label: '朋友圈',   hint: '自发朋友圈配图' },
  { key: 'events',    label: '奇遇',     hint: '奇遇主图与分支图' },
  { key: 'schedule',  label: '日程',     hint: '日程/行程配图' },
  { key: 'mailbox',   label: '信件',     hint: '信箱插图' },
  { key: 'sticker',   label: '表情包',   hint: '表情包生成' },
  { key: 'item',      label: '道具',     hint: '商品与战利品图' },
  { key: 'media',     label: '媒体图',   hint: '媒体相册里的图' },
  { key: 'paper',     label: '报纸',     hint: '报纸插图' },
  { key: 'proactive', label: '主动聊天', hint: '角色主动发起对话时的配图' },
  { key: 'gift',      label: '礼物',     hint: '角色送礼的图' },
  { key: 'town',      label: '小镇素材', hint: 'AI 小镇的地块与 NPC 素材' },
];

export const IMAGE_SCENE_KEYS = IMAGE_SCENES.map(s => s.key);

/**
 * 旧版前端的默认勾选（8 项，缺头像/道具/媒体/报纸/主动聊天/礼物/小镇）。
 * 迁移用：配置恰好等于这一组时，视为"当时能勾的全勾了"，补全到新全集。
 */
export const LEGACY_UI_SCENES_V1 = [
  'chat', 'group', 'portrait', 'moments', 'events', 'sticker', 'mailbox', 'schedule',
];

/** 更早的五项（初版弹窗） */
export const LEGACY_UI_SCENES_V0 = ['chat', 'moments', 'events', 'mailbox', 'schedule'];

/** 加过群聊与立绘之后的那一版（7 项） */
export const LEGACY_UI_SCENES_V0_1 = [...LEGACY_UI_SCENES_V0, 'group', 'portrait'];

export function isKnownScene(key) {
  return IMAGE_SCENE_KEYS.includes(key);
}

/** 清单外的值：调用点传错了，或新链路没登记 */
export function unknownScenes(keys) {
  return (Array.isArray(keys) ? keys : []).filter(k => k && !isKnownScene(k));
}
