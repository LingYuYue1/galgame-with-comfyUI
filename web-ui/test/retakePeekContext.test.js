import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// F-15 回归（2026-10-12）：「再拍一张」必须带上被瞄活动上下文。
//
// 背景：后端通过 `body.activity.startTime` 钉「时段锚点」（凌晨的活动不画成白天），
// 并保持与原图同时段、同着装。此前 retakePeekSnapshot 只发 `{ prompt }`，
// 活动时刻/着装全部丢失 —— 与 peek 的 onPeekAt 路径不一致。
//
// ⚠ mock 契约：request() 读的是 res.text()（用于识别"后端未重启 → Express HTML 404"），
//   所以 mock 必须同时给出 text()；只给 json() 的旧写法会直接抛错（见 api/index.js 头注）。

let lastCall = null
const mockRes = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body })
globalThis.fetch = async (url, init = {}) => {
  lastCall = { url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined }
  return mockRes({ success: true })
}

const { retakePeekSnapshot } = await import('../src/api/index.js')

test('★ F-15①：retake 带活动上下文（时刻 + 着装透传，后端据此钉时段锚点）', async () => {
  await retakePeekSnapshot(7, 'prompt text', {
    activity: '夜间安睡',
    location: '家',
    startTime: '02:00',
    endTime: '07:00',
    outfit: '睡衣',
  })
  assert.equal(lastCall.url, '/api/schedule/7/peek/retake')
  assert.equal(lastCall.method, 'POST')
  assert.equal(lastCall.body.prompt, 'prompt text')
  assert.equal(lastCall.body.activity.startTime, '02:00', '活动时刻应透传（时段锚点输入）')
  assert.equal(lastCall.body.activity.outfit, '睡衣', '着装标注应透传')
})

test('F-15②：不带上下文时请求体与旧版一致（只有 prompt，行为不变）', async () => {
  await retakePeekSnapshot(7, 'prompt text')
  assert.deepEqual(lastCall.body, { prompt: 'prompt text' })
})

test('F-15③：组件接线 —— retakePeek 与 onPeekAt 共用活动上下文构造函数', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views', 'ScheduleView.vue'),
    'utf8',
  )
  assert.match(src, /function buildPeekActivityCtx/, '应有共用上下文构造函数')
  // retakePeek 内必须把被瞄活动传给 api（否则「再拍一张」丢时段）
  const retakeFn = src.slice(src.indexOf('async function retakePeek'), src.indexOf('function onPeekClose'))
  assert.match(
    retakeFn, /retakePeekSnapshot\([^)]*buildPeekActivityCtx\(peekAct\.value\)/,
    'retakePeek 应传 buildPeekActivityCtx(peekAct.value)',
  )
  const peekAtFn = src.slice(src.indexOf('function onPeekAt'), src.indexOf('async function onRegenerate'))
  assert.match(peekAtFn, /peekSnapshot\([^)]*buildPeekActivityCtx\(act\)/, 'onPeekAt 也应走同一构造函数')
})
