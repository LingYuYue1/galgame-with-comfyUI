/**
 * 角色文件夹的计数口径与归属同步（F-20）。
 *
 * ── 这个模块解决什么问题 ─────────────────────────────────────
 *
 * 同一个文件夹，界面上存在两类数字，含义本就不同，但同屏出现时必须**说得清楚**：
 *   · 「能看到几个」= 活跃角色数 —— 普通分类视图只渲染未归档角色（归档角色只在
 *     「归档管理」里出现，见 TavernView 的 activeCharacters），所以点进文件夹
 *     见到的卡片数就是活跃数；
 *   · 「会动几个」= 该文件夹全部成员（**含归档**）—— 后端 /api/characters/folders
 *     返回的 f.count 是这个口径，删除文件夹、批量归档等动作的作用范围同样含归档
 *     成员（与 utils/archiveScope.js 的口径一致）。
 *
 * F-20 之前：分类栏 chip 用活跃数，而移动角色弹窗与删除确认**裸用后端 f.count** ——
 * 同一文件夹两处数字打架。本模块把「活跃口径」的计算收口到一处，供 chip、移动
 * 弹窗、未分类计数共用；「含归档口径」只在删除确认文案里显式标注着用。
 *
 * ── 顺带收口的一条连锁缺陷 ───────────────────────────────────
 *
 * 删除文件夹后，后端执行 `UPDATE characters SET folder_id = NULL WHERE folder_id = ?`
 * —— 不带 archived 条件，成员（含归档）**全部**退回未分类。但前端删除后只刷新了
 * folders 列表，`chat.characters` 里成员的 folder_id 不会自己变；而侧栏分组
 * （stores/characterFolders.js 的 groupCharactersByFolder）是「按 folders 分组 +
 * 未分类按 folder_id 为 null 分组」—— 残留旧 folder_id 的角色会**无组可归，
 * 从侧栏消失**，未分类计数也少算，直到刷新页面才恢复。
 * `detachFolderFromCharacters` 负责把本地归属同步成与后端一致的状态。
 */

/** 角色是否已归档（口径真源：后端 characters.archived，0/1） */
export function isArchived(character) {
  return !!character?.archived
}

function asList(characters) {
  return Array.isArray(characters) ? characters : []
}

/** 归属比较：folder_id 在接口与筛选之间时而是数字、时而是字符串，统一按字符串比 */
function inFolder(character, folderId) {
  return character?.folder_id != null && String(character.folder_id) === String(folderId)
}

/** 某文件夹内的活跃（未归档）角色数 —— 与点进该文件夹后实际看到的卡片数一致 */
export function activeCountInFolder(characters, folderId) {
  return asList(characters).filter(c => !isArchived(c) && inFolder(c, folderId)).length
}

/** 「未分类」的活跃角色数 —— 与未分类视图实际渲染的一致 */
export function activeUncategorizedCount(characters) {
  return asList(characters).filter(c => !isArchived(c) && c?.folder_id == null).length
}

/** 某文件夹内的归档成员数 —— 仅供删除确认文案把口径差显式讲出来 */
export function archivedCountInFolder(characters, folderId) {
  return asList(characters).filter(c => isArchived(c) && inFolder(c, folderId)).length
}

/**
 * 文件夹被删除后，把本地角色列表里属于它的成员归属清空（folder_id → null）。
 *
 * 口径必须与后端删除动作一致：不带 archived 条件，归档成员同样退回未分类。
 * 若只清活跃成员，归档成员会留下指向已删文件夹的悬空 id，在侧栏里无处可归。
 *
 * @returns {number} 被退回未分类的成员数（含归档，与后端动作范围一致）
 */
export function detachFolderFromCharacters(characters, folderId) {
  let moved = 0
  for (const c of asList(characters)) {
    if (c && inFolder(c, folderId)) {
      c.folder_id = null
      moved += 1
    }
  }
  return moved
}
