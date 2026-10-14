import { test } from 'node:test'
import assert from 'node:assert/strict'

// F-03 回归（2026-10-12）：日程弹窗「重新生成」的四类字段必须真的发出去。
//
// 背景：ScheduleView.regenOptionsPayload() 早已组装好 transitMode / dayType /
// excludedByArea / pickedPlaces（用户在弹窗里真的选了），但 api/index.js 的
// regenerateSchedule 是**白名单透传** —— 这四类字段此前被静默吞掉：
// 「选了日子类型 / 划掉了地点后重新生成，后端实际收不到」。
//
// ⚠ mock 契约：request() 读的是 res.text()（用于识别"后端未重启 → Express HTML 404"），
//   所以 mock 必须同时给出 text()；只给 json() 的旧写法会直接抛错（见 api/index.js 头注）。

let lastCall = null
const mockRes = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body })
globalThis.fetch = async (url, init = {}) => {
  lastCall = { url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined }
  return mockRes({ ok: true, version: 1 })
}

const { regenerateSchedule } = await import('../src/api/index.js')

test('★ F-03①：四字段全部透传（transitMode / dayType / excludedByArea / pickedPlaces）', async () => {
  await regenerateSchedule(7, '更宅一点', {
    areas: ['旧城区'],
    areaStrict: true,
    nsfwRatio: 2,
    sleepType: 'night_owl',
    transitMode: 'teleport',
    dayType: 'workday',
    excludedByArea: { 旧城区: ['地下赌场'] },
    pickedPlaces: ['私人会所'],
  })
  assert.equal(lastCall.url, '/api/schedule/7/regenerate')
  assert.equal(lastCall.method, 'POST')
  const b = lastCall.body
  assert.equal(b.transitMode, 'teleport', '移动方式应透传')
  assert.equal(b.dayType, 'workday', '日子类型应透传')
  assert.deepEqual(b.excludedByArea, { 旧城区: ['地下赌场'] }, '地点排除应透传')
  assert.deepEqual(b.pickedPlaces, ['私人会所'], '受限地点显式放行应透传')
  // 旧字段不受影响
  assert.equal(b.direction, '更宅一点')
  assert.deepEqual(b.areas, ['旧城区'])
  assert.equal(b.areaStrict, true)
  assert.equal(b.nsfwRatio, 2)
  assert.equal(b.sleepType, 'night_owl')
})

test('★ F-03②：mapId 独立透传，不依赖 areas 是否勾选', async () => {
  await regenerateSchedule(7, undefined, { mapId: 3 })
  assert.equal(lastCall.body.mapId, 3)
  assert.equal('areas' in lastCall.body, false)
  // 与 areas 同时存在时也照常
  await regenerateSchedule(7, undefined, { mapId: 3, areas: ['旧城区'] })
  assert.equal(lastCall.body.mapId, 3)
  assert.deepEqual(lastCall.body.areas, ['旧城区'])
})

test('★ F-03③：sleepPlace 只设睡眠地点也能透传（原先嵌在 homePlace 条件里被吞）', async () => {
  await regenerateSchedule(7, undefined, { sleepPlace: '阁楼' })
  assert.equal(lastCall.body.sleepPlace, '阁楼')
})

test('空值不注入：dayType 空串 / excludedByArea 空对象 / pickedPlaces 空数组 → body 保持最小', async () => {
  await regenerateSchedule(7, undefined, { dayType: '', excludedByArea: {}, pickedPlaces: [] })
  assert.deepEqual(lastCall.body, {})
})

test('旧行为不回归：不传 options 时请求体与旧版一致（只有 direction）', async () => {
  await regenerateSchedule(7, '维持原样')
  assert.deepEqual(lastCall.body, { direction: '维持原样' })
})
