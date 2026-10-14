/**
 * 角色文件夹 store
 *
 * 单层分类：一个角色只属于一个文件夹，`folder_id` 为 null 表示「未分类」。
 *
 * 为什么收在 store 而不是各自 fetch：左侧会话栏（Sidebar）和酒馆页（TavernView）
 * 是同屏可见的，在酒馆页把角色挪进文件夹，侧栏的分组要立刻跟着变 —— 两边共用
 * 同一份 folders 与计数，才能天然同步，也省掉重复请求。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../api/index.js'
import { createGeneration } from '../utils/loadGeneration.js'

/** 未分类分组在前端的统一 key（后端对应 folder_id = null） */
export const UNCATEGORIZED_KEY = 'uncategorized'

/** 单个文件夹分组的 key（与未分类区分开） */
export function folderGroupKey(folderId) {
  return `f${folderId}`
}

export const useCharacterFoldersStore = defineStore('characterFolders', () => {
  const folders = ref([])
  // ⚠ 口径为「含归档」（后端 /folders 的 uncategorized 未排除 archived），
  // 且当前**没有任何视图消费它** —— 展示用的未分类计数请走 utils/folderCounts.js，
  // 不要把这里的值直接渲染到界面上（否则又是一处口径打架，见 F-20）。
  const uncategorizedCount = ref(0)
  /** 接口就绪前不渲染分组 UI，避免后端未更新时出现半坏状态 */
  const ready = ref(false)

  let inflight = null
  /** F-23：文件夹列表加载的「世代号」守卫 —— 作废被写后刷新取代的旧读响应 */
  const loadGen = createGeneration()

  /**
   * 拉取文件夹列表（含各组成员数）。
   *
   * ★ 并发合并 + 写后强制刷新（F-23 修订）：**纯读**场景仍合并同一飞行中的请求；
   *   **写后刷新**（移动 / 新建 / 改名 / 删除文件夹）必须传 `{ force: true }`，
   *   跳过合并真发新请求 —— 否则会复用写之前发出的旧请求、拿回写之前的计数，
   *   界面表现为「移动了计数没变 / 改名后还是旧名」。响应写入前先校验世代，
   *   迟到的旧响应一律丢弃。
   *
   * @param {{ force?: boolean }} [opts] force=true 用于写后刷新（绕过飞行中合并）
   */
  function load({ force = false } = {}) {
    if (!force && inflight) return inflight
    const gen = loadGen.next()
    let p
    p = (async () => {
      try {
        const data = await api.listCharacterFolders()
        if (!loadGen.isCurrent(gen)) return  // 迟到响应：已被更新的加载取代
        folders.value = data.folders || []
        uncategorizedCount.value = data.uncategorized || 0
        ready.value = true
      } catch {
        // 接口不可用（例如后端还是旧版本）时保持上一次状态，列表退化为平铺
      }
    })().finally(() => { if (inflight === p) inflight = null })
    inflight = p
    return p
  }

  /** 把角色移入文件夹（folderId 传 null = 移回未分类），成功后刷新计数 */
  async function moveCharacter(characterId, folderId) {
    await api.moveCharacterToFolder(characterId, folderId)
    await load({ force: true })   // F-23：写后刷新须真发新请求
  }

  async function createFolder(name) {
    const created = await api.createCharacterFolder(name)
    await load({ force: true })   // F-23：写后刷新须真发新请求
    return created
  }

  async function renameFolder(id, name) {
    await api.renameCharacterFolder(id, name)
    await load({ force: true })   // F-23：写后刷新须真发新请求
  }

  async function removeFolder(id) {
    await api.deleteCharacterFolder(id)
    await load({ force: true })   // F-23：写后刷新须真发新请求
  }

  /**
   * 拖拽重排文件夹。
   * 先乐观更新本地顺序（拖完立刻见效果），失败再回滚 —— 顺序是纯观感数据，
   * 没必要等接口回来才动。ids 之外没提到的文件夹保留在末尾，避免界面凭空丢项。
   */
  async function reorderFolders(ids) {
    const prev = folders.value
    const byId = new Map(prev.map(f => [f.id, f]))
    const next = ids.map(id => byId.get(id)).filter(Boolean)
    for (const f of prev) if (!ids.includes(f.id)) next.push(f)
    folders.value = next
    try {
      await api.reorderCharacterFolders(ids)
    } catch (err) {
      folders.value = prev      // 回滚，避免本地顺序与库里不一致
      throw err
    }
  }

  return {
    folders, uncategorizedCount, ready,
    load, moveCharacter, createFolder, renameFolder, removeFolder, reorderFolders,
  }
})

/**
 * 按文件夹把角色分组，供侧栏渲染。
 * 返回 `[{ key, id, name, characters }]`；「未分类」永远排最后，空文件夹也保留
 * （分类体系本身要完整，哪怕某组暂时是空的）。
 */
export function groupCharactersByFolder(characters, folders) {
  const groups = folders.map(f => ({
    key: folderGroupKey(f.id),
    id: f.id,
    name: f.name,
    characters: characters.filter(c => c.folder_id === f.id),
  }))
  const uncategorized = characters.filter(c => !c.folder_id)
  if (uncategorized.length) {
    groups.push({ key: UNCATEGORIZED_KEY, id: null, name: '未分类', characters: uncategorized })
  }
  return groups
}
