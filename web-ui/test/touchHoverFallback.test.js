/**
 * F-24 护栏：触屏（无 hover）下「待发送图片」的移除按钮必须常显。
 *
 * 背景：`.chat-img-del` 默认 `opacity: 0`，只靠 `.chat-img-thumb:hover .chat-img-del`
 * 才显形。触屏设备没有 hover → 按钮永远 `opacity: 0`（虽然仍能被盲点到，但用户
 * 根本看不见、不知道能删）→ 体感就是「发了图删不掉」。模板 ChatView.vue 注释自声明
 * 该预览条「可逐张移除」，且 `.chat-img-del` 是**唯一**删除入口。
 *
 * 同仓已有同类触屏兜底先例：BackpackModal.vue:923 / MediaView.vue:1891 /
 * TavernView.vue:3170（都在 `@media (hover: none)` 下让 hover-only 控件常显）。
 * 本测试钉住 ChatView 也接上这条兜底，防止回退。
 *
 * 这是「静态接线护栏」：确认兜底规则存在且写对；真实可见性由 CDP 移动视口验收。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CHAT = readFileSync(resolve(__dirname, '../src/views/ChatView.vue'), 'utf8')

test('F-24 前置：.chat-img-del 目前是 hover 显隐（问题根源基线）', () => {
  // 基础规则确实靠 opacity:0 + :hover 显示 —— 这正是触屏看不到的原因
  assert.match(CHAT, /\.chat-img-del\s*\{[^}]*opacity:\s*0/s, '基础规则应含 opacity:0')
  assert.match(
    CHAT,
    /\.chat-img-thumb:hover\s+\.chat-img-del\s*\{[^}]*opacity:\s*1/s,
    '应存在 .chat-img-thumb:hover .chat-img-del { opacity:1 } 的桌面显隐',
  )
})

test('F-24：@media (hover: none) 触屏块内 .chat-img-del 必须 opacity:1', () => {
  // 宽松匹配：从 @media (hover: none) 起，到下一个 @media 之前，必须出现
  // .chat-img-del { ... opacity: 1 }
  const block = CHAT.match(/@media\s*\(\s*hover:\s*none[^)]*\)[\s\S]*?(?=@media|$)/)
  assert.ok(block, '缺少 @media (hover: none) 触屏兜底块（触屏上移除按钮将不可见）')
  assert.match(
    block[0],
    /\.chat-img-del\s*\{[^}]*opacity:\s*1/s,
    '触屏兜底块内应把 .chat-img-del 设为 opacity:1（常显）',
  )
})
