import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'

// F-17 回归（2026-10-12）：用户侧带图消息（发图 / 参考图）刷新后必须仍在。
//
// 背景：实时链路里，用户消息的图走 sticker_images 渲染（store 的 msg_saved 处理
// → scheduleSticker → sticker 气泡）；但刷新后重建历史（rawToMessages）时只把
// `/images/emoji/...` 归入 sticker_images，`/images/chat/...` 的附件图被当成
// 「助手生成图」处理：纯图消息被 isImageCarrier 跳过、图文消息的图又被
// `role === 'assistant'` 门挡掉 → 刷新后用户图凭空消失。
//
// 本测试按「实时链路的口径」钉住历史重建：
//   ① 用户纯图消息 → 有渲染载体（sticker_images 含图）；
//   ② 用户 文本+图 → 文本气泡 + sticker_images 含图；
//   ③（不回归）助手生成图仍走 image_gen 气泡；
//   ④（不回归）助手表情仍归 sticker_images。
//
// ⚠ mock 契约：request() 读的是 res.text()（识别"后端未重启 → HTML 404"），
//   所以 mock 必须同时给出 text()。

let nextPayload = { messages: [] }
const mockRes = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body })
globalThis.fetch = async () => mockRes(nextPayload)

const { useChatStore } = await import('../src/stores/chat.js')
setActivePinia(createPinia())

const IMG = '/images/chat/1791167771186_novelai_1791167771186_1.png'
const EMO = '/images/emoji/wink.png'

async function loadWith(msgs) {
  nextPayload = { messages: msgs }
  const store = useChatStore()
  store.activeCharId = 4
  await store.loadMessages(4)
  return store.messages
}

function stickerUrls(m) {
  return (m.sticker_images || []).map(s => (typeof s === 'string' ? s : s?.url))
}

test('★ F-17①：用户纯图消息刷新后仍在（sticker_images 载体；修复前整条消失）', async () => {
  const msgs = await loadWith([
    { id: 1, raw_id: 1, role: 'user', content: '', images: JSON.stringify([IMG]), created_at: '2026-10-12T10:00:00Z' },
  ])
  const bubble = msgs.find(m => m.role === 'user')
  assert.ok(bubble, '纯图消息不能整条消失（修复前被 isImageCarrier 跳过 + role 门挡掉）')
  assert.ok(stickerUrls(bubble).includes(IMG), '附件图应挂到 sticker_images（与实时链路同口径）')
})

test('★ F-17②：用户「文本+图」消息的图刷新后仍在', async () => {
  const msgs = await loadWith([
    { id: 2, raw_id: 2, role: 'user', content: '看这个', images: JSON.stringify([IMG]), created_at: '2026-10-12T10:01:00Z' },
  ])
  const bubble = msgs.find(m => m.role === 'user')
  assert.ok(bubble, '文本气泡应存在')
  assert.equal(bubble.content, '看这个')
  assert.ok(stickerUrls(bubble).includes(IMG), '附件图应挂到 sticker_images（修复前为空 → 图丢失）')
})

test('F-17③（不回归）：助手生成图仍走 image_gen 气泡', async () => {
  const msgs = await loadWith([
    { id: 3, raw_id: 3, role: 'assistant', content: '送你一张', images: JSON.stringify([IMG]), created_at: '2026-10-12T10:02:00Z' },
  ])
  const gen = msgs.find(m => m.type === 'image_gen')
  assert.ok(gen, '助手生成图仍应有 image_gen 气泡')
  assert.ok(gen.images.some(i => (i?.url || i) === IMG))
})

test('F-17④（不回归）：助手表情仍归 sticker_images 且不产生 image_gen', async () => {
  const msgs = await loadWith([
    { id: 4, raw_id: 4, role: 'assistant', content: '', images: JSON.stringify([EMO]), created_at: '2026-10-12T10:03:00Z' },
  ])
  assert.equal(msgs.filter(m => m.type === 'image_gen').length, 0, '纯表情不应生成 image_gen 气泡')
  const bubble = msgs.find(m => m.role === 'assistant' && m.type !== 'image_gen')
  assert.ok(bubble, '表情气泡应存在')
  assert.ok(stickerUrls(bubble).includes(EMO))
})
