import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// F-07 护栏（2026-10-12）：SSE「后端广播 → 前端 handlers 注册」契约。
//
// 背景：F-07 修复时发现后端广播的媒体事件（media_*）在 `unifiedStream.js` 的
// `_connect()` 注册表里**一个都没注册** —— 事件到达前端后 `handlers[event]` 查不到、
// 被静默丢弃（页面只能等 60s 兜底轮询）。同类漏网还有 `group_round_undone`（已修）。
// 这类故障「编译不报错、控制台不报错、页面只是不更新」，只能靠契约测试拦住。
//
// 规则：agent-core 里所有 `broadcast('X'` / `broadcastToUnified('X'` 广播的事件名，
//   都必须在前端注册表（或白名单）里出现；新增广播忘了接线 → 测试失败。
//   白名单只保留**有明确编号、待后续批次处理**的事件（不许塞无主项）。

const WEB_UI = fileURLToPath(new URL('..', import.meta.url))
const AGENT_CORE_SRC = fileURLToPath(new URL('../../agent-core/src', import.meta.url))
const STREAM_FILE = path.join(WEB_UI, 'src/stores/unifiedStream.js')

// 待办白名单：必须与 docs/pr1-6-修复清单.md 的条目对应，修好后删掉对应行。
// （2026-10-12：F-12 / F-27 修复后**已清空** —— item_ready / loot_image_ready / loot_taken
//   三事件全部完成接线；此后新增白名单项必须带条目引用。）
const PENDING = new Map([])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

/** 后端全部广播事件名（含跨行、含 broadcastToUnified；不含包装函数名） */
function collectBroadcastEvents() {
  const events = new Map()   // name -> ['file:line']
  const re = /[^\w]broadcast(?:ToUnified)?\(\s*'([^']+)'/g
  for (const f of walk(AGENT_CORE_SRC)) {
    const text = fs.readFileSync(f, 'utf8')
    const rel = path.relative(AGENT_CORE_SRC, f).replace(/\\/g, '/')
    for (const m of text.matchAll(re)) {
      if (!events.has(m[1])) events.set(m[1], [])
      const line = text.slice(0, m.index).split('\n').length
      events.get(m[1]).push(`${rel}:${line}`)
    }
  }
  return events
}

/** 前端 unifiedStream._connect() 注册表的键集合（花括号配对取块，稳健） */
function collectRegisteredHandlers() {
  const text = fs.readFileSync(STREAM_FILE, 'utf8')
  const anchor = text.indexOf('api.connectUnifiedStream({')
  assert.ok(anchor >= 0, '在 unifiedStream.js 找不到 api.connectUnifiedStream({ 锚点')
  const start = text.indexOf('{', anchor)
  let depth = 0
  let end = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  assert.ok(end > start, '注册表花括号配对失败')
  const block = text.slice(start, end + 1)
  return new Set(
    [...block.matchAll(/(?:^|[\s,{])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:d\s*=>|\(\s*\)\s*=>|\(\s*\)\s*\{)/gm)].map(m => m[1])
  )
}

const broadcastEvents = collectBroadcastEvents()
const registered = collectRegisteredHandlers()

test('★ F-07 护栏：后端广播的每个事件都在前端注册表（或待办白名单）里', () => {
  const missing = []
  for (const [name, locs] of broadcastEvents) {
    if (registered.has(name)) continue
    if (PENDING.has(name)) continue
    missing.push(`  '${name}'  ← 广播于 ${locs[0]}${locs.length > 1 ? ` 等 ${locs.length} 处` : ''}`)
  }
  assert.equal(
    missing.length, 0,
    `以下事件后端有广播、前端未注册（事件会被静默丢弃；接线后加入注册表即修复）：\n${missing.join('\n')}`
  )
})

test('★ F-07 护栏：曾经的漏网事件已接线（媒体四事件 + 群聊撤回）', () => {
  for (const name of ['media_new_posts', 'media_image_ready', 'media_portal_ready', 'media_post_deleted', 'group_round_undone']) {
    assert.ok(registered.has(name), `${name} 应在注册表里`)
    assert.ok(broadcastEvents.has(name), `后端应确实在广播 ${name}`)
  }
})

test('护栏自检：扫描确实工作（能扫到已注册的既有事件）', () => {
  assert.ok(broadcastEvents.has('schedule_state_change'), '应扫到 schedule_state_change 的广播点')
  assert.ok(registered.has('schedule_state_change'), '注册表应含 schedule_state_change')
})
