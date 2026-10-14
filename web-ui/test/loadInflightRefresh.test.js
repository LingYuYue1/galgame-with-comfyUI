import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'

/**
 * ★ F-23 回归守卫 —— 「飞行中复用同一 Promise」的并发合并会吞掉「写后刷新」。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `stores/chat.js` 的 `loadCharacters()` 与 `stores/characterFolders.js` 的 `load()`
 * 都用「**请求飞行中复用同一 Promise**」做启动去重（`if (inflight) return inflight`）。
 * 这本身是为「启动阶段多个入口几乎同时碰同一个列表」设计的，但合并**没有区分
 * 「纯读刷新」与「写后刷新」**：
 *
 *   若一个在**写操作之前**发出的加载请求仍在飞行，写路径随后调用 `load()` 会
 *   **复用那个旧 Promise** → 拿回**写之前**的数据 → 写操作的结果被吞。
 *   界面表现：「删了还在 / 改了还是旧名 / 移动后计数没变」，要等下一次真实刷新才恢复。
 *
 * ── 药是什么 ────────────────────────────────────────────────
 *   ① 世代号守卫（复用 utils/loadGeneration.js）：每次真正发起加载取新世代，
 *      响应回来先校验 `isCurrent` 才写 —— 迟到的旧响应天然自废（防后发先至）。
 *   ② 写路径传 `{ force: true }` 跳过合并、**真发一次新请求**，否则连新请求都不会发出。
 *   两者缺一不可：只有 ① 没 ② → 不发新请求；只有 ② 没 ① → 旧响应仍可能后到覆盖。
 *
 * 本文件两层：
 *   ① 行为 —— 假 api + 可控「闸门」（每条 GET 都挂起，可逐条放行），
 *      完整复现「旧读飞行中触发写」，验证最终状态包含写入结果、且写后确实发了新请求；
 *      另复现「先放行新的、后放行旧的」证明迟到旧响应不覆盖。
 *   ② 接线（静态护栏）—— 钉住两个 store 确实用了世代守卫 + 写路径 force，防回退。
 */

// ───────────────────────── 打桩脚手架 ─────────────────────────

const jsonRes = (body) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
})

/**
 * 可编程的假后端：
 *   · GET 请求进入时**先对服务端状态做快照**（模拟服务端「此刻读库」），再挂起，
 *     由测试用 release(i) 逐条放行 —— 从而精确控制响应先后顺序。
 *   · 写请求立即修改服务端状态。
 */
function makeServer(initial) {
  const state = { characters: [], folders: [], uncategorized: 0, ...initial }
  const gates = [] // 每个挂起的 GET：{ path, snapshot, release }

  const snapshot = () => JSON.parse(JSON.stringify({
    characters: state.characters,
    folders: state.folders,
    uncategorized: state.uncategorized,
  }))

  const release = (i) => { const g = gates[i]; if (g) g.release() }
  const releaseAll = () => { while (gates.length) gates.shift().release() }

  const fetchImpl = async (url, opts = {}) => {
    const path = String(url)
    const method = (opts.method || 'GET').toUpperCase()

    if (method === 'GET') {
      const snap = snapshot() // ★ 快照在请求到达这一刻取，之后的写操作不影响它
      await new Promise((resolve) => gates.push({ path, snapshot: snap, release: resolve }))
      if (path === '/api/characters') return jsonRes({ characters: snap.characters })
      if (path === '/api/characters/folders') return jsonRes({ folders: snap.folders, uncategorized: snap.uncategorized })
      return jsonRes({})
    }

    if (method === 'DELETE' && /^\/api\/characters\/\d+$/.test(path)) {
      const id = Number(path.split('/').pop())
      state.characters = state.characters.filter((c) => c.id !== id)
      return jsonRes({ ok: true })
    }

    if (method === 'PUT' && /^\/api\/characters\/\d+\/folder$/.test(path)) {
      const id = Number(path.split('/')[3])
      const folderId = opts.body ? JSON.parse(opts.body).folder_id : null
      const c = state.characters.find((x) => x.id === id)
      if (c) c.folder_id = folderId
      state.folders = state.folders.map((f) => ({ ...f, count: state.characters.filter((x) => x.folder_id === f.id).length }))
      return jsonRes({ ok: true })
    }

    return jsonRes({ ok: true })
  }

  return { state, gates, release, releaseAll, fetchImpl }
}

const tick = () => new Promise((r) => setTimeout(r, 5))
const origFetch = globalThis.fetch

// ───────────────────────── ① 行为 ─────────────────────────

test('★ F-23①（chat）：旧读飞行中触发写 → 写后必须真发新请求，界面即时正确', async () => {
  const srv = makeServer({ characters: [{ id: 1, name: 'A', display_name: 'A' }, { id: 2, name: 'B', display_name: 'B' }] })
  globalThis.fetch = srv.fetchImpl
  try {
    setActivePinia(createPinia())
    const { useChatStore } = await import('../src/stores/chat.js')
    const store = useChatStore()
    store.activeCharId = 1

    const p1 = store.loadCharacters()          // 非强制读：GET#1 挂起（快照含 A、B）
    assert.equal(srv.gates.length, 1, '首个加载应发起一个请求并挂起')

    const pd = store.deleteActiveCharacter()   // DELETE(A) → 写后刷新
    await tick()                               // 让 DELETE 完成并走到写后刷新
    assert.equal(
      srv.gates.length, 2,
      '★ 写后刷新必须真发新请求（force），不能复用写之前发出的旧请求 —— 否则删除结果被吞',
    )

    srv.releaseAll()
    await Promise.all([p1, pd])

    assert.deepEqual(store.characters.map((c) => c.id), [2], '删除后列表不得再含 A（旧请求的快照不得覆盖写后数据）')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('★ F-23②（chat）：迟到的旧读响应不得覆盖写后的新数据（防后发先至）', async () => {
  const srv = makeServer({ characters: [{ id: 1, name: 'A', display_name: 'A' }, { id: 2, name: 'B', display_name: 'B' }] })
  globalThis.fetch = srv.fetchImpl
  try {
    setActivePinia(createPinia())
    const { useChatStore } = await import('../src/stores/chat.js')
    const store = useChatStore()
    store.activeCharId = 1

    const p1 = store.loadCharacters()          // GET#1（旧，快照含 A）
    const pd = store.deleteActiveCharacter()   // DELETE(A) → GET#2（新）
    await tick()
    assert.equal(srv.gates.length, 2)

    srv.release(1)                             // 先放行「写后刷新」（GET#2）
    await tick()
    assert.deepEqual(store.characters.map((c) => c.id), [2], '写后刷新应先生效')

    srv.release(0)                             // 再放行更早的 GET#1（快照含已删的 A）
    await Promise.all([p1, pd])
    assert.deepEqual(store.characters.map((c) => c.id), [2], '★ 迟到的旧响应必须被丢弃，不得把已删角色写回来')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('★ F-23③（characterFolders）：写后刷新同样必须真发新请求（移动角色后计数即时更新）', async () => {
  const srv = makeServer({
    characters: [{ id: 1, folder_id: null }, { id: 2, folder_id: null }],
    folders: [{ id: 5, name: 'F', count: 0 }],
  })
  globalThis.fetch = srv.fetchImpl
  try {
    setActivePinia(createPinia())
    const { useCharacterFoldersStore } = await import('../src/stores/characterFolders.js')
    const store = useCharacterFoldersStore()

    const p1 = store.load()                    // GET#1 挂起（快照 count=0）
    assert.equal(srv.gates.length, 1)

    const pm = store.moveCharacter(2, 5)       // PUT 移动 → 写后刷新
    await tick()
    assert.equal(srv.gates.length, 2, '★ 写后刷新必须真发新请求')

    srv.releaseAll()
    await Promise.all([p1, pm])
    assert.equal(store.folders[0].count, 1, '移动后计数应即时反映，不得用旧快照（count=0）')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('F-23：纯读场景仍应合并同一飞行中的请求（不破坏启动去重）', async () => {
  const srv = makeServer({ characters: [{ id: 1, name: 'A', display_name: 'A' }] })
  globalThis.fetch = srv.fetchImpl
  try {
    setActivePinia(createPinia())
    const { useChatStore } = await import('../src/stores/chat.js')
    const store = useChatStore()

    const a = store.loadCharacters()
    const b = store.loadCharacters()           // 与 a 并发 → 应复用同一请求
    assert.equal(srv.gates.length, 1, '并发的纯读必须合并成一个请求（启动去重的本意）')
    srv.releaseAll()
    await Promise.all([a, b])
    assert.equal(srv.gates.length, 0)
  } finally {
    globalThis.fetch = origFetch
  }
})

// ───────────────────────── ② 接线（静态护栏）─────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 去掉注释，避免匹配到说明文字（F-21 沉淀：守卫只该查代码，不查注释） */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 从源码里抠出一个具名函数的函数体（含花括号），用于检查其内部实现。
 *  注意：参数表可能含解构（如 `{ force = false } = {}`），必须先配平圆括号再找函数体，
 *  否则会误把参数里的 `{` 当成函数体开始（F-23 踩到）。 */
function extractFnBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(')
  const m = re.exec(src)
  if (!m) return null
  // 1) 从参数表的 '(' 起配平圆括号，跳过参数（可能含解构花括号/箭头默认值）
  const paren = src.indexOf('(', m.index + m[0].length - 1)
  let pd = 0
  let afterParams = -1
  for (let j = paren; j < src.length; j++) {
    const ch = src[j]
    if (ch === '(') pd++
    else if (ch === ')') { pd--; if (pd === 0) { afterParams = j; break } }
  }
  if (afterParams < 0) return null
  // 2) 参数表之后第一个 '{' 即函数体开始，再配平花括号
  const brace = src.indexOf('{', afterParams)
  if (brace < 0) return null
  let depth = 0
  for (let j = brace; j < src.length; j++) {
    const ch = src[j]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(brace, j + 1) }
  }
  return null
}

test('★ F-23（接线）：两个 store 的加载须带「世代守卫 + force 旁路」，写路径须传 force', () => {
  const chat = stripComments(read('stores/chat.js'))
  const folders = stripComments(read('stores/characterFolders.js'))

  // ① 都引入世代守卫
  assert.match(chat, /createGeneration/, 'chat store 应引入 createGeneration 世代守卫')
  assert.match(folders, /createGeneration/, 'characterFolders store 应引入 createGeneration 世代守卫')

  // ② loadCharacters 支持 force 且响应写入前校验世代
  const lc = extractFnBody(chat, 'loadCharacters')
  assert.ok(lc, '未找到 loadCharacters')
  assert.match(lc, /force/, 'loadCharacters 应支持 force 旁路（写后刷新用）')
  assert.match(lc, /isCurrent\(/, 'loadCharacters 在写入前必须校验世代（防迟到旧响应覆盖）')

  // ③ chat store 的写路径必须传 force
  for (const fn of ['updateActiveCharacter', 'deleteActiveCharacter', 'generateCharacter', 'uploadAvatar']) {
    const body = extractFnBody(chat, fn)
    assert.ok(body, `未找到 ${fn}`)
    assert.match(body, /loadCharacters\(\s*\{\s*force\s*:\s*true\s*\}\s*\)/, `${fn} 写后刷新须传 { force: true }`)
  }

  // ④ characterFolders 的 load 支持 force，且四个写方法都传 force
  const load = extractFnBody(folders, 'load')
  assert.ok(load, '未找到 load')
  assert.match(load, /force/, 'characterFolders.load 应支持 force 旁路')
  assert.match(load, /isCurrent\(/, 'characterFolders.load 在写入前必须校验世代')
  for (const fn of ['moveCharacter', 'createFolder', 'renameFolder', 'removeFolder']) {
    const body = extractFnBody(folders, fn)
    assert.ok(body, `未找到 ${fn}`)
    assert.match(body, /load\(\s*\{\s*force\s*:\s*true\s*\}\s*\)/, `${fn} 写后刷新须传 { force: true }`)
  }
})
